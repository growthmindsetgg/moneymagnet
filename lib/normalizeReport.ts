import type { ScoreReport, TokenSnapshot } from "./types";

/** The answer is too broken to render at all (no tier). */
export class ReportShapeError extends Error {
  constructor(what: string) {
    super(`incomplete report: ${what}`);
    this.name = "ReportShapeError";
  }
}

const arr = <T,>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);
const obj = <T extends object>(v: T | undefined | null, d: T): T => (v && typeof v === "object" && !Array.isArray(v) ? v : d);

/**
 * §2b resilience: a report read back from JSON (the shared cache, an API answer) renders even when parts
 * are missing. Missing lists become empty and missing maps become {} — the page then shows "no data"
 * for them rather than crashing. Nothing is invented: no number, tier or state is filled in.
 */
export function normalizeReport(input: unknown): ScoreReport {
  const r = input as Partial<ScoreReport> | null;
  if (!r || typeof r !== "object") throw new ReportShapeError("not an object");
  if (typeof r.tier !== "string") throw new ReportShapeError("no tier");
  if (!r.token || typeof r.token !== "object") throw new ReportShapeError("no token snapshot");
  const t = r.token as Partial<TokenSnapshot>;
  const token = {
    ...t,
    staleFields: obj(t.staleFields, {}),
    nullReasons: obj(t.nullReasons, {}),
    provenance: obj(t.provenance, {}),
    holders: arr(t.holders),
    swapHolders: arr(t.swapHolders),
    liquidityHolders: arr(t.liquidityHolders),
    poolAddresses: arr(t.poolAddresses),
    zeroActivity: arr(t.zeroActivity),
    patterns: arr(t.patterns),
    fakeSignals: arr(t.fakeSignals),
    links: arr(t.links),
  } as TokenSnapshot;
  return {
    ...(r as ScoreReport),
    score: typeof r.score === "number" ? r.score : null,
    rawScore: typeof r.rawScore === "number" ? r.rawScore : 0,
    coveragePct: typeof r.coveragePct === "number" ? r.coveragePct : 0,
    verdict: r.verdict ?? "",
    tierReason: r.tierReason ?? "",
    modeLabel: r.modeLabel ?? "",
    rules: arr(r.rules),
    manualChecks: arr(r.manualChecks),
    penalties: arr(r.penalties),
    bonuses: arr(r.bonuses),
    gates: arr(r.gates),
    requirements: arr(r.requirements),
    groups: arr(r.groups).map((g) => ({ ...g, factors: arr(g?.factors) })),
    fakeSignals: arr(r.fakeSignals),
    sourceStatus: arr(r.sourceStatus),
    verification: r.verification && Array.isArray(r.verification.metrics) ? r.verification : { verified: 0, single: 0, disputed: 0, metrics: [] },
    generatedAt: typeof r.generatedAt === "string" ? r.generatedAt : "",
    token,
  };
}
