import type { StatsMetadataResponse } from "@taikoproofs/shared";
import { formatDateTime } from "./format";

const DAY_MS = 86_400_000;

/** Days between the last indexed day and today before the dashboard is considered stale. */
export const STALE_AFTER_DAYS = 2;

/**
 * Explains why the dashboard may be showing old data, or returns null when indexing is healthy.
 * The date range picker anchors itself to the last indexed day, so without this notice a stalled
 * indexer silently keeps showing the last good week as if it were current.
 */
export function describeIndexerLag(
  metadata: StatsMetadataResponse | undefined,
  now: Date = new Date()
): string | null {
  if (!metadata) {
    return null;
  }

  const reasons: string[] = [];

  if (metadata.dataEnd) {
    const dataEnd = new Date(`${metadata.dataEnd}T00:00:00Z`);
    const lagDays = Math.floor((now.getTime() - dataEnd.getTime()) / DAY_MS);
    if (Number.isFinite(lagDays) && lagDays >= STALE_AFTER_DAYS) {
      reasons.push(`data stops at ${metadata.dataEnd} (${lagDays} days ago)`);
    }
  }

  const indexer = metadata.indexer;
  if (indexer?.lastRunStatus === "failed") {
    const finishedAt = indexer.lastRunFinishedAt
      ? ` at ${formatDateTime(indexer.lastRunFinishedAt)} UTC`
      : "";
    reasons.push(`the latest indexer run failed${finishedAt}`);
  }

  if (!reasons.length) {
    return null;
  }

  const sentence = reasons.join(" and ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
