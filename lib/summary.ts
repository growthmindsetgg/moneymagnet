import type { ScoreReport, Tier } from "./types";
import { defaultConfig, type MetricCondition, type ScoringConfig } from "./scoring/config";
import { matchMetrics } from "./scoring/conditions";
import { fill, metricFormats } from "./scoring/engine";

/** The compact answer: tier, conviction vs churn, and at most five short reasons with evidence. */
export interface TierSummary {
  chain: ScoreReport["chain"];
  address: string;
  name: string | null;
  symbol: string | null;
  meme: boolean;
  /** Set when the token is refused (not a meme). */
  notMemeReason: string | null;
  /** The refusal shown instead of a tier, e.g. "stock token — HoodTier scores memecoins only". */
  rejected: string | null;
  tier: Tier | null;
  score: number | null;
  rawScore: number;
  /** Tier held from the last complete run because a source is down (live tier and score inside). */
  held: ({ text: string } & import("./hold").TierHold) | null;
  coveragePct: number;
  mode: ScoreReport["mode"];
  verdict: string;
  conviction: { label: "conviction" | "churn" | "mixed" | "unknown"; conviction: string[]; churn: string[]; evaluated: number };
  reasons: { kind: "risk" | "positive" | "info"; text: string }[];
  sources: { id: string; state: string; note?: string }[];
  /** Sources that hit a rate limit this run (their data may be missing or stale). */
  rateLimited: string[];
  generatedAt: string;
  url: string;
}

interface SignalDef {
  id: string;
  side: "conviction" | "churn";
  when: MetricCondition;
  text: string;
}
interface SummaryConfig {
  minSignals: number;
  leanBy: number;
  signals: SignalDef[];
}

const MAX_REASONS = 5;

export function convictionOf(r: ScoreReport, cfg: ScoringConfig = defaultConfig): TierSummary["conviction"] {
  const sc = cfg.summary as SummaryConfig;
  const formats = metricFormats(cfg);
  const conviction: string[] = [];
  const churn: string[] = [];
  let evaluated = 0;
  for (const sig of sc.signals) {
    const res = matchMetrics(r.token, sig.when);
    if (res === "unknown") continue;
    evaluated++;
    if (res === "pass") (sig.side === "conviction" ? conviction : churn).push(fill(sig.text, r.token, formats));
  }
  const label = evaluated < sc.minSignals ? "unknown" : conviction.length - churn.length >= sc.leanBy ? "conviction" : churn.length - conviction.length >= sc.leanBy ? "churn" : "mixed";
  return { label, conviction, churn, evaluated };
}

const RATE = /\b429\b|rate.?limit/i;

/** Builds the compact summary. Every reason is taken from the report's own evidence — nothing new is claimed. */
export function summarize(r: ScoreReport, baseUrl = "", maxReasons = MAX_REASONS): TierSummary {
  const t = r.token;
  const meme = r.eligibility?.meme !== false;
  const conviction = convictionOf(r);
  const reasons: TierSummary["reasons"] = [];
  const push = (kind: TierSummary["reasons"][number]["kind"], text: string) => {
    if (reasons.length < maxReasons && !reasons.some((x) => x.text === text)) reasons.push({ kind, text });
  };
  if (!meme) {
    push("info", `Not rated: ${r.eligibility!.rejected ?? "not a memecoin"} (${r.eligibility!.reason}).`);
  } else {
    const fired = r.rules.filter((x) => x.state === "fired");
    for (const x of fired.filter((x) => x.forceF)) push("risk", `${x.label} — ${x.evidence}`);
    if (r.tier === "U") push("info", r.tierReason);
    for (const x of fired.filter((x) => x.capTier && !x.forceF)) push("risk", `${x.label} (caps at ${x.capTier}) — ${x.evidence}`);
    // Conviction vs churn, leading with the side that decides the label.
    const first = conviction.label === "churn" ? conviction.churn : conviction.conviction;
    const second = conviction.label === "churn" ? conviction.conviction : conviction.churn;
    for (const s of first.slice(0, 2)) push(conviction.label === "churn" ? "risk" : "positive", s);
    for (const x of fired.filter((x) => !x.capTier && !x.forceF && x.points > 0)) push("risk", `${x.label} (−${x.points}) — ${x.evidence}`);
    const factors = r.groups.flatMap((g) => g.factors).filter((f) => f.applicable && !f.missing);
    for (const f of factors.filter((f) => f.flag === "danger")) push("risk", f.evidence);
    for (const s of second.slice(0, 1)) push(conviction.label === "churn" ? "positive" : "risk", s);
    for (const f of factors.filter((f) => f.points >= f.max && f.max >= 4).sort((a, b) => b.max - a.max)) push("positive", f.evidence);
  }
  return {
    chain: r.chain,
    address: r.address,
    name: t.name,
    symbol: t.symbol,
    meme,
    notMemeReason: meme ? null : (r.eligibility?.reason ?? null),
    rejected: meme ? null : (r.eligibility?.rejected ?? null),
    tier: meme ? r.tier : null,
    score: meme ? r.score : null,
    rawScore: r.rawScore,
    held: r.hold ? { text: r.hold.rescored ? "re-scored with last values (source down)" : "unchanged (source down)", ...r.hold } : null,
    coveragePct: r.coveragePct,
    mode: r.mode,
    verdict: meme ? r.verdict : "Not a meme — not rated.",
    conviction,
    reasons,
    sources: r.sourceStatus.map((s) => ({ id: s.id, state: s.state, ...(s.state !== "ok" && s.message ? { note: s.message.slice(0, 140) } : {}) })),
    rateLimited: r.sourceStatus.filter((s) => RATE.test(s.message ?? "")).map((s) => s.id),
    generatedAt: r.generatedAt,
    url: `${baseUrl}/t/${r.chain}/${r.address}`,
  };
}
