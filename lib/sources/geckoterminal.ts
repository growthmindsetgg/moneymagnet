import type { AdapterResult, Chain, PatternDetection, TokenSnapshot } from "../types";
import { num } from "./http";
import { isOutage } from "./retry";
import { gtGet, staleMinutes } from "./gtClient";
import { poolMetrics, pumpMarket, type PoolRow } from "./pools";
import { identicalCandles, launchRetrace, sortCandles, staircase, trend, upOnly } from "../patterns";
import { priceChange7d } from "../cohort";

interface GtPool {
  id: string;
  attributes: {
    name: string;
    address: string;
    reserve_in_usd: string | null;
    pool_created_at: string | null;
    fdv_usd: string | null;
    base_token_price_usd: string | null;
    volume_usd: { h24: string | null };
    price_change_percentage?: { h24?: string | null };
    transactions: { h24?: { buys: number; sells: number; buyers: number; sellers: number } };
  };
  relationships: { base_token: { data: { id: string } }; dex?: { data?: { id?: string } } };
}

interface GtOhlcv {
  data?: { attributes?: { ohlcv_list?: number[][] } };
}

const NETWORK: Record<Chain, string> = { robinhood: "robinhood", solana: "solana", base: "base", monad: "monad", ethereum: "eth" };

/**
 * Candle reuse per series (seconds). Under a minute counts as this run's reading (GeckoTerminal's own refresh step);
 * older reuse is labelled "stale Xm" on exactly the fields that series fed. 1m candles (launch checks) are never reused.
 */
export const CANDLE_CACHE_S = { m5: 120, h1: 600, d1: 1800 } as const;
/** The token's pool list: reused only within GeckoTerminal's ~1 min refresh step, so it is always this run's reading. */
const POOLS_CACHE_S = 45;

