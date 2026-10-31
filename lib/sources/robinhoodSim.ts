import { keccak_256 } from "@noble/hashes/sha3";
import type { AdapterResult } from "../types";
import { kvGet, kvSet } from "../kv";
import { hex, makeRpc, RpcError, type Rpc } from "../onchain/rpc";
import { patientRpc } from "../timemachine/robinhood";
import { fetchJson } from "./http";
import infra from "@/data/robinhood-infra.json";

/**
 * Robinhood Chain sell simulation, entirely through `eth_call` on the public RPC:
 *  1. find the token's main pool (GeckoTerminal / HoodScan pool id) and its v4 pool key from the
 *     PoolManager's Initialize log (or a v2 pair's reserves);
 *  2. quote a small SELL (token → quote currency) and the BUY back through Uniswap's V4Quoter — the
 *     official mainnet runtime bytecode with the PoolManager immutable re-pointed, injected with a
 *     state override (nothing is deployed). The quoter runs the real swap path, hooks included;
 *  3. probe `transfer` from a real holder to a fresh address and to the PoolManager (how a v4 sale
 *     settles) to catch blacklists / transfer locks.
 * Sellable = the sell quote succeeds, both transfers succeed and the round trip loses < 50%.
 */

const INIT_TOPIC = "0x" + Buffer.from(keccak_256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")).toString("hex");
const QUOTE_SELECTOR = "0x" + Buffer.from(keccak_256("quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))")).toString("hex").slice(0, 8);
/** Uniswap V4Quoter on Ethereum mainnet, and the mainnet PoolManager embedded in its bytecode. */
const MAINNET_QUOTER = "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203";
const MAINNET_POOL_MANAGER = "000000000004444c5dc75cb358380d2e3de08a90";
const ETH_RPC = process.env.ETHEREUM_RPC_URL || "https://ethereum-rpc.publicnode.com";
/** Where the patched quoter "lives" during the eth_call (any unused address). */
const QUOTER_AT = "0x00000000000000000000000000000000000c0de4";
const FRESH = "0x000000000000000000000000000000000000f2e5";
const SPAN = 9_000_000;
/** Spec: the buyer's round trip starts with 0.01 ETH. */
const BUY_ETH_WEI = 10n ** 16n;
const infraRole = (a: string) => infra.addresses.find((e) => e.address.toLowerCase() === a)?.role;

export interface PoolKey {
  id: string;
  manager: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

const word = (v: bigint) => (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, "0");
const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export function encodeQuote(k: PoolKey, zeroForOne: boolean, amount: bigint): string {
  const body = [
    word(32n), // offset of the params tuple
    addrWord(k.currency0),
    addrWord(k.currency1),
    word(BigInt(k.fee)),
    word(BigInt(k.tickSpacing)),
    addrWord(k.hooks),
    word(zeroForOne ? 1n : 0n),
    word(amount),
    word(256n), // offset of hookData within the tuple (8 words)
    word(0n), // hookData length
  ];
  return QUOTE_SELECTOR + body.join("");
}

let quoterCode: Promise<string> | null = null;
/** Mainnet V4Quoter runtime code with the PoolManager immutable replaced by Robinhood's. */
async function patchedQuoter(manager: string): Promise<string> {
  quoterCode ??= kvGet<string>("sim:v4quoter:mainnet").then(async (cached) => {
    if (cached) return cached;
    const r = await fetchJson<{ result?: string }>(ETH_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [MAINNET_QUOTER, "latest"] }),
      timeoutMs: 15_000,
    });
    if (!r.result || r.result.length < 1000) throw new Error("could not load the V4Quoter bytecode");
    await kvSet("sim:v4quoter:mainnet", r.result);
    return r.result;
  });
  const code = await quoterCode;
  const out = code.replace(new RegExp(MAINNET_POOL_MANAGER, "gi"), manager.toLowerCase().slice(2));
  if (out === code) throw new Error("V4Quoter bytecode no longer embeds the PoolManager");
  return out;
}

