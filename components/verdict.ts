import factors from "@/lib/scoring/factors.json";
import type { FactorResult, RuleResult, ScoreReport } from "@/lib/types";
import { band, type CheckState, type Severity } from "./severity";
import { dedupeReasons, plainSentence } from "./present";

// Server-only (reads the scoring config): the "Verdict" view's derived pieces. Presentation only.

interface RuleDef {
  id: string;
  when?: Record<string, unknown>;
  passLabel?: string;
  gate?: boolean;
}
const RULES = new Map((factors.rules as RuleDef[]).map((r) => [r.id, r]));
const metricsOf = (id: string) => Object.keys(RULES.get(id)?.when ?? {});

/** A fired rule that takes something away: a gate, a cap, a forced tier or a penalty. */
const hurts = (r: RuleResult) => r.state === "fired" && (r.gate || !!r.capTier || !!r.forceF || !!r.forceU || r.points > 0);
/** A fired rule that binds the tier: a gate, a cap or a forced tier (red); penalties are orange. */
const binds = (r: RuleResult) => r.state === "fired" && (r.gate || !!r.capTier || !!r.forceF || !!r.forceU);

/** Metrics read by a fired gate / cap / penalty: factor rows on these metrics are red. */
export function hitMetrics(report: ScoreReport): Set<string> {
  return new Set(report.rules.filter(hurts).flatMap((r) => metricsOf(r.id)));
}

export interface Check {
  id: string;
  label: string;
  state: CheckState;
  evidence: string[];
}

const basicState = (b: NonNullable<FactorResult["basic"]>): CheckState => (b === "pass" ? "pass" : b === "fail" ? "fail" : "unknown");

/**
 * One pill per check: every gate, with the gate-only basic that reads the same metric merged into it
 * (Sellable, LP lock, owner, upgradeable, mint, freeze), then the basics no gate covers.
 * Fail if either says fail, else pass if either passes, else unknown; n/a only when nothing applies.
 */
export function mergedChecks(report: ScoreReport): Check[] {
  const basics = report.groups.flatMap((g) => g.factors).filter((f) => f.basic);
  const used = new Set<string>();
  const checks: Check[] = report.gates.map((g) => {
    const twins = basics.filter((b) => !used.has(b.id) && metricsOf(g.id).includes(b.metric));
    twins.forEach((b) => used.add(b.id));
    const states = [g.state as CheckState, ...twins.map((b) => basicState(b.basic!))].filter((s) => s !== "n/a");
    const state: CheckState = states.includes("fail") ? "fail" : states.includes("pass") ? "pass" : states.length ? "unknown" : "n/a";
    const passLabel = RULES.get(g.id)?.passLabel;
    const label = state === "pass" ? (passLabel ?? twins[0]?.label ?? g.label) : state === "fail" ? (g.state === "fail" ? g.label : (twins.find((b) => b.basic === "fail")?.label ?? g.label)) : (passLabel ?? g.label);
    return { id: g.id, label, state, evidence: [g.evidence, ...twins.map((b) => b.evidence)] };
  });
  for (const b of basics.filter((b) => !used.has(b.id))) checks.push({ id: b.id, label: b.label, state: basicState(b.basic!), evidence: [b.evidence] });
  // A label can still repeat (two rules phrasing the same check): keep one, worst state wins.
  const RANK: Record<CheckState, number> = { "n/a": 0, pass: 1, unknown: 2, fail: 3 };
  const byLabel = new Map<string, Check>();
  for (const c of checks) {
    const k = c.label.toLowerCase();
    const prev = byLabel.get(k);
    if (!prev || RANK[c.state] > RANK[prev.state]) byLabel.set(k, prev ? { ...c, evidence: [...prev.evidence, ...c.evidence] } : c);
  }
  return [...byLabel.values()];
}

export interface WhyLine {
  kind: "positive" | "holdback";
  sev: Severity;
  text: string;
}

const pointRows = (r: ScoreReport) => r.groups.flatMap((g) => g.factors).filter((f) => !f.basic && f.applicable && !f.missing && f.max > 0);

/**
 * "Why this tier": up to 3 positives (✓), then up to 2 things holding it back (▲) — red only for a fired
 * gate / cap, orange otherwise. One plain sentence each, no source names.
 */
export function whyLines(report: ScoreReport): WhyLine[] {
  const rows = pointRows(report);
  const positives = rows
    .filter((f) => band(f.points, f.max) === "good")
    .sort((a, b) => b.max - a.max || b.points / b.max - a.points / a.max)
    .map((f) => ({ kind: "positive" as const, sev: "good" as const, text: plainSentence(f.evidence, f.label) }));

  const fired = report.rules.filter((r) => r.state === "fired");
  const ruleLine = (r: RuleResult): WhyLine => {
    const name = r.label.split(" — ")[0];
    const what = r.forceF ? " forces F" : r.capTier ? ` caps the tier at ${r.capTier}` : r.points > 0 ? ` costs ${r.points} points` : "";
    // The evidence's first fact that is not just the rule's own name.
    const fact = plainSentence(r.evidence, r.label).replace(/\.$/, "");
    const bare = !fact || fact.toLowerCase().startsWith(r.label.toLowerCase());
    // Lower-case the first letter only for an ordinary word ("Every buyer…" → "every buyer…", not "vOL/MC").
    const lead = /^[A-Z][a-z]/.test(fact) ? fact.charAt(0).toLowerCase() + fact.slice(1) : fact;
    return { kind: "holdback", sev: binds(r) ? "bad" : "warn", text: bare ? `${name}${what}.` : `${name}${what}: ${lead}.` };
  };
  const weak = rows
    .filter((f) => band(f.points, f.max) !== "good")
    .sort((a, b) => b.max - b.points - (a.max - a.points))
    .map((f) => ({ kind: "holdback" as const, sev: "warn" as const, text: plainSentence(f.evidence, f.label) }));
  const holdbacks = [...fired.filter(binds).map(ruleLine), ...fired.filter((r) => hurts(r) && !binds(r)).map(ruleLine), ...weak];

  const pos = dedupeReasons(positives.filter((p) => p.text), 3);
  const back = dedupeReasons(holdbacks.filter((h) => h.text && !pos.some((p) => p.text === h.text)), 2);
  return [...pos, ...back];
}

/** "14/18 metrics cross-checked · 3 differ" — the verification summary in one line. */
export function verificationLine(report: ScoreReport): { crossChecked: number; total: number; differ: number } | null {
  const v = report.verification;
  if (!v || !v.metrics.length) return null;
  return { crossChecked: v.verified + v.disputed, total: v.metrics.length, differ: v.disputed };
}
