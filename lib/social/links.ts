import type { Chain } from "../types";
import { gtGet } from "../sources/gtClient";
import { SourceError } from "../sources/http";

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

const GT_NET: Record<Chain, string> = { robinhood: "robinhood", solana: "solana", base: "base", monad: "monad", ethereum: "eth" };

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
    // Default path: the shared GeckoTerminal client (background priority, budget + cool-down). Tests inject fetchImpl.
    const res = fetchImpl === fetch ? await gtResponse(`/networks/${GT_NET[chain]}/tokens/${address}/info`) : await fetchImpl(`https://api.geckoterminal.com/api/v2/networks/${GT_NET[chain]}/tokens/${address}/info`, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
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

/** A GeckoTerminal GET through the shared client, shaped like the bits of a fetch Response this file reads. */
async function gtResponse(path: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  try {
    const r = await gtGet(path, { priority: "background", timeoutMs: 8_000 });
    return { ok: true, status: 200, json: async () => r.body };
  } catch (e) {
    if (e instanceof SourceError && e.status) return { ok: false, status: e.status, json: async () => ({}) };
    throw e;
  }
}
