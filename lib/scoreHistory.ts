import type { Chain, PreviousTier, ScoreReport, Tier } from "./types";
import { kvGet, kvSet } from "./kv";

/** One scoring of a token, as appended to `score_history`. */
export interface ScoreEntry {
  at: string;
  tier: Tier;
  score: number | null;
  rawScore: number;
  coveragePct: number;
  mode: ScoreReport["mode"];
  /** What placed the tier (gate, cap, score bands, hysteresis…); hysteresis only follows a band-placed tier. */
  bindingKind?: string;
  /** Gates that failed. */
  firedGates: string[];
  /** Every fired rule (gates, caps, penalties, bonuses). */
  firedRules: string[];
  /** Factor id → points (null when the factor had no data). */
  factors: Record<string, number | null>;
  /** Social stage / size / quality at this scoring (information only; null when unmeasured). */
  social?: { stage: number | null; early: boolean; size: string | null; quality: number | null } | null;
}

export interface FactorMove {
  id: string;
  label: string;
  from: number | null;
  to: number | null;
}

export interface HistoryDiff {
  from: string;
  to: string;
  tier: { from: Tier; to: Tier } | null;
  score: { from: number | null; to: number | null } | null;
  factors: FactorMove[];
  rulesFired: string[];
  rulesCleared: string[];
}

export interface ScoreHistory {
  entries: ScoreEntry[];
  diff: HistoryDiff | null;
}

const MAX_ENTRIES = 200;
export const historyKey = (chain: Chain, address: string) => `score_history:v1:${chain}:${address}`;

export function entryOf(r: ScoreReport): ScoreEntry {
  return {
    at: r.generatedAt,
    tier: r.tier,
    score: r.score,
    rawScore: r.rawScore,
    coveragePct: r.coveragePct,
    mode: r.mode,
    ...(r.binding ? { bindingKind: r.binding.kind } : {}),
    firedGates: r.gates.filter((g) => g.state === "fail").map((g) => g.id),
    firedRules: r.rules.filter((x) => x.state === "fired").map((x) => x.id),
    factors: Object.fromEntries(r.groups.flatMap((g) => g.factors).map((f) => [f.id, f.applicable && !f.missing ? Math.round(f.points * 100) / 100 : null])),
    social: r.social ? { stage: r.social.stage?.stage ?? null, early: !!r.social.stage?.earlyRead, size: r.social.size, quality: r.social.quality.score } : null,
  };
}

/** What changed between two scorings: tier, score, factors whose points moved, rules fired/cleared. */
export function diffEntries(a: ScoreEntry, b: ScoreEntry, labels: Record<string, string> = {}): HistoryDiff {
  const ids = [...new Set([...Object.keys(a.factors), ...Object.keys(b.factors)])];
  const factors = ids
    .filter((id) => {
      const x = a.factors[id] ?? null;
      const y = b.factors[id] ?? null;
      return x === null || y === null ? x !== y : Math.abs(x - y) >= 0.01;
    })
    .map((id) => ({ id, label: labels[id] ?? id, from: a.factors[id] ?? null, to: b.factors[id] ?? null }));
  return {
    from: a.at,
    to: b.at,
    tier: a.tier !== b.tier ? { from: a.tier, to: b.tier } : null,
    score: a.score !== b.score ? { from: a.score, to: b.score } : null,
    factors,
    rulesFired: b.firedRules.filter((r) => !a.firedRules.includes(r)),
    rulesCleared: a.firedRules.filter((r) => !b.firedRules.includes(r)),
  };
}

/** The token's latest scoring, as hysteresis reads it (null when none). */
export async function previousTier(chain: Chain, address: string): Promise<PreviousTier | null> {
  const entries = await kvGet<ScoreEntry[]>(historyKey(chain, address));
  const last = entries?.at(-1);
  return last ? { tier: last.tier, at: last.at, mode: last.mode, bindingKind: last.bindingKind } : null;
}

/** Appends this scoring to the token's history and returns the history with the latest diff. */
export async function appendScore(r: ScoreReport): Promise<ScoreHistory> {
  const key = historyKey(r.chain, r.address);
  const prev = (await kvGet<ScoreEntry[]>(key)) ?? [];
  const entry = entryOf(r);
  const entries = [...prev.filter((e) => e.at !== entry.at), entry].slice(-MAX_ENTRIES);
  await kvSet(key, entries);
  const labels = Object.fromEntries(r.groups.flatMap((g) => g.factors).map((f) => [f.id, f.label]));
  return { entries, diff: entries.length >= 2 ? diffEntries(entries[entries.length - 2], entries[entries.length - 1], labels) : null };
}