export async function geckoterminal(chain: Chain, address: string): Promise<AdapterResult> {
  const t0 = Date.now();
  const net = NETWORK[chain];
  const res = await gtGet<{ data: GtPool[] }>(`/networks/${net}/tokens/${address}/pools?page=1`, { priority: "core", cacheTtlS: POOLS_CACHE_S })
    .then((r) => r.body)
    .catch((e: Error) => {
      // Base / Monad: 404 = GeckoTerminal does not index the token (e.g. a nad.fun curve token) — an answer, not an outage.
      if ((chain === "base" || chain === "monad" || chain === "ethereum") && /HTTP 404/.test(e.message)) return { data: [] as GtPool[] };
      throw e;
    });
  const pools = res.data ?? [];
  const page = `https://www.geckoterminal.com/${net}/tokens/${address}`;
  if (!pools.length) {
    return { status: { id: "geckoterminal", label: "GeckoTerminal", state: "partial", message: "No pools", ms: Date.now() - t0, url: page }, data: {}, raw: res };
  }
  const baseId = `${net}_${chain === "solana" ? address : address.toLowerCase()}`;
  const rows: (PoolRow & { dexId?: string | null })[] = pools.map((p) => ({
    id: p.attributes.address,
    name: p.attributes.name,
    // A pool listed without reserve / volume is unknown, never $0 (C1).
    liquidityUsd: num(p.attributes.reserve_in_usd),
    volume24hUsd: num(p.attributes.volume_usd?.h24),
    createdAt: p.attributes.pool_created_at,
    dexId: p.relationships.dex?.data?.id ?? null,
  }));
  const pump = chain === "solana" ? pumpMarket(rows) : null;
  const asBase = pools.filter((p) => p.relationships.base_token.data.id.toLowerCase() === baseId.toLowerCase());
  const main = [...(asBase.length ? asBase : pools)].sort(
    // Ordering only: a pool without a reserve figure sorts last.
    (a, b) => (num(b.attributes.reserve_in_usd) ?? -1) - (num(a.attributes.reserve_in_usd) ?? -1),
  )[0];
  const tx = main.attributes.transactions.h24;
  // Buyer/seller counts are per pool; they stand for the token only when the main pool carries
  // (nearly) all of its volume. Otherwise they would be a partial count presented as the total.
  // The share is only known when every pool's volume is: an unreported pool may carry the trading.
  const volUnknown = rows.filter((r) => r.volume24hUsd == null).length;
  const mainVol = num(main.attributes.volume_usd?.h24);
  const totalVol = volUnknown ? null : rows.reduce((a, r) => a + r.volume24hUsd!, 0);
  const mainVolShare = totalVol == null || mainVol == null ? null : totalVol > 0 ? mainVol / totalVol : 1;
  const wholeToken = mainVolShare != null && mainVolShare >= 0.9;
  const scopeReason =
    mainVolShare == null
      ? `GeckoTerminal counts trades per pool and ${volUnknown || 1} pool${(volUnknown || 1) > 1 ? "s are" : " is"} listed without a 24h volume, so the main pool's share of the token's trading is unknown`
      : `GeckoTerminal counts trades per pool and the main pool has only ${(mainVolShare * 100).toFixed(0)}% of 24h volume`;

  const pools0 = pump ? null : poolMetrics(rows);
  const poolReasons = pools0?.nullReasons;
  const data: Partial<TokenSnapshot> = {
    ...(pump ? pump.metrics : pools0),
    poolAddresses: rows.map((r) => r.id).filter((id) => /^0x[0-9a-fA-F]{40}$/.test(id) || !id.startsWith("0x")),
    fdvUsd: num(main.attributes.fdv_usd),
    priceUsd: asBase.length ? num(main.attributes.base_token_price_usd) : null,
    // Read on the most-traded pool with this token as base: a dust pool's stale price is not the market's move.
    priceChange24hPct: asBase.length ? num([...asBase].sort((a, b) => (num(b.attributes.volume_usd.h24) ?? 0) - (num(a.attributes.volume_usd.h24) ?? 0))[0].attributes.price_change_percentage?.h24) : null,
    // Unique buyer/seller wallets on the main pool — the per-pool counts GeckoTerminal publishes.
    buyers24h: wholeToken ? (tx?.buyers ?? null) : null,
    sellers24h: wholeToken ? (tx?.sellers ?? null) : null,
    // Main-pool trade counts stand for the token under the same rule as the buyer/seller counts (M5).
    sells24h: wholeToken ? (tx?.sells ?? null) : null,
    tradesPerWallet: wholeToken && tx && tx.buyers + tx.sellers > 0 ? (tx.buys + tx.sells) / (tx.buyers + tx.sellers) : null,
    links: [{ label: "GeckoTerminal", url: page }],
  };
  const raw: Record<string, unknown> = { pools: rows, mainPool: main.attributes.address, ...(pump?.curveOnly ? { curveOnly: true } : {}) };

  // Chart patterns from the main pool's candles (guide p.24, 27, 61-71).
  let failedFields: string[] | undefined;
  const ohlcvNote = await chartPatterns(net, main.attributes.address, main.attributes.pool_created_at, data, raw).catch((e: Error) => {
    const reason = `GeckoTerminal OHLCV failed: ${/\b429\b/.test(e.message) ? "rate limited (HTTP 429)" : e.message.slice(0, 80)}`;
    data.nullReasons = Object.fromEntries(
      ["identicalCandleSharePct", "staircase", "trendScore", "brokeHigherLow", "upOnlyChart", "launchRetraced30", "launchPriceUsd", "hugeCandlesOnly", "priceChange7dPct"].map((m) => [m, reason]),
    );
    // An outage (429 / 5xx / timeout), not an answer: the last good candles' readings stand in, labelled stale.
    if (isOutage(e)) failedFields = [...OHLCV_FIELDS];
    return `OHLCV failed: ${e.message}`;
  });
  if (ohlcvNote) raw.ohlcv = ohlcvNote;
  if (!wholeToken) data.nullReasons = { ...data.nullReasons, buyers24h: scopeReason, sellers24h: scopeReason, sells24h: scopeReason, tradesPerWallet: scopeReason };
  // Pool aggregates GeckoTerminal could not state (a pool without reserve / volume): poolMetrics' reasons
  // (chartPatterns replaces data.nullReasons, so they are put back here).
  if (!pump && poolReasons) data.nullReasons = { ...poolReasons, ...data.nullReasons };
  if (pump) data.nullReasons = { ...data.nullReasons, ...pump.nullReasons };

  return {
    status: {
      id: "geckoterminal",
      label: "GeckoTerminal",
      state: typeof ohlcvNote === "string" && ohlcvNote.startsWith("OHLCV failed") ? "partial" : "ok",
      message: `${pools.length} pools${typeof ohlcvNote === "string" && ohlcvNote.startsWith("OHLCV failed") ? ` · ${ohlcvNote.slice(0, 120)}` : " + OHLCV"}`,
      ms: Date.now() - t0,
      url: page,
    },
    data,
    raw,
    ...(failedFields ? { failedFields } : {}),
  };
}

