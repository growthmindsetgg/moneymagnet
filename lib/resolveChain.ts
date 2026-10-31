import { EVM_CHAINS, type EvmChain } from "./chain";
import { chainRpc, type Rpc } from "./onchain/rpc";
import { kvGet, kvSet } from "./kv";

/**
 * §1a: an 0x address can be a token on Robinhood Chain, Base or Monad. Each chain's RPC is asked for
 * bytecode and totalSupply() (an ERC-20 answers it); DexScreener's token endpoint (all chains in one call)
 * gives each chain's FDV and pair count. A chain counts when the token contract exists there.
 */
export interface ChainCandidate {
  chain: EvmChain;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  pairs: number;
}

export interface Resolution {
  candidates: ChainCandidate[];
  /** Per chain: what was checked, for the picker and the logs. */
  checks: Record<EvmChain, string>;
}

const DS_CHAIN: Record<string, EvmChain> = { robinhood: "robinhood", base: "base", monad: "monad" };
const TTL_S = 600;

interface DsPair {
  chainId: string;
  baseToken: { address: string };
  fdv?: number;
  liquidity?: { usd?: number };
}

export async function resolveEvmChain(
  address: string,
  deps: { rpc?: (c: EvmChain) => Rpc; fetchPairs?: (a: string) => Promise<DsPair[]>; cache?: boolean } = {},
): Promise<Resolution> {
  const a = address.toLowerCase();
  const useCache = deps.cache ?? !deps.rpc;
  const key = `resolve:v1:${a}`;
  if (useCache) {
    const hit = await kvGet<Resolution>(key);
    if (hit) return hit;
  }
  const rpcOf = deps.rpc ?? chainRpc;
  const fetchPairs = deps.fetchPairs ?? dexPairs;
  const [onChain, pairs] = await Promise.all([
    Promise.all(EVM_CHAINS.map(async (c) => [c, await tokenOn(rpcOf(c), a)] as const)),
    fetchPairs(a).catch(() => null),
  ]);
  const checks = {} as Record<EvmChain, string>;
  const candidates: ChainCandidate[] = [];
  for (const [chain, state] of onChain) {
    const mine = (pairs ?? []).filter((p) => DS_CHAIN[p.chainId] === chain && p.baseToken.address.toLowerCase() === a);
    checks[chain] = state === "token" ? `ERC-20 contract · ${mine.length} DexScreener pairs` : state === "contract" ? "contract, not an ERC-20" : state === "none" ? "no code" : "RPC unreachable";
    if (state !== "token") continue;
    const fdvs = mine.map((p) => p.fdv).filter((v): v is number => typeof v === "number");
    const liq = mine.map((p) => p.liquidity?.usd ?? 0);
    candidates.push({ chain, fdvUsd: fdvs.length ? Math.max(...fdvs) : null, liquidityUsd: liq.length ? liq.reduce((x, y) => x + y, 0) : null, pairs: mine.length });
  }
  // Highest FDV first; a chain without pairs last.
  candidates.sort((x, y) => (y.fdvUsd ?? -1) - (x.fdvUsd ?? -1) || EVM_CHAINS.indexOf(x.chain) - EVM_CHAINS.indexOf(y.chain));
  const res = { candidates, checks };
  // Only cache an answer every chain gave (an unreachable RPC is retried next time).
  if (useCache && !Object.values(checks).includes("RPC unreachable")) await kvSet(key, res, TTL_S);
  return res;
}

/** "token" = bytecode and a totalSupply() answer; "contract" = code without one; "none" = no code. */
async function tokenOn(rpc: Rpc, address: string): Promise<"token" | "contract" | "none" | "error"> {
  try {
    const code = await rpc<string>("eth_getCode", [address, "latest"], 8_000);
    if (!code || code === "0x") return "none";
    const supply = await rpc<string>("eth_call", [{ to: address, data: "0x18160ddd" }, "latest"], 8_000).catch(() => null);
    return supply && supply !== "0x" && supply.length >= 66 ? "token" : "contract";
  } catch {
    return "error";
  }
}

async function dexPairs(address: string): Promise<DsPair[]> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
  const body = (await res.json()) as { pairs: DsPair[] | null };
  return body.pairs ?? [];
}
