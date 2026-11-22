import { kvGet, kvSet } from "./kv";

export interface LiqPoint {
  t: number;
  liq: number;
  /** Market cap (FDV) at the same moment, when known. */
  mcap?: number | null;
}

const DAY = 24 * 60 * 60 * 1000;
const MAX_POINTS = 1500;
/** Observations closer together than this replace the latest point instead of appending. */
const MIN_SPACING_MS = 60_000;

export const historyKey = (chain: string, address: string) => `liq:${chain}:${address.toLowerCase()}`;

export function addPoint(points: LiqPoint[], p: LiqPoint): LiqPoint[] {
  const out = points.filter((x) => p.t - x.t <= 30 * DAY);
  const last = out[out.length - 1];
  if (last && p.t - last.t < MIN_SPACING_MS) out[out.length - 1] = p;
  else out.push(p);
  return out.slice(-MAX_POINTS);
}

export interface LiqChange {
  pct: number;
  window: string;
}

function hoursLabel(ms: number): string {
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : `${h.toFixed(h < 10 ? 1 : 0)}h`;
}

/**
 * Change of the latest observation vs the newest point at least `windowMs` old — provided that point is no older
 * than 1.5× the window. A point far older than the window (a gap in the history, e.g. one observation 8 days ago
 * and the rest from today) does not measure the window: before this rule the 24h change was read against that
 * 8-day-old point and printed the same number as the 7d change.
 *
 * Without such a point the change is measured against the oldest observation inside the window, labelled with
 * how much history it covers — only when that covers at least half of the window (or half of the token's whole
 * life, for a token younger than the window), and never when `requireFull` is set (the 7d change: a 21h history
 * is not "7d"). Anything else is null, with the reason naming the history that exists.
 */
export function liquidityChange(points: LiqPoint[], windowMs: number, label: string, ageMs: number | null = null, opts: { requireFull?: boolean } = {}): LiqChange | null {
  return liquidityChangeWhy(points, windowMs, label, ageMs, opts).change;
}

/** How far past the window the reference point may lie and still stand for it. */
export const WINDOW_SLACK = 1.5;

export function liquidityChangeWhy(
  points: LiqPoint[],
  windowMs: number,
  label: string,
  ageMs: number | null = null,
  opts: { requireFull?: boolean } = {},
): { change: LiqChange | null; reason: string | null } {
  if (points.length < 2) return { change: null, reason: "first liquidity observation — the change appears from the next analysis" };
  const cur = points[points.length - 1];
  const older = points.slice(0, -1);
  const maxAge = windowMs * WINDOW_SLACK;
  const full = [...older].reverse().find((p) => cur.t - p.t >= windowMs);
  const noPositive = { change: null, reason: "no earlier positive liquidity observation" };
  if (full && cur.t - full.t <= maxAge) {
    if (full.liq <= 0) return noPositive;
    return { change: { pct: ((cur.liq - full.liq) / full.liq) * 100, window: label }, reason: null };
  }
  const gap = full ? `no liquidity observation between ${label} and ${hoursLabel(maxAge)} ago — the nearest older one is ${hoursLabel(cur.t - full.t)} old (a gap in the history)` : null;
  const inside = older.filter((p) => cur.t - p.t < windowMs);
  const ref = inside[0];
  const span = ref ? cur.t - ref.t : 0;
  const need = Math.min(windowMs, ageMs != null && ageMs > 0 ? ageMs : windowMs) * 0.5;
  if (opts.requireFull) {
    if (gap) return { change: null, reason: gap };
    if (span < need) return { change: null, reason: `only ${hoursLabel(span)} of liquidity history — a ${label} change needs ≥ ${hoursLabel(need)}` };
    return { change: null, reason: `history covers only ${hoursLabel(span)} — a ${label} change needs a full ${label} of liquidity history` };
  }
  if (!ref) return { change: null, reason: gap ?? "no earlier liquidity observation" };
  if (span < need) {
    const short = `only ${hoursLabel(span)} of liquidity history — a ${label} change needs ≥ ${hoursLabel(need)}`;
    return { change: null, reason: gap ? `${gap}; ${short}` : short };
  }
  if (ref.liq <= 0) return noPositive;
  return { change: { pct: ((cur.liq - ref.liq) / ref.liq) * 100, window: `${hoursLabel(span)} of history` }, reason: null };
}

export async function recordLiquidity(chain: string, address: string, liq: number, now = Date.now(), mcap: number | null = null): Promise<LiqPoint[]> {
  const key = historyKey(chain, address);
  const points = addPoint((await kvGet<LiqPoint[]>(key)) ?? [], mcap != null ? { t: now, liq, mcap } : { t: now, liq });
  await kvSet(key, points, 31 * 24 * 60 * 60);
  return points;
}

export function historyMetrics(points: LiqPoint[], ageHours: number | null = null) {
  const ageMs = ageHours != null ? ageHours * 3_600_000 : null;
  const d1 = liquidityChangeWhy(points, DAY, "24h", ageMs);
  // 7d needs a real 7-day-old observation: a shorter history would only repeat the 24h change under a 7d label.
  const d7 = liquidityChangeWhy(points, 7 * DAY, "7d", ageMs, { requireFull: true });
  const nullReasons: Record<string, string> = {};
  if (d1.reason) nullReasons.liqChange24hPct = d1.reason;
  if (d7.reason) nullReasons.liqChange7dPct = d7.reason;
  return {
    liqHistoryPoints: points.length,
    liqChange24hPct: d1.change?.pct ?? null,
    liqChange24hWindow: d1.change?.window ?? null,
    liqChange7dPct: d7.change?.pct ?? null,
    liqChange7dWindow: d7.change?.window ?? null,
    nullReasons,
  };
}
