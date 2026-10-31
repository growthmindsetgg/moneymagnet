import type { AdapterResult, PatternDetection, TokenSnapshot } from "../types";
import { fetchJson } from "./http";
import { identicalCandles, launchRetrace, staircase, trend, upOnly, type Candle } from "../patterns";

/**
 * nad.fun (Monad's launchpad) agent API: https://api.nad.fun/agent/{token,market,metrics,chart,swap-history}/<ca>
 * Keyless: 10 requests / minute (x-ratelimit-limit); NAD_API_KEY (X-API-Key) raises it to 100/min.
 * Covers every nad.fun token, on the curve or graduated. Amounts are in MON (18 decimals) and token
 * units (18 decimals). See docs/chains/monad.md.
 */
const API = "https://api.nad.fun/agent";
const WEI = 1e18;

const headers = () => (process.env.NAD_API_KEY ? { "X-API-Key": process.env.NAD_API_KEY } : undefined);
const get = <T,>(path: string) => fetchJson<T>(`${API}${path}`, { headers: headers(), timeoutMs: 10_000 });
const n = (v: unknown) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

interface TokenInfo {
  token_info?: { name: string; symbol: string; is_graduated: boolean; twitter: string | null; telegram: string | null; website: string | null; created_at: number; creator?: { account_id: string }; version?: string };
}
interface MarketInfo {
  market_info?: { market_type: string; price_usd: string; native_price: string; total_supply: string; holder_count: number };
}
interface Metrics {
  metrics?: { timeframe: string; transactions: { buy: number; sell: number }; volume: { buy: string; sell: string }; makers: { buy: number; sell: number; total: number } }[];
}
interface Swaps {
  swaps?: { swap_info: { event_type: "BUY" | "SELL"; token_amount: string; created_at: number } }[];
  total_count?: number;
}

/** "CURVE" / "V2_CURVE" = still on the bonding curve; "DEX" / "V2_DEX" = graduated to a DEX pool. */
export const onCurve = (marketType: string | null | undefined) => !!marketType && /CURVE/.test(marketType);

export async function nadfun(address: string): Promise<AdapterResult> {
  const t0 = Date.now();
  const a = address.toLowerCase();
  const token = await get<TokenInfo>(`/token/${a}`).catch((e: Error) => {
    if (/\b404\b/.test(e.message)) return null;
    throw e;
  });
  const info = token?.token_info;
  if (!info) {
    // Not nad.fun's — which does not prove "no launchpad" (another factory may have made it): left null.
    return { status: { id: "nadfun", label: "nad.fun", state: "partial", message: "not a nad.fun token", ms: Date.now() - t0 }, data: { nullReasons: { isLaunchpad: "not a nad.fun token; no other Monad launchpad is registered" } } };
  }
  const creator = info.creator?.account_id?.toLowerCase() ?? null;
  const [market, metrics, creatorSwaps] = await Promise.all([
    get<MarketInfo>(`/market/${a}`).catch(() => null),
    get<Metrics>(`/metrics/${a}?timeframes=1D`).catch(() => null),
    creator ? get<Swaps>(`/swap-history/${a}?limit=100&account_id=${creator}`).catch(() => null) : Promise.resolve(null),
  ]);
  const m = market?.market_info;
  const d1 = metrics?.metrics?.find((x) => x.timeframe === "1D");
  const nullReasons: Record<string, string> = {};
  const failed: string[] = [];
  const data: Partial<TokenSnapshot> = {
    name: info.name,
    symbol: info.symbol,
    launchpad: `nad.fun ${info.version ?? "V1"}`,
    isLaunchpad: true,
    createdAt: new Date(info.created_at * 1000).toISOString(),
    deployerAddress: creator,
    socialLinks: [info.twitter, info.telegram, info.website].filter(Boolean).join(" ") || null,
  };
  if (m) {
    const supply = n(m.total_supply);
    const price = n(m.price_usd);
    data.totalSupply = supply != null ? supply / WEI : null;
    // Curve tokens have no DEX pair: price is nad.fun's, FDV derived = price × total supply. Graduated
    // tokens take both from the DEX indexers.
    if (onCurve(m.market_type)) {
      data.priceUsd = price;
      if (price != null && supply != null) data.fdvUsd = (price * supply) / WEI;
    }
    data.holderCount = m.holder_count ?? null;
    if (onCurve(m.market_type)) nullReasons.liquidityUsd = "nad.fun curve: the API's reserve fields are not documented as real (non-virtual) reserves, so curve liquidity is not stated";
  } else failed.push("priceUsd", "fdvUsd", "holderCount");
  if (d1) {
    const vb = n(d1.volume.buy);
    const vs = n(d1.volume.sell);
    data.buyers24h = d1.makers.buy;
    data.sellers24h = d1.makers.sell;
    data.buyTxs24h = d1.transactions.buy;
    data.sellTxs24h = d1.transactions.sell;
    data.sells24h = d1.transactions.sell;
    data.makersCount = d1.makers.total;
    data.netFlowRatio24h = vb != null && vs != null && vb + vs > 0 ? (vb - vs) / (vb + vs) : null;
    const native = n(m?.native_price);
    if (vb != null && vs != null && native != null) {
      data.netFlowUsd24h = (vb - vs) * native;
      data.volume24hUsd = (vb + vs) * native;
    }
  } else failed.push("buyers24h", "sellers24h", "netFlowRatio24h");
  // Dev sold = swaps only (§7): the creator's SELL token amount over their BUY amount on nad.fun.
  if (creatorSwaps?.swaps) {
    const sum = (t: "BUY" | "SELL") => creatorSwaps.swaps!.filter((s) => s.swap_info.event_type === t).reduce((x, s) => x + (n(s.swap_info.token_amount) ?? 0), 0);
    const bought = sum("BUY");
    const sold = sum("SELL");
    if ((creatorSwaps.total_count ?? creatorSwaps.swaps.length) > creatorSwaps.swaps.length) nullReasons.deployerSoldPct = `creator has ${creatorSwaps.total_count} swaps; only the latest 100 were read`;
    else {
      data.deployerSoldPct = bought > 0 ? Math.min(100, (sold / bought) * 100) : 0;
      data.deployerHasSold = sold > 0;
    }
  } else if (creator) failed.push("deployerSoldPct");
  nullReasons.devBuySharePct = "nad.fun: the dev's share of the first-10-minute buys needs the full launch trade list (not read within the 10 req/min budget)";
  data.nullReasons = nullReasons;
  const notes = [
    `${info.version ?? "V1"} ${m?.market_type ?? "?"}${info.is_graduated ? " (graduated)" : ""}`,
    m ? `${m.holder_count} holders` : "market call failed",
    d1 ? `24h: ${d1.makers.buy} buyers / ${d1.makers.sell} sellers` : "metrics call failed",
    data.deployerSoldPct != null ? `creator sold ${data.deployerSoldPct.toFixed(1)}% of what they bought (swaps)` : null,
  ].filter(Boolean);
  return {
    status: { id: "nadfun", label: "nad.fun", state: failed.length ? "partial" : "ok", message: notes.join(" · "), ms: Date.now() - t0, url: `https://nad.fun/tokens/${a}` },
    data,
    raw: { marketType: m?.market_type ?? null, version: info.version ?? "V1", graduated: info.is_graduated, creator },
    ...(failed.length ? { failedFields: failed } : {}),
  };
}

