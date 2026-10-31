import type { FakeSignal, FlagLevel, GateResult, Provenance, RuleResult, SourceState, Tier } from "@/lib/types";

/**
 * Four display severities. Presentation only: read from a finished ScoreReport, never fed back into scoring.
 *   good: neon fill, ink text · ok: ink outline · warn: orange outline + orange text · bad: red fill
 *
 * For factors, colour means ONE thing — how good the factor is (`band`). Staleness and source
 * disagreements are shown as separate grey chips and never change a factor's colour.
 */
export type Severity = "good" | "ok" | "warn" | "bad";

const RANK: Record<Severity, number> = { good: 0, ok: 1, warn: 2, bad: 3 };
export const worst = (...s: (Severity | null | undefined)[]): Severity => s.reduce<Severity>((a, b) => (b && RANK[b] > RANK[a] ? b : a), "good");

/** Points / max → colour: ≥ 80% good, 40–80% ok, < 40% warn, 0 points bad. Null when there is nothing to rate. */
export function band(points: number, max: number): Severity | null {
  if (!(max > 0)) return null;
  if (points <= 0) return "bad";
  const p = points / max;
  return p >= 0.8 ? "good" : p >= 0.4 ? "ok" : "warn";
}

/** The fields of a factor row that its colour depends on. */
export interface Rated {
  id: string;
  metric: string;
  points: number;
  max: number;
  applicable: boolean;
  missing: boolean;
  basic?: string;
}

/**
 * A factor's colour: its band, or bad when a fired gate / cap / penalty reads its metric (`hitMetrics`).
 * Null (grey) for a row with no data, a row that does not apply, or a gate-only basic.
 */
export function factorSeverity(f: Rated, hitMetrics: ReadonlySet<string> = new Set()): Severity | null {
  if (f.basic || !f.applicable || f.missing) return null;
  if (hitMetrics.has(f.metric)) return "bad";
  return band(f.points, f.max);
}

/** A group's bar: the group's own percentage, same bands. */
export function groupSeverity(g: { points: number; max: number; hasData: boolean }): Severity | null {
  return g.hasData ? band(g.points, g.max) : null;
}

/** Widest disagreement between source readings, as the verifier measures it: |a − b| / max(|a|, |b|). */
export function spread(values: Provenance[]): number | null {
  const nums = values.map((v) => v.value).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length < 2) return null;
  const hi = Math.max(...nums);
  const lo = Math.min(...nums);
  const scale = Math.max(Math.abs(hi), Math.abs(lo));
  return scale > 0 ? (hi - lo) / scale : 0;
}

/** The "≠ sources differ" chip: grey, or orange when the conservative pick moved the factor's band. Never red. */
export type DisputeLook = "muted" | "warn";
export const disputeLook = (bandMoved: boolean): DisputeLook => (bandMoved ? "warn" : "muted");

/** Merged gate / basic check: pass neon, unknown orange "?", fail red; n/a is shown only in the research view. */
export type CheckState = "pass" | "fail" | "unknown" | "n/a";
export const CHECK_SEVERITY: Record<CheckState, Severity> = { pass: "good", fail: "bad", unknown: "warn", "n/a": "ok" };
export const GATE_SEVERITY: Record<GateResult["state"], Severity> = CHECK_SEVERITY;

/** Fired rules (research view): gates, caps, forced tiers and penalties are bad; bonuses good; a points-free warning warn. */
export function ruleSeverity(r: RuleResult): Severity {
  if (r.gate || r.forceF || r.forceU || r.capTier || r.points > 0) return "bad";
  if (r.points < 0) return "good";
  return r.flag === "danger" || r.flag === "rug" || r.flag === "bundle" ? "bad" : r.flag === "warn" ? "warn" : "ok";
}

export const FLAG_SEVERITY: Record<FlagLevel, Severity> = { none: "ok", info: "ok", warn: "warn", danger: "bad" };
export const fakeSignalSeverity = (s: FakeSignal): Severity => FLAG_SEVERITY[s.level];

export const SOURCE_SEVERITY: Record<SourceState, Severity> = { ok: "good", partial: "ok", skipped: "ok", stale: "warn", failed: "bad" };

/** CSS class per severity (app/globals.css). */
export const SEV: Record<Severity, string> = { good: "sev-good", ok: "sev-ok", warn: "sev-warn", bad: "sev-bad" };
export const SEV_FILL: Record<Severity, string> = { good: "sev-fill-good", ok: "sev-fill-ok", warn: "sev-fill-warn", bad: "sev-fill-bad" };

/** Tier letters: S/A neon block, B ink block, C ink outline, D orange block, F red block, U grey dashed. */
export const TIER_LOOK: Record<Tier, string> = {
  S: "sev-good",
  A: "sev-good",
  B: "sev-ink",
  C: "sev-ok",
  D: "sev-orange",
  F: "sev-bad",
  U: "sev-unrated",
};
