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
 * Change of the latest observation vs the newest point at least `windowMs` old. When history is
 * shorter than the window, the oldest point is used and the label says how much history exists.
 */
export function liquidityChange(points: LiqPoint[], windowMs: number, label: string): LiqChange | null {
  if (points.length < 2) return null;
  const cur = points[points.length - 1];
  const older = points.slice(0, -1);
  const full = [...older].reverse().find((p) => cur.t - p.t >= windowMs);
  const ref = full ?? older[0];
  if (!ref || ref.liq <= 0) return null;
  return {
    pct: ((cur.liq - ref.liq) / ref.liq) * 100,
    window: full ? label : `${hoursLabel(cur.t - ref.t)} of history`,
  };
}

export async function recordLiquidity(chain: string, address: string, liq: number, now = Date.now(), mcap: number | null = null): Promise<LiqPoint[]> {
  const key = historyKey(chain, address);
  const points = addPoint((await kvGet<LiqPoint[]>(key)) ?? [], mcap != null ? { t: now, liq, mcap } : { t: now, liq });
  await kvSet(key, points, 31 * 24 * 60 * 60);
  return points;
}

export function historyMetrics(points: LiqPoint[]) {
  const d1 = liquidityChange(points, DAY, "24h");
  const d7 = liquidityChange(points, 7 * DAY, "7d");
  return {
    liqHistoryPoints: points.length,
    liqChange24hPct: d1?.pct ?? null,
    liqChange24hWindow: d1?.window ?? null,
    liqChange7dPct: d7?.pct ?? null,
    liqChange7dWindow: d7?.window ?? null,
  };
}
