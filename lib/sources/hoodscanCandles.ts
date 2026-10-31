import type { AdapterResult, PatternDetection, TokenSnapshot } from "../types";
import { identicalCandles, launchRetrace, staircase, trend, upOnly, type Candle } from "../patterns";
import { fetchJson } from "./http";

/**
 * Candles built from HoodScan's swap index, for Robinhood launch-mode tokens whose v4 pools have
 * no GeckoTerminal OHLCV. Every candle is real trades: price = USD value / token amount of each
 * swap, OHLC per 1m / 5m bucket, volume = USD traded, plus the trade count per candle (which
 * GeckoTerminal does not give, so "only huge candles" becomes measurable). The raw launch-window
 * trades are returned for the dev-buy share.
 */

export interface HsSwap {
  ts: number;
  block: number;
  trader: string;
  side: "buy" | "sell";
  usd: number;
  tokenIn: { address: string };
  amountIn: number;
  tokenOut: { address: string };
  amountOut: number;
}

const API = "https://hoodscan.co/swaps-api/trades";
const PAGE = 100;

/** Swaps before `beforeTs` (newest first), paging backwards until `stopTs` or `maxPages`. */
async function swapsBefore(token: string, beforeTs: number | null, stopTs: number, maxPages: number): Promise<{ swaps: HsSwap[]; complete: boolean }> {
  const out: HsSwap[] = [];
  let before: string | null = beforeTs != null ? String(beforeTs) : null;
  for (let i = 0; i < maxPages; i++) {
    const url = `${API}?token=${token}&limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
    type Page = { items?: HsSwap[]; next?: string | null; available?: boolean };
    // One retry per page; a failure after the first page keeps what was already read (marked incomplete).
    const page = await fetchJson<Page>(url, { timeoutMs: 10_000 }).catch(() => fetchJson<Page>(url, { timeoutMs: 10_000 })).catch((err: Error) => {
      if (!out.length) throw err;
      return null;
    });
    if (!page) return { swaps: out, complete: false };
    const items = page.items ?? [];
    out.push(...items);
    if (!items.length || !page.next || items[items.length - 1].ts < stopTs) return { swaps: out, complete: true };
    before = page.next;
  }
  return { swaps: out, complete: out.length > 0 && out[out.length - 1].ts < stopTs };
}

export function priceOf(s: HsSwap, token: string): { price: number; tokens: number } | null {
  const t = token.toLowerCase();
  const tokens = s.tokenOut.address.toLowerCase() === t ? s.amountOut : s.tokenIn.address.toLowerCase() === t ? s.amountIn : 0;
  if (!(tokens > 0) || !(s.usd > 0)) return null;
  return { price: s.usd / tokens, tokens };
}

/** OHLCV candles (+ trade counts) of `tfSec` seconds from swaps. */
export function buildCandles(swaps: HsSwap[], token: string, tfSec: number): (Candle & { n: number })[] {
  const by = new Map<number, (Candle & { n: number })>();
  for (const s of [...swaps].sort((a, b) => a.ts - b.ts || a.block - b.block)) {
    const p = priceOf(s, token);
    if (!p) continue;
    const t = Math.floor(s.ts / tfSec) * tfSec;
    const c = by.get(t);
    if (!c) by.set(t, { t, o: p.price, h: p.price, l: p.price, c: p.price, v: s.usd, n: 1 });
    else {
      c.h = Math.max(c.h, p.price);
      c.l = Math.min(c.l, p.price);
      c.c = p.price;
      c.v += s.usd;
      c.n++;
    }
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}

/** Guide p.24: median candle body > 5% of price on < 20 trades per candle = bundled "huge candles". */
export function hugeCandles(cs: (Candle & { n: number })[]): { value: boolean | null; detail: string } {
  const recent = cs.slice(-24);
  if (recent.length < 6) return { value: null, detail: `only ${recent.length} 5m candles with trades` };
  const bodies = recent.map((c) => Math.abs(c.c - c.o) / c.o).sort((a, b) => a - b);
  const trades = recent.map((c) => c.n).sort((a, b) => a - b);
  const medBody = bodies[Math.floor(bodies.length / 2)];
  const medTrades = trades[Math.floor(trades.length / 2)];
  return {
    value: medBody > 0.05 && medTrades < 20,
    detail: `median 5m body ${(medBody * 100).toFixed(1)}% on a median ${medTrades} trades per candle (last ${recent.length} candles)`,
  };
}

export async function hoodscanCandles(token: string, createdAt: string | null): Promise<AdapterResult> {
  const t0 = Date.now();
  const a = token.toLowerCase();
  const launchTs = createdAt ? Math.floor(Date.parse(createdAt) / 1000) : null;
  const now = Math.floor(Date.now() / 1000);
  // Recent life (up to 2,000 swaps) and, separately, the first hour after launch.
  // HoodScan's cursor pages are slow (10–20s each), so recent history is capped at 4 pages and
  // the launch window is one page right after launch.
  const [recent, launch] = await Promise.all([
    swapsBefore(a, null, launchTs ?? now - 72 * 3600, 4),
    launchTs ? swapsBefore(a, launchTs + 3600, launchTs - 1, 1) : Promise.resolve({ swaps: [] as HsSwap[], complete: false }),
  ]);
  const all = [...new Map([...recent.swaps, ...launch.swaps].map((s) => [`${s.ts}:${s.block}:${s.trader}:${s.usd}`, s])).values()];
  const c1 = buildCandles(all, a, 60);
  const c5 = buildCandles(recent.swaps, a, 300);
  const data: Partial<TokenSnapshot> = {};
  const nullReasons: Record<string, string> = {};
  const patterns: PatternDetection[] = [];
  const label = (p: PatternDetection) => ({ ...p, detail: `${p.detail} [HoodScan swaps]` });

  if (c5.length) {
    const ident = identicalCandles(c1.slice(-60));
    data.identicalCandleSharePct = ident.value;
    data.identicalWindow = ident.window ? `${ident.window} (from HoodScan swaps)` : null;
    patterns.push(label(ident.detection));
    const stair = staircase(c5.slice(-60));
    data.staircase = stair.value;
    data.staircaseWindow = stair.window ? `${stair.window} (from HoodScan swaps)` : null;
    patterns.push(label(stair.detection));
    const tr = trend(c5, "5m");
    data.trendScore = tr.value;
    data.trendWindow = tr.window ? `${tr.window} (from HoodScan swaps)` : null;
    data.brokeHigherLow = tr.brokeHigherLow;
    patterns.push(label(tr.detection));
    data.upOnlyChart = upOnly(c5.slice(-288)).value;
    const huge = hugeCandles(c5);
    data.hugeCandlesOnly = huge.value;
    if (huge.value == null) nullReasons.hugeCandlesOnly = huge.detail;
    patterns.push({ id: "huge_candles", result: huge.value, detail: `${huge.detail} [HoodScan swaps]`, timeframe: "5m", from: null, to: null, candles: Math.min(24, c5.length) });
  } else {
    for (const m of ["identicalCandleSharePct", "staircase", "trendScore", "hugeCandlesOnly"]) nullReasons[m] = "HoodScan swap index has no trades for this token";
  }
  if (launchTs && launch.swaps.length) {
    const lr = launchRetrace(buildCandles(launch.swaps, a, 60), launchTs);
    data.launchRetraced30 = lr.value;
    data.launchWindow = lr.window ? `${lr.window} (from HoodScan swaps)` : null;
    patterns.push(label(lr.detection));
    if (lr.value == null) nullReasons.launchRetraced30 = lr.detection.detail;
  } else {
    nullReasons.launchRetraced30 = launchTs ? "no HoodScan swaps in the first hour after launch" : "creation time unknown";
  }
  data.patterns = patterns;
  data.nullReasons = nullReasons;
  return {
    status: {
      id: "hs-candles",
      label: "HoodScan swap candles",
      state: c5.length ? "ok" : "partial",
      message: `${all.length} swaps → ${c1.length} × 1m / ${c5.length} × 5m candles${recent.complete ? "" : " (recent history capped at 400 swaps)"}`,
      ms: Date.now() - t0,
    },
    data,
    raw: { launchSwaps: launch.swaps, launchComplete: launch.complete },
  };
}
