import type { AdapterResult, FakeSignal, HolderRow, TokenSnapshot } from "../types";
import { fetchJson, mcpCall, num, SourceError } from "./http";
import { withRetry, type Sleep } from "./retry";
import { fillFromStale, formatStaleAge, lastGoodKey, loadGood, saveGood } from "../stale";

const MCP = "https://hoodscan.co/mcp";

interface HsToken {
  identity?: { kind?: string; symbol?: string; name?: string; anchor?: { symbol?: string } | null; launchpad?: string | null };
  meme?: {
    fdvUsd?: number;
    liquidityUsd?: number;
    volume24hUsd?: number;
    createdAt?: string;
    ageHours?: number;
    flow24h?: { buyers: number; sellers: number; netUsd: number; smartBuyers: number; smartNetUsd: number };
  } | null;
  market?: {
    priceUsd?: number;
    h24?: { buyUsd: number; sellUsd: number; buyers?: number; sellers?: number; sells?: number };
    d7?: { buyUsd: number; sellUsd: number };
    topHolders?: { trader: string; qty: number; buys: number; sells: number }[];
  } | null;
}

interface HsEvidence {
  available?: boolean;
  item?: {
    metrics?: Record<string, number>;
    risk?: { level: string; suspicious: boolean; flags: string[] };
    signals?: string[];
    evidence?: string[];
  } | null;
  confidence?: { features?: Record<string, number> } | null;
}

interface HsStats {
  available?: boolean;
  priceUsd?: number;
  h24?: { buyUsd: number; sellUsd: number; sells?: number };
  d7?: { buyUsd: number; sellUsd: number };
  buyers24?: number;
  sellers24?: number;
  holders?: { trader: string; qty: number; buys: number; sells: number }[];
  recent?: HsTrade[];
}

interface HsTrade {
  tx: string;
  ts?: number;
  block: number;
  trader: string;
  side: "buy" | "sell";
  usd: number | null;
  amountIn: number;
  amountOut: number;
  tokenOut: { address: string };
}

const ratio = (buy?: number, sell?: number) =>
  buy != null && sell != null && buy + sell > 0 ? (buy - sell) / (buy + sell) : null;

/** Same-size and same-block patterns in the most recent swaps. */
export function tradePatterns(trades: HsTrade[], token: string) {
  const byTx = new Map<string, HsTrade>();
  for (const t of trades) if (!byTx.has(t.tx)) byTx.set(t.tx, t);
  const uniq = [...byTx.values()];
  if (uniq.length < 20) return { repeatedSizeSharePct: null, bundleSharePct: null, sample: uniq.length };

  const sizeKey = (t: HsTrade) => {
    const qty = t.tokenOut.address.toLowerCase() === token ? t.amountOut : t.amountIn;
    return `${t.side}:${Number(qty).toPrecision(4)}`;
  };
  const sizes = new Map<string, number>();
  for (const t of uniq) sizes.set(sizeKey(t), (sizes.get(sizeKey(t)) ?? 0) + 1);
  const repeated = uniq.filter((t) => (sizes.get(sizeKey(t)) ?? 0) >= 3).length;

  const blocks = new Map<number, HsTrade[]>();
  for (const t of uniq) blocks.set(t.block, [...(blocks.get(t.block) ?? []), t]);
  let bundled = 0;
  for (const list of blocks.values()) {
    const traders = new Set(list.map((t) => t.trader));
    if (list.length >= 3 && traders.size >= 2) bundled += list.length;
  }
  return {
    repeatedSizeSharePct: (repeated / uniq.length) * 100,
    bundleSharePct: (bundled / uniq.length) * 100,
    sample: uniq.length,
  };
}

type CallName = "get_token" | "evidence" | "trades" | "stats";

/** Which HoodScan calls can produce each field. A field missing live is served stale when one of them failed. */
const FIELD_SOURCES: Record<string, CallName[]> = {
  name: ["get_token"],
  symbol: ["get_token"],
  launchpad: ["get_token"],
  anchor: ["get_token"],
  fdvUsd: ["get_token", "evidence"],
  mainPoolLiquidityUsd: ["get_token"],
  createdAt: ["get_token", "evidence"],
  ageHours: ["get_token", "evidence"],
  priceUsd: ["get_token", "stats"],
  buyers24h: ["get_token", "stats", "evidence"],
  sellers24h: ["get_token", "stats", "evidence"],
  netFlowRatio24h: ["evidence", "get_token", "stats"],
  netFlowUsd24h: ["get_token", "evidence"],
  netFlowRatio7d: ["get_token", "stats"],
  singleTradeWalletSharePct: ["evidence"],
  tradesPerWallet: ["evidence"],
  smartMoneyNetUsd: ["get_token", "evidence"],
  smartBuyers: ["get_token", "evidence"],
  earlyCohortSize: ["evidence"],
  earlyExitRatePct: ["evidence"],
  repeatedSizeSharePct: ["trades", "stats"],
  bundleSharePct: ["trades", "stats"],
  washFlag: ["evidence"],
  swapHolders: ["stats", "get_token"],
  first5mSharePct: ["evidence"],
  makersCount: ["evidence"],
  sells24h: ["get_token", "stats"],
  isLaunchpad: ["get_token"],
  // The newest swap comes from the trades list or the stats endpoint's recent swaps (aged by its staleness on refill).
  lastTradeHoursAgo: ["trades", "stats"],
};

