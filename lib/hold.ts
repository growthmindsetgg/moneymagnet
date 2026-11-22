import { kvGet, kvSet } from "./kv";
import { STALE_MAX_MS } from "./stale";
import { scoreSnapshot } from "./scoring/engine";
import type { FactorResult, ScoreReport, SourceStatus, Tier, TokenSnapshot } from "./types";

/**
 * Tier hold: a factor that is null only because its source is down this run (and had a value in the
 * last complete run) must not move the tier across a band boundary. The page then shows the last
 * complete run's tier and score, marked "unchanged (source down)", until the factor returns.
 */

/** The last run in which no factor was missing because of an outage. */
export interface CompleteRun {
  tier: Tier;
  score: number | null;
  verdict: string;
  at: number;
  /** metric → value for every factor that had one. */
  values: Record<string, number | boolean>;
  /** metric → when that value was fetched (ms). A stale-filled value keeps its original fetch time. Absent in older records: `at`. */
  fetchedAt?: Record<string, number>;
}

export interface TierHold {
  /** What this run alone would show. */
  liveTier: Tier;
  liveScore: number | null;
  /** When the held tier was measured. */
  since: string;
  minutesAgo: number;
  /** Labels of the factors that are down. */
  factors: string[];
  /**
   * True when the shown tier is a re-score of this run with the down factors' last values (labelled
   * stale), not the previous run's tier: re-scored, the tier lands neither on this run's nor the previous one.
   */
  rescored?: boolean;
}

/** Null reasons that describe an outage, not the absence of data. */
const OUTAGE = /fail|timed? ?out|rate.?limit|\b429\b|\b5\d\d\b|unavailable|unreachable|not reachable|busy|outage/i;

const factorsOf = (r: ScoreReport) => r.groups.flatMap((g) => g.factors);

/** Factors with no value because a source is down this run (its reason names an outage, or every source that supplies it failed). */
export function outageNulls(r: ScoreReport): FactorResult[] {
  const failed = new Set(r.sourceStatus.filter((s) => s.state === "failed").map((s) => s.label));
  return factorsOf(r).filter(
    (f) => f.status === "null" && (OUTAGE.test(f.nullReason ?? "") || (f.dataSources.length > 0 && f.dataSources.every((s) => failed.has(s)))),
  );
}

/**
 * C6: stores live values stamped now and stale-filled values with their ORIGINAL fetch time
 * (now − stale age), so a later hold never re-uses a value older than the 6h stale limit.
 */
export function completeRunOf(r: ScoreReport, now: number): CompleteRun {
  const values: Record<string, number | boolean> = {};
  const fetchedAt: Record<string, number> = {};
  for (const f of factorsOf(r)) {
    if (f.value == null || (f.status !== "live" && f.status !== "stale")) continue;
    const staleMin = f.status === "stale" ? r.token.staleFields?.[f.metric] : 0;
    // A stale value whose age is not on the snapshot cannot be dated: not stored.
    if (staleMin == null) continue;
    values[f.metric] = f.value;
    fetchedAt[f.metric] = now - staleMin * 60_000;
  }
  return { tier: r.tier, score: r.score, verdict: r.verdict, at: now, values, fetchedAt };
}

/** The previous run's values still inside the 6h stale limit (by each value's own fetch time). */
export function usableValues(prev: CompleteRun, now: number): Record<string, { v: number | boolean; at: number }> {
  const out: Record<string, { v: number | boolean; at: number }> = {};
  for (const [m, v] of Object.entries(prev.values)) {
    const at = prev.fetchedAt?.[m] ?? prev.at;
    if (now - at <= STALE_MAX_MS && now >= at) out[m] = { v, at };
  }
  return out;
}

/**
 * Applies the hold. Returns the report unchanged when every factor is present, when nothing that is
 * down had a (still fresh) value last time, when the tier did not move, or when the missing factors are
 * not what moved it (re-scored with their last values, the tier would still be this run's).
 * M1: the previous tier is held only when the re-score lands exactly on it; otherwise the re-score is
 * shown, its refilled values labelled stale, and the hold marked `rescored`.
 */
