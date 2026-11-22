import type { AdapterResult, TokenSnapshot } from "../types";

export interface PoolRow {
  id: string;
  name: string;
  /** null = the indexer listed the pool without a liquidity figure (never read as $0). */
  liquidityUsd: number | null;
  /** null = the indexer listed the pool without a 24h volume figure (never read as $0). */
  volume24hUsd: number | null;
  createdAt: string | null;
}

const usd = (v: number) => `$${v >= 1000 ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 100) / 100)}`;

/**
 * Sum of one field over pools, or null when any pool lacks it. A partial sum is a lower bound, not the
 * total: presented as the total it would win every "lowest liquidity / volume" dispute. The reason names
 * how many pools are missing and what the known ones add up to.
 */
export function sumKnown(pools: PoolRow[], field: "liquidityUsd" | "volume24hUsd", what: string): { value: number | null; reason: string | null } {
  const unknown = pools.filter((p) => p[field] == null);
  const known = pools.reduce((a, p) => a + (p[field] ?? 0), 0);
  if (!unknown.length) return { value: known, reason: null };
  return {
    value: null,
    reason: `${unknown.length} of ${pools.length} pools listed without a ${what} figure — total not stated (the ${pools.length - unknown.length} known pools sum to ${usd(known)}, a partial sum)`,
  };
}

/** pump.fun bonding-curve "markets" as GeckoTerminal / DexScreener list them. */
export const isCurveMarket = (dexId: string | null | undefined) => !!dexId && /^pump-?fun$/i.test(dexId);

/**
 * Solana pump.fun tokens: before graduation the only market is the curve (its liquidity is the
 * curve's real SOL reserve, read on-chain — indexer "liquidity" for it is not comparable); after
 * graduation the curve market is dead and the main market is the deepest AMM pool, which alone
 * supplies liquidity, volume and VOL/MC. Returns null for tokens without a curve market.
 */
export function pumpMarket(pools: (PoolRow & { dexId?: string | null })[]): { metrics: Partial<TokenSnapshot>; nullReasons: Record<string, string>; note: string; curveOnly: boolean } | null {
  const curve = pools.filter((p) => isCurveMarket(p.dexId));
  if (!curve.length) return null;
  const ammAll = pools.filter((p) => !isCurveMarket(p.dexId));
  const amm = ammAll.filter((p) => p.liquidityUsd != null).sort((a, b) => b.liquidityUsd! - a.liquidityUsd!);
  const ammUnknown = ammAll.length - amm.length;
  const curveVol = sumKnown(curve, "volume24hUsd", "24h volume");
  const curveVolume = curveVol.value;
  // Anyone can open a pool for a curve token (e.g. a $0.60 Meteora pool next to a $57k/24h curve). A dust pool
  // (< ACTIVE_MIN_LIQ) that trades less than the live curve is not graduation: the curve stays the main market.
  // A drained AMM pool next to a dead curve still counts as graduated, so a pulled pool is not hidden.
  // Every input must be known: an unreported figure never decides "dust" or "graduated".
  const dust =
    amm.length > 0 &&
    ammUnknown === 0 &&
    amm[0].liquidityUsd! < ACTIVE_MIN_LIQ &&
    curveVolume != null &&
    amm[0].volume24hUsd != null &&
    curveVolume > amm[0].volume24hUsd;
  if (!ammAll.length || dust) {
    const reason = "pre-graduation: liquidity is the curve's real SOL reserve (Solana RPC), not an indexer figure";
    return {
      metrics: { poolCount: 1, ...(curveVolume != null ? { volume24hUsd: curveVolume } : {}), createdAt: curve[0].createdAt },
      nullReasons: { liquidityUsd: reason, mainPoolLiquidityUsd: reason, ...(curveVol.reason ? { volume24hUsd: `curve market: ${curveVol.reason}` } : {}) },
      note: dust ? `pre-graduation (curve market; ${amm.length} dust pool${amm.length > 1 ? "s" : ""} under $${ACTIVE_MIN_LIQ} ignored)` : "pre-graduation (curve market only)",
      // The curve is the market this source reads (a dust pool beside it does not change that): if the chain
      // says the curve has graduated, dropGraduatedCurveMarket() discards these fields.
      curveOnly: true,
    };
  }
  const createdAt = [...pools].map((p) => p.createdAt).filter(Boolean).sort()[0] ?? null;
  if (ammUnknown > 0) {
    // The deepest AMM pool cannot be named while one of them has no liquidity figure.
    const reason = `graduated, but ${ammUnknown} of ${ammAll.length} AMM pools are listed without a liquidity figure — the main market (deepest pool) is unknown`;
    const keys = ["liquidityUsd", "mainPoolLiquidityUsd", "mainPoolSharePct", "volume24hUsd", "liquidityTotalUsd", "poolCount"];
    return { metrics: { createdAt }, nullReasons: Object.fromEntries(keys.map((k) => [k, reason])), note: `graduated — ${reason}`, curveOnly: false };
  }
  const main = amm[0];
  return {
    metrics: {
      poolCount: amm.filter((p) => p.liquidityUsd! >= ACTIVE_MIN_LIQ).length || 1,
      liquidityUsd: main.liquidityUsd,
      mainPoolLiquidityUsd: main.liquidityUsd,
      mainPoolSharePct: 100,
      ...(main.volume24hUsd != null ? { volume24hUsd: main.volume24hUsd } : {}),
      liquidityTotalUsd: main.liquidityUsd,
      createdAt,
    },
    nullReasons: main.volume24hUsd == null ? { volume24hUsd: `main market ${main.name} (${main.id.slice(0, 8)}…) is listed without a 24h volume figure` } : {},
    note: `graduated — main market ${main.name} (${main.id.slice(0, 8)}…), curve market ignored`,
    curveOnly: false,
  };
}