/** Everything chartPatterns derives from the OHLCV candles. */
export const OHLCV_FIELDS = [
  "identicalCandleSharePct",
  "identicalWindow",
  "staircase",
  "staircaseWindow",
  "trendScore",
  "trendWindow",
  "brokeHigherLow",
  "upOnlyChart",
  "launchRetraced30",
  "launchWindow",
  "launchPriceUsd",
  "priceChange7dPct",
  "priceChange7dWindow",
  "patterns",
] as const;

interface Series {
  candles: ReturnType<typeof sortCandles>;
  /** Whole minutes old when reused from the cache (≥ 1), else null (this run's reading). */
  staleMin: number | null;
}
const NONE: Series = { candles: [], staleMin: null };

async function ohlcv(net: string, pool: string, tf: "minute" | "hour" | "day", aggregate: number, limit: number, opts: { before?: number; cacheTtlS?: number } = {}): Promise<Series> {
  const q = new URLSearchParams({ aggregate: String(aggregate), limit: String(limit), currency: "usd" });
  if (opts.before) q.set("before_timestamp", String(opts.before));
  const r = await gtGet<GtOhlcv>(`/networks/${net}/pools/${pool}/ohlcv/${tf}?${q}`, { priority: "core", cacheTtlS: opts.cacheTtlS, timeoutMs: 10_000 });
  return { candles: sortCandles(r.body.data?.attributes?.ohlcv_list ?? []), staleMin: staleMinutes(r.cachedAgeS) };
}