export interface HoodscanOptions {
  /** Test/e2e hook: every HoodScan call fails like a busy index (HTTP 503). */
  simulateDown?: boolean;
  sleep?: Sleep;
  now?: () => number;
  /** Total time allowed for HoodScan including retries. */
  budgetMs?: number;
}

export async function hoodscan(address: string, opts: HoodscanOptions = {}): Promise<AdapterResult> {
  const t0 = Date.now();
  const deadline = t0 + (opts.budgetMs ?? 45_000);
  const call = <T,>(fn: () => Promise<T>) =>
    withRetry(
      () => {
        if (opts.simulateDown) throw new SourceError("HTTP 503: trade index is busy (simulated)", 503);
        return fn();
      },
      { sleep: opts.sleep, deadline },
    );
  const a = address.toLowerCase();
  const page = `https://hoodscan.co/token/${a}`;
  // HoodScan latency varies with its cache; the swap-index stats endpoint overlaps get_token
  // (flow, holders, recent swaps), so either one is enough for the core metrics.
  const [tok, ev, trades, stats] = await Promise.allSettled([
    call(() => mcpCall<HsToken>(MCP, "get_token", { address: a }, 15_000)),
    call(() => mcpCall<HsEvidence>(MCP, "get_token_evidence", { address: a, window_minutes: 1440 }, 15_000)),
    call(() => fetchJson<{ items?: HsTrade[] }>(`https://hoodscan.co/swaps-api/trades?token=${a}&limit=100`, { timeoutMs: 15_000 })),
    call(() => fetchJson<HsStats>(`https://hoodscan.co/swaps-api/token/${a}`, { timeoutMs: 15_000 })),
  ]);
  const calls = [tok, ev, trades, stats];

  const t = tok.status === "fulfilled" ? tok.value : {};
  const e = ev.status === "fulfilled" ? ev.value : {};
  const st: HsStats = stats.status === "fulfilled" && stats.value.available !== false ? stats.value : {};
  const f = e.confidence?.features ?? {};
  const m = e.item?.metrics ?? {};
  const flow = t.meme?.flow24h;
  const h24 = t.market?.h24 ?? st.h24;
  const d7 = t.market?.d7 ?? st.d7;

  const holderSrc = st.holders?.length ? st.holders : (t.market?.topHolders ?? []);
  const swapHolders: HolderRow[] = holderSrc.map((h) => ({
    address: h.trader,
    qty: h.qty,
    pct: null,
    buys: h.buys,
    sells: h.sells,
    isContract: null,
  }));

  const signals: FakeSignal[] = [];
  if (e.item?.risk?.suspicious) {
    signals.push({ kind: "wash", level: "danger", text: "HoodScan flags wash-like concentration or churn", source: "HoodScan" });
  }
  for (const flag of e.item?.risk?.flags ?? []) {
    signals.push({ kind: "other", level: "info", text: `HoodScan risk flag: ${flag.replace(/_/g, " ")}`, source: "HoodScan" });
  }

  let patterns: ReturnType<typeof tradePatterns> | null = null;
  const tradeList = trades.status === "fulfilled" && trades.value.items?.length ? trades.value.items : st.recent;
  if (tradeList?.length) {
    patterns = tradePatterns(tradeList, a);
    if (patterns.repeatedSizeSharePct != null && patterns.repeatedSizeSharePct >= 20) {
      signals.push({ kind: "bot", level: "warn", text: `${patterns.repeatedSizeSharePct.toFixed(0)}% of last ${patterns.sample} swaps repeat an identical size`, source: "HoodScan swaps" });
    }
    if (patterns.bundleSharePct != null && patterns.bundleSharePct >= 20) {
      signals.push({ kind: "bundle", level: "warn", text: `${patterns.bundleSharePct.toFixed(0)}% of last ${patterns.sample} swaps share a block with other wallets`, source: "HoodScan swaps" });
    }
  }

  const buyers = flow?.buyers ?? t.market?.h24?.buyers ?? st.buyers24 ?? num(f.buyers);
  const sellers = flow?.sellers ?? t.market?.h24?.sellers ?? st.sellers24 ?? num(f.sellers);
  const earlyExit = num(f.earlyExitRate);

  const data: Partial<TokenSnapshot> = {
    assetKind: t.identity?.kind ?? null,
    name: t.identity?.name ?? null,
    symbol: t.identity?.symbol ?? null,
    launchpad: t.identity?.launchpad ?? null,
    anchor: t.identity?.anchor?.symbol ?? null,
    priceUsd: num(t.market?.priceUsd ?? st.priceUsd),
    fdvUsd: num(t.meme?.fdvUsd ?? m.marketCapUsd),
    // HoodScan reports the meme's own pool (`meme.pool`), i.e. main-pool liquidity — not the all-pool total.
    mainPoolLiquidityUsd: num(t.meme?.liquidityUsd),
    createdAt: t.meme?.createdAt ?? (m.firstSeenTs ? new Date(m.firstSeenTs * 1000).toISOString() : null),
    ageHours: num(t.meme?.ageHours ?? m.tokenAgeHours),
    buyers24h: buyers ?? null,
    sellers24h: sellers ?? null,
    netFlowRatio24h: num(m.netFlowRatio) ?? ratio(h24?.buyUsd, h24?.sellUsd),
    netFlowUsd24h: num(flow?.netUsd ?? m.netFlowUsd),
    netFlowRatio7d: ratio(d7?.buyUsd, d7?.sellUsd),
    singleTradeWalletSharePct: f.oneTradeWalletShare != null ? f.oneTradeWalletShare * 100 : null,
    tradesPerWallet: num(f.tradesPerWallet ?? m.tradesPerWallet),
    smartMoneyNetUsd: num(flow?.smartNetUsd ?? m.smartNetUsd),
    smartBuyers: num(flow?.smartBuyers ?? m.smartBuyers),
    earlyCohortSize: num(f.earlyCohort),
    earlyExitRatePct: earlyExit != null ? earlyExit * 100 : null,
    repeatedSizeSharePct: patterns?.repeatedSizeSharePct ?? null,
    bundleSharePct: patterns?.bundleSharePct ?? null,
    washFlag: e.item?.risk?.suspicious ? true : null,
    swapHolders,
    first5mSharePct: f.first5mShare != null ? f.first5mShare * 100 : null,
    makersCount: num(f.wallets),
    sells24h: num(t.market?.h24?.sells ?? st.h24?.sells),
    // Hours since the newest indexed swap (the swap index trails the chain by seconds).
    lastTradeHoursAgo: (() => {
      const newest = Math.max(0, ...(tradeList ?? []).map((x) => x.ts ?? 0));
      return newest > 0 ? Math.max(0, (Date.now() / 1000 - newest) / 3600) : null;
    })(),
    isLaunchpad: t.identity ? !!t.identity.launchpad : null,
    fakeSignals: signals,
    links: [{ label: "HoodScan", url: page }],
  };

  const names: CallName[] = ["get_token", "evidence", "trades", "stats"];
  const failedCalls = new Set(names.filter((_, i) => calls[i].status === "rejected"));
  const failedNames = calls.flatMap((c, i) =>
    c.status === "rejected" ? [`${names[i]}: ${String(c.reason?.name === "TimeoutError" ? "timed out" : c.reason?.message)}`] : [],
  );
  const raw = { token: t, evidence: { item: e.item, confidence: e.confidence }, stats: { h24: st.h24, d7: st.d7, holders: st.holders }, patterns };

  // Persist what came back live; patch what didn't from the last good values (≤ 6h).
  const now = opts.now?.() ?? Date.now();
  const key = lastGoodKey("hoodscan", "robinhood", a);
  const prev = await loadGood(key);
  if (failedCalls.size < names.length) await saveGood(key, prev, data, now);

  if (!failedCalls.size) {
    return {
      status: { id: "hoodscan", label: "HoodScan", state: "ok", message: `token + evidence + ${patterns?.sample ?? 0} swaps`, ms: Date.now() - t0, url: page },
      data,
      raw,
    };
  }

  // A field the answering calls did not deliver comes back stale when any call that can produce it failed
  // (e.g. the stats endpoint is down and get_token has no buyer count for this token).
  const allow = new Set(Object.entries(FIELD_SOURCES).filter(([, srcs]) => srcs.some((c) => failedCalls.has(c))).map(([k]) => k));
  const fill = fillFromStale(data, prev, now, allow);
  const staleCount = Object.keys(fill.staleFields).length;
  if (failedCalls.size === names.length && !staleCount) throw (tok as PromiseRejectedResult).reason;

  const failSummary = `${failedCalls.size}/4 calls failed (${failedNames.join("; ").slice(0, 160)})`;
  return {
    status: {
      id: "hoodscan",
      label: "HoodScan",
      state: staleCount ? "stale" : "partial",
      message: staleCount ? `stale (${formatStaleAge(fill.oldestMinutes ?? 0)} old) for ${staleCount} fields — ${failSummary}` : failSummary,
      ms: Date.now() - t0,
      url: page,
    },
    data: { ...fill.data, staleFields: fill.staleFields },
    raw,
  };
}