/** A pool counts as "active" when it has real depth and was traded in the last 24h. */
export const ACTIVE_MIN_LIQ = 1000;
export const ACTIVE_MIN_VOL = 100;

/**
 * Turns a pool list into liquidity / fragmentation / age metrics. A pool listed without a liquidity or volume
 * figure is unknown, not $0: aggregates that depend on it are null with a reason naming the partial sum.
 */
export function poolMetrics(pools: PoolRow[]): Partial<TokenSnapshot> {
  if (!pools.length) return { poolCount: 0 };
  const nullReasons: Record<string, string> = {};
  const isActive = (p: PoolRow) => p.liquidityUsd != null && p.volume24hUsd != null && p.liquidityUsd >= ACTIVE_MIN_LIQ && p.volume24hUsd >= ACTIVE_MIN_VOL;
  // Inactive only when a known figure rules it out; otherwise a pool with a missing figure is undecided.
  const isInactive = (p: PoolRow) => (p.liquidityUsd != null && p.liquidityUsd < ACTIVE_MIN_LIQ) || (p.volume24hUsd != null && p.volume24hUsd < ACTIVE_MIN_VOL);
  const active = pools.filter(isActive);
  const undecided = pools.filter((p) => !isActive(p) && !isInactive(p));
  const created = pools
    .map((p) => (p.createdAt ? Date.parse(p.createdAt) : NaN))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  const total = sumKnown(pools, "liquidityUsd", "liquidity");
  const volume = sumKnown(pools, "volume24hUsd", "24h volume");
  if (total.reason) nullReasons.liquidityTotalUsd = total.reason;
  if (volume.reason) nullReasons.volume24hUsd = volume.reason;
  let poolCount: number | null = active.length;
  let liquidityUsd: number | null = null;
  let main: number | null = null;
  if (undecided.length) {
    // An undecided pool may be active (or the deepest): the active-pool figures cannot be stated.
    const reason = `${undecided.length} of ${pools.length} pools are listed without a liquidity or volume figure, so the active pools (≥ $${ACTIVE_MIN_LIQ} liquidity and ≥ $${ACTIVE_MIN_VOL} 24h volume) cannot be told apart`;
    poolCount = null;
    for (const k of ["poolCount", "liquidityUsd", "mainPoolLiquidityUsd", "mainPoolSharePct"]) nullReasons[k] = reason;
  } else {
    const basis = active.length ? active : pools;
    const basisLiq = sumKnown(basis, "liquidityUsd", "liquidity");
    liquidityUsd = basisLiq.value;
    main = basisLiq.value != null ? Math.max(...basis.map((p) => p.liquidityUsd!)) : null;
    if (basisLiq.reason) for (const k of ["liquidityUsd", "mainPoolLiquidityUsd", "mainPoolSharePct"]) nullReasons[k] = basisLiq.reason;
  }
  return {
    poolCount,
    liquidityUsd,
    mainPoolLiquidityUsd: main,
    mainPoolSharePct: liquidityUsd != null && main != null && liquidityUsd > 0 ? (main / liquidityUsd) * 100 : null,
    volume24hUsd: volume.value,
    liquidityTotalUsd: total.value,
    createdAt: created ? new Date(created).toISOString() : null,
    ...(Object.keys(nullReasons).length ? { nullReasons } : {}),
  };
}