const managers = (): string[] => infra.addresses.filter((a) => a.role === "v4-pool-manager").map((a) => a.address.toLowerCase());

/** Pool key for a v4 pool id, from the Initialize log on the PoolManager (cached forever). */
export async function poolKeyOf(rpc: Rpc, id: string, fromBlock: number): Promise<PoolKey | null> {
  const cacheKey = `sim:poolkey:${id.toLowerCase()}`;
  const cached = await kvGet<PoolKey>(cacheKey);
  if (cached) return cached;
  const head = Number(await rpc<string>("eth_blockNumber", []));
  for (const manager of managers()) {
    for (let from = fromBlock; from <= head; from += SPAN) {
      const logs = await rpc<{ topics: string[]; data: string }[]>("eth_getLogs", [
        { address: manager, topics: [INIT_TOPIC, id.toLowerCase()], fromBlock: hex(from), toBlock: hex(Math.min(head, from + SPAN - 1)) },
      ]);
      const l = logs[0];
      if (!l) continue;
      const d = l.data.slice(2).match(/.{64}/g)!;
      const key: PoolKey = {
        id: id.toLowerCase(),
        manager,
        currency0: "0x" + l.topics[2].slice(26),
        currency1: "0x" + l.topics[3].slice(26),
        fee: parseInt(d[0], 16),
        tickSpacing: Number(BigInt.asIntN(24, BigInt("0x" + d[1]))),
        hooks: "0x" + d[2].slice(24),
      };
      await kvSet(cacheKey, key);
      return key;
    }
  }
  return null;
}

/** In-range liquidity of a v4 pool, read from PoolManager storage (`_pools` mapping at slot 6, liquidity at +3). */
export async function inRangeLiquidity(rpc: Rpc, key: PoolKey): Promise<bigint> {
  const base = BigInt("0x" + Buffer.from(keccak_256(Buffer.from(key.id.slice(2) + "6".padStart(64, "0"), "hex"))).toString("hex"));
  const slot = "0x" + (base + 3n).toString(16).padStart(64, "0");
  return BigInt(await rpc<string>("eth_getStorageAt", [key.manager, slot, "latest"]));
}

/** V4Quoter wraps pool errors in UnexpectedRevertBytes(bytes); NotEnoughLiquidity(bytes32) means a dry pool, not a block. */
const NOT_ENOUGH_LIQUIDITY = "7a5ed734";
export function describeRevert(data: string | undefined): { reason: string; dry: boolean } {
  if (!data || data === "0x") return { reason: "reverted without data", dry: false };
  if (data.includes(NOT_ENOUGH_LIQUIDITY)) return { reason: "NotEnoughLiquidity — the pool cannot absorb the trade", dry: true };
  // UnexpectedRevertBytes(bytes): selector, offset, length, then the inner revert data.
  const inner = data.startsWith("0x6190b2b0") ? "0x" + data.slice(2 + 8 + 128, 2 + 8 + 136) : data.slice(0, 10);
  return { reason: `swap reverted with ${inner}`, dry: false };
}

/** A plausible EOA to quote "as": hooks can tax calls whose origin is 0x0 or a contract. */
const QUOTE_FROM_FALLBACK = "0x1111111111111111111111111111111111111111";

async function quote(rpc: Rpc, key: PoolKey, zeroForOne: boolean, amount: bigint, from: string): Promise<{ out: bigint | null; error?: string; dry?: boolean }> {
  try {
    const code = await patchedQuoter(key.manager);
    const res = await rpc<string>("eth_call", [{ from, to: QUOTER_AT, data: encodeQuote(key, zeroForOne, amount), gas: hex(QUOTE_GAS) }, "latest", { [QUOTER_AT]: { code } }], 12_000);
    return { out: BigInt("0x" + res.slice(2, 66)) };
  } catch (err) {
    const r = describeRevert(err instanceof RpcError ? err.data : undefined);
    return { out: null, error: err instanceof RpcError && err.data !== undefined ? r.reason : (err as Error).message.slice(0, 120), dry: r.dry };
  }
}

