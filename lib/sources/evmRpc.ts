import type { AdapterResult, TokenSnapshot } from "../types";
import type { EvmChain } from "../chain";
import { CHAIN_LABEL } from "../chain";
import { chainRpc, type Rpc } from "../onchain/rpc";
import { EIP1167_PREFIX } from "../onchain/chainInfra";

/**
 * Base / Monad token reads straight from the chain: code, supply, decimals, owner, proxy status.
 * Public RPCs only (data/<chain>-rpc-endpoints.json, rotated on 429 / 5xx); BASE_RPC_URL / MONAD_RPC_URL go first.
 * No address index and short getLogs windows, so the deployer comes from GoPlus / nad.fun, not from here.
 */
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export const rpcSourceId = (chain: EvmChain) => `${chain}-rpc`;

async function safeCall(rpc: Rpc, to: string, data: string): Promise<string | null> {
  try {
    return await rpc<string>("eth_call", [{ to, data }, "latest"], 10_000);
  } catch {
    return null; // revert, e.g. no owner() function
  }
}

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
  const [code, supplyHex, decHex, ownerHex, implSlot, nameHex, symbolHex] = await Promise.all([
    rpc<string>("eth_getCode", [a, "latest"], 12_000),
    safeCall(rpc, a, "0x18160ddd"),
    safeCall(rpc, a, "0x313ce567"),
    safeCall(rpc, a, "0x8da5cb5b"),
    rpc<string>("eth_getStorageAt", [a, EIP1967_IMPL, "latest"], 10_000).catch(() => null),
    safeCall(rpc, a, "0x06fdde03"),
    safeCall(rpc, a, "0x95d89b41"),
  ]);
  if (!code || code === "0x") {
    return { status: { id, label, state: "partial", message: "No contract code at this address", ms: Date.now() - t0 }, data: { tokenExists: false } };
  }
  const decimals = decHex && decHex !== "0x" ? Number(BigInt(decHex)) : 18;
  const supplyRaw = supplyHex && supplyHex.length >= 66 ? BigInt(supplyHex.slice(0, 66)) : null;
  if (supplyRaw == null) {
    return { status: { id, label, state: "partial", message: "Contract answers no totalSupply() — not an ERC-20", ms: Date.now() - t0 }, data: { tokenExists: false } };
  }
  const clone = code.toLowerCase().startsWith(EIP1167_PREFIX);
  const data: Partial<TokenSnapshot> = { tokenExists: true, totalSupply: Number(supplyRaw) / 10 ** decimals };
  const name = decodeString(nameHex);
  const symbol = decodeString(symbolHex);
  if (name) data.name = name;
  if (symbol) data.symbol = symbol;
  // owner() reverting = no Ownable owner (same reading as on Robinhood Chain).
  if (ownerHex && ownerHex.length >= 66) {
    const owner = `0x${ownerHex.slice(26, 66)}`.toLowerCase();
    data.ownerRenounced = /^0x0{40}$/.test(owner) || owner.endsWith("dead");
  } else data.ownerRenounced = true;
  // An EIP-1167 clone's implementation is fixed in its bytecode: not upgradeable. Else the ERC-1967 slot.
  data.upgradeable = clone ? false : implSlot == null ? null : !/^0x0*$/.test(implSlot);
  const notes = [
    `supply ${data.totalSupply?.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    clone ? "EIP-1167 clone (immutable implementation)" : data.upgradeable ? "ERC-1967 proxy (upgradeable)" : "not a proxy",
    ownerHex && ownerHex.length >= 66 ? (data.ownerRenounced ? "owner renounced" : `owner 0x${ownerHex.slice(26, 66)}`) : "no owner() function",
  ];
  return {
    status: { id, label, state: "ok", message: notes.join(" · "), ms: Date.now() - t0 },
    data,
    raw: { decimals, supplyRaw: supplyRaw.toString(), owner: ownerHex, implSlot, clone, codeBytes: (code.length - 2) / 2 },
  };
}
