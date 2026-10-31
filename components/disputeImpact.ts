import { scoreSnapshot } from "@/lib/scoring/engine";
import { deriveMetrics } from "@/lib/snapshot";
import type { FactorResult, MetricVerification, ScoreReport, TokenSnapshot } from "@/lib/types";
import { band } from "./severity";

/**
 * Metrics derived once from a verified input. When an input takes another source's value they are
 * cleared, so deriveMetrics recomputes them from that value.
 */
const DEPENDENTS: Record<string, (keyof TokenSnapshot)[]> = {
  fdvUsd: ["liqFdvPct", "volMcRatio", "volMcBar", "volMcVsBar"],
  liquidityUsd: ["liqFdvPct", "mainPoolSharePct", "volLiqRatio"],
  mainPoolLiquidityUsd: ["mainPoolSharePct"],
  volume24hUsd: ["volLiqRatio", "volMcRatio", "volMcBar", "volMcVsBar", "honeypotPattern"],
  buyers24h: ["buyerSellerRatio"],
  sellers24h: ["buyerSellerRatio"],
  sellable: ["honeypot"],
  honeypot: ["sellable"],
  ageHours: ["ageMinutes", "volMcBar", "volMcVsBar"],
};

const factorsOf = (r: ScoreReport) => new Map(r.groups.flatMap((g) => g.factors).map((f) => [f.id, f] as const));
const bandOf = (f: FactorResult | undefined) => (f && f.applicable && !f.missing ? band(f.points, f.max) : null);

/**
 * Display only: the factor rows whose source disagreement matters — scoring the same snapshot with
 * another source's reading of that row's metric puts the row in a different colour band. Composite flags
 * that cannot be re-derived from the snapshot keep their measured values.
 */
export function bandMovingDisputes(report: ScoreReport): Set<string> {
  const out = new Set<string>();
  const disputed = report.verification?.metrics.filter((m) => m.status === "disputed") ?? [];
  if (!disputed.length || report.eligibility?.meme === false) return out;
  const current = factorsOf(report);
  // Only judge when re-scoring the unchanged snapshot reproduces the report's own rows.
  const base = factorsOf(scoreSnapshot(deriveMetrics({ ...report.token }), report.sourceStatus));
  for (const [id, f] of current) if (bandOf(base.get(id)) !== bandOf(f)) return out;
  for (const m of disputed) {
    const rows = [...current.values()].filter((f) => f.metric === m.metric && f.verification?.status === "disputed");
    if (!rows.length) continue;
    for (const alt of alternatives(report, m)) {
      const moved = factorsOf(alt);
      for (const f of rows) if (bandOf(moved.get(f.id)) !== bandOf(f)) out.add(f.id);
    }
  }
  return out;
}

/**
 * Display only: labels of disputed metrics where scoring another source's reading gives a different tier.
 * Same guard as above: judged only when re-scoring the unchanged snapshot reproduces the report's tier.
 */
export function tierMovingDisputes(report: ScoreReport): string[] {
  const disputed = report.verification?.metrics.filter((m) => m.status === "disputed") ?? [];
  if (!disputed.length || report.eligibility?.meme === false || report.hold) return [];
  if (scoreSnapshot(deriveMetrics({ ...report.token }), report.sourceStatus).tier !== report.tier) return [];
  return disputed
    .filter((m) => alternatives(report, m).some((alt) => alt.tier !== report.tier))
    .map((m) => m.label)
    .sort();
}

function alternatives(report: ScoreReport, m: MetricVerification): ScoreReport[] {
  const key = m.metric as keyof TokenSnapshot;
  if (!(key in report.token)) return [];
  return m.values
    .filter((v) => v.source !== m.chosenSource && v.value !== null && v.value !== m.chosen)
    .map((v) => {
      const s: TokenSnapshot = { ...report.token, [key]: v.value };
      for (const d of DEPENDENTS[m.metric] ?? []) (s as unknown as Record<string, unknown>)[d] = null;
      if (key === "sellable" && typeof v.value === "boolean" && s.liquidityPulled !== true) s.honeypot = !v.value;
      if (key === "honeypot" && typeof v.value === "boolean") s.sellable = !v.value;
      return scoreSnapshot(deriveMetrics(s), report.sourceStatus);
    });
}
