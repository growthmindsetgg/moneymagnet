import type { Chain } from "../types";

/** Official links the project registered with DexScreener / GeckoTerminal, and DexScreener's paid-boost flag. */
export interface OfficialLinks {
  x: string | null;
  telegram: string | null;
  websites: string[];
  /** An X community URL (x.com/i/communities/…) among the links. */
  xCommunity: string | null;
  /** DexScreener `boosts.active` > 0 on any pair; null when no pair was listed. */
  boosted: boolean | null;
  boostsActive: number | null;
  sources: string[];
  nullReasons: Record<string, string>;
}

const GT_NET: Record<Chain, string> = { robinhood: "robinhood", solana: "solana", base: "base", monad: "monad" };

interface DsPair {
  info?: { websites?: { url: string }[]; socials?: { type?: string; url: string }[] };
  boosts?: { active?: number };
}

export async function officialLinks(chain: Chain, address: string, dexRaw: { pairs?: DsPair[] } | undefined, fetchImpl: typeof fetch = fetch): Promise<OfficialLinks> {
  const urls = new Set<string>();
  const sources: string[] = [];
  const nullReasons: Record<string, string> = {};
  const pairs = dexRaw?.pairs ?? [];
  let boostsActive: number | null = null;
  if (pairs.length) {
    sources.push("DexScreener");
    boostsActive = Math.max(0, ...pairs.map((p) => p.boosts?.active ?? 0));
    for (const p of pairs) {
      for (const s of p.info?.socials ?? []) urls.add(s.url);
      for (const w of p.info?.websites ?? []) urls.add(w.url);
    }
  } else nullReasons.boosted = "DexScreener lists no pair for this token";
  try {
    const res = await fetchImpl(`https://api.geckoterminal.com/api/v2/networks/${GT_NET[chain]}/tokens/${address}/info`, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
    if (res.ok) {
      const a = ((await res.json()) as { data?: { attributes?: { websites?: string[]; twitter_handle?: string | null; telegram_handle?: string | null } } }).data?.attributes;
      sources.push("GeckoTerminal");
      for (const w of a?.websites ?? []) urls.add(w);
      if (a?.twitter_handle) urls.add(`https://x.com/${a.twitter_handle}`);
      if (a?.telegram_handle) urls.add(`https://t.me/${a.telegram_handle}`);
    } else nullReasons.gecko = `GeckoTerminal token info HTTP ${res.status}`;
  } catch (err) {
    nullReasons.gecko = `GeckoTerminal token info failed: ${(err as Error).message.slice(0, 60)}`;
  }
  const list = [...urls];
  const isX = (u: string) => /^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(u);
  const community = list.find((u) => isX(u) && /\/i\/communities\//i.test(u)) ?? null;
  const x = list.find((u) => isX(u) && !/\/i\/communities\//i.test(u)) ?? null;
  const telegram = list.find((u) => /^https?:\/\/(t\.me|telegram\.me)\//i.test(u)) ?? null;
  if (!sources.length) nullReasons.links = "neither DexScreener nor GeckoTerminal answered";
  return {
    x,
    telegram,
    websites: list.filter((u) => !isX(u) && u !== telegram),
    xCommunity: community,
    boosted: boostsActive == null ? null : boostsActive > 0,
    boostsActive,
    sources,
    nullReasons,
  };
}
