import type { FactorResult, RuleResult, ScoreReport, Tier } from "@/lib/types";
import { band } from "./severity";
import { mergedChecks } from "./verdict";
import { tierMovingDisputes } from "./disputeImpact";

// Presentation only: the PROS / CONS box under "Why this tier", derived deterministically from a
// finished ScoreReport (no LLM, no clock, no randomness). Same report ⇒ same words, same order.

export interface ProCon {
  text: string;
  /** Pros are always "good"; a con is "bad" (red) only for a gate or cap, else "warn" (orange). */
  sev: "good" | "warn" | "bad";
  /** What produced the bullet (tests and data attributes). */
  from: "factor" | "check" | "rule" | "coverage" | "dispute" | "requirement" | "missing";
}

export const MAX_WORDS = 12;
const MIN = 2;
const MAX = 4;

/** At most `max` words; a clipped bullet ends with "…" attached to its last word. */
export function clipWords(text: string, max = MAX_WORDS): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= max) return words.join(" ");
  return `${words.slice(0, max).join(" ").replace(/[.,;:—–-]+$/, "")}…`;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const pointRows = (r: ScoreReport) => r.groups.flatMap((g) => g.factors).filter((f) => !f.basic && f.applicable && !f.missing && f.max > 0);
const ratio = (f: FactorResult) => f.points / f.max;
const factorText = (f: FactorResult) => `${f.label}: ${f.display}`;
const ruleName = (r: RuleResult) => r.label.split(" — ")[0];
const binds = (r: RuleResult) => r.state === "fired" && (r.gate || !!r.capTier || !!r.forceF || !!r.forceU);
/** A fired rule flagged "danger" (e.g. founder started selling) is a red con even without a cap. */
const red = (r: RuleResult) => r.state === "fired" && r.flag === "danger";
const TIER_RANK: Record<Tier, number> = { S: 6, A: 5, B: 4, C: 3, D: 2, F: 1, U: 0 };

function uniq(items: ProCon[]): ProCon[] {
  const seen = new Set<string>();
  return items.filter((p) => {
    const k = p.text.toLowerCase();
    if (!p.text || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function prosCons(report: ScoreReport): { pros: ProCon[]; cons: ProCon[] } {
  const rows = pointRows(report);

  // PROS: the top-scoring factors (most points first), then passed checks when fewer than two scored well.
  const strong = rows
    .filter((f) => band(f.points, f.max) === "good")
    .sort((a, b) => b.points - a.points || ratio(b) - ratio(a) || byId(a, b))
    .map((f): ProCon => ({ text: clipWords(factorText(f)), sev: "good", from: "factor" }));
  const fair = rows
    .filter((f) => band(f.points, f.max) === "ok")
    .sort((a, b) => ratio(b) - ratio(a) || b.points - a.points || byId(a, b))
    .map((f): ProCon => ({ text: clipWords(factorText(f)), sev: "good", from: "factor" }));
  const passed = mergedChecks(report)
    .filter((c) => c.state === "pass")
    .map((c): ProCon => ({ text: clipWords(`Passes: ${c.label}`), sev: "good", from: "check" }));
  let pros = uniq(strong).slice(0, MAX);
  if (pros.length < MIN) pros = uniq([...pros, ...fair]).slice(0, MIN);
  if (pros.length < MIN) pros = uniq([...pros, ...passed]).slice(0, MIN);

  // CONS: what binds (gates, caps, forced tiers, coverage), then penalties, disputes that move the tier,
  // then the lowest-scoring factors.
  const fired = report.rules.filter((r) => r.state === "fired");
  const binding = fired.filter((r) => binds(r) || red(r)).map((r): ProCon => {
    const what = r.forceF ? "forces F" : r.forceU ? "leaves it unrated" : r.capTier ? `caps at ${r.capTier}` : r.gate ? "gate failed" : "— red flag";
    return { text: clipWords(`${ruleName(r)} ${what}`), sev: "bad", from: "rule" };
  });
  const coverage: ProCon[] =
    report.binding?.kind === "coverage" ? [{ text: clipWords(`Only ${report.coveragePct}% of factor weight has data`), sev: "bad", from: "coverage" }] : [];
  const penalties = fired
    .filter((r) => !binds(r) && !red(r) && r.points > 0)
    .map((r): ProCon => ({ text: clipWords(`${ruleName(r)}: −${r.points} points`), sev: "warn", from: "rule" }));
  const disputes = safeTierDisputes(report).map((label): ProCon => ({ text: clipWords(`Sources disagree on ${label.toLowerCase()}; it changes the tier`), sev: "warn", from: "dispute" }));
  const weak = rows
    .filter((f) => band(f.points, f.max) === "warn" || band(f.points, f.max) === "bad")
    .sort((a, b) => b.max - b.points - (a.max - a.points) || ratio(a) - ratio(b) || byId(a, b))
    .map((f): ProCon => ({ text: clipWords(factorText(f)), sev: "warn", from: "factor" }));
  let cons = uniq([...binding, ...coverage, ...penalties, ...disputes, ...weak]).slice(0, MAX);
  if (cons.length < MIN) {
    const unmet = report.requirements
      .filter((r) => r.state !== "pass" && TIER_RANK[r.tier] > TIER_RANK[report.tier])
      .map((r): ProCon => ({ text: clipWords(`${r.tier} needs ${r.label}`), sev: "warn", from: "requirement" }));
    cons = uniq([...cons, ...unmet]).slice(0, MIN);
  }
  if (cons.length < MIN) {
    const missing = report.groups
      .flatMap((g) => g.factors)
      .filter((f) => f.applicable && f.missing && f.max > 0)
      .sort((a, b) => b.max - a.max || byId(a, b))
      .map((f): ProCon => ({ text: clipWords(`No data: ${f.label}`), sev: "warn", from: "missing" }));
    cons = uniq([...cons, ...missing]).slice(0, MIN);
  }
  return { pros, cons };
}

function safeTierDisputes(report: ScoreReport): string[] {
  try {
    return tierMovingDisputes(report);
  } catch {
    // Display-only re-scoring: if it cannot run, no dispute bullet.
    return [];
  }
}