/** Chart patterns from nad.fun candles (MON price; shapes only) for tokens no DEX indexer charts — i.e. curve tokens. */
export async function nadfunChart(address: string, createdAt: string | null): Promise<AdapterResult> {
  const t0 = Date.now();
  const a = address.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const launch = createdAt ? Math.floor(Date.parse(createdAt) / 1000) : null;
  const ageH = launch ? (now - launch) / 3600 : null;
  const candles = async (res: string, from: number) => {
    const c = await get<{ t: number[]; o: string[]; h: string[]; l: string[]; c: string[]; v?: string[] }>(`/chart/${a}?resolution=${res}&from=${from}&to=${now}`);
    return (c.t ?? []).map((t, i): Candle => ({ t, o: Number(c.o[i]), h: Number(c.h[i]), l: Number(c.l[i]), c: Number(c.c[i]), v: Number(c.v?.[i] ?? 0) })).filter((x) => x.o > 0 && x.c > 0);
  };
  const [m1, m5] = await Promise.all([ageH != null && ageH < 72 ? candles("1", launch!) : Promise.resolve([]), candles("5", Math.max(launch ?? now - 3 * 86_400, now - 3 * 86_400))]);
  const data: Partial<TokenSnapshot> = {};
  const nullReasons: Record<string, string> = {};
  const patterns: PatternDetection[] = [];
  if (ageH != null && ageH < 72) {
    const ident = identicalCandles(m1);
    data.identicalCandleSharePct = ident.value;
    data.identicalWindow = ident.window;
    patterns.push(ident.detection);
    if (ident.value == null) nullReasons.identicalCandleSharePct = ident.detection.detail;
    const lr = launchRetrace(m1.slice(0, 300), launch!);
    data.launchRetraced30 = lr.value;
    data.launchWindow = lr.window;
    patterns.push(lr.detection);
    if (lr.value == null) nullReasons.launchRetraced30 = lr.detection.detail;
  }
  const stair = staircase(m5.slice(-60));
  data.staircase = stair.value;
  data.staircaseWindow = stair.window;
  patterns.push(stair.detection);
  const tr = trend(m5, "5m");
  data.trendScore = tr.value;
  data.trendWindow = tr.window;
  data.brokeHigherLow = tr.brokeHigherLow;
  patterns.push(tr.detection);
  if (tr.value == null) nullReasons.trendScore = tr.detection.detail;
  const up = upOnly(m5.slice(-288));
  data.upOnlyChart = up.value;
  patterns.push(up.detection);
  nullReasons.hugeCandlesOnly = "nad.fun candles carry no per-candle trade count";
  data.patterns = patterns;
  data.nullReasons = nullReasons;
  return { status: { id: "nadfun-chart", label: "nad.fun candles", state: "ok", message: `${m1.length} × 1m, ${m5.length} × 5m candles (MON price)`, ms: Date.now() - t0 }, data };
}
