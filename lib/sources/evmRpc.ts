import type { AdapterResult, TokenSnapshot } from "../types";
import type { EvmChain } from "../chain";
import { CHAIN_LABEL } from "../chain";
import { callOrRevert, chainRpc, type Rpc } from "../onchain/rpc";
import { EIP1167_PREFIX } from "../onchain/chainInfra";

/**
 * Base / Monad / Ethereum token reads straight from the chain: code, supply, decimals, owner, proxy status.
 * Public RPCs only (data/<chain>-rpc-endpoints.json, rotated on 429 / 5xx); BASE_RPC_URL / MONAD_RPC_URL / ETHEREUM_RPC_URL go first.
 * No address index and short getLogs windows, so the deployer comes from GoPlus / nad.fun, not from here.
 */
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export const rpcSourceId = (chain: EvmChain) => `${chain}-rpc`;

/** ABI string (dynamic) or bytes32 → text. */
export function decodeString(hex: string | null): string | null {
  if (!hex || hex === "0x") return null;
  const h = hex.slice(2);
  try {
    if (h.length >= 128) {
      const len = Number(BigInt("0x" + h.slice(64, 128)));
      if (len > 0 && len <= 256 && h.length >= 128 + len * 2) return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8").replace(/\0/g, "") || null;
    }
    return Buffer.from(h.slice(0, 64), "hex").toString("utf8").replace(/\0/g, "").trim() || null;
  } catch {
    return null;
  }
}

export async function evmTokenRpc(chain: EvmChain, address: string, opts: { rpc?: Rpc } = {}): Promise<AdapterResult> {
  const t0 = Date.now();
  const id = rpcSourceId(chain);
  const label = `${CHAIN_LABEL[chain]} RPC`;
  const rpc = opts.rpc ?? chainRpc(chain);
  const a = address.toLowerCase();
  const [code, supplyCall, decCall, ownerCall, implSlot, nameCall, symbolCall] = await Promise.all([
    rpc<string>("eth_getCode", [a, "latest"], 12_000),
    callOrRevert(rpc, a, "0x18160ddd"),
    callOrRevert(rpc, a, "0x313ce567"),
    callOrRevert(rpc, a, "0x8da5cb5b"),
    rpc<string>("eth_getStorageAt", [a, EIP1967_IMPL, "latest"], 10_000).catch(() => null),
    callOrRevert(rpc, a, "0x06fdde03"),
    callOrRevert(rpc, a, "0x95d89b41"),
  ]);
  if (!code || code === "0x") {
    return { status: { id, label, state: "partial", message: "No contract code at this address", ms: Date.now() - t0 }, data: { tokenExists: false } };
  }
  const [supplyHex, decHex, ownerHex] = [supplyCall.value, decCall.value, ownerCall.value];
  const decimals = decHex && decHex !== "0x" ? Number(BigInt(decHex)) : 18;
  const supplyRaw = supplyHex && supplyHex.length >= 66 ? BigInt(supplyHex.slice(0, 66)) : null;
  // Only an answered call (or a revert) proves "no totalSupply()": a failed read never yields tokenExists:false.
  if (supplyRaw == null && !supplyCall.error) {
    return { status: { id, label, state: "partial", message: "Contract answers no totalSupply() — not an ERC-20", ms: Date.now() - t0 }, data: { tokenExists: false } };
  }
  const clone = code.toLowerCase().startsWith(EIP1167_PREFIX);
  const nullReasons: Record<string, string> = {};
  const failed: string[] = [];
  if (supplyCall.error) failed.push((nullReasons.totalSupply = `totalSupply() read failed: ${supplyCall.error}`));
  else if (decCall.error) failed.push((nullReasons.totalSupply = `decimals() read failed: ${decCall.error}`)); // the supply would be scaled by a guessed 18
  const data: Partial<TokenSnapshot> = supplyCall.error ? {} : { tokenExists: true, totalSupply: supplyRaw != null && !decCall.error ? Number(supplyRaw) / 10 ** decimals : null };
  const name = decodeString(nameCall.value);
  const symbol = decodeString(symbolCall.value);
  if (name) data.name = name;
  if (symbol) data.symbol = symbol;
  // owner() reverting = no Ownable owner (same reading as on Robinhood Chain). A failed read: null, never "renounced".
  if (ownerCall.error) {
    data.ownerRenounced = null;
    failed.push((nullReasons.ownerRenounced = `owner() read failed: ${ownerCall.error}`));
  } else if (ownerHex && ownerHex.length >= 66) {
    const owner = `0x${ownerHex.slice(26, 66)}`.toLowerCase();
    data.ownerRenounced = /^0x0{40}$/.test(owner) || owner.endsWith("dead");
  } else data.ownerRenounced = true;
  if (failed.length) data.nullReasons = nullReasons;
  // An EIP-1167 clone's implementation is fixed in its bytecode: not upgradeable. Else the ERC-1967 slot.
  data.upgradeable = clone ? false : implSlot == null ? null : !/^0x0*$/.test(implSlot);
  const notes = [
    data.totalSupply != null ? `supply ${data.totalSupply.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : null,
    clone ? "EIP-1167 clone (immutable implementation)" : data.upgradeable ? "ERC-1967 proxy (upgradeable)" : "not a proxy",
    ownerCall.error ? null : ownerHex && ownerHex.length >= 66 ? (data.ownerRenounced ? "owner renounced" : `owner 0x${ownerHex.slice(26, 66)}`) : "no owner() function",
    ...failed,
  ].filter((x): x is string => !!x);
  return {
    status: { id, label, state: failed.length ? "partial" : "ok", message: notes.join(" · "), ms: Date.now() - t0 },
    data,
    raw: { decimals, supplyRaw: supplyRaw?.toString() ?? null, owner: ownerHex, implSlot, clone, codeBytes: (code.length - 2) / 2 },
  };
}