export async function transferProbe(rpc: Rpc, token: string, from: string, to: string, amount: bigint): Promise<{ ok: boolean; error?: string }> {
  const data = "0xa9059cbb" + addrWord(to) + word(amount);
  try {
    const res = await rpc<string>("eth_call", [{ from, to: token, data }, "latest"], 15_000);
    // Tokens that return false instead of reverting.
    if (res && res !== "0x" && BigInt(res.slice(0, 66)) === 0n) return { ok: false, error: "transfer returned false" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 120) };
  }
}

export interface PoolCandidate {
  id: string;
  volume24hUsd: number | null;
  reserveUsd: number | null;
}

export interface SimInput {
  token: string;
  /** Pools the indexers list (v4 ids or v2/v3 pair addresses) with their reported activity. */
  pools: PoolCandidate[];
  /** A wallet that currently holds the token (for the transfer probe). */
  holder: string | null;
  /** More candidate holders: the first with a real on-chain balance is probed. */
  holders?: string[];
  holderBalanceRaw: bigint | null;
  totalSupplyRaw: bigint | null;
  creationBlock: number | null;
  rpc?: Rpc;
}

/** One pool's round trip. */
export interface PoolSim {
  pool: string;
  kind: "v4" | "v3" | "v2";
  hooks: string | null;
  feePct: number | null;
  liquidityUsd: number | null;
  /** pass = round trip completed with < 50% loss; fail = completed with ≥ 50%; revert = sell reverts; dry = no liquidity. */
  result: "pass" | "fail" | "revert" | "dry";
  lossPct: number | null;
  detail: string;
}

export interface SimResult {
  /** Every pool's liquidity is gone (dry / < $100) — nothing to sell into. */
  liquidityPulled?: boolean;
  sellable: boolean | null;
  honeypot: boolean | null;
  /** Best pool's round-trip loss. */
  roundTripLossPct: number | null;
  hooked: boolean;
  pool: PoolKey | null;
  pools: PoolSim[];
  /** e.g. "hooked pool unsellable — trade via pool 0x528f…". */
  info: string[];
  detail: string;
}

/** Minimum listed liquidity for a pool to be simulated (unlisted v4 pools need in-range liquidity). */
export const MIN_POOL_LIQUIDITY_USD = 500;
/** Unlisted (indexer-missing) ETH/WETH pools simulated per token. */
const MAX_UNLISTED = 8;
/** A V4Quoter swap needs well under 1M gas; a cap keeps reverting hooks from running to 30M. */
const QUOTE_GAS = Number(process.env.SIM_QUOTE_GAS || 3_000_000);
/** Time the simulation may take per analysis; pools not reached are reported as not simulated. */
const SIM_BUDGET_MS = Number(process.env.SIM_BUDGET_MS || 40_000);
const SIM_CONCURRENCY = 6;

/**
 * Every v4 pool of the token on the registered PoolManagers (Initialize logs). Pools never
 * disappear, so the list is cached for good with the block it was scanned to; later runs only scan
 * new blocks. Windows are scanned in parallel (spread over the full-log endpoints).
 */
