import type { Chain } from "../types";

/** Age buckets the Time Machine compares at (hours after creation). */
export const BUCKETS = [1, 6, 24, 72] as const;
export type Bucket = (typeof BUCKETS)[number];

/** Fields of a reconstructed snapshot. Every one is null when it cannot be rebuilt from real history. */
export interface BucketFields {
  holders: number | null;
  top10SharePct: number | null;
  earlyRetentionPct: number | null;
  buyers: number | null;
  sellers: number | null;
  buyerSellerRatio: number | null;
  devBuySharePct: number | null;
  devSoldPct: number | null;
  freshWalletSharePct: number | null;
  fundingClusterMax: number | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  volMc: number | null;
  drawdownPct: number | null;
  peakMultiple: number | null;
}
export type FieldName = keyof BucketFields;

export const FIELD_NAMES: FieldName[] = [
  "holders",
  "top10SharePct",
  "earlyRetentionPct",
  "buyers",
  "sellers",
  "buyerSellerRatio",
  "devBuySharePct",
  "devSoldPct",
  "freshWalletSharePct",
  "fundingClusterMax",
  "priceUsd",
  "mcapUsd",
  "liquidityUsd",
  "volume24hUsd",
  "volMc",
  "drawdownPct",
  "peakMultiple",
];

export const FIELD_LABELS: Record<FieldName, string> = {
  holders: "Holders",
  top10SharePct: "Top-10 share (ex-LP)",
  earlyRetentionPct: "Early-buyer retention",
  buyers: "Unique buyers",
  sellers: "Unique sellers",
  buyerSellerRatio: "Buyers / sellers",
  devBuySharePct: "Dev buy share",
  devSoldPct: "Dev sold",
  freshWalletSharePct: "Fresh wallets in top 10",
  fundingClusterMax: "Largest same-funder cluster (top 10)",
  priceUsd: "Price",
  mcapUsd: "Market cap",
  liquidityUsd: "Liquidity",
  volume24hUsd: "Volume (trailing 24h)",
  volMc: "VOL / MC",
  drawdownPct: "Drawdown from peak",
  peakMultiple: "Peak / first price",
};

export interface BucketSnapshot {
  bucket: Bucket;
  /** ISO time of the bucket edge (creation + bucket hours). */
  at: string;
  fields: BucketFields;
  /** Field → why it is null. */
  nulls: Partial<Record<FieldName, string>>;
}

export interface Reconstruction {
  chain: Chain;
  address: string;
  symbol: string | null;
  name: string | null;
  createdAt: string | null;
  creationTx: string | null;
  creator: string | null;
  launchpad: string | null;
  /** Field → how it was obtained (same for every bucket). */
  methods: Partial<Record<FieldName, string>>;
  buckets: BucketSnapshot[];
  /** Notes about budgets, gaps and sources. */
  notes: string[];
  builtAt: string;
  buildMs: number;
}

export interface Archetype extends Reconstruction {
  kind: "winner" | "rug";
  /** Why it is in the library, e.g. "named meme", "three.ws top graduation by peak mcap", "ScanHood honeypot". */
  source: string;
  peakMcapUsd: number | null;
}

export interface ArchetypeLibrary {
  version: 1;
  builtAt: string;
  buildMs: number;
  archetypes: Archetype[];
  /** Candidates that could not be built, with the reason. */
  skipped: { chain: Chain; address: string; label: string; reason: string }[];
}

// --- Event model shared by both chains ------------------------------------------------------

/** A change of one owner's token balance. `pos` orders events (block number or unix seconds). */
export interface BalanceDelta {
  pos: number;
  owner: string;
  delta: number;
}

export interface Trade {
  pos: number;
  /** Unix seconds, when known (Solana). */
  t?: number;
  wallet: string;
  side: "buy" | "sell";
  tokens: number;
}

export interface PricePoint {
  /** Unix seconds. */
  t: number;
  priceUsd: number;
  /** USD volume traded in this point's interval, when known. */
  volumeUsd: number | null;
}

export interface WalletOrigin {
  /** Unix seconds of the wallet's first-ever transaction. */
  firstT: number | null;
  funder: string | null;
}
