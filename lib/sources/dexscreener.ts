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
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

const DS_CHAIN: Record<Chain, string> = { robinhood: "robinhood", solana: "solana", base: "base", monad: "monad" };

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
    liquidityUsd: p.liquidity?.usd ?? 0,
    volume24hUsd: p.volume?.h24 ?? 0,
    createdAt: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
  }));
  const pump = chain === "solana" ? pumpMarket(rows) : null;
  const top = [...(asBase.length ? asBase : pairs)].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const buys = asBase.reduce((a, p) => a + (p.txns?.h24?.buys ?? 0), 0);
  const sells = asBase.reduce((a, p) => a + (p.txns?.h24?.sells ?? 0), 0);
  return {
    status: { id: "dexscreener", label: "DexScreener", state: "ok", message: `${pairs.length} pairs`, ms: Date.now() - t0, url: top.url },
    data: {
      ...(pump ? pump.metrics : poolMetrics(rows)),
      ...(pump && Object.keys(pump.nullReasons).length ? { nullReasons: pump.nullReasons } : {}),
      poolAddresses: rows.map((r) => r.id.toLowerCase()).filter((id) => /^0x[0-9a-f]{40}$/.test(id) || !id.startsWith("0x")),
      name: top.baseToken.address.toLowerCase() === lower ? top.baseToken.name : null,
      symbol: top.baseToken.address.toLowerCase() === lower ? top.baseToken.symbol : null,
      priceUsd: top.baseToken.address.toLowerCase() === lower ? num(top.priceUsd) : null,
      fdvUsd: num(top.fdv ?? top.marketCap),
      sells24h: asBase.length ? sells : null,
      buyTxs24h: asBase.length ? buys : null,
      sellTxs24h: asBase.length ? sells : null,
      // No trade in 24h on any pair ⇒ the last trade is at least 24h ago (a lower bound, not exact).
      lastTradeHoursAgo: asBase.length && buys + sells === 0 ? 24 : null,
      links: [{ label: "DexScreener", url: top.url }],
    },
    // Only what the sell sims, the research pool list and the social links read (no images / price history).
    raw: { pairs: pairs.slice(0, 25).map(slimPair), txns24h: { buys, sells } },
  };
}