async function v4PoolsOf(rpc: Rpc, token: string, fromBlock: number): Promise<PoolKey[]> {
  const cacheKey = `sim:v4pools:v2:${token}`;
  const cached = await kvGet<{ keys: PoolKey[]; scannedTo: number }>(cacheKey);
  const head = Number(await rpc<string>("eth_blockNumber", []));
  const start = cached ? cached.scannedTo + 1 : fromBlock;
  if (cached && head - cached.scannedTo < 600) return cached.keys; // scanned within the last minute
  const pad = "0x" + "0".repeat(24) + token.slice(2);
  const jobs: { manager: string; pos: number; from: number }[] = [];
  for (const manager of managers()) for (const pos of [2, 3]) for (let from = start; from <= head; from += SPAN) jobs.push({ manager, pos, from });
  const found = await Promise.all(
    jobs.map(async ({ manager, pos, from }) => {
      const to = Math.min(head, from + SPAN - 1);
      // Completed past windows never change: each is cached on its own, so a timeout only costs that window.
      const winKey = `sim:v4win:${manager}:${token}:${pos}:${from}`;
      const full = to === from + SPAN - 1;
      const hit = full ? await kvGet<{ topics: string[]; data: string }[]>(winKey) : null;
      const topics: (string | null)[] = [INIT_TOPIC, null, null, null];
      topics[pos] = pad;
      const logs = hit ?? (await rpc<{ topics: string[]; data: string }[]>("eth_getLogs", [{ address: manager, topics, fromBlock: hex(from), toBlock: hex(to) }], 20_000).catch(() => null));
      if (!logs) return null; // a failed window must not be recorded as scanned
      if (!hit && full) await kvSet(winKey, logs);
      return logs.map((l): PoolKey => {
        const d = l.data.slice(2).match(/.{64}/g)!;
        return { id: l.topics[1].toLowerCase(), manager, currency0: "0x" + l.topics[2].slice(26), currency1: "0x" + l.topics[3].slice(26), fee: parseInt(d[0], 16), tickSpacing: Number(BigInt.asIntN(24, BigInt("0x" + d[1]))), hooks: "0x" + d[2].slice(24) };
      });
    }),
  );
  const keys = [...(cached?.keys ?? []), ...found.flatMap((x) => x ?? [])].filter((k, i, all) => all.findIndex((x) => x.id === k.id) === i);
  if (found.every((x) => x !== null)) await kvSet(cacheKey, { keys, scannedTo: head });
  return keys;
}

const call = (rpc: Rpc, to: string, data: string) => rpc<string>("eth_call", [{ to, data }, "latest"], 10_000).catch(() => null);
const word0 = (hexStr: string | null, i = 0) => (hexStr && hexStr.length >= 66 + i * 64 ? BigInt("0x" + hexStr.slice(2 + i * 64, 66 + i * 64)) : null);

/** v2 pair: constant-product quote from on-chain reserves (0.3% fee, the Uniswap v2 standard). */
export async function simV2(rpc: Rpc, pair: string, token: string, ethQuoted: (a: string) => boolean, supply: bigint | null): Promise<PoolSim | null> {
  const [reserves, t0] = await Promise.all([call(rpc, pair, "0x0902f1ac"), call(rpc, pair, "0x0dfe1681")]);
  const r0 = word0(reserves, 0);
  const r1 = word0(reserves, 1);
  if (r0 == null || r1 == null || !t0) return null;
  const tokenIs0 = "0x" + t0.slice(26) === token;
  const [rt, rq] = tokenIs0 ? [r0, r1] : [r1, r0];
  if (rt === 0n || rq === 0n) return { pool: pair, kind: "v2", hooks: null, feePct: 0.3, liquidityUsd: null, result: "dry", lossPct: null, detail: "v2 pair has no reserves" };
  const out = (amountIn: bigint, rIn: bigint, rOut: bigint) => (amountIn * 997n * rOut) / (rIn * 1000n + amountIn * 997n);
  const quoteSide = tokenIs0 ? "0x" + (await call(rpc, pair, "0xd21220a7"))?.slice(26) : "0x" + t0.slice(26);
  const qIn = ethQuoted(quoteSide) ? BUY_ETH_WEI : rq / 10_000n || 1n;
  const tokens = out(qIn, rq, rt);
  const back = out(tokens, rt, rq);
  const loss = Math.max(0, Number(((qIn - back) * 10_000n) / qIn) / 100);
  void supply;
  return { pool: pair, kind: "v2", hooks: null, feePct: 0.3, liquidityUsd: null, result: loss < 50 ? "pass" : "fail", lossPct: loss, detail: `${loss.toFixed(2)}% loss (computed from reserves, 0.3% fee)` };
}

