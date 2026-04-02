"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import useSWR from "swr";
import clsx from "clsx";
import {
  BatchDateField,
  BatchDetailResponse,
  BatchProofType,
  BatchProtocol,
  BatchStatus,
  BatchesResponse,
  ProofSystem,
  TeeVerifier
} from "@taikoproofs/shared";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { buildApiUrl, fetcher } from "../lib/api";
import { formatDateTime } from "../lib/format";

interface BatchesViewProps {
  range: {
    start: string;
    end: string;
  };
}

const statusFilters: { label: string; value: BatchStatus | "all" }[] = [
  { label: "All", value: "all" },
  { label: "Proposed", value: "proposed" },
  { label: "Proven", value: "proven" },
  { label: "Verified", value: "verified" }
];

const systemLabels: Record<ProofSystem, string> = {
  TEE: "TEE",
  SP1: "SP1 RETH",
  RISC0: "RISC0 RETH"
};
const teeLabels: Record<TeeVerifier, string> = {
  SGX_GETH: "SGX GETH",
  SGX_RETH: "SGX RETH"
};
const protocolLabels: Record<BatchProtocol, string> = {
  PACAYA: "Pacaya",
  SHASTA: "Shasta"
};
type ProofFilterOption =
  | { type: "system"; value: ProofSystem; label: string }
  | { type: "tee"; value: TeeVerifier; label: string };

const proofFilters: ProofFilterOption[] = [
  { type: "tee", value: "SGX_GETH", label: teeLabels.SGX_GETH },
  { type: "tee", value: "SGX_RETH", label: teeLabels.SGX_RETH },
  { type: "system", value: "SP1", label: systemLabels.SP1 },
  { type: "system", value: "RISC0", label: systemLabels.RISC0 }
];
const PAGE_SIZE = 20;

type ProofBadgeTone = "tee" | "teeGeth" | "teeReth" | "sp1" | "risc0";

const proofBadgeStyles: Record<ProofBadgeTone, string> = {
  tee: "border-mint/50 bg-mint/10 text-mint",
  teeGeth: "border-mint/40 bg-mint/10 text-mint",
  teeReth: "border-mint/40 bg-mint/20 text-mint",
  sp1: "border-accentSoft/50 bg-accent/10 text-accent",
  risc0: "border-[#ec6b56]/40 bg-[#ec6b56]/10 text-[#ec6b56]"
};

const parseProofType = (value: string | null): BatchProofType => {
  if (value === "zk" || value === "non-zk" || value === "all") {
    return value;
  }
  return "all";
};

const parseDateField = (value: string | null): BatchDateField => {
  return value === "provenAt" ? "provenAt" : "proposedAt";
};

const parseBoolean = (value: string | null): boolean | undefined => {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
};


function buildProofBadges(
  proofSystems: ProofSystem[],
  teeVerifiers?: TeeVerifier[]
) {
  const badges: { label: string; tone: ProofBadgeTone }[] = [];
  const seen = new Set<string>();

  for (const system of proofSystems) {
    if (system === "TEE") {
      if (teeVerifiers?.length) {
        for (const tee of teeVerifiers) {
          const label = teeLabels[tee] ?? tee;
          if (seen.has(label)) {
            continue;
          }
          const tone =
            tee === "SGX_GETH" ? "teeGeth" : tee === "SGX_RETH" ? "teeReth" : "tee";
          badges.push({ label, tone });
          seen.add(label);
        }
      } else {
        const label = "TEE";
        if (!seen.has(label)) {
          badges.push({ label, tone: "tee" });
          seen.add(label);
        }
      }
      continue;
    }

    const label = systemLabels[system] ?? system;
    if (seen.has(label)) {
      continue;
    }
    badges.push({
      label,
      tone: system === "SP1" ? "sp1" : "risc0"
    });
    seen.add(label);
  }

  return badges;
}

function ProofBadge({ label, tone }: { label: string; tone: ProofBadgeTone }) {
  return (
    <span
      className={clsx(
        "rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.2em]",
        proofBadgeStyles[tone]
      )}
    >
      {label}
    </span>
  );
}

