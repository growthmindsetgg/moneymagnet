import type { AdapterResult, HolderRow, TokenSnapshot } from "../types";
import { mcpCall, num } from "./http";

/**
 * pump.fun intel feed. This is the backend behind the `@three-ws/pumpfun-mcp` server
 * (`npx -y @three-ws/pumpfun-mcp`): that package is only a stdio bridge to a stateless
 * JSON-RPC MCP endpoint at https://three.ws/api/pump-fun-mcp, with no API key. We call it
 * server-side directly — no bridge process is needed.
 *
 * `get_coin_intel` holds the engine's launch observation (first ~90s of trading). Its 0–1 scores
 * are rescaled to 0–100 for the factor thresholds; nothing absent from the response is filled in.
 */
export const DEFAULT_FEED_URL = "https://three.ws/api/pump-fun-mcp";

interface CoinIntel {
  found?: boolean;
  creator?: string | null;
  first_seen_at?: string | null;
  observation_seconds?: number | null;
  snipe_ratio?: number | null;
  bundle_score?: number | null;
  organic_score?: number | null;
  timing_entropy?: number | null;
  dev_buy_sol?: number | null;
  dev_sold?: boolean | null;
  unique_buyers?: number | null;
  unique_sellers?: number | null;
  buy_volume_sol?: number | null;
  has_socials?: boolean | null;
  twitter?: string | null;
  telegram?: string | null;
  website?: string | null;
  risk_flags?: unknown[];
  /** Oracle block; `reasons` entries are strings or { pillar, text } objects. */
  oracle?: { reasons?: unknown[] } | null;
  verdict?: { label?: string } | null;
  top_wallets?: { wallet: string; is_creator: boolean; buy_sol: number; sell_sol: number }[];
}

const FEED_METRICS = ["snipeRatioPct", "bundleScore", "organicScore", "timingEntropy", "devBuySol", "devBuySharePct", "feesSol"] as const;

/** Feed fields arrive as strings or as objects ({ pillar, text } etc.): always render text, never throw. */
export const textOf = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" ? String((v as { text?: unknown }).text ?? JSON.stringify(v)) : String(v));
/** One malformed field must never sink the snapshot: a getter that throws yields null. */
const safe = <T,>(get: () => T): T | null => {
  try {
    const v = get();
    return typeof v === "number" && !Number.isFinite(v) ? null : v;
  } catch {
    return null;
  }
};

const pct = (v: unknown) => {
  const n = num(v);
  return n == null ? null : n <= 1 ? n * 100 : n;
};

interface TokenDetails {
  supply?: string;
  decimals?: number;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
}
interface FeedHolders {
  holders?: { address: string; uiAmount: number; percent: number }[];
}

/**
 * The feed's on-chain reads: mint/freeze authority and supply (get_token_details), and the
 * largest token accounts (get_token_holders). The feed's own `percent` is relative to the listed
 * accounts, not to supply, so only raw amounts are kept and shares are computed against supply.
 */
function onchainSlice(details: TokenDetails | null, holders: FeedHolders | null): Partial<TokenSnapshot> {
  const out: Partial<TokenSnapshot> = {};
  if (details && "mintAuthority" in details) out.mintAuthority = details.mintAuthority !== null;
  if (details && "freezeAuthority" in details) out.freezeAuthority = details.freezeAuthority !== null;
  if (details?.supply && details.decimals != null) out.totalSupply = Number(details.supply) / 10 ** details.decimals;
  const rows = (holders?.holders ?? []).filter((h) => h.uiAmount > 0);
  if (rows.length) {
    out.holders = rows.map((h): HolderRow => ({ address: h.address, qty: h.uiAmount, pct: null, buys: null, sells: null, isContract: null }));
  }
  return out;
}