/** v3 pool: quote from slot0 + in-range liquidity + fee for a trade small enough to stay in the tick. */
export async function simV3(rpc: Rpc, pool: string, token: string): Promise<PoolSim | null> {
  const [slot0, liq, feeHex, t0] = await Promise.all([call(rpc, pool, "0x3850c7bd"), call(rpc, pool, "0x1a686502"), call(rpc, pool, "0xddca3f43"), call(rpc, pool, "0x0dfe1681")]);
  const sqrtP = word0(slot0, 0);
  const L = word0(liq, 0);
  const fee = word0(feeHex, 0);
  if (sqrtP == null || L == null || fee == null || !t0) return null;
  const feePct = Number(fee) / 10_000;
  if (L === 0n) return { pool, kind: "v3", hooks: null, feePct, liquidityUsd: null, result: "dry", lossPct: null, detail: "v3 pool has 0 in-range liquidity" };
  // Both fee legs within the current tick: the round trip loses the fee twice plus negligible impact.
  const loss = Math.round((1 - (1 - feePct / 100) ** 2) * 10_000) / 100;
  void token;
  return { pool, kind: "v3", hooks: null, feePct, liquidityUsd: null, result: loss < 50 ? "pass" : "fail", lossPct: loss, detail: `${loss.toFixed(2)}% loss (computed from pool state: fee ${feePct}% twice, in-tick)` };
}

