import type { Chain } from "@/lib/types";

/**
 * v3 §1d fixtures, picked live on 2026-10-29 (docs/chains/<chain>-fixtures.json has why each was chosen).
 * `expectTiers` is what the RECORDED snapshot must score; the production matrix (scripts/v3-matrix.mjs)
 * checks the live analysis against `liveExpect` (looser: markets move, launches age into Established).
 */
export interface V3Fixture {
  name: string;
  chain: Chain;
  address: string;
  kind: "established" | "launch" | "rug" | "blue-chip";
  note: string;
  expectTiers: string[];
}

export const V3_FIXTURES: V3Fixture[] = [
  { name: "base-brett", chain: "base", address: "0x532f27101965dd16442e59d40670faf5ebb142e4", kind: "established", note: "BRETT — largest established Base meme ($48M FDV, $2.1M liquidity, 26 pairs).", expectTiers: ["A", "B", "C"] },
  { name: "base-toshi", chain: "base", address: "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4", kind: "established", note: "TOSHI — established Base meme on Uniswap v3/v4 and Aerodrome.", expectTiers: ["A", "B", "C"] },
  { name: "base-99", chain: "base", address: "0xd44bc820aba3a4965cf6082661bb9ec543524619", kind: "launch", note: "'99' — Clanker v4 launch (< 24h at pick, created through a wrapper; detected by its Clanker v4 hook).", expectTiers: ["A", "B", "C", "D", "F", "U"] },
  { name: "base-adfo", chain: "base", address: "0xf57b2065428ab1c1afb8ba4c1ec933ff8c6f9a82", kind: "launch", note: "ADFO — Zora coin launch (< 24h at pick; detected by its getPoolKey() Zora hook).", expectTiers: ["A", "B", "C", "D", "F", "U"] },
  { name: "base-rug", chain: "base", address: "0x5ad1d043031659a562c34803eea3b51bb2156b07", kind: "rug", note: "小小徐 — Clanker launch whose LP was burned and 220k USDC pulled at 11:31Z; indexers still showed $2.24M. Expected F (liquidity removed).", expectTiers: ["F"] },
  { name: "monad-chog", chain: "monad", address: "0x350035555e10d9afaf1566aaebfced5ba6c27777", kind: "established", note: "CHOG — oldest large nad.fun meme (V1, graduated), multi-DEX.", expectTiers: ["A", "B", "C"] },
  { name: "monad-james", chain: "monad", address: "0x43cf5407bda1400498b8064d50a7e17528d87777", kind: "established", note: "JAMES — nad.fun V2 graduate (v2-style pair); one EOA holds ~61% (capped).", expectTiers: ["B", "C", "D"] },
  { name: "monad-vibe", chain: "monad", address: "0x4c995d07af7ee32a08fc7094f532a91a44567777", kind: "launch", note: "Vibe — busiest nad.fun V2 curve launch of the day; no DEX pair (nad.fun + on-chain only; our sim is the only sellability source).", expectTiers: ["A", "B", "C", "D", "F", "U"] },
  { name: "monad-perpl", chain: "monad", address: "0xb47ffe20d02a827efcc9647d7db9e1a1ef287777", kind: "launch", note: "PERPL — youngest traded nad.fun V2 curve launch (5 buyers).", expectTiers: ["A", "B", "C", "D", "F", "U"] },
  { name: "monad-nad", chain: "monad", address: "0x47c6ac22d1fbb5747b711b7d6602090c8dd37777", kind: "rug", note: "NAD — graduated nad.fun V1 token whose pool is drained ($0.66). Expected F (liquidity removed).", expectTiers: ["F"] },
  // Ethereum (1), picked live on 2026-11-20 (docs/chains/ethereum-fixtures.json).
  { name: "ethereum-pepe", chain: "ethereum", address: "0x6982508145454ce325ddbe47a25d4ec3d2311933", kind: "established", note: "PEPE — the largest Ethereum meme ($1.57B FDV, 19 pairs); top holder is Binance 8 (11.9%).", expectTiers: ["A", "B", "C"] },
  { name: "ethereum-mog", chain: "ethereum", address: "0xaaee1a9723aadb7afa2810263653a34ba2c21c7a", kind: "established", note: "Mog — mid-cap Ethereum meme ($31M FDV, one v2 pair holds the liquidity); one wallet holds ~29% (capped at C).", expectTiers: ["B", "C", "D"] },
  { name: "ethereum-pipi", chain: "ethereum", address: "0x7bcefbb4ea938f71e4352057d9bf6cb2122d47b9", kind: "launch", note: "PIPI — < 24h native-ETH Uniswap v4 launch (no hook); deployer holds the unlocked LP NFT; GoPlus lists a stale 100% row.", expectTiers: ["A", "B", "C", "D", "F", "U"] },
];

/** Refused before scoring (not memes). */
export const V3_BLUE_CHIPS = [
  { chain: "base" as Chain, address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", label: "USDC (Base)" },
  { chain: "base" as Chain, address: "0x4200000000000000000000000000000000000006", label: "WETH (Base)" },
  { chain: "monad" as Chain, address: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a", label: "WMON" },
  { chain: "monad" as Chain, address: "0x754704bc059f8c67012fed69bc8a327a5aafb603", label: "USDC (Monad)" },
  { chain: "ethereum" as Chain, address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", label: "WETH (Ethereum)" },
  { chain: "ethereum" as Chain, address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", label: "USDC (Ethereum)" },
];

/** A token on more than one EVM chain (chain picker). */
export const V3_DUAL = { address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", label: "USDe — on Robinhood Chain, Base and Monad" };
