import infra from "@/data/robinhood-infra.json";

/**
 * Robinhood Chain infrastructure (data/robinhood-infra.json): pools, liquidity managers, routers,
 * launchpad factories and bonding curves. Infrastructure is never a holder and never a deployer.
 */
export interface InfraEntry {
  address: string;
  role: string;
  label: string;
  launchpad?: string;
  identifiedBy: string;
}

const ENTRIES = new Map<string, InfraEntry>((infra.addresses as InfraEntry[]).map((e) => [e.address.toLowerCase(), e]));
const LP_SELECTORS = new Set(infra.lpSeedingSelectors.selectors.map((s) => s.toLowerCase()));

export const infraEntry = (address: string): InfraEntry | undefined => ENTRIES.get(address.toLowerCase());
export const isRegisteredInfra = (address: string) => ENTRIES.has(address.toLowerCase());
export const isLiquidityManager = (address: string | null | undefined) => !!address && ENTRIES.get(address.toLowerCase())?.role === "liquidity-manager";
export const isLpSeedingSelector = (input: string | null | undefined) => !!input && LP_SELECTORS.has(input.slice(0, 10).toLowerCase());

/** Launchpad name when the creation tx was sent to a registered launchpad factory. */
export function launchpadOfFactory(factory: string | null | undefined): string | null {
  if (!factory) return null;
  const e = ENTRIES.get(factory.toLowerCase());
  return e?.role === "launchpad-factory" ? (e.launchpad ?? "launchpad") : null;
}

/**
 * Infrastructure = registered, or a contract with real bytecode (pools, curves, routers, lockers).
 * `codeKind` comes from eth_getCode ("contract" > 100 bytes; 7702 / minimal-proxy wallets stay wallets).
 */
export function isInfrastructure(address: string, codeKind?: "wallet" | "contract" | null): boolean {
  const a = address.toLowerCase();
  if (ENTRIES.has(a) || a.endsWith("dead")) return true;
  return codeKind === "contract";
}
