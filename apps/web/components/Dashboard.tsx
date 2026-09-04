"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { subDays } from "date-fns";
import useSWR from "swr";
import RangePicker, { RangePreset, resolveRange } from "./RangePicker";
import StatsView from "./StatsView";
import BatchesView from "./BatchesView";
import clsx from "clsx";
import { StatsMetadataResponse } from "@taikoproofs/shared";
import { buildApiUrl, fetcher } from "../lib/api";
import { formatUtcDateTime } from "../lib/date";
import { formatDate } from "../lib/format";
import { describeIndexerLag } from "../lib/indexer";

const tabs = [
  { id: "stats", label: "Stats" },
  { id: "batches", label: "Batches" }
] as const;

type TabId = (typeof tabs)[number]["id"];

export default function Dashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTab: TabId = searchParams.get("tab") === "batches" ? "batches" : "stats";
  const [preset, setPreset] = useState<RangePreset>("7");
  const [customStart, setCustomStart] = useState(
    formatUtcDateTime(subDays(new Date(), 7))
  );
  const [customEnd, setCustomEnd] = useState(formatUtcDateTime(new Date()));
  const { data: statsMetadata } = useSWR<StatsMetadataResponse>(
    buildApiUrl("/stats/metadata"),
    fetcher
  );
  const dataStartLabel = statsMetadata?.dataStart
    ? formatDate(statsMetadata.dataStart)
    : null;
  const dataEndLabel = statsMetadata?.dataEnd ? formatDate(statsMetadata.dataEnd) : null;

  const anchorDate = useMemo(() => {
    if (!statsMetadata?.dataEnd) {
      return undefined;
    }
    const parsed = new Date(`${statsMetadata.dataEnd}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }, [statsMetadata?.dataEnd]);

  const indexerNotice = useMemo(() => describeIndexerLag(statsMetadata), [statsMetadata]);

  const range = useMemo(
    () => resolveRange(preset, customStart, customEnd, anchorDate),
    [preset, customStart, customEnd, anchorDate]
  );

  const setActiveTab = (nextTab: TabId) => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextTab === "batches") {
      params.set("tab", "batches");
    } else {
      params.delete("tab");
      params.delete("page");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <div className="min-h-screen px-6 pb-16 pt-10 lg:px-14">
      <header className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div>
              <span className="chip">TaikoProofs</span>
              <h1 className="mt-4 font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl lg:text-5xl">
                Proof coverage for Taiko Alethia, made simple.
              </h1>
              <p className="mt-3 max-w-2xl text-sm text-white/70 sm:text-base">
                Daily stats, latency and batch details.
              </p>
            </div>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <span className="label">Range</span>
                {dataEndLabel && (
                  <span className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                    Indexed through {dataEndLabel}
                  </span>
                )}
                {dataStartLabel && (
                  <span className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                    Data available since {dataStartLabel}
                  </span>
                )}
              </div>
              <RangePicker
                preset={preset}
                customStart={customStart}
                customEnd={customEnd}
                onPresetChange={setPreset}
                onCustomStartChange={setCustomStart}
                onCustomEndChange={setCustomEnd}
              />
            </div>
          </div>

          {indexerNotice && (
            <div
              role="status"
              className="rounded-2xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-white/80"
            >
              <span className="mr-2 font-medium uppercase tracking-[0.2em] text-accent">
                Indexer behind
              </span>
              {indexerNotice}
            </div>
          )}

          <div className="flex w-full flex-wrap items-center gap-3 rounded-full border border-line/70 bg-slate px-2 py-2 sm:w-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={clsx(
                  "flex-1 rounded-full px-4 py-2 text-[11px] uppercase tracking-[0.2em] transition sm:flex-none sm:px-6 sm:text-xs sm:tracking-[0.25em]",
                  activeTab === tab.id
                    ? "bg-accent text-ink"
                    : "text-white/60 hover:text-white"
                )}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto mt-10 max-w-6xl">
        {activeTab === "stats" ? (
          <StatsView range={range} />
        ) : (
          <BatchesView range={range} />
        )}
      </main>
    </div>
  );
}
