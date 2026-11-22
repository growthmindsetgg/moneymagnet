/**
 * Owner-mint detection from runtime bytecode (Robinhood Chain has no GoPlus coverage).
 * Solidity dispatchers compare the calldata selector with PUSH4 <selector>, so a public mint entry point
 * leaves `63 <selector>` in the code. This proves the function exists; who may call it is read from owner().
 */
export const MINT_SELECTORS: Record<string, string> = {
  "40c10f19": "mint(address,uint256)",
  a0712d68: "mint(uint256)",
  "449a52f8": "mintTo(address,uint256)",
};

export function mintSelectorsIn(code: string | null | undefined): string[] {
  if (!code || code === "0x") return [];
  const hex = code.toLowerCase().replace(/^0x/, "");
  return Object.entries(MINT_SELECTORS)
    .filter(([sel]) => hex.includes(`63${sel}`))
    .map(([, sig]) => sig);
}

/**
 * mintAuthority for an EVM token: true when a mint entry point exists and the owner is live; false when no
 * mint entry point exists in immutable code; null (with the reason) when the code can change or the caller
 * check is not an owner.
 */
export function evmMintAuthority(
  code: string | null | undefined,
  ownerRenounced: boolean | null,
  upgradeable: boolean | null,
  /** Why ownerRenounced is null (e.g. "owner() read failed: …"), quoted in the reason. */
  ownerUnknownReason?: string,
): { mintAuthority: boolean | null; reason: string } {
  const found = mintSelectorsIn(code);
  if (found.length && ownerRenounced === false) return { mintAuthority: true, reason: `bytecode has ${found.join(", ")} and the owner is live` };
  if (upgradeable === true) return { mintAuthority: null, reason: "upgradeable proxy — the implementation can add a mint function" };
  if (!found.length) return { mintAuthority: false, reason: "no mint entry point in the bytecode" };
  if (ownerRenounced === true) return { mintAuthority: false, reason: `bytecode has ${found.join(", ")} but the owner is renounced` };
  return { mintAuthority: null, reason: `bytecode has ${found.join(", ")}; owner unknown${ownerUnknownReason ? ` (${ownerUnknownReason})` : ""}` };
}
