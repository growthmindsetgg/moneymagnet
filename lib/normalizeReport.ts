import type { ScoreReport, TokenSnapshot } from "./types";
import { formatStaleAge } from "./stale";

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
    // L1: a missing number stays missing (rendered "—"), never 0. ScoreReport types these as number
    // (lib/types.ts); readers of a normalized report must treat them as possibly null.
    rawScore: typeof r.rawScore === "number" ? r.rawScore : (null as unknown as number),
    coveragePct: typeof r.coveragePct === "number" ? r.coveragePct : (null as unknown as number),
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

/** Explicit cache marker carried in the JSON of every /api/analyze answer. */
export interface CacheMarker {
  /** True when this answer was served from the 2-minute result cache, not computed for this request. */
  cached: boolean;
  /** When the analysis ran (= report.generatedAt). */
  generatedAt: string;
  /** Seconds between the analysis and this answer (0 for a fresh run; null when generatedAt is unreadable). */
  ageSeconds: number | null;
}

/** "3h 20m" / "45m" / "2h" (formatStaleAge's output) back to minutes; null when it is not one. */
export function parseStaleAge(label: string): number | null {
  const m = /^(?:(\d+)h)?\s*(?:(\d+)m)?$/.exec(label.trim());
  if (!m || (m[1] == null && m[2] == null)) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

const STALE_NOTE = /\(stale, ([^)]+?) old\)/g;
const STALE_STATUS = /stale \(([^)]+?) old\)/g;

/**
 * A cached report re-served later: every stale age ("stale Xm") grows by the time since the analysis,
 * so it always means time since the value was fetched. Factor labels, evidence, the snapshot's
 * staleFields and source-status messages move together. A fresh report (age 0) is returned as is.
 */
export function ageCachedReport(report: ScoreReport, now: number = Date.now()): { report: ScoreReport; cache: CacheMarker } {
  const at = Date.parse(report.generatedAt);
  const ageSeconds = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : null;
  const cache: CacheMarker = { cached: true, generatedAt: report.generatedAt, ageSeconds };
  const add = ageSeconds == null ? 0 : Math.floor(ageSeconds / 60);
  if (!add) return { report, cache };
  const grow = (label: string) => {
    const m = parseStaleAge(label);
    return m == null ? label : formatStaleAge(m + add);
  };
  const staleFields = Object.fromEntries(Object.entries(report.token.staleFields ?? {}).map(([k, v]) => [k, v + add]));
  return {
    cache,
    report: {
      ...report,
      token: { ...report.token, staleFields },
      groups: report.groups.map((g) => ({
        ...g,
        factors: g.factors.map((f) =>
          f.status === "stale" && f.stale ? { ...f, stale: grow(f.stale), evidence: f.evidence.replace(STALE_NOTE, (_, l: string) => `(stale, ${grow(l)} old)`) } : f,
        ),
      })),
      sourceStatus: report.sourceStatus.map((x) => (x.state === "stale" && x.message ? { ...x, message: x.message.replace(STALE_STATUS, (_, l: string) => `stale (${grow(l)} old)`) } : x)),
    },
  };
}
