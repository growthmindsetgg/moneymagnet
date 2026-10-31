import type { Chain, Tier } from "@/lib/types";

export interface RecentItem {
  chain: Chain;
  address: string;
  symbol: string | null;
  tier: Tier;
  score?: number | null;
}

const KEY = "hoodtier:recent";
const TIER_RANK: Record<Tier, number> = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5, U: 6 };

/** Best first: by tier, then by displayed score. */
export function sortRecent(items: RecentItem[]): RecentItem[] {
  return [...items].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || (b.score ?? -1) - (a.score ?? -1));
}

export function loadRecent(): RecentItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? sortRecent(v.slice(0, 8)) : [];
  } catch {
    return [];
  }
}

export function pushRecent(item: RecentItem) {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as RecentItem[];
    const list = (Array.isArray(raw) ? raw : []).filter((r) => !(r.chain === item.chain && r.address === item.address));
    localStorage.setItem(KEY, JSON.stringify([item, ...list].slice(0, 8)));
  } catch {
    // storage unavailable (private mode) — recents are a convenience only
  }
}
