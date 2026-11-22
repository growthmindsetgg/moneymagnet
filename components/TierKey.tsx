import { defaultConfig } from "@/lib/scoring/config";
import type { Tier } from "@/lib/types";
import { TierChip } from "./TierChip";

// A first-time reader's key: what each tier means and how to read a factor line. Server-only — the bands
// and coverage limits are read from lib/scoring/factors.json (via loadConfig), never restated here.
const MEANING: Record<Tier, string> = {
  S: "strong on almost every factor",
  A: "strong, with a few weak spots",
  B: "mixed — worth a closer look",
  C: "more weak factors than strong ones",
  D: "mostly weak factors",
  F: "weak, or a safety gate failed",
  U: "unrated — too little live data to score",
};

export default function TierKey({ evidence = false, testId = "tier-key" }: { evidence?: boolean; testId?: string }) {
  const { tiers, coverage } = defaultConfig;
  const bands = [...tiers].sort((a, b) => b.min - a.min);
  // Score bands, highest first: "≥ 85" … and the bottom band as "< 25".
  return (
    <details className="mm-box p-4 text-xs" data-testid={testId}>
      <summary className="cursor-pointer text-sm font-bold">
        <span className="mm-plus" aria-hidden="true" /> {evidence ? "How to read this page" : "What do the tiers mean?"}
      </summary>
      <ul className="mt-3 space-y-1.5" aria-label="Tiers">
        {bands.map((b, i) => (
          <li key={b.tier} className="flex items-start gap-2">
            <TierChip tier={b.tier} />
            <span className="w-[4.5ch] shrink-0 font-mono font-bold leading-6 tabular-nums">{b.min > 0 ? `≥ ${b.min}` : `< ${bands[i - 1]?.min ?? 0}`}</span>
            <span className="min-w-0 leading-6">{MEANING[b.tier]}</span>
          </li>
        ))}
        <li className="flex items-start gap-2">
          <TierChip tier="U" />
          <span className="w-[4.5ch] shrink-0" aria-hidden="true" />
          <span className="min-w-0 leading-6">
            {MEANING.U} (under {coverage.unratedBelowPct}% of the factor weight had data, or the token is minutes old)
          </span>
        </li>
      </ul>
      <p className="mt-3 break-words">
        The score (0–100) sets the band. Gates and caps can lower the tier below it — a token that cannot be sold is F at any score — and the &ldquo;Why this tier&rdquo; line names the one that applied. S and A also need
        data for at least {coverage.topTierMinPct}% of the weight; under {coverage.capBBelowPct}% the tier is capped at B. Age never costs points.
      </p>
      {evidence && (
        <ul className="mt-3 list-disc space-y-1 pl-5 break-words">
          <li>
            Each factor line reads: colour dot · name · measured value · points earned / points possible. Open a line for the evidence sentence and its sources.
          </li>
          <li>
            <span className="font-bold">no data — reason</span>: no reading this run, with the exact reason. The factor is usually left out of the score and lowers coverage instead.
          </li>
          <li>
            <span className="font-bold">stale Xm</span>: taken from the last good snapshot, X minutes old (never older than 6h), because the live call failed.
          </li>
          <li>
            <span className="font-bold">≠</span>: sources disagree; the most conservative reading is the one scored. Research view shows every reading.
          </li>
          <li>The Sources list at the bottom shows which data sources answered this run, and why any failed.</li>
        </ul>
      )}
    </details>
  );
}
