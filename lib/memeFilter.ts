import type { Chain, TokenSnapshot } from "./types";
import { kvGet, kvSet } from "./kv";
import { mcpCall } from "./sources/http";
import { chainInfraEntry } from "./onchain/chainInfra";

/**
 * HoodTier scores memecoins only. Tokenized stocks/ETFs, stablecoins, wrapped/bridged/staked
 * assets and blue chips are refused with `rejected: "<what> — HoodTier scores memecoins only"`.
 */
export interface Eligibility {
  meme: boolean;
  reason: string | null;
  /** The user-facing refusal, e.g. "stock token — HoodTier scores memecoins only". */
  rejected?: string;
}

export const MEMES_ONLY = "HoodTier scores memecoins only";
/** The message for any input that is not a contract address (or where no token exists). */
export const NOT_A_CA = "paste a contract address";
const reject = (what: string, reason: string): Eligibility => ({ meme: false, reason, rejected: `${what} — ${MEMES_ONLY}` });

/** Solana non-memes by mint: wrapped SOL, stables, LSTs, majors. */
const SOLANA_NON_MEMES: Record<string, string> = {
  So11111111111111111111111111111111111111112: "wrapped SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC (stablecoin)",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT (stablecoin)",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD (stablecoin)",
  USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX: "USDH (stablecoin)",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP (protocol token)",
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL (liquid staking)",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "jitoSOL (liquid staking)",
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: "bSOL (liquid staking)",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY (protocol token)",
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: "PYTH (protocol token)",
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: "JTO (protocol token)",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH (Wormhole bridged)",
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: "cbBTC (wrapped BTC)",
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "WBTC (Wormhole bridged)",
};

/** HoodScan kinds that are definitely not memes ("unknown" is not a verdict and is let through). */
const NON_MEME_KINDS = new Set(["stock", "etf", "stablecoin", "stable"]);
const WRAPPED_NAME = /\b(wrapped|bridged?|bridge|staked|liquid staking|usd ?coin|tether|stablecoin)\b/i;
const STABLE_SYMBOL = /^(usd[ct]?|usdc|usdt|pyusd|usdh|dai|fdusd|usde|eurc)$/i;
/** Robinhood's tokenized stocks are named "<Company> • Robinhood Token". */
const STOCK_NAME = /robinhood token/i;
/** A Solana token with no launchpad origin above this market cap is a blue chip, not a memecoin. */
export const BLUE_CHIP_MCAP_USD = 1_000_000_000;

export interface StockRegistry {
  addresses: Set<string>;
  tickers: Set<string>;
}

/** HoodScan's tokenized stock / ETF roster (list_stocks), cached for a day. Empty on failure. */
export async function stockRegistry(): Promise<StockRegistry> {
  let rows = await kvGet<{ address: string; symbol: string }[]>("stocks:robinhood:v1");
  if (!rows) {
    const r = await mcpCall<{ items?: { address: string; symbol: string }[] }>("https://hoodscan.co/mcp", "list_stocks", { limit: 500 }, 20_000).catch(() => null);
    rows = (r?.items ?? []).map((x) => ({ address: x.address.toLowerCase(), symbol: x.symbol }));
    if (rows.length) await kvSet("stocks:robinhood:v1", rows, 86_400);
  }
  return { addresses: new Set(rows.map((r) => r.address)), tickers: new Set(rows.map((r) => r.symbol.toUpperCase())) };
}

/** Before any data is fetched: refuse known non-meme mints / registered stock tokens. */
export function knownNonMeme(chain: Chain, address: string, stocks?: StockRegistry): Eligibility | null {
  if (chain === "solana" && SOLANA_NON_MEMES[address]) return reject(SOLANA_NON_MEMES[address], `${SOLANA_NON_MEMES[address]} is not a meme`);
  if (chain === "robinhood" && stocks?.addresses.has(address.toLowerCase())) return reject("stock token", "listed in HoodScan's tokenized stock / ETF roster");
  // Base / Monad / Ethereum: quote tokens (WETH, WMON, USDC…) and registered blue chips in data/<chain>-infra.json.
  if (chain === "base" || chain === "monad" || chain === "ethereum") {
    const e = chainInfraEntry(chain, address);
    if (e && (e.role === "quote-token" || e.role === "quote-currency" || e.role === "blue-chip")) return reject(/USD|stable/i.test(e.label) ? "stablecoin" : /^W[A-Z]+\b|wrapped/i.test(e.label) ? "wrapped / bridged / stable asset" : "blue chip", `${e.label} is not a meme (registered in data/${chain}-infra.json)`);
  }
  return null;
}

/** After collection: refuse what the data says is not a meme. */
export function eligibility(s: TokenSnapshot, stocks?: StockRegistry): Eligibility {
  const known = knownNonMeme(s.chain, s.address, stocks);
  if (known) return known;
  if (s.tokenExists === false) return { meme: false, reason: s.chain === "solana" ? "no mint account exists at this address" : "no contract code at this address", rejected: NOT_A_CA };
  if (s.chain === "robinhood") {
    if (s.assetKind && NON_MEME_KINDS.has(s.assetKind.toLowerCase())) return reject("stock token", `HoodScan classifies this token as a ${s.assetKind}${s.name ? ` (${s.name})` : ""}`);
    if (s.name && STOCK_NAME.test(s.name)) return reject("stock token", `named "${s.name}" — the tokenized-stock naming pattern`);
    if (s.symbol && stocks?.tickers.has(s.symbol.toUpperCase()) && s.name && STOCK_NAME.test(s.name)) return reject("stock token", `ticker ${s.symbol} is a listed stock`);
  }
  if (s.name && WRAPPED_NAME.test(s.name)) return reject("wrapped / bridged / stable asset", `"${s.name}" is a wrapped, bridged, staked or stable asset`);
  if (s.symbol && STABLE_SYMBOL.test(s.symbol)) return reject("stablecoin", `${s.symbol} is a stablecoin`);
  if ((s.chain === "solana" || s.chain === "base" || s.chain === "monad") && !s.launchpad && !s.isLaunchpad && !s.address.endsWith("pump") && s.fdvUsd != null && s.fdvUsd > BLUE_CHIP_MCAP_USD) {
    return reject("blue chip", `no pump.fun / launchpad origin and a $${(s.fdvUsd / 1e9).toFixed(1)}B market cap`);
  }
  return { meme: true, reason: null };
}


