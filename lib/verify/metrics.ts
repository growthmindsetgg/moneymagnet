/**
 * Metrics that more than one source can supply, and how to resolve a disagreement.
 * `direction` names the most conservative reading: the one that makes the token look worse.
 * `tolerance` is the absolute floor under the 15% relative rule, so 0.01% vs 0.02% is not a dispute.
 */
export type Direction = "min" | "max" | "unsafe-true" | "unsafe-false" | "unknown";

export interface VerifiedMetricDef {
  metric: string;
  label: string;
  kind: "number" | "boolean" | "address";
  direction: Direction;
  /** Absolute difference that must also be exceeded for a numeric dispute. */
  tolerance?: number;
  /** Phrase for the resolution line, e.g. "lowest liquidity". */
  conservative: string;
}

export const RELATIVE_TOLERANCE = 0.15;

export const VERIFIED_METRICS: VerifiedMetricDef[] = [
  // Market
  { metric: "priceUsd", label: "Price", kind: "number", direction: "min", conservative: "lowest price" },
  { metric: "fdvUsd", label: "FDV / market cap", kind: "number", direction: "max", tolerance: 100, conservative: "highest FDV (thinnest liquidity and VOL/MC ratios)" },
  { metric: "liquidityUsd", label: "Liquidity (all pools)", kind: "number", direction: "min", tolerance: 100, conservative: "lowest liquidity" },
  { metric: "mainPoolLiquidityUsd", label: "Main-pool liquidity", kind: "number", direction: "min", tolerance: 100, conservative: "lowest liquidity" },
  { metric: "volume24hUsd", label: "24h volume", kind: "number", direction: "min", tolerance: 100, conservative: "lowest volume" },
  { metric: "buyers24h", label: "24h buyers", kind: "number", direction: "min", tolerance: 2, conservative: "fewest buyers" },
  { metric: "sellers24h", label: "24h sellers", kind: "number", direction: "max", tolerance: 2, conservative: "most sellers" },
  // Holders
  { metric: "totalSupply", label: "Total supply", kind: "number", direction: "min", conservative: "smallest supply (highest holder shares)" },
  { metric: "holderCount", label: "Holder count", kind: "number", direction: "min", tolerance: 2, conservative: "fewest holders" },
  { metric: "top10SharePct", label: "Top-10 share (ex-LP)", kind: "number", direction: "max", tolerance: 1, conservative: "highest concentration" },
  { metric: "top1SharePct", label: "Top holder share", kind: "number", direction: "max", tolerance: 0.5, conservative: "highest concentration" },
  { metric: "deployerAddress", label: "Creator / deployer", kind: "address", direction: "unknown", conservative: "unknown (sources name different wallets)" },
  { metric: "deployerHoldingPct", label: "Deployer holding", kind: "number", direction: "max", tolerance: 0.5, conservative: "highest deployer holding" },
  { metric: "deployerHasSold", label: "Deployer has sold", kind: "boolean", direction: "unsafe-true", conservative: "\"sold\" over \"not sold\"" },
  // Contract safety
  { metric: "mintAuthority", label: "Mint authority", kind: "boolean", direction: "unsafe-true", conservative: "authority present" },
  { metric: "freezeAuthority", label: "Freeze authority", kind: "boolean", direction: "unsafe-true", conservative: "authority present" },
  { metric: "sellable", label: "Sellable", kind: "boolean", direction: "unsafe-false", conservative: "\"not sellable\" over \"sellable\"" },
  { metric: "honeypot", label: "Honeypot", kind: "boolean", direction: "unsafe-true", conservative: "honeypot over clean" },
  { metric: "roundTripLossPct", label: "Round-trip loss", kind: "number", direction: "max", tolerance: 1, conservative: "highest loss" },
  { metric: "lpLockedPct", label: "LP locked", kind: "number", direction: "min", tolerance: 1, conservative: "least locked" },
  // Age: on-chain creation tx is truth; without it the youngest reading (Launch mode is stricter).
  { metric: "ageHours", label: "Age", kind: "number", direction: "min", tolerance: 0.25, conservative: "youngest (stricter Launch rules)" },
  // Launch mechanics. Snipe ratio and dev-buy share are NOT cross-checked: the feed measures its first-90s
  // observation and Helius the first two slots / whole curve history — different quantities, not readings of one.
  { metric: "devBuySol", label: "Dev buy (SOL)", kind: "number", direction: "max", tolerance: 0.1, conservative: "largest dev buy" },
  { metric: "uniqueBuyers", label: "Unique buyers", kind: "number", direction: "min", tolerance: 2, conservative: "fewest buyers" },
];

/** Source ids that read the chain directly. Their readings are truth over any indexer API. */
export const ONCHAIN_SOURCES = new Set(["rpc", "solana-rpc", "helius", "base-rpc", "monad-rpc"]);

/** Metrics a source supplies indirectly: counted for the source when it supplied any input. */
export const DERIVED_INPUTS: Record<string, string[]> = {
  top10SharePct: ["holders", "swapHolders", "top10SharePct"],
  top1SharePct: ["holders", "swapHolders", "top1SharePct"],
  ageHours: ["createdAt", "ageHours"],
  sellable: ["sellable", "honeypot"],
  honeypot: ["honeypot", "sellable"],
  deployerHasSold: ["deployerHasSold", "deployerSoldPct"],
  buyerSellerRatio: ["buyers24h", "sellers24h"],
};