/** Fills pattern metrics on `data` and returns null, or a failure note. Never invents a value. */
async function chartPatterns(net: string, pool: string, createdAt: string | null, data: Partial<TokenSnapshot>, raw: Record<string, unknown> = {}): Promise<string | null> {
  const launchTs = createdAt ? Math.floor(Date.parse(createdAt) / 1000) : null;
  const ageH = launchTs ? (Date.now() / 1000 - launchTs) / 3600 : null;
  const young = ageH != null && ageH < 72;
  const [s1, s5, sd, sh, sl] = await Promise.all([
    young ? ohlcv(net, pool, "minute", 1, 60) : Promise.resolve(NONE),
    // A launch-mode series is sized by the token's age, so it is not reused (its window moves every minute).
    ohlcv(net, pool, "minute", 5, young ? Math.min(1000, Math.ceil(ageH! * 12) + 2) : 300, { cacheTtlS: young ? undefined : CANDLE_CACHE_S.m5 }),
    ohlcv(net, pool, "day", 1, 1000, { cacheTtlS: CANDLE_CACHE_S.d1 }),
    ageH == null || ageH >= 72 ? ohlcv(net, pool, "hour", 1, 168, { cacheTtlS: CANDLE_CACHE_S.h1 }) : Promise.resolve(NONE),
    launchTs && young ? ohlcv(net, pool, "minute", 1, 300, { before: launchTs + 300 * 60 }) : Promise.resolve(NONE),
  ]);
  const [m1, m5, d1, h1, launch1m] = [s1.candles, s5.candles, sd.candles, sh.candles, sl.candles];
  // A field read from a reused series is as stale as that series (CLAUDE.md: labelled "stale Xm").
  const staleFields: Record<string, number> = {};
  const markStale = (s: Series, fields: string[]) => {
    if (s.staleMin != null) for (const f of fields) staleFields[f] = Math.max(staleFields[f] ?? 0, s.staleMin);
  };
  markStale(s5, ["staircase", "staircaseWindow", "upOnlyChart", ...(young ? ["trendScore", "trendWindow", "brokeHigherLow"] : [])]);
  markStale(sh, ["trendScore", "trendWindow", "brokeHigherLow"]);
  markStale(sd, ["priceChange7dPct", "priceChange7dWindow", "launchPriceUsd"]);
  const oldest = Math.max(0, ...Object.values(staleFields));
  if (oldest) {
    staleFields.patterns = oldest;
    raw.candleReuse = { m5: s5.staleMin, h1: sh.staleMin, d1: sd.staleMin };
  }
  const patterns: PatternDetection[] = [];
  const nullReasons: Record<string, string> = {};

  if (ageH != null && ageH < 72) {
    const ident = identicalCandles(m1);
    data.identicalCandleSharePct = ident.value;
    data.identicalWindow = ident.window;
    patterns.push(ident.detection);
    if (ident.value == null) nullReasons.identicalCandleSharePct = ident.detection.detail;
  } else {
    nullReasons.identicalCandleSharePct = "1m candles are only checked for launch-mode (< 72h) tokens";
  }

  const stair = staircase(m5.slice(-60));
  data.staircase = stair.value;
  data.staircaseWindow = stair.window;
  patterns.push(stair.detection);
  if (stair.value == null) nullReasons.staircase = stair.detection.detail;

  // Trend (guide p.61-71): Launch mode reads 5m candles over the token's life, Established mode 1h over 7d.
  const launchMode = ageH != null && ageH < 72;
  const tr = launchMode ? trend(m5, "5m") : trend(h1, "1h");
  data.trendScore = tr.value;
  data.trendWindow = tr.window;
  data.brokeHigherLow = tr.brokeHigherLow;
  patterns.push(tr.detection);
  if (tr.value == null) nullReasons.trendScore = tr.detection.detail;

  const up = upOnly(m5.slice(-288));
  data.upOnlyChart = up.value;
  patterns.push(up.detection);

  if (launchTs && launch1m.length) {
    const lr = launchRetrace(launch1m, launchTs);
    data.launchRetraced30 = lr.value;
    data.launchWindow = lr.window;
    patterns.push(lr.detection);
    if (lr.value == null) nullReasons.launchRetraced30 = lr.detection.detail;
  } else {
    nullReasons.launchRetraced30 = launchTs ? "token is ≥ 72h old — launch window not fetched" : "pool creation time unknown";
  }

  // Daily candles of the main pool, kept for Holder Strength (drawdowns and dips over the token's life).
  raw.dayCandles = d1.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }));
  // 7d price change of the main pool (relative strength vs the peer cohort reads it with the same rule as the peers').
  const ch7 = priceChange7d(d1);
  data.priceChange7dPct = ch7.pct;
  data.priceChange7dWindow = ch7.window;
  if (ch7.pct == null) nullReasons.priceChange7dPct = `GeckoTerminal ${ch7.reason}`;
  // Launch price = open of the first daily candle of the main pool.
  if (d1.length && launchTs && d1[0].t <= launchTs + 86_400) data.launchPriceUsd = d1[0].o;
  else nullReasons.launchPriceUsd = "first daily candle not available from GeckoTerminal";

  // GeckoTerminal candles have volume but no trade counts, which the "only huge candles" rule needs.
  nullReasons.hugeCandlesOnly = "GeckoTerminal candles carry no per-candle trade count (guide rule needs < 20 trades/candle)";

  data.patterns = patterns;
  data.nullReasons = nullReasons;
  // Only fields that hold a value can be stale (a null keeps its reason).
  const held = Object.fromEntries(Object.entries(staleFields).filter(([k]) => (data as Record<string, unknown>)[k] != null));
  if (Object.keys(held).length) data.staleFields = { ...data.staleFields, ...held };
  return null;
}