export async function simulateRobinhood(inp: SimInput): Promise<SimResult> {
  const rpc = inp.rpc ?? patientRpc(makeRpc());
  const token = inp.token.toLowerCase();
  const listed = new Map(inp.pools.map((p) => [p.id.toLowerCase(), p]));
  const ethQuoted = (a: string) => a.toLowerCase() === ZERO_ADDR || infraRole(a.toLowerCase()) === "quote-token";
  const supply = inp.totalSupplyRaw ?? 10n ** 24n;

  // The wallet to quote "as" and to probe transfers from: the first holder with a real balance.
  let from = QUOTE_FROM_FALLBACK;
  let probeHolder: string | null = null;
  let holderBalance = 0n;
  for (const h of [...new Set([inp.holder, ...(inp.holders ?? [])].filter((x): x is string => !!x))].slice(0, 5)) {
    const bal = word0(await call(rpc, token, "0x70a08231" + addrWord(h)), 0) ?? 0n;
    if (bal > 0n) {
      probeHolder = h;
      holderBalance = bal;
      from = h;
      break;
    }
  }

  // v4: every pool on the PoolManager, plus listed ids; listed pools need ≥ $500, unlisted need in-range liquidity.
  const keys = new Map<string, PoolKey>();
  // Discovery returns every pool of the token on the registered PoolManagers; a listed v4 id it
  // does not contain lives elsewhere and cannot be quoted here.
  for (const k of await v4PoolsOf(rpc, token, inp.creationBlock ?? 0)) keys.set(k.id, k);
  const simV4 = async (key: PoolKey): Promise<PoolSim | null> => {
    const l = listed.get(key.id);
    const hooked = key.hooks.toLowerCase() !== ZERO_ADDR;
    const base = { pool: key.id, kind: "v4" as const, hooks: hooked ? key.hooks : null, feePct: key.fee / 10_000, liquidityUsd: l?.reserveUsd ?? null };
    if (l && l.reserveUsd != null && l.reserveUsd < MIN_POOL_LIQUIDITY_USD && (l.volume24hUsd ?? 0) === 0) return null;
    // 0 liquidity at the current tick is not "dry": a swap crosses into initialized ticks. Listed
    // pools are always quoted (the quoter reports NotEnoughLiquidity when it is really dry);
    // unlisted ones need in-range liquidity, which filters out the spam pools.
    const inRange = await inRangeLiquidity(rpc, key);
    if (!l && inRange === 0n) return { ...base, result: "dry", lossPct: null, detail: "0 in-range liquidity" };
    const tokenIs0 = key.currency0.toLowerCase() === token;
    const quoteCur = tokenIs0 ? key.currency1 : key.currency0;
    let lossPct: number | null = null;
    let detail = "";
    let result: PoolSim["result"];
    if (ethQuoted(quoteCur)) {
      const buy = await quote(rpc, key, !tokenIs0, BUY_ETH_WEI, from);
      if (buy.out == null || buy.out === 0n) {
        // With nothing at the current tick, a buy that reverts is the quoter walking empty ticks
        // (it runs out of gas before NotEnoughLiquidity): the pool is dry, not blocking sells.
        const dry = buy.dry || inRange === 0n;
        return { ...base, result: dry ? "dry" : "revert", lossPct: null, detail: `buy reverts (${buy.error ?? "zero output"})${inRange === 0n && !buy.dry ? " with 0 in-range liquidity" : ""}` };
      }
      const sell = await quote(rpc, key, tokenIs0, buy.out, from);
      if (sell.out == null || sell.out === 0n) {
        result = sell.dry ? "dry" : "revert";
        detail = `sell reverts (${sell.error ?? "zero output"})`;
      } else {
        lossPct = Math.max(0, Number(((BUY_ETH_WEI - sell.out) * 10_000n) / BUY_ETH_WEI) / 100);
        // A holder-sized exit (1e-6 of supply) must also go through.
        const exitAmount = supply / 1_000_000n;
        const exit = exitAmount > buy.out ? await quote(rpc, key, tokenIs0, exitAmount, from) : { out: 1n } as { out: bigint | null; error?: string; dry?: boolean };
        if ((exit.out == null || exit.out === 0n) && !exit.dry) {
          result = "revert";
          detail = `0.01 ETH round trip ${lossPct.toFixed(2)}%, but a 1e-6-of-supply sell reverts (${exit.error ?? "zero output"})`;
        } else {
          result = lossPct < 50 ? "pass" : "fail";
          detail = `${lossPct.toFixed(2)}% loss (0.01 ETH buy → sell all)`;
        }
      }
    } else {
      const amount = supply / 1_000_000n || 1n;
      const sell = await quote(rpc, key, tokenIs0, amount, from);
      if (sell.out == null || sell.out === 0n) {
        result = sell.dry ? "dry" : "revert";
        detail = `sell reverts (${sell.error ?? "zero output"})`;
      } else {
        const back = await quote(rpc, key, !tokenIs0, sell.out, from);
        lossPct = back.out != null ? Math.max(0, Number(((amount - back.out) * 10_000n) / amount) / 100) : null;
        result = lossPct == null ? "revert" : lossPct < 50 ? "pass" : "fail";
        detail = lossPct == null ? `buy-back reverts (${back.error})` : `${lossPct.toFixed(2)}% loss (sell 1e-6 of supply → buy back)`;
      }
    }
    return { ...base, result, lossPct, detail };
  };
  // Pools are simulated 4 at a time (the RPC pool spreads the calls over endpoints).
  // Candidates: listed pools with ≥ $500 liquidity or any 24h volume, plus up to 8 unlisted
  // ETH/WETH-quoted pools with in-range liquidity (indexers miss some real pools; most unlisted
  // pools are spam — microduck has 568). Others are counted as skipped.
  const listedKeys = [...keys.values()].filter((k) => {
    const l = listed.get(k.id);
    return l && ((l.reserveUsd ?? 0) >= MIN_POOL_LIQUIDITY_USD || (l.volume24hUsd ?? 0) > 0);
  });
  const unlisted = [...keys.values()].filter((k) => !listed.has(k.id) && ethQuoted(k.currency0.toLowerCase() === token ? k.currency1 : k.currency0));
  const withL = await Promise.all(unlisted.slice(0, 40).map(async (k) => ({ k, L: await inRangeLiquidity(rpc, k).catch(() => 0n) })));
  const unlistedLive = withL.filter((x) => x.L > 0n).sort((a, b) => (b.L > a.L ? 1 : -1)).slice(0, MAX_UNLISTED).map((x) => x.k);
  const skipped = keys.size - listedKeys.length - unlistedLive.length;
  const sims: PoolSim[] = [];
  const queue = [...listedKeys, ...unlistedLive].sort((a, b) => (listed.get(b.id)?.volume24hUsd ?? 0) - (listed.get(a.id)?.volume24hUsd ?? 0));
  const deadline = Date.now() + SIM_BUDGET_MS;
  let notReached = 0;
  await Promise.all(
    Array.from({ length: SIM_CONCURRENCY }, async () => {
      for (let k = queue.shift(); k; k = queue.shift()) {
        if (Date.now() > deadline) {
          notReached++;
          continue;
        }
        const s = await simV4(k);
        if (s) sims.push(s);
      }
    }),
  );

  // v2 / v3: listed pair addresses with ≥ $500 liquidity.
  for (const p of inp.pools) {
    if (!/^0x[0-9a-f]{40}$/i.test(p.id) || (p.reserveUsd ?? 0) < MIN_POOL_LIQUIDITY_USD) continue;
    const pool = p.id.toLowerCase();
    const s = (await simV2(rpc, pool, token, ethQuoted, inp.totalSupplyRaw)) ?? (await simV3(rpc, pool, token));
    if (s) sims.push({ ...s, liquidityUsd: p.reserveUsd });
  }

  // Transfer probes: a real holder → a fresh wallet, and → the best pool's custody (PoolManager / pair).
  // Quoter-verified (v4) passes rank before v2/v3 results computed from pool state.
  const passing = sims.filter((s) => s.result === "pass").sort((a, b) => Number(a.kind !== "v4") - Number(b.kind !== "v4") || (a.lossPct ?? 0) - (b.lossPct ?? 0));
  const best = passing[0];
  let blocked: string | null = null;
  if (probeHolder) {
    const amt = holderBalance / 2n < supply / 1_000_000n ? holderBalance / 2n : supply / 1_000_000n;
    const custody = best ? (best.kind === "v4" ? keys.get(best.pool)!.manager : best.pool) : null;
    const probes = await Promise.all([transferProbe(rpc, token, probeHolder, FRESH, amt), custody ? transferProbe(rpc, token, probeHolder, custody, amt) : Promise.resolve({ ok: true } as { ok: boolean; error?: string })]);
    const bad = probes.find((x) => !x.ok);
    if (bad) blocked = `transfer from a holder reverts (${bad.error})`;
  }
  const probeNote = probeHolder ? (blocked ? "" : "transfers from a holder succeed") : "no holder with a balance to probe transfers";

  const extra: string[] = [];
  if (notReached > 0) extra.push(`${notReached} pools not simulated (time budget ${SIM_BUDGET_MS / 1000}s)`);
  if (skipped > 0) extra.push(`${skipped} other v4 pools skipped (unlisted, non-ETH quote or no in-range liquidity)`);
  const bestKey = best && best.kind === "v4" ? keys.get(best.pool)! : null;
  return { ...verdictOf(sims, { blocked, probeNote, extra }), pool: bestKey };
}

