import robinhood from "@/data/robinhood-infra.json";
import base from "@/data/base-infra.json";
import monad from "@/data/monad-infra.json";
import type { EvmChain } from "../chain";
import type { InfraEntry } from "./infra";

/**
 * Per-chain infrastructure registries (data/<chain>-infra.json): routers, pool managers, quoters,
 * lockers, launchpad factories and bonding curves, each with how it was identified.
 * Robinhood Chain keeps its own helpers in ./infra (unchanged); Base and Monad use these.
 */
const FILES: Record<EvmChain, { addresses: unknown[] }> = { robinhood, base, monad };
const maps: Partial<Record<EvmChain, Map<string, InfraEntry>>> = {};

function registry(chain: EvmChain): Map<string, InfraEntry> {
  return (maps[chain] ??= new Map((FILES[chain].addresses as InfraEntry[]).map((e) => [e.address.toLowerCase(), e])));
}

export const chainInfraEntry = (chain: EvmChain, address: string) => registry(chain).get(address.toLowerCase());
export const chainInfraEntries = (chain: EvmChain) => [...registry(chain).values()];

/** The first registered contract with this role whose label matches (e.g. quoter / /v4/i). */
export function findInfra(chain: EvmChain, role: string, label?: RegExp): InfraEntry | undefined {
  return chainInfraEntries(chain).find((e) => e.role === role && (!label || label.test(e.label)));
}

/** EIP-1167 minimal proxy runtime prefix (nad.fun tokens and V2 pairs are such clones). */
export const EIP1167_PREFIX = "0x363d3d373d3d3d363d73";

/**
 * Infrastructure on Base / Monad: registered, burn-like, or a contract — real bytecode (> 100 bytes), or on
 * Monad an EIP-1167 clone (nad.fun V2 pairs are 45-byte clones).
 */
export function isChainInfra(chain: EvmChain, address: string, code: string | null | undefined): boolean {
  const a = address.toLowerCase();
  if (registry(chain).has(a) || a.endsWith("dead") || /^0x0{40}$/.test(a)) return true;
  if (!code || code === "0x") return false;
  const bytes = (code.length - 2) / 2;
  // 23-byte EIP-7702 delegations are wallets.
  if (code.startsWith("0xef0100")) return false;
  // Minimal-proxy clones count as infrastructure on Monad only (nad.fun pairs); on Base many smart wallets are clones.
  return bytes > 100 || (chain === "monad" && code.toLowerCase().startsWith(EIP1167_PREFIX));
}

/** Launchpad name when the token's creator contract / factory is a registered launchpad. */
export function chainLaunchpadOf(chain: EvmChain, factory: string | null | undefined): string | null {
  if (!factory) return null;
  const e = registry(chain).get(factory.toLowerCase());
  return e && (e.role === "launchpad-factory" || e.role === "bonding-curve") ? (e.launchpad ?? e.label.split(" ")[0]) : null;
}
