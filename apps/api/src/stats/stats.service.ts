import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  IndexerRunStatus,
  IndexerStatus,
  LatencyResponse,
  ProofSystemResponse,
  StatsMetadataResponse,
  ZkShareResponse
} from "@taikoproofs/shared";
import { addDays, startOfUtcDay } from "../common/date";
import { Prisma, ShastaIndexingState } from "@prisma/client";
import { combinedProtocolStatsSql } from "../common/protocol-records.sql";
import { AppConfigService } from "../config/app-config.service";

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService
  ) {}

  async getMetadata(): Promise<StatsMetadataResponse> {
    const [[row], indexerState] = await Promise.all([
      this.prisma.$queryRaw<{ data_start: Date | null; data_end: Date | null }[]>`
        WITH combined AS (${combinedProtocolStatsSql})
        SELECT
          MIN(proposed_at) AS data_start,
          MAX(proposed_at) AS data_end
        FROM combined
      `,
      this.prisma.shastaIndexingState.findUnique({ where: { chainId: this.config.chainId } })
    ]);
    const earliest = row?.data_start ?? null;
    const latest = row?.data_end ?? null;

    return {
      dataStart: earliest ? dateKey(earliest) : null,
      dataEnd: latest ? dateKey(latest) : null,
      indexer: this.toIndexerStatus(indexerState)
    };
  }

  // Deliberately omits last_run_error: it can embed RPC URLs (and their API keys).
  private toIndexerStatus(state: ShastaIndexingState | null | undefined): IndexerStatus | null {
    if (!state) {
      return null;
    }

    return {
      lastProcessedBlock: state.lastProcessedBlock?.toString() ?? null,
      lastRunStartedAt: state.lastRunStartedAt?.toISOString() ?? null,
      lastRunFinishedAt: state.lastRunFinishedAt?.toISOString() ?? null,
      lastRunStatus: (state.lastRunStatus as IndexerRunStatus | null) ?? null
    };
  }

  async refreshDailyStats(lookbackDays: number) {
    const end = await this.resolveStatsEndDate();
    const start = addDays(end, -lookbackDays);

    const provenRows = await this.prisma.$queryRaw<
      {
        date: Date;
        proven_total: number;
        zk_proven_total: number;
        tee_total: number;
        tee_sgx_geth_total: number;
        tee_sgx_reth_total: number;
        sp1_total: number;
        risc0_total: number;
        proving_avg_seconds: number | null;
      }[]
    >`
      WITH combined AS (${combinedProtocolStatsSql})
      SELECT
        date_trunc('day', proven_at) as date,
        COUNT(*)::int as proven_total,
        SUM(CASE WHEN proof_systems && ARRAY['SP1','RISC0']::"ProofSystem"[] THEN 1 ELSE 0 END)::int as zk_proven_total,
        SUM(CASE WHEN 'TEE' = ANY(proof_systems) THEN 1 ELSE 0 END)::int as tee_total,
        SUM(CASE WHEN 'SGX_GETH' = ANY(tee_verifiers) THEN 1 ELSE 0 END)::int as tee_sgx_geth_total,
        SUM(CASE WHEN 'SGX_RETH' = ANY(tee_verifiers) THEN 1 ELSE 0 END)::int as tee_sgx_reth_total,
        SUM(CASE WHEN 'SP1' = ANY(proof_systems) THEN 1 ELSE 0 END)::int as sp1_total,
        SUM(CASE WHEN 'RISC0' = ANY(proof_systems) THEN 1 ELSE 0 END)::int as risc0_total,
        AVG(EXTRACT(EPOCH FROM proven_at - proposed_at)) as proving_avg_seconds
      FROM combined
      WHERE proven_at BETWEEN ${start} AND ${addDays(end, 1)}
        AND is_contested = false
        AND proposed_at IS NOT NULL
      GROUP BY 1
    `;

    const verificationRows = await this.prisma.$queryRaw<
      { date: Date; verification_avg_seconds: number | null }[]
    >`
      WITH combined AS (${combinedProtocolStatsSql})
      SELECT
        date_trunc('day', verified_at) as date,
        AVG(EXTRACT(EPOCH FROM verified_at - proposed_at)) as verification_avg_seconds
      FROM combined
      WHERE verified_at BETWEEN ${start} AND ${addDays(end, 1)}
        AND is_contested = false
        AND proposed_at IS NOT NULL
      GROUP BY 1
    `;

    const verificationMap = new Map(
      verificationRows.map((row) => [dateKey(row.date), row])
    );

    const provenMap = new Map(provenRows.map((row) => [dateKey(row.date), row]));

    for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) {
      const key = dateKey(cursor);
      const proven = provenMap.get(key);
      const verification = verificationMap.get(key);

      await this.prisma.dailyStat.upsert({
        where: { date: cursor },
        create: {
          date: cursor,
          provenTotal: proven?.proven_total ?? 0,
          zkProvenTotal: proven?.zk_proven_total ?? 0,
          teeTotal: proven?.tee_total ?? 0,
          teeSgxGethTotal: proven?.tee_sgx_geth_total ?? 0,
          teeSgxRethTotal: proven?.tee_sgx_reth_total ?? 0,
          sp1Total: proven?.sp1_total ?? 0,
          risc0Total: proven?.risc0_total ?? 0,
          provingAvgSeconds: proven?.proving_avg_seconds ?? null,
          verificationAvgSeconds: verification?.verification_avg_seconds ?? null
        },
        update: {
          provenTotal: proven?.proven_total ?? 0,
          zkProvenTotal: proven?.zk_proven_total ?? 0,
          teeTotal: proven?.tee_total ?? 0,
          teeSgxGethTotal: proven?.tee_sgx_geth_total ?? 0,
          teeSgxRethTotal: proven?.tee_sgx_reth_total ?? 0,
          sp1Total: proven?.sp1_total ?? 0,
          risc0Total: proven?.risc0_total ?? 0,
          provingAvgSeconds: proven?.proving_avg_seconds ?? null,
          verificationAvgSeconds: verification?.verification_avg_seconds ?? null
        }
      });
    }
  }

  private async resolveStatsEndDate(): Promise<Date> {
    const [row] = await this.prisma.$queryRaw<
      {
        max_proposed_at: Date | null;
        max_proven_at: Date | null;
        max_verified_at: Date | null;
      }[]
    >`
      WITH combined AS (${combinedProtocolStatsSql})
      SELECT
        MAX(proposed_at) AS max_proposed_at,
        MAX(proven_at) AS max_proven_at,
        MAX(verified_at) AS max_verified_at
      FROM combined
    `;

    const candidates = [row?.max_verified_at, row?.max_proven_at, row?.max_proposed_at].filter(
      (value): value is Date => value instanceof Date
    );

    if (!candidates.length) {
      return startOfUtcDay(new Date());
    }

    const latest = candidates.reduce((best, current) =>
      current.getTime() > best.getTime() ? current : best
    );

    return startOfUtcDay(latest);
  }

  async getZkShare(
    start: Date,
    end: Date,
    endIsDateOnly: boolean
  ): Promise<ZkShareResponse> {
    const startDay = startOfUtcDay(start);
    const endDay = startOfUtcDay(end);

    const dailyStats = await this.prisma.dailyStat.findMany({
      where: {
        date: {
          gte: startDay,
          lte: endDay
        }
      },
      orderBy: { date: "asc" }
    });

    const statsMap = new Map(dailyStats.map((row) => [dateKey(row.date), row]));
    const points = [];

    for (let cursor = new Date(startDay); cursor <= endDay; cursor = addDays(cursor, 1)) {
      const key = dateKey(cursor);
      const row = statsMap.get(key);
      const provenTotal = row?.provenTotal ?? 0;
      const zkProvenTotal = row?.zkProvenTotal ?? 0;
      const zkPercent = provenTotal ? (zkProvenTotal / provenTotal) * 100 : null;

      points.push({
        date: key,
        provenTotal,
        zkProvenTotal,
        zkPercent
      });
    }

    const endBoundary = endIsDateOnly ? addDays(end, 1) : end;
    const summaryRange = endIsDateOnly
      ? Prisma.sql`proven_at >= ${start} AND proven_at < ${endBoundary}`
      : Prisma.sql`proven_at >= ${start} AND proven_at <= ${endBoundary}`;

    const [summaryRow] = await this.prisma.$queryRaw<
      { proven_total: number; zk_proven_total: number }[]
    >`
      WITH combined AS (${combinedProtocolStatsSql})
      SELECT
        COUNT(*)::int as proven_total,
        SUM(CASE WHEN proof_systems && ARRAY['SP1','RISC0']::"ProofSystem"[] THEN 1 ELSE 0 END)::int as zk_proven_total
      FROM combined
      WHERE ${summaryRange}
        AND is_contested = false
        AND proposed_at IS NOT NULL
    `;

    return {
      range: { start: dateKey(startDay), end: dateKey(endDay) },
      points,
      summary: {
        provenTotal: summaryRow?.proven_total ?? 0,
        zkProvenTotal: summaryRow?.zk_proven_total ?? 0
      }
    };
  }

  async getProofSystemUsage(start: Date, end: Date): Promise<ProofSystemResponse> {
    const startDay = startOfUtcDay(start);
    const endDay = startOfUtcDay(end);
    const dailyStats = await this.prisma.dailyStat.findMany({
      where: {
        date: {
          gte: startDay,
          lte: endDay
        }
      },
      orderBy: { date: "asc" }
    });

    const statsMap = new Map(dailyStats.map((row) => [dateKey(row.date), row]));
    const points = [];

    for (let cursor = new Date(startDay); cursor <= endDay; cursor = addDays(cursor, 1)) {
      const key = dateKey(cursor);
      const row = statsMap.get(key);

      points.push({
        date: key,
        provenTotal: row?.provenTotal ?? 0,
        tee: row?.teeTotal ?? 0,
        teeSgxGeth: row?.teeSgxGethTotal ?? 0,
        teeSgxReth: row?.teeSgxRethTotal ?? 0,
        sp1: row?.sp1Total ?? 0,
        risc0: row?.risc0Total ?? 0
      });
    }

    return {
      range: { start: dateKey(startDay), end: dateKey(endDay) },
      points
    };
  }

  async getLatency(
    type: "proving" | "verification",
    start: Date,
    end: Date,
    endIsDateOnly: boolean,
    verifiedOnly: boolean
  ): Promise<LatencyResponse> {
    if (type === "verification") {
      return this.getVerificationLatency(start, end, endIsDateOnly);
    }

    return this.getProvingLatency(start, end, endIsDateOnly, verifiedOnly);
  }

  private async getProvingLatency(
    start: Date,
    end: Date,
    endIsDateOnly: boolean,
    verifiedOnly: boolean
  ): Promise<LatencyResponse> {
    const endBoundary = endIsDateOnly ? addDays(end, 1) : end;
    const rangeClause = endIsDateOnly
      ? Prisma.sql`proven_at >= ${start} AND proven_at < ${endBoundary}`
      : Prisma.sql`proven_at >= ${start} AND proven_at <= ${endBoundary}`;

    const statsQuery = verifiedOnly
      ? this.prisma.$queryRaw<
          {
            avg_seconds: number | string | null;
            median_seconds: number | string | null;
            p90_seconds: number | string | null;
            p95_seconds: number | string | null;
            p99_seconds: number | string | null;
          }[]
        >`
          WITH combined AS (${combinedProtocolStatsSql})
          SELECT
            AVG(EXTRACT(EPOCH FROM proven_at - proposed_at)) as avg_seconds,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM proven_at - proposed_at)) as median_seconds,
            PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM proven_at - proposed_at)) as p90_seconds,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM proven_at - proposed_at)) as p95_seconds,
            PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM proven_at - proposed_at)) as p99_seconds
          FROM combined
          WHERE ${rangeClause}
            AND is_contested = false
            AND proposed_at IS NOT NULL
            AND proven_at >= proposed_at
            AND status = 'verified'
        `
      : this.prisma.$queryRaw<
          {
            avg_seconds: number | string | null;
            median_seconds: number | string | null;
            p90_seconds: number | string | null;
            p95_seconds: number | string | null;
            p99_seconds: number | string | null;
          }[]
        >`
          WITH combined AS (${combinedProtocolStatsSql})
          SELECT
            AVG(EXTRACT(EPOCH FROM proven_at - proposed_at)) as avg_seconds,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM proven_at - proposed_at)) as median_seconds,
            PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM proven_at - proposed_at)) as p90_seconds,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM proven_at - proposed_at)) as p95_seconds,
            PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM proven_at - proposed_at)) as p99_seconds
          FROM combined
          WHERE ${rangeClause}
            AND is_contested = false
            AND proposed_at IS NOT NULL
            AND proven_at >= proposed_at
        `;

    const [stats] = await statsQuery;
    const normalizeStat = (value: number | string | null | undefined) => {
      if (value === null || value === undefined) {
        return 0;
      }
      const numeric = typeof value === "number" ? value : Number(value);
      return Number.isFinite(numeric) ? numeric : 0;
    };

    const seriesQuery = verifiedOnly
      ? this.prisma.$queryRaw<{ date: Date; avg_seconds: number | string | null }[]>`
          WITH combined AS (${combinedProtocolStatsSql})
          SELECT
            date_trunc('day', proven_at) as date,
            AVG(EXTRACT(EPOCH FROM proven_at - proposed_at)) as avg_seconds
          FROM combined
          WHERE ${rangeClause}
            AND is_contested = false
            AND proposed_at IS NOT NULL
            AND proven_at >= proposed_at
            AND status = 'verified'
          GROUP BY 1
          ORDER BY 1
        `
      : this.prisma.$queryRaw<{ date: Date; avg_seconds: number | string | null }[]>`
          WITH combined AS (${combinedProtocolStatsSql})
          SELECT
            date_trunc('day', proven_at) as date,
            AVG(EXTRACT(EPOCH FROM proven_at - proposed_at)) as avg_seconds
          FROM combined
          WHERE ${rangeClause}
            AND is_contested = false
            AND proposed_at IS NOT NULL
            AND proven_at >= proposed_at
          GROUP BY 1
          ORDER BY 1
        `;

    const seriesRows = await seriesQuery;

    const startDay = startOfUtcDay(start);
    const endDay = startOfUtcDay(end);
    const seriesMap = new Map(
      seriesRows.map((row) => [dateKey(row.date), normalizeStat(row.avg_seconds)])
    );
    const series = [];
    for (let cursor = new Date(startDay); cursor <= endDay; cursor = addDays(cursor, 1)) {
      const key = dateKey(cursor);
      series.push({
        date: key,
        avgSeconds: seriesMap.get(key) ?? 0
      });
    }

    return {
      range: { start: dateKey(startDay), end: dateKey(endDay) },
      stats: {
        avgSeconds: normalizeStat(stats?.avg_seconds),
        medianSeconds: normalizeStat(stats?.median_seconds),
        p90Seconds: normalizeStat(stats?.p90_seconds),
        p95Seconds: normalizeStat(stats?.p95_seconds),
        p99Seconds: normalizeStat(stats?.p99_seconds)
      },
      series
    };
  }

  private async getVerificationLatency(
    start: Date,
    end: Date,
    endIsDateOnly: boolean
  ): Promise<LatencyResponse> {
    const endBoundary = endIsDateOnly ? addDays(end, 1) : end;
    const rangeClause = endIsDateOnly
      ? Prisma.sql`verified_at >= ${start} AND verified_at < ${endBoundary}`
      : Prisma.sql`verified_at >= ${start} AND verified_at <= ${endBoundary}`;
    const [stats] = await this.prisma.$queryRaw<
      {
        avg_seconds: number | string | null;
        median_seconds: number | string | null;
        p90_seconds: number | string | null;
        p95_seconds: number | string | null;
        p99_seconds: number | string | null;
      }[]
    >`
      WITH combined AS (${combinedProtocolStatsSql})
      SELECT
        AVG(EXTRACT(EPOCH FROM verified_at - proposed_at)) as avg_seconds,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM verified_at - proposed_at)) as median_seconds,
        PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM verified_at - proposed_at)) as p90_seconds,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM verified_at - proposed_at)) as p95_seconds,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM verified_at - proposed_at)) as p99_seconds
      FROM combined
      WHERE ${rangeClause}
        AND is_contested = false
        AND proposed_at IS NOT NULL
        AND verified_at >= proposed_at
        AND status = 'verified'
    `;

    const seriesRows = await this.prisma.$queryRaw<
      { date: Date; avg_seconds: number | string | null }[]
    >`
      WITH combined AS (${combinedProtocolStatsSql})
      SELECT
        date_trunc('day', verified_at) as date,
        AVG(EXTRACT(EPOCH FROM verified_at - proposed_at)) as avg_seconds
      FROM combined
      WHERE ${rangeClause}
        AND is_contested = false
        AND proposed_at IS NOT NULL
        AND verified_at >= proposed_at
        AND status = 'verified'
      GROUP BY 1
      ORDER BY 1
    `;

    const startDay = startOfUtcDay(start);
    const endDay = startOfUtcDay(end);
    const normalizeStat = (value: number | string | null | undefined) => {
      if (value === null || value === undefined) {
        return 0;
      }
      const numeric = typeof value === "number" ? value : Number(value);
      return Number.isFinite(numeric) ? numeric : 0;
    };
    const seriesMap = new Map(
      seriesRows.map((row) => [dateKey(row.date), normalizeStat(row.avg_seconds)])
    );
    const series = [];
    for (let cursor = new Date(startDay); cursor <= endDay; cursor = addDays(cursor, 1)) {
      const key = dateKey(cursor);
      series.push({
        date: key,
        avgSeconds: seriesMap.get(key) ?? 0
      });
    }

    return {
      range: { start: dateKey(startDay), end: dateKey(endDay) },
      stats: {
        avgSeconds: normalizeStat(stats?.avg_seconds),
        medianSeconds: normalizeStat(stats?.median_seconds),
        p90Seconds: normalizeStat(stats?.p90_seconds),
        p95Seconds: normalizeStat(stats?.p95_seconds),
        p99Seconds: normalizeStat(stats?.p99_seconds)
      },
      series
    };
  }
}
