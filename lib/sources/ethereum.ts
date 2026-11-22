import type { AdapterResult } from "../types";
import { etherscanV2 } from "./base";

/**
 * Ethereum-only sources (docs/chains/ethereum.md):
 * - Etherscan = the Etherscan v2 API with chainid=1 (ETHERSCAN_API_KEY; the free plan covers Ethereum mainnet):
 *   contract creator, creation time (the token's own age, not its pool's) and verified source.
 *   One Etherscan v2 key serves every chain, so a BASESCAN_API_KEY is used when ETHERSCAN_API_KEY is not set.
 * No launchpad adapter: no Ethereum launchpad is registered (data/ethereum-infra.json), so the Ethereum sets
 * carry no launchpad factor.
 */
export function ethereumAdapters(address: string): [string, () => Promise<AdapterResult>][] {
  return [["etherscan", () => etherscan(address)]];
}

export const ETHERSCAN_MISSING = "ETHERSCAN_API_KEY not set (Etherscan v2, free plan covers Ethereum) — creator, creation time and verified source come from GoPlus / the DEX indexers only";

export async function etherscan(address: string): Promise<AdapterResult> {
  const key = process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY;
  if (!key) return { status: { id: "etherscan", label: "Etherscan", state: "skipped", message: ETHERSCAN_MISSING }, data: {} };
  return etherscanV2({ id: "etherscan", label: "Etherscan", chainid: 1, key, page: "https://etherscan.io/token/" }, address);
}