export async function pumpfeed(mint: string): Promise<AdapterResult> {
  const t0 = Date.now();
  const url = process.env.PUMPFUN_FEED_URL || DEFAULT_FEED_URL;
  const key = process.env.PUMPFUN_FEED_KEY;
  const [intel, details, holders] = await Promise.all([
    mcpCall<CoinIntel>(url, "get_coin_intel", { mint, network: "mainnet" }, 20_000, key),
    mcpCall<TokenDetails>(url, "get_token_details", { mint }, 15_000, key).catch(() => null),
    mcpCall<FeedHolders>(url, "get_token_holders", { mint, limit: 20, network: "mainnet" }, 15_000, key).catch(() => null),
  ]);
  const chainData = onchainSlice(details, holders);
  if (!intel.found) {
    const reason = "three.ws has no launch observation for this mint (it only records pump.fun launches it watched live)";
    return {
      status: { id: "pumpfeed", label: "pump.fun intel feed", state: "partial", message: reason, ms: Date.now() - t0, url: "https://three.ws" },
      data: { ...chainData, nullReasons: Object.fromEntries(FEED_METRICS.map((m) => [m, reason])) },
      raw: intel,
    };
  }
  const window = `three.ws launch observation, first ${intel.observation_seconds ?? "?"}s from ${intel.first_seen_at?.slice(0, 16) ?? "?"}Z`;
  const wallets = Array.isArray(intel.top_wallets) ? intel.top_wallets : [];
  const creatorBuy = safe(() => wallets.filter((w) => w?.is_creator).reduce((a, w) => a + (num(w.buy_sol) ?? 0), 0)) ?? 0;
  const buyVol = safe(() => num(intel.buy_volume_sol));
  const data: Partial<TokenSnapshot> = {
    ...chainData,
    deployerAddress: safe(() => (typeof intel.creator === "string" ? intel.creator : null)),
    deployerHasSold: safe(() => (typeof intel.dev_sold === "boolean" ? intel.dev_sold : null)),
    snipeRatioPct: safe(() => pct(intel.snipe_ratio)),
    bundleScore: safe(() => pct(intel.bundle_score)),
    organicScore: safe(() => pct(intel.organic_score)),
    timingEntropy: safe(() => num(intel.timing_entropy)),
    devBuySol: safe(() => num(intel.dev_buy_sol)),
    // Dev share of all SOL spent on buys during the observation.
    devBuySharePct: buyVol && buyVol > 0 && wallets.length ? (creatorBuy / buyVol) * 100 : null,
    feedWindow: window,
    nullReasons: { feesSol: "three.ws intel has no fees field", feesPerMcap15k: "three.ws intel has no fees field" },
  };
  const flags = safe(() => (Array.isArray(intel.risk_flags) ? intel.risk_flags.map(textOf) : [])) ?? [];
  const reasons = safe(() => (Array.isArray(intel.oracle?.reasons) ? intel.oracle!.reasons!.map(textOf) : [])) ?? [];
  const missing = FEED_METRICS.filter((m) => (data as Record<string, unknown>)[m] == null && m !== "feesSol");
  for (const m of missing) (data.nullReasons as Record<string, string>)[m] = "three.ws intel did not return this field";
  return {
    status: {
      id: "pumpfeed",
      label: "pump.fun intel feed",
      state: "ok",
      message: `three.ws verdict ${safe(() => textOf(intel.verdict?.label ?? "?")) ?? "?"}${flags.length ? ` · flags: ${flags.join(", ")}` : ""}${reasons.length ? ` · oracle: ${reasons.join("; ").slice(0, 200)}` : ""} · ${window}`,
      ms: Date.now() - t0,
      url: `https://three.ws/oracle?mint=${mint}`,
    },
    data,
    raw: intel,
  };
}

/** How long after the token's creation a launch observation may start and still describe its launch. */
const MAX_OBSERVATION_LAG_MS = 24 * 3_600_000;

/**
 * three.ws sometimes returns an observation that started long after the token was created (e.g.
 * a 2-year-old mint with intel "first seen" 12 days ago under another name). That observation
 * is not of this token's launch, so its launch metrics are dropped; the feed's on-chain reads stay.
 */
export function rejectLateObservation(result: AdapterResult, createdAt: string | null): AdapterResult {
  const intel = result.raw as CoinIntel | undefined;
  if (!intel?.found || !intel.first_seen_at || !createdAt) return result;
  const lag = Date.parse(intel.first_seen_at) - Date.parse(createdAt);
  if (!(lag > MAX_OBSERVATION_LAG_MS)) return result;
  const reason = `three.ws observation started ${Math.round(lag / 86_400_000)}d after the token's creation — not this token's launch`;
  const keep: (keyof TokenSnapshot)[] = ["mintAuthority", "freezeAuthority", "totalSupply", "holders"];
  const data: Partial<TokenSnapshot> = Object.fromEntries(keep.filter((k) => result.data[k] != null).map((k) => [k, result.data[k]]));
  data.nullReasons = Object.fromEntries([...FEED_METRICS, "deployerAddress", "deployerHasSold"].map((m) => [m, reason]));
  return { ...result, status: { ...result.status, state: "partial", message: `${reason} · kept on-chain reads only` }, data };
}