function ProofBadgeGroup({
  proofSystems,
  teeVerifiers
}: {
  proofSystems: ProofSystem[];
  teeVerifiers?: TeeVerifier[];
}) {
  const badges = buildProofBadges(proofSystems, teeVerifiers);
  if (!badges.length) {
    return <span className="text-white/40">—</span>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {badges.map((badge, index) => (
        <ProofBadge
          key={`${badge.label}-${index}`}
          label={badge.label}
          tone={badge.tone}
        />
      ))}
    </div>
  );
}

type BatchItem = BatchesResponse["items"][number];
type SelectedBatch = Pick<BatchItem, "batchId" | "protocol" | "recordKey">;

const getRecordNoun = (protocol: BatchProtocol) =>
  protocol === "SHASTA" ? "Proposal" : "Batch";

function ProtocolBadge({ protocol }: { protocol: BatchProtocol }) {
  return (
    <span className="rounded-full border border-line/70 bg-slate px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-white/60">
      {protocolLabels[protocol]}
    </span>
  );
}

function BatchCard({
  batch,
  onSelect
}: {
  batch: BatchItem;
  onSelect: (batch: SelectedBatch) => void;
}) {
  const noun = getRecordNoun(batch.protocol);

  return (
    <button
      type="button"
      onClick={() => onSelect(batch)}
      aria-label={`View ${noun.toLowerCase()} ${batch.batchId}`}
      className="w-full rounded-2xl border border-line/60 bg-slate/60 p-4 text-left transition hover:border-line/80 hover:bg-slate/80"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-2">
          <span className="block text-sm font-medium text-white">
            {noun} #{batch.batchId}
          </span>
          <ProtocolBadge protocol={batch.protocol} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={batch.status} contested={batch.isContested} />
          {batch.isLegacy && <LegacyBadge />}
        </div>
      </div>
      <div className="mt-3">
        <p className="text-[10px] uppercase tracking-[0.2em] text-white/40">
          Proof Systems
        </p>
        <div className="mt-2">
          <ProofBadgeGroup
            proofSystems={batch.proofSystems}
            teeVerifiers={batch.teeVerifiers}
          />
        </div>
      </div>
      <div className="mt-4 grid gap-2 text-xs text-white/70">
        <div className="flex items-center justify-between">
          <span className="text-white/50">Proposed</span>
          <span>{formatDateTime(batch.proposedAt)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-white/50">Proven</span>
          <span>{formatDateTime(batch.provenAt)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-white/50">Verified</span>
          <span>{formatDateTime(batch.verifiedAt)}</span>
        </div>
      </div>
    </button>
  );
}

export default function BatchesView({ range }: BatchesViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<BatchStatus | "all">("all");
  const [systems, setSystems] = useState<ProofSystem[]>([]);
  const [teeVerifiers, setTeeVerifiers] = useState<TeeVerifier[]>([]);
  const [search, setSearch] = useState("");
  const [proofType, setProofType] = useState<BatchProofType>(() =>
    parseProofType(searchParams.get("proofType"))
  );
  const [hasProof, setHasProof] = useState<boolean>(
    () => parseBoolean(searchParams.get("hasProof")) ?? false
  );
  const [dateField, setDateField] = useState<BatchDateField>(() =>
    parseDateField(searchParams.get("dateField"))
  );
  const [contested, setContested] = useState<boolean | undefined>(() => {
    const parsed = parseBoolean(searchParams.get("contested"));
    return parsed === false ? false : undefined;
  });
  const [selectedBatch, setSelectedBatch] = useState<SelectedBatch | null>(null);
  const isNonZkFilterActive = proofType === "non-zk" && hasProof;
  const rangeKey = `${range.start}:${range.end}`;
  const previousRange = useRef(rangeKey);

  const pageParam = Number(searchParams.get("page"));
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;

  const setPageInUrl = useCallback(
    (nextPage: number, mode: "push" | "replace" = "push") => {
      const normalized = Number.isFinite(nextPage) ? Math.max(1, Math.floor(nextPage)) : 1;
      const params = new URLSearchParams(searchParams.toString());
      if (normalized === 1) {
        params.delete("page");
      } else {
        params.set("page", String(normalized));
      }
      params.set("tab", "batches");
      const query = params.toString();
      const href = query ? `${pathname}?${query}` : pathname;
      if (mode === "replace") {
        router.replace(href, { scroll: false });
      } else {
        router.push(href, { scroll: false });
      }
    },
    [pathname, router, searchParams]
  );

  const clearNonZkFilter = () => {
    setProofType("all");
    setHasProof(false);
    setDateField("proposedAt");
    setContested(undefined);

    const params = new URLSearchParams(searchParams.toString());
    params.delete("proofType");
    params.delete("hasProof");
    params.delete("dateField");
    params.delete("contested");
    params.delete("snapshotDate");
    params.delete("page");
    params.set("tab", "batches");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  useEffect(() => {
    if (previousRange.current !== rangeKey) {
      previousRange.current = rangeKey;
      if (page !== 1) {
        setPageInUrl(1, "replace");
      }
    }
  }, [page, rangeKey, setPageInUrl]);

  const params = useMemo(
    () => ({
      ...range,
      status: status === "all" ? undefined : status,
      system: systems.length ? systems.join(",") : undefined,
      teeVerifier: teeVerifiers.length ? teeVerifiers.join(",") : undefined,
      search: search || undefined,
      page,
      pageSize: PAGE_SIZE,
      proofType: proofType === "all" ? undefined : proofType,
      hasProof: hasProof ? true : undefined,
      dateField: dateField === "proposedAt" ? undefined : dateField,
      contested: contested === false ? false : undefined
    }),
    [
      range,
      status,
      systems,
      teeVerifiers,
      search,
      page,
      proofType,
      hasProof,
      dateField,
      contested
    ]
  );

  const { data } = useSWR<BatchesResponse>(
    buildApiUrl("/batches", params),
    fetcher,
    { refreshInterval: 60000 }
  );

  const { data: detail } = useSWR<BatchDetailResponse>(
    selectedBatch
      ? buildApiUrl(
          `/batches/${selectedBatch.protocol.toLowerCase()}/${selectedBatch.batchId}`
        )
      : null,
    fetcher
  );

  const currentPage = data?.page ?? page;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  const toggleProofFilter = (filter: ProofFilterOption) => {
    if (filter.type === "system") {
      setSystems((prev) =>
        prev.includes(filter.value)
          ? prev.filter((item) => item !== filter.value)
          : [...prev, filter.value]
      );
    } else {
      setTeeVerifiers((prev) =>
        prev.includes(filter.value)
          ? prev.filter((item) => item !== filter.value)
          : [...prev, filter.value]
      );
    }
    if (page !== 1) {
      setPageInUrl(1, "replace");
    }
  };

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-display text-2xl text-white">Batches & Proposals</h2>
            <p className="mt-2 text-sm text-white/60">
              Archived Pacaya batches and live Shasta proposals across the selected range.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {statusFilters.map((filter) => (
              <button
                key={filter.value}
                className={clsx(
                  "rounded-full px-4 py-2 text-xs uppercase tracking-[0.2em] transition",
                  status === filter.value
                    ? "bg-accent text-ink"
                    : "bg-slate text-white/60"
                )}
                onClick={() => {
                  setStatus(filter.value);
                  if (page !== 1) {
                    setPageInUrl(1, "replace");
                  }
                }}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {isNonZkFilterActive && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line/60 bg-slate/60 px-4 py-3 text-sm text-white/70">
            <span>
              Showing <span className="text-accent">Not Proven By ZK</span> batches in
              the selected range.
            </span>
            <button
              type="button"
              className="rounded-full border border-line/70 px-3 py-1 text-xs uppercase tracking-[0.2em] text-white/60 hover:text-white"
              onClick={clearNonZkFilter}
            >
              Show all batches
            </button>
          </div>
        )}

        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex flex-wrap gap-2">
            {proofFilters.map((filter) => {
              const isActive =
                filter.type === "system"
                  ? systems.includes(filter.value)
                  : teeVerifiers.includes(filter.value);
              return (
                <button
                  key={`${filter.type}-${filter.value}`}
                  className={clsx(
                    "rounded-full border px-4 py-2 text-xs uppercase tracking-[0.2em] transition",
                    isActive
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-line/70 bg-slate text-white/60"
                  )}
                  onClick={() => toggleProofFilter(filter)}
                >
                  {filter.label}
                </button>
              );
            })}
          </div>
          <input
            type="text"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              if (page !== 1) {
                setPageInUrl(1, "replace");
              }
            }}
            placeholder="Search batch or proposal id"
            className="w-full rounded-full border border-line/70 bg-slate px-4 py-2 text-sm text-white/80 sm:ml-auto sm:min-w-[180px] sm:w-auto"
          />
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="space-y-3 lg:hidden">
          {data?.items?.map((batch) => (
            <BatchCard
              key={batch.recordKey}
              batch={batch}
              onSelect={setSelectedBatch}
            />
          ))}
        </div>

        <table className="hidden w-full text-left text-sm lg:table">
          <thead className="text-white/60">
            <tr>
              <th className="px-4 py-3">Record</th>
              <th className="px-4 py-3">Proof Systems</th>
              <th className="px-4 py-3">
                <div className="flex flex-col">
                  <span>Proposed</span>
                  <span className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                    UTC
                  </span>
                </div>
              </th>
              <th className="px-4 py-3">
                <div className="flex flex-col">
                  <span>Proven</span>
                  <span className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                    UTC
                  </span>
                </div>
              </th>
              <th className="px-4 py-3">
                <div className="flex flex-col">
                  <span>Verified</span>
                  <span className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                    UTC
                  </span>
                </div>
              </th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {data?.items?.map((batch) => (
              <tr
                key={batch.recordKey}
                className="border-t border-line/60 hover:bg-slate/60 cursor-pointer"
                onClick={() => setSelectedBatch(batch)}
              >
                <td className="px-4 py-3 font-medium text-white">
                  <div className="space-y-1">
                    <div>
                      {getRecordNoun(batch.protocol)} #{batch.batchId}
                    </div>
                    <ProtocolBadge protocol={batch.protocol} />
                  </div>
                </td>
                <td className="px-4 py-3">
                  <ProofBadgeGroup
                    proofSystems={batch.proofSystems}
                    teeVerifiers={batch.teeVerifiers}
                  />
                </td>
                <td className="px-4 py-3 text-white/70">
                  {formatDateTime(batch.proposedAt)}
                </td>
                <td className="px-4 py-3 text-white/70">
                  {formatDateTime(batch.provenAt)}
                </td>
                <td className="px-4 py-3 text-white/70">
                  {formatDateTime(batch.verifiedAt)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={batch.status} contested={batch.isContested} />
                    {batch.isLegacy && <LegacyBadge />}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {data && data.items.length === 0 && (
          <div className="px-4 py-10 text-center text-white/50">
            No batches or proposals found.
          </div>
        )}

        <div className="flex flex-col gap-3 border-t border-line/60 px-4 py-4 text-sm text-white/70 sm:flex-row sm:items-center sm:justify-between">
          <span>
            Page {currentPage} of {totalPages}
          </span>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <button
              className="flex-1 rounded-full border border-line/70 px-3 py-1 disabled:opacity-40 sm:flex-none"
              disabled={!data || currentPage === 1}
              onClick={() => setPageInUrl(currentPage - 1)}
            >
              Prev
            </button>
            <button
              className="flex-1 rounded-full border border-line/70 px-3 py-1 disabled:opacity-40 sm:flex-none"
              disabled={!data || currentPage >= totalPages}
              onClick={() => setPageInUrl(currentPage + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {selectedBatch && detail?.batch && (
        <BatchDrawer
          batch={detail.batch}
          onClose={() => setSelectedBatch(null)}
        />
      )}
    </div>
  );
}

function StatusBadge({ status, contested }: { status: BatchStatus; contested?: boolean }) {
  if (contested) {
    return (
      <span className="rounded-full border border-red-400/60 bg-red-500/10 px-3 py-1 text-xs text-red-200">
        Contested
      </span>
    );
  }

  const styles: Record<BatchStatus, string> = {
    proposed: "border-line/70 bg-slate text-white/60",
    proven: "border-accentSoft/50 bg-accent/10 text-accent",
    verified: "border-mint/50 bg-mint/10 text-mint"
  };

  return (
    <span className={`rounded-full border px-3 py-1 text-xs uppercase tracking-[0.2em] ${styles[status]}`}>
      {status}
    </span>
  );
}

function LegacyBadge() {
  return (
    <span
      title="Verified on-chain before our indexer start block; proposal/proof details were not ingested."
      className="rounded-full border border-amber-400/50 bg-amber-500/10 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-amber-200"
    >
      Legacy
    </span>
  );
}

function BatchDrawer({
  batch,
  onClose
}: {
  batch: BatchDetailResponse["batch"];
  onClose: () => void;
}) {
  const noun = getRecordNoun(batch.protocol);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60">
      <div className="h-full w-full max-w-lg overflow-y-auto bg-ink p-4 shadow-xl sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-2">
            <h3 className="font-display text-2xl text-white">
              {noun} #{batch.batchId}
            </h3>
            <ProtocolBadge protocol={batch.protocol} />
          </div>
          <button
            className="rounded-full border border-line/70 px-3 py-1 text-xs uppercase tracking-[0.2em] text-white/60"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {batch.isLegacy && (
          <div className="mt-4 rounded-2xl border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            Verified-only batch. Proposal and proof details predate the indexer start
            block and were not ingested.
          </div>
        )}

        <div className="mt-6 space-y-4 text-sm text-white/70">
          <DetailRow label="Protocol" value={protocolLabels[batch.protocol]} />
          <DetailRow label="Proposer" value={batch.proposer} mono />
          {batch.actualProver && (
            <DetailRow label="Actual Prover" value={batch.actualProver} mono />
          )}
          {batch.parentProposalHash && (
            <DetailRow label="Parent Proposal Hash" value={batch.parentProposalHash} mono />
          )}
          <DetailRow label="Status" value={batch.status} />
          <DetailRow
            label="Proof Systems"
            value={
              <ProofBadgeGroup
                proofSystems={batch.proofSystems}
                teeVerifiers={batch.teeVerifiers}
              />
            }
          />
          <DetailRow label="Proposed (UTC)" value={formatDateTime(batch.proposedAt)} />
          {batch.proposedTxHash && (
            <DetailRow
              label="Proposed Tx"
              value={batch.proposedTxHash}
              href={batch.proofLinks?.proposedTx}
              mono
            />
          )}
          <DetailRow label="Proven (UTC)" value={formatDateTime(batch.provenAt)} />
          <DetailRow label="Verified (UTC)" value={formatDateTime(batch.verifiedAt)} />
          {batch.verifiedTxHash && (
            <DetailRow
              label="Verified Tx"
              value={batch.verifiedTxHash}
              href={batch.proofLinks?.verifiedTx}
              mono
            />
          )}
          <DetailRow label="Transition Parent" value={batch.transitionParentHash ?? "—"} />
          <DetailRow label="Transition Block" value={batch.transitionBlockHash ?? "—"} />
          <DetailRow label="State Root" value={batch.transitionStateRoot ?? "—"} />
          {batch.proofTxHash && (
            <DetailRow
              label="Proof Tx"
              value={batch.proofTxHash}
              href={batch.proofLinks?.tx}
              mono
            />
          )}
          {batch.verifierAddress && (
            <DetailRow
              label="Verifier"
              value={batch.verifierAddress}
              href={batch.proofLinks?.verifier}
              mono
            />
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  href,
  mono
}: {
  label: string;
  value: ReactNode;
  href?: string;
  mono?: boolean;
}) {
  const valueClassName = clsx(mono && "break-all font-mono text-xs text-white/80");

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-[0.3em] text-white/40">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          className={clsx("text-accent hover:text-accentSoft", valueClassName)}
        >
          {value}
        </a>
      ) : (
        <span className={valueClassName}>{value}</span>
      )}
    </div>
  );
}