/**
 * Market fields a source derives from its main pool. When that pool is a pump.fun curve that has already
 * graduated, the curve is a dead market: its volume, trade counts, price and recent candles read 0 / frozen
 * at graduation while trading carries on in the AMM pool. Launch-window candles stay (the curve WAS the launch).
 */
export const CURVE_MARKET_FIELDS = [
  "volume24hUsd",
  "poolCount",
  "buyers24h",
  "sellers24h",
  "sells24h",
  "buyTxs24h",
  "sellTxs24h",
  "tradesPerWallet",
  "lastTradeHoursAgo",
  "priceUsd",
  "priceChange24hPct",
  "fdvUsd",
  "identicalCandleSharePct",
  "identicalWindow",
  "staircase",
  "staircaseWindow",
  "trendScore",
  "trendWindow",
  "brokeHigherLow",
  "upOnlyChart",
  "hugeCandlesOnly",
  "patterns",
] as const;

/**
 * A source that saw only the curve pool of a token the chain says has graduated (its AMM pool is not
 * indexed there yet) must not supply market fields: they become null with the reason, so a source that
 * does index the AMM pool (or nothing) fills them. Never a 0 standing in for "this indexer is behind".
 */
export function dropGraduatedCurveMarket(r: AdapterResult): AdapterResult {
  if (!(r.raw && typeof r.raw === "object" && (r.raw as { curveOnly?: boolean }).curveOnly === true)) return r;
  const reason = `${r.status.label} lists only the pump.fun curve pool, which has graduated (dead market); its AMM pool is not indexed there yet`;
  const data = { ...r.data } as Record<string, unknown>;
  const nulled: Record<string, string> = {};
  for (const k of CURVE_MARKET_FIELDS) {
    if (k in data) delete data[k];
    nulled[k] = reason;
  }
  data.nullReasons = { ...(r.data.nullReasons ?? {}), ...nulled };
  return {
    ...r,
    data: data as Partial<TokenSnapshot>,
    status: { ...r.status, state: r.status.state === "ok" ? "partial" : r.status.state, message: `${r.status.message ?? ""} · curve pool only (graduated) — market fields not used`.replace(/^ · /, "") },
  };
}

/** Liquidity fields an indexer derives from the pools it lists. */
const POOL_LIQUIDITY_FIELDS = ["liquidityUsd", "mainPoolLiquidityUsd", "mainPoolSharePct", "liquidityTotalUsd"] as const;

type IndexedPool = { id: string; liquidityUsd: number | null; volume24hUsd: number | null };

/** The pools an indexer listed, read from its raw payload (GeckoTerminal `pools`, DexScreener `pairs`). */
export function indexedPools(r: AdapterResult): IndexedPool[] | null {
  const raw = r.raw as { pools?: PoolRow[]; pairs?: { pairAddress: string; liquidity?: { usd?: number }; volume?: { h24?: number } }[] } | undefined;
  if (r.status.id === "geckoterminal" && Array.isArray(raw?.pools)) return raw.pools.map((p) => ({ id: p.id.toLowerCase(), liquidityUsd: p.liquidityUsd, volume24hUsd: p.volume24hUsd }));
  if (r.status.id === "dexscreener" && Array.isArray(raw?.pairs))
    return raw.pairs.map((p) => ({ id: p.pairAddress.toLowerCase(), liquidityUsd: typeof p.liquidity?.usd === "number" ? p.liquidity.usd : null, volume24hUsd: typeof p.volume?.h24 === "number" ? p.volume.h24 : null }));
  return null;
}

