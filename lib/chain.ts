import type { Chain } from "./types";

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** EVM chains share the 0x address space: an 0x address alone does not say which chain it is on. */
export const EVM_CHAINS = ["robinhood", "base", "monad", "ethereum"] as const;
export type EvmChain = (typeof EVM_CHAINS)[number];
export const ALL_CHAINS: Chain[] = ["robinhood", "solana", "base", "monad", "ethereum"];

export const isEvmChain = (c: string | null | undefined): c is EvmChain => !!c && (EVM_CHAINS as readonly string[]).includes(c);
export const isChain = (c: string | null | undefined): c is Chain => !!c && (ALL_CHAINS as string[]).includes(c);

export function addressKind(address: string): "evm" | "solana" | null {
  const a = address.trim();
  if (EVM_RE.test(a)) return "evm";
  if (SOL_RE.test(a)) return "solana";
  return null;
}

/**
 * The chain for an address. `hint` (a URL segment or the home chain selector) wins when it fits the
 * address format. Without a hint, base58 → Solana and 0x → Robinhood Chain (the original default; the
 * API and the /t/auto/ page resolve 0x addresses across every EVM chain first — lib/resolveChain.ts).
 */
export function detectChain(address: string, hint?: string | null): Chain | null {
  const kind = addressKind(address);
  if (kind === "solana") return "solana";
  if (kind === "evm") return isEvmChain(hint) ? hint : "robinhood";
  return null;
}

export function normalizeAddress(chain: Chain, address: string): string {
  return chain === "solana" ? address.trim() : address.trim().toLowerCase();
}

export const CHAIN_LABEL: Record<Chain, string> = { robinhood: "Robinhood Chain", solana: "Solana", base: "Base", monad: "Monad", ethereum: "Ethereum" };
export const CHAIN_ID: Record<Chain, number | null> = { robinhood: 4663, solana: null, base: 8453, monad: 143, ethereum: 1 };