const poolLabel = (s: PoolSim) => `pool ${s.pool.slice(0, 10)}… (${s.kind}${s.hooks ? `, hook ${s.hooks.slice(0, 6)}…` : s.kind === "v4" ? ", no hook" : ""}${s.feePct != null ? `, fee ${s.feePct}%` : ""})`;

/**
 * The token's verdict from every pool's round trip. Sellable = at least one pool completes with
 * < 50% loss (quoter-verified v4 pools rank before v2/v3 results computed from pool state); the
 * round-trip loss is the best pool's. A hooked pool that fails while another passes is an info
 * flag, not a honeypot. Every pool dry ⇒ liquidity removed. Honeypot only when a sell actually
 * reverts (or a holder's transfer is blocked) and no pool passes.
 */
export function verdictOf(sims: PoolSim[], o: { blocked?: string | null; probeNote?: string; extra?: string[] } = {}): Omit<SimResult, "pool"> {
  const lines = [...sims.map((x) => `${poolLabel(x)}: ${x.detail}`), ...(o.extra ?? [])];
  const passing = sims.filter((x) => x.result === "pass").sort((a, b) => Number(a.kind !== "v4") - Number(b.kind !== "v4") || (a.lossPct ?? 0) - (b.lossPct ?? 0));
  const best = passing[0];
  const info: string[] = [];
  const hookedFail = sims.find((x) => x.hooks && (x.result === "revert" || x.result === "fail"));
  if (best && hookedFail) info.push(`hooked pool unsellable — trade via ${poolLabel(best)}`);
  const hooked = sims.some((x) => !!x.hooks);
  const anyRevert = sims.some((x) => x.result === "revert");
  const allDry = sims.length > 0 && sims.every((x) => x.result === "dry" || (x.liquidityUsd != null && x.liquidityUsd < 100));
  if (!sims.length) return { sellable: null, honeypot: null, roundTripLossPct: null, hooked: false, pools: [], info, detail: "no pool found (v4 PoolManager, or v2/v3 pairs ≥ $500)" };
  if (o.blocked) return { sellable: false, honeypot: true, roundTripLossPct: null, hooked, pools: sims, info, detail: `honeypot — ${o.blocked} · ${lines.join(" · ")}` };
  if (best) return { sellable: true, honeypot: false, roundTripLossPct: best.lossPct, hooked, pools: sims, info, detail: `sellable via ${poolLabel(best)}${o.probeNote ? ` · ${o.probeNote}` : ""} · ${lines.join(" · ")}` };
  if (allDry) return { liquidityPulled: true, sellable: false, honeypot: false, roundTripLossPct: null, hooked, pools: sims, info, detail: `liquidity removed — every pool is dry · ${lines.join(" · ")}` };
  const worst = sims.filter((x) => x.lossPct != null).sort((a, b) => (a.lossPct ?? 0) - (b.lossPct ?? 0))[0];
  return {
    sellable: false,
    honeypot: anyRevert || (worst?.lossPct ?? 0) >= 50,
    roundTripLossPct: worst?.lossPct ?? null,
    hooked,
    pools: sims,
    info,
    detail: `${anyRevert ? "honeypot — sell reverts on every pool with liquidity" : "every round trip loses ≥ 50%"} · ${lines.join(" · ")}`,
  };
}

/** Adapter wrapper: needs pools + a holder, which collect() passes after the other sources ran. */
export async function robinhoodSim(inp: SimInput): Promise<AdapterResult> {
  const t0 = Date.now();
  const r = await simulateRobinhood(inp);
  return {
    status: { id: "rh-sim", label: "HoodTier sell simulation", state: r.sellable == null ? "partial" : "ok", message: r.detail, ms: Date.now() - t0 },
    data: {
      liquidityPulled: r.liquidityPulled ?? (r.pools.length ? false : null),
      sellable: r.sellable,
      honeypot: r.honeypot,
      roundTripLossPct: r.roundTripLossPct,
      nullReasons: r.sellable == null ? { sellable: r.detail, roundTripLossPct: r.detail } : {},
      fakeSignals: [
        ...r.info.map((text) => ({ kind: "other" as const, level: "info" as const, text, source: "HoodTier sell simulation" })),
        ...(r.hooked && !r.info.length ? [{ kind: "other" as const, level: "info" as const, text: "Hooked Uniswap v4 pool — custom code runs on every swap", source: "HoodTier sell simulation" }] : []),
      ],
    },
    raw: r,
  };
}