/**
 * An indexer that lists only dust pools (every one with a known liquidity under ACTIVE_MIN_LIQ) while the token's
 * real market is elsewhere describes a side pool, not the token: its liquidity / volume / buyer figures would win
 * every "most conservative" dispute (MOE on Monad, 2026-11-22: GeckoTerminal saw only a $4.41 v4 pool, not the
 * $12,962 nad.fun DEX pool DexScreener lists, and scored "1 buyer, $4.41 liquidity — dead launch" against
 * nad.fun's 400 buyers). The real market is elsewhere when another indexer lists a pool ≥ ACTIVE_MIN_LIQ this one
 * does not list, or the token is still on a launchpad curve (nad.fun) whose own 24h volume is larger. Its market
 * fields become null with the reason; a drained market is not hidden (the same pool, drained, matches by id).
 */
/** Every pool this indexer lists has a known liquidity under ACTIVE_MIN_LIQ. */
export function listsOnlyDust(r: AdapterResult): boolean {
  const own = indexedPools(r);
  return !!own?.length && own.every((p) => p.liquidityUsd != null && p.liquidityUsd < ACTIVE_MIN_LIQ);
}

/**
 * The fields a dust-only listing must not leave in the last-good store: served stale on a later outage they would
 * come back without the pool list that dropDustOnlyMarkets checks.
 */
export function withoutMarketFields(data: Partial<TokenSnapshot>): Partial<TokenSnapshot> {
  const out = { ...data } as Record<string, unknown>;
  for (const k of [...CURVE_MARKET_FIELDS, ...POOL_LIQUIDITY_FIELDS]) delete out[k];
  return out as Partial<TokenSnapshot>;
}

export function dropDustOnlyMarkets(results: AdapterResult[], curve?: { label: string; volume24hUsd: number | null } | null): AdapterResult[] {
  const lists = new Map(results.map((r) => [r, indexedPools(r)] as const));
  return results.map((r) => {
    const own = lists.get(r);
    if (!own || !listsOnlyDust(r)) return r;
    const ownIds = new Set(own.map((p) => p.id));
    const elsewhere = [...lists.entries()]
      .filter(([o, l]) => o !== r && l)
      .flatMap(([o, l]) => l!.map((p) => ({ ...p, src: o.status.label })))
      .filter((p) => p.liquidityUsd != null && p.liquidityUsd >= ACTIVE_MIN_LIQ && !ownIds.has(p.id))
      .sort((a, b) => b.liquidityUsd! - a.liquidityUsd!)[0];
    const ownVol = own.every((p) => p.volume24hUsd != null) ? own.reduce((a, p) => a + p.volume24hUsd!, 0) : null;
    const onCurve = !elsewhere && curve && curve.volume24hUsd != null && ownVol != null && curve.volume24hUsd > ownVol;
    if (!elsewhere && !onCurve) return r;
    const top = Math.max(...own.map((p) => p.liquidityUsd!));
    const where = elsewhere
      ? `the main market is pool ${elsewhere.id.slice(0, 10)}… (${usd(elsewhere.liquidityUsd!)} liquidity on ${elsewhere.src}), which ${r.status.label} does not index`
      : `the token still trades on the ${curve!.label} curve (${usd(curve!.volume24hUsd!)} 24h volume there)`;
    const reason = `${r.status.label} lists only ${own.length} dust pool${own.length > 1 ? "s" : ""} (largest ${usd(top)} liquidity) — ${where}; its market figures are not the token's`;
    const data = { ...r.data } as Record<string, unknown>;
    const nulled: Record<string, string> = {};
    for (const k of [...CURVE_MARKET_FIELDS, ...POOL_LIQUIDITY_FIELDS]) {
      if (k in data) delete data[k];
      nulled[k] = reason;
    }
    data.nullReasons = { ...(r.data.nullReasons ?? {}), ...nulled };
    return {
      ...r,
      data: data as Partial<TokenSnapshot>,
      status: { ...r.status, state: r.status.state === "ok" ? "partial" : r.status.state, message: `${r.status.message ?? ""} · dust pools only — market fields not used`.replace(/^ · /, "") },
    };
  });
}
