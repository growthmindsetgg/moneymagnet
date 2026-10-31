import { hex, windowsBackward, type Rpc, type RpcLog } from "./rpc";

/** Uniswap v3 pool Mint(sender, owner indexed, tickLower indexed, tickUpper indexed, amount, amount0, amount1). */
const V3_MINT = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
/** NonfungiblePositionManager IncreaseLiquidity(tokenId indexed, liquidity, amount0, amount1). */
const INCREASE_LIQUIDITY = "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f";
const BURN_ADDRESSES = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);

/** Burn addresses plus any lockers configured via LP_LOCKER_ADDRESSES (comma-separated). */
export function lockerSet(): Set<string> {
  const extra = (process.env.LP_LOCKER_ADDRESSES ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^0x[0-9a-f]{40}$/.test(x));
  return new Set([...BURN_ADDRESSES, ...extra]);
}

export interface LpLockResult {
  lockedPct: number | null;
  kind: "v2" | "v3" | null;
  detail: string;
}

const word = (data: string, i: number) => BigInt("0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64));
const addrTopic = (a: string) => "0x" + "0".repeat(24) + a.slice(2);

async function tryCall(rpc: Rpc, to: string, data: string): Promise<string | null> {
  try {
    const r = await rpc<string>("eth_call", [{ to, data }, "latest"], 10_000);
    return r && r !== "0x" ? r : null;
  } catch {
    return null;
  }
}

/**
 * Share of the main pool's liquidity that is burned or held by a locker.
 * v2: LP-token balances of burn/locker addresses over LP totalSupply.
 * v3: positions minted into the pool (Mint → IncreaseLiquidity tokenId), current liquidity, NFT owner.
 */
export async function lpLock(rpc: Rpc, pool: string, fromBlock: number, head: number): Promise<LpLockResult> {
  const lockers = lockerSet();
  // v2 pools are ERC-20 LP tokens and expose getReserves().
  if (await tryCall(rpc, pool, "0x0902f1ac")) {
    const supplyHex = await tryCall(rpc, pool, "0x18160ddd");
    if (!supplyHex) return { lockedPct: null, kind: "v2", detail: "v2 pool did not return LP totalSupply" };
    const supply = BigInt(supplyHex);
    let locked = 0n;
    for (const l of lockers) {
      const b = await tryCall(rpc, pool, "0x70a08231" + addrTopic(l).slice(2));
      if (b) locked += BigInt(b);
    }
    const pct = supply > 0n ? Number((locked * 10_000n) / supply) / 100 : 0;
    return { lockedPct: pct, kind: "v2", detail: `${pct}% of v2 LP tokens are burned or in a configured locker` };
  }

  const mints: RpcLog[] = [];
  for (const [f, t] of windowsBackward(fromBlock, head)) {
    mints.push(...(await rpc<RpcLog[]>("eth_getLogs", [{ address: pool, topics: [V3_MINT], fromBlock: hex(f), toBlock: hex(t) }], 30_000)));
  }
  if (!mints.length) return { lockedPct: null, kind: null, detail: "no v2 reserves and no v3 Mint events — pool type not resolvable via RPC (v4 positions live in the PoolManager)" };

  const positions = new Map<string, { npm: string; tokenId: bigint }>();
  for (const m of mints.slice(0, 40)) {
    const rc = await rpc<{ logs: RpcLog[] }>("eth_getTransactionReceipt", [m.transactionHash], 15_000);
    for (const l of rc.logs) {
      if (l.topics[0] === INCREASE_LIQUIDITY) {
        const tokenId = BigInt(l.topics[1]);
        positions.set(`${l.address.toLowerCase()}:${tokenId}`, { npm: l.address.toLowerCase(), tokenId });
      }
    }
  }
  if (!positions.size) return { lockedPct: null, kind: "v3", detail: "v3 liquidity was not minted through a position manager (no position NFTs to inspect)" };

  let total = 0n;
  let locked = 0n;
  for (const { npm, tokenId } of positions.values()) {
    const id = tokenId.toString(16).padStart(64, "0");
    const pos = await tryCall(rpc, npm, "0x99fbab88" + id); // positions(tokenId): liquidity is word 7
    const liquidity = pos ? word(pos, 7) : 0n;
    const ownerHex = await tryCall(rpc, npm, "0x6352211e" + id); // ownerOf; reverts once burned
    const owner = ownerHex ? "0x" + ownerHex.slice(-40).toLowerCase() : "0x0000000000000000000000000000000000000000";
    total += liquidity;
    if (lockers.has(owner)) locked += liquidity;
  }
  if (total === 0n) return { lockedPct: 0, kind: "v3", detail: `${positions.size} v3 positions found, none with liquidity left` };
  const pct = Number((locked * 10_000n) / total) / 100;
  return { lockedPct: pct, kind: "v3", detail: `${pct}% of liquidity across ${positions.size} v3 positions is burned or held by a configured locker` };
}
