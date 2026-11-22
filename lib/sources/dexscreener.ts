import type { AdapterResult, Chain } from "../types";
import { fetchJson, num } from "./http";
import { poolMetrics, pumpMarket, type PoolRow } from "./pools";

interface DsPair {
  chainId: string;
  dexId?: string;
  pairAddress: string;
  url: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  txns?: { h1?: { buys: number; sells: number }; h6?: { buys: number; sells: number }; h24?: { buys: number; sells: number } };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

const DS_CHAIN: Record<Chain, string> = { robinhood: "robinhood", solana: "solana", base: "base", monad: "monad", ethereum: "ethereum" };

/** A pair without the display-only fields (image URLs, price-change history). */
function slimPair(p: DsPair) {
  const x = p as DsPair & { info?: { websites?: unknown; socials?: unknown }; boosts?: unknown; labels?: unknown; url?: string };
  return {
    chainId: p.chainId,
    dexId: p.dexId,
    url: x.url,
    pairAddress: p.pairAddress,
    labels: x.labels,
    baseToken: p.baseToken,
    quoteToken: p.quoteToken,
    priceUsd: p.priceUsd,
    txns: p.txns,
    volume: p.volume,
    liquidity: p.liquidity,
    fdv: p.fdv,
    marketCap: p.marketCap,
    pairCreatedAt: p.pairCreatedAt,
    ...(x.info ? { info: { websites: x.info.websites, socials: x.info.socials } } : {}),
    ...(x.boosts ? { boosts: x.boosts } : {}),
  };
}

export async function dexscreener(chain: Chain, address: string): Promise<AdapterResult> {
  const t0 = Date.now();
  const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`;
  const res = await fetchJson<{ pairs: DsPair[] | null }>(url);
  const lower = address.toLowerCase();
  const pairs = (res.pairs ?? []).filter((p) => p.chainId === DS_CHAIN[chain]);
  const asBase = pairs.filter((p) => p.baseToken.address.toLowerCase() === lower);
  if (!pairs.length) {
    return {
      status: { id: "dexscreener", label: "DexScreener", state: "partial", message: "No pairs listed", ms: Date.now() - t0, url },
      data: {},
      raw: res,
    };
  }
  const rows: (PoolRow & { dexId?: string | null })[] = pairs.map((p) => ({
    dexId: p.dexId ?? null,
    id: p.pairAddress,
    name: `${p.baseToken.symbol}/${p.quoteToken.symbol}`,
    // A pair listed without a liquidity / volume object is unknown, never $0 (C1).
    liquidityUsd: num(p.liquidity?.usd),
    volume24hUsd: num(p.volume?.h24),
    createdAt: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
  }));
  const pump = chain === "solana" ? pumpMarket(rows) : null;
  // Ordering only (which pair names the token / gives the price): a pair without the figure sorts last.
  const top = [...(asBase.length ? asBase : pairs)].sort((a, b) => (num(b.liquidity?.usd) ?? -1) - (num(a.liquidity?.usd) ?? -1))[0];
  // The price move is read on the most-traded pair: a dust pool's stale price is not the market's move.
  const traded = [...asBase].sort((a, b) => (num(b.volume?.h24) ?? -1) - (num(a.volume?.h24) ?? -1))[0];
  // Trade counts are a token total only when every pair with this token as base carries its h24 counts.
  const counted = asBase.filter((p) => num(p.txns?.h24?.buys) != null && num(p.txns?.h24?.sells) != null);
  const allCounted = asBase.length > 0 && counted.length === asBase.length;
  const buys = allCounted ? asBase.reduce((a, p) => a + p.txns!.h24!.buys, 0) : null;
  const sells = allCounted ? asBase.reduce((a, p) => a + p.txns!.h24!.sells, 0) : null;
  // Upper bound on the time since the last trade: the shortest window (1h / 6h / 24h) with at least one trade,
  // stated only when every base pair reports that window's counts. Cross-checks an index that may have stalled.
  const windowKeys = [["h1", 1], ["h6", 6], ["h24", 24]] as const;
  const lastTradeWithinHours =
    windowKeys.find(([k]) => {
      if (!asBase.length || !asBase.every((p) => num(p.txns?.[k]?.buys) != null && num(p.txns?.[k]?.sells) != null)) return false;
      return asBase.reduce((a, p) => a + p.txns![k]!.buys + p.txns![k]!.sells, 0) > 0;
    })?.[1] ?? null;
  const pm = pump ? null : poolMetrics(rows);
  const nullReasons: Record<string, string> = { ...(pm?.nullReasons ?? {}), ...(pump?.nullReasons ?? {}) };
  if (asBase.length && !allCounted) {
    const why = `DexScreener: ${asBase.length - counted.length} of ${asBase.length} pairs are listed without 24h trade counts — the token's total is not stated`;
    for (const k of ["sells24h", "buyTxs24h", "sellTxs24h", "lastTradeHoursAgo"]) nullReasons[k] = why;
  }
  return {
    status: { id: "dexscreener", label: "DexScreener", state: "ok", message: `${pairs.length} pairs`, ms: Date.now() - t0, url: top.url },
    data: {
      ...(pump ? pump.metrics : pm),
      ...(Object.keys(nullReasons).length ? { nullReasons } : {}),
      poolAddresses: rows.map((r) => r.id.toLowerCase()).filter((id) => /^0x[0-9a-f]{40}$/.test(id) || !id.startsWith("0x")),
      name: top.baseToken.address.toLowerCase() === lower ? top.baseToken.name : null,
      symbol: top.baseToken.address.toLowerCase() === lower ? top.baseToken.symbol : null,
      priceUsd: top.baseToken.address.toLowerCase() === lower ? num(top.priceUsd) : null,
      // The most-traded pair's 24h change (since it opened when younger), with this token as base.
      priceChange24hPct: traded ? num(traded.priceChange?.h24) : null,
      fdvUsd: num(top.fdv ?? top.marketCap),
      sells24h: sells,
      buyTxs24h: buys,
      sellTxs24h: sells,
      // No trade in 24h on any pair (every pair reporting its counts) ⇒ the last trade is at least 24h ago (a lower bound).
      lastTradeHoursAgo: buys != null && sells != null && buys + sells === 0 ? 24 : null,
      lastTradeWithinHours,
      links: [{ label: "DexScreener", url: top.url }],
    },
    // Only what the sell sims, the research pool list and the social links read (no images / price history).
    raw: { pairs: pairs.slice(0, 25).map(slimPair), txns24h: { buys, sells }, ...(pump?.curveOnly ? { curveOnly: true } : {}) },
  };
}