export function applyHold(report: ScoreReport, snapshot: TokenSnapshot, sources: SourceStatus[], prev: CompleteRun | null, now: number): ScoreReport {
  if (!prev || now - prev.at > STALE_MAX_MS || now < prev.at) return report;
  const usable = usableValues(prev, now);
  if (!outageNulls(report).some((f) => usable[f.metric] != null)) return report;
  // Everything that had a value last time and is null now: the outage's own factors plus those derived
  // from them (bundlers flushed needs the launch price from the same OHLCV call).
  const down = factorsOf(report).filter((f) => f.status === "null" && usable[f.metric] != null);
  if (report.tier === prev.tier) return report;
  // U when ≥ 40% of the weight is missing because sources failed stays U (CLAUDE.md).
  if (report.tier === "U" && report.binding?.kind === "coverage") return report;
  const refilled = { ...snapshot, staleFields: { ...(snapshot.staleFields ?? {}) } } as TokenSnapshot;
  const r = refilled as unknown as Record<string, unknown>;
  for (const f of down) {
    r[f.metric] = usable[f.metric].v;
    // Refilled values are last-good values: labelled stale with their real age.
    refilled.staleFields[f.metric] = Math.round((now - usable[f.metric].at) / 60_000);
  }
  const rescored = scoreSnapshot(refilled, sources);
  if (rescored.tier === report.tier) return report;

  const minutesAgo = Math.round((now - prev.at) / 60_000);
  const labels = down.map((f) => f.label);
  const base: TierHold = { liveTier: report.tier, liveScore: report.score, since: new Date(prev.at).toISOString(), minutesAgo, factors: labels };
  if (rescored.tier === prev.tier) {
    return {
      ...report,
      tier: prev.tier,
      score: prev.score,
      verdict: prev.verdict,
      binding: { kind: "held", text: `unchanged (source down): ${labels.join(", ")} missing ⇒ ${prev.tier} from ${minutesAgo}m ago` },
      hold: base,
    };
  }
  // The re-score is a third tier: show it (with its stale-labelled values), not the old tier.
  return {
    ...report,
    tier: rescored.tier,
    score: rescored.score,
    rawScore: rescored.rawScore,
    coveragePct: rescored.coveragePct,
    verdict: rescored.verdict,
    tierReason: rescored.tierReason,
    penalties: rescored.penalties,
    bonuses: rescored.bonuses,
    gates: rescored.gates,
    rules: rescored.rules,
    requirements: rescored.requirements,
    groups: rescored.groups,
    token: { ...report.token, staleFields: refilled.staleFields },
    binding: { kind: "held", text: `re-scored (source down): ${labels.join(", ")} from last values (stale) ⇒ ${rescored.tier}; live ${report.tier}, ${minutesAgo}m ago ${prev.tier}` },
    hold: { ...base, rescored: true },
  };
}

const key = (chain: string, address: string) => `complete:v1:${chain}:${address.toLowerCase()}`;

/**
 * Loads the last complete run, applies the hold, and records this run when it is complete: no factor
 * that had a value last time is missing because of an outage (a source that never answered for a
 * factor does not keep a run from being complete).
 */
export async function holdTier(report: ScoreReport, snapshot: TokenSnapshot, sources: SourceStatus[], now = Date.now()): Promise<ScoreReport> {
  const k = key(report.chain, report.address);
  const prev = await kvGet<CompleteRun>(k);
  const fresh = prev && now - prev.at <= STALE_MAX_MS && now >= prev.at ? prev : null;
  const usable = fresh ? usableValues(fresh, now) : {};
  if (!outageNulls(report).some((f) => usable[f.metric] != null)) {
    await kvSet(k, completeRunOf(report, now), 24 * 60 * 60);
    return report;
  }
  return applyHold(report, snapshot, sources, fresh, now);
}
