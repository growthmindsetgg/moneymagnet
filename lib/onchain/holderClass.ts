import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import type { HolderClass, HolderClassRow } from "../types";
import { addressTopic, codeKind, hex, TRANSFER_TOPIC, topicAddress, type Rpc, type RpcLog } from "./rpc";
import { EIP1167_PREFIX } from "./chainInfra";

/**
 * Top-holder classification (all EVM chains): eth_getCode on each of the top-5 non-LP holders, then —
 * for contracts — a match of the (proxy-resolved) runtime bytecode against the function selectors of
 * known vesting / locker / staking contracts, and a Safe probe (getThreshold + getOwners). Selectors are
 * computed from the signatures below, never typed in by hand.
 */

const selector = (sig: string) => bytesToHex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);

export interface ContractSignature {
  id: string;
  label: string;
  class: Exclude<HolderClass, "wallet" | "founder" | "treasury" | "contract">;
  /** Every one of these functions must be in the bytecode. */
  fns: string[];
}

/** Characteristic functions per contract family (from their published ABIs). Order matters: first match wins. */
export const CONTRACT_SIGNATURES: ContractSignature[] = [
  { id: "sablier-lockup", label: "Sablier", class: "vesting", fns: ["withdrawableAmountOf(uint256)", "streamedAmountOf(uint256)", "getEndTime(uint256)"] },
  { id: "sablier-v1", label: "Sablier", class: "vesting", fns: ["getStream(uint256)", "createStream(address,uint256,address,uint256,uint256)"] },
  { id: "hedgey", label: "Hedgey", class: "vesting", fns: ["redeemPlans(uint256[])", "planBalanceOf(uint256,uint256,uint256)"] },
  { id: "team-finance", label: "Team Finance", class: "locker", fns: ["getDepositsByTokenAddress(address)", "getDepositDetails(uint256)"] },
  { id: "uncx-vesting", label: "UNCX (Unicrypt)", class: "locker", fns: ["getTokenLocksLength(address)", "getTokenLockIDAtIndex(address,uint256)"] },
  { id: "uncx-locker", label: "UNCX (Unicrypt)", class: "locker", fns: ["getNumLocksForToken(address)", "tokenLocks(address,uint256)"] },
  { id: "pinklock", label: "PinkLock", class: "locker", fns: ["totalLockCountForToken(address)", "getLocksForToken(address,uint256,uint256)"] },
  { id: "oz-vesting-wallet", label: "OpenZeppelin VestingWallet", class: "vesting", fns: ["start()", "duration()", "released(address)", "vestedAmount(address,uint64)"] },
  { id: "token-vesting", label: "TokenVesting", class: "vesting", fns: ["cliff()", "start()", "duration()", "release(address)", "released(address)"] },
  { id: "staking-rewards", label: "staking (StakingRewards)", class: "staking", fns: ["stake(uint256)", "getReward()", "earned(address)"] },
];

const SELECTORS = new Map(CONTRACT_SIGNATURES.map((s) => [s.id, s.fns.map(selector)]));
/** Selectors appear in the dispatcher as PUSH4 <selector> (0x63). */
const hasSelector = (code: string, sel: string) => code.toLowerCase().includes(`63${sel}`);

export function matchSignature(code: string): ContractSignature | null {
  for (const s of CONTRACT_SIGNATURES) if (SELECTORS.get(s.id)!.every((sel) => hasSelector(code, sel))) return s;
  return null;
}

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ZERO = "0x0000000000000000000000000000000000000000";
const slotAddress = (word: string | null | undefined) => (word && /^0x[0-9a-f]{64}$/i.test(word) ? `0x${word.slice(26)}`.toLowerCase() : null);
const isAddr = (a: string | null): a is string => !!a && a !== ZERO;

/** The implementation's runtime code behind EIP-1167 clones, EIP-1967 (or beacon) proxies and Safe proxies. */
async function resolvedCode(rpc: Rpc, address: string, code: string): Promise<{ code: string; via: string | null }> {
  const c = code.toLowerCase();
  if (c.startsWith(EIP1167_PREFIX)) {
    const impl = `0x${c.slice(EIP1167_PREFIX.length, EIP1167_PREFIX.length + 40)}`;
    return { code: await rpc<string>("eth_getCode", [impl, "latest"]), via: `EIP-1167 clone of ${impl}` };
  }
  const [implWord, beaconWord, slot0] = await Promise.all([
    rpc<string>("eth_getStorageAt", [address, EIP1967_IMPL, "latest"]).catch(() => null),
    rpc<string>("eth_getStorageAt", [address, EIP1967_BEACON, "latest"]).catch(() => null),
    // Safe proxies keep the singleton at slot 0 and are tiny.
    c.length < 2 + 2 * 1200 ? rpc<string>("eth_getStorageAt", [address, "0x0", "latest"]).catch(() => null) : Promise.resolve(null),
  ]);
  let impl = slotAddress(implWord);
  let via = impl && isAddr(impl) ? `EIP-1967 proxy → ${impl}` : null;
  if (!isAddr(impl)) {
    const beacon = slotAddress(beaconWord);
    if (isAddr(beacon)) {
      const r = await rpc<string>("eth_call", [{ to: beacon, data: `0x${selector("implementation()")}` }, "latest"]).catch(() => null);
      impl = slotAddress(r);
      via = isAddr(impl) ? `beacon proxy → ${impl}` : null;
    }
  }
  if (!isAddr(impl)) {
    const s0 = slotAddress(slot0);
    if (isAddr(s0) && c.length < 2 + 2 * 1200) {
      const code0 = await rpc<string>("eth_getCode", [s0, "latest"]).catch(() => "0x");
      if (code0.length > 2 + 2 * 1200) return { code: code0, via: `proxy (slot 0) → ${s0}` };
    }
    return { code, via: null };
  }
  return { code: await rpc<string>("eth_getCode", [impl, "latest"]).catch(() => code), via };
}

const word = (data: string, i: number) => (data && data.length >= 2 + 64 * (i + 1) ? BigInt(`0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1))}`) : null);
const call = (rpc: Rpc, to: string, sig: string, args = "") => rpc<string>("eth_call", [{ to, data: `0x${selector(sig)}${args}` }, "latest"]).catch(() => null);
const iso = (sec: bigint | number) => new Date(Number(sec) * 1000).toISOString();
const plausibleTime = (t: bigint | null): t is bigint => t != null && t > 1_400_000_000n && t < 4_200_000_000n;
export const monthOf = (isoDate: string) => isoDate.slice(0, 7);

/**
 * Smallest block in (lo, hi] where a monotone predicate turns true (pred(hi) assumed true), probing
 * `k` blocks in parallel per round: log_k instead of log_2 round trips. Null when `rounds` runs out.
 */
export async function kSearch(lo: number, hi: number, pred: (b: number) => Promise<boolean>, k = 8, rounds = 12): Promise<number | null> {
  for (let i = 0; i < rounds && hi - lo > 1; i++) {
    const step = (hi - lo) / (k + 1);
    const pts = [...new Set(Array.from({ length: k }, (_, j) => Math.floor(lo + step * (j + 1))).filter((b) => b > lo && b < hi))];
    const res = await Promise.all(pts.map(pred));
    const firstTrue = res.indexOf(true);
    if (firstTrue === -1) lo = pts[pts.length - 1] ?? lo;
    else {
      hi = pts[firstTrue];
      if (firstTrue > 0) lo = pts[firstTrue - 1];
    }
  }
  return hi - lo <= 1 ? hi : null;
}

/** Safe (Gnosis) multisig: getThreshold() and getOwners() both answer. */
async function safeInfo(rpc: Rpc, address: string): Promise<{ threshold: number; owners: number } | null> {
  const [t, o] = await Promise.all([call(rpc, address, "getThreshold()"), call(rpc, address, "getOwners()")]);
  const threshold = word(t ?? "", 0);
  // getOwners() returns a dynamic array: offset, length, items.
  const owners = word(o ?? "", 1);
  if (threshold == null || owners == null || threshold < 1n || owners < 1n || owners > 100n || threshold > owners) return null;
  return { threshold: Number(threshold), owners: Number(owners) };
}

export interface ContractVerdict {
  class: "treasury" | "vesting" | "locker" | "staking" | "contract";
  label: string;
  unlocksAt: string | null;
  detail: string | null;
  evidence: string;
}

/** Reads the release schedule where the contract exposes one for this token. */
async function schedule(rpc: Rpc, sig: ContractSignature, address: string, token: string): Promise<{ unlocksAt: string | null; detail: string | null; note: string }> {
  if (sig.id === "oz-vesting-wallet" || sig.id === "token-vesting") {
    const [start, duration, cliff] = await Promise.all([call(rpc, address, "start()"), call(rpc, address, "duration()"), sig.id === "token-vesting" ? call(rpc, address, "cliff()") : Promise.resolve(null)]);
    const s = word(start ?? "", 0);
    const d = word(duration ?? "", 0);
    if (plausibleTime(s) && d != null) {
      const end = iso(s + d);
      const c = word(cliff ?? "", 0);
      return { unlocksAt: end, detail: `vests ${monthOf(iso(s))} → ${monthOf(end)}${plausibleTime(c) ? `, cliff ${monthOf(iso(c))}` : ""}`, note: "start()/duration() read" };
    }
    return { unlocksAt: null, detail: null, note: "start()/duration() unreadable" };
  }
  if (sig.id === "team-finance") {
    const ids = await call(rpc, address, "getDepositsByTokenAddress(address)", token.slice(2).toLowerCase().padStart(64, "0"));
    const n = Number(word(ids ?? "", 1) ?? 0n);
    let latest: bigint | null = null;
    for (let i = 0; i < Math.min(n, 20); i++) {
      const id = word(ids!, 2 + i)!;
      const d = await call(rpc, address, "getDepositDetails(uint256)", id.toString(16).padStart(64, "0"));
      // (token, withdrawalAddress, amount, unlockTime, withdrawn, …)
      const unlock = word(d ?? "", 3);
      const withdrawn = word(d ?? "", 4);
      if (plausibleTime(unlock) && withdrawn === 0n && (latest == null || unlock > latest)) latest = unlock;
    }
    if (latest != null) return { unlocksAt: iso(latest), detail: `unlocks ${monthOf(iso(latest))}`, note: `${Math.min(n, 20)} deposits read (getDepositDetails)` };
    return { unlocksAt: null, detail: null, note: n ? "no open deposit with a readable unlock time" : "no deposit listed for this token" };
  }
  return { unlocksAt: null, detail: null, note: "per-stream / per-lock schedule, not indexed by token — not read" };
}

/** Classifies one contract holder. `code` is its runtime bytecode (eth_getCode). */
export async function classifyContract(rpc: Rpc, address: string, token: string, code: string): Promise<ContractVerdict> {
  const bytes = (code.length - 2) / 2;
  const safe = await safeInfo(rpc, address);
  if (safe) {
    return { class: "treasury", label: `treasury (multisig, Safe ${safe.threshold}/${safe.owners})`, unlocksAt: null, detail: null, evidence: `contract (${bytes} B); getThreshold() = ${safe.threshold}, getOwners() = ${safe.owners} owners → Safe multisig` };
  }
  const { code: impl, via } = await resolvedCode(rpc, address, code);
  const sig = matchSignature(impl);
  if (!sig) {
    return { class: "contract", label: "unclassified contract", unlocksAt: null, detail: null, evidence: `contract (${bytes} B${via ? `, ${via}` : ""}); no vesting / locker / staking / multisig signature matched` };
  }
  const sch = await schedule(rpc, sig, address, token).catch(() => ({ unlocksAt: null, detail: null, note: "schedule read failed" }));
  const kind = sig.class === "staking" ? "staking contract" : sig.class === "locker" ? "locker" : "vesting contract";
  return {
    class: sig.class,
    label: `${kind} (${sig.label})`,
    unlocksAt: sch.unlocksAt,
    detail: sch.detail,
    evidence: `contract (${bytes} B${via ? `, ${via}` : ""}); bytecode has ${sig.fns.join(", ")} → ${sig.label}; ${sch.note}`,
  };
}

// ── Wallet history (archive state) ────────────────────────────────────────────────────────────────

const SWAP_TOPICS = new Set([
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
]);

export interface WalletHistory {
  /** The whole history since the token's creation was read. */
  complete: boolean;
  reason: string | null;
  /** Outbound moves into a pool / router / other contract, or inside a tx with a Swap event. */
  toPools: number;
  /** Outbound transfers to wallets (EOA or EIP-7702). */
  transfersOut: number;
  transfersOutRaw: bigint;
  firstReceipt: { block: number; from: string | null } | null;
  method: string;
  calls: number;
}

export interface HistoryOptions {
  fromBlock: number;
  head: number;
  maxCalls?: number;
  deadline?: number;
  /** Destinations that count as a pool / router even without code (registered infra, pool ids). */
  isPool?: (address: string) => boolean;
  /** Stop after the first receipt (who funded the wallet). */
  firstReceiptOnly?: boolean;
}

/**
 * A wallet's token history from archive state, without an address index:
 * - nonce 0 now ⇒ it never sent a transaction (nothing out);
 * - else the first receipt is bisected on balanceOf; an unchanged nonce since then ⇒ nothing out;
 * - else every block where its balance changed is found by bisection and the outbound Transfer logs
 *   of those blocks are read (destination code, Swap events in the tx).
 * Bisection compares balances at interval ends, so an outflow exactly offset by an inflow inside one
 * interval is not seen — the method text says so.
 */
export async function archiveWalletHistory(rpc: Rpc, token: string, wallet: string, o: HistoryOptions): Promise<WalletHistory> {
  let calls = 0;
  const max = o.maxCalls ?? 160;
  const deadline = o.deadline ?? Infinity;
  const budgetLeft = () => calls < max && Date.now() < deadline;
  const r = async <T,>(m: string, p: unknown[]) => {
    calls++;
    return rpc<T>(m, p);
  };
  const wTopic = addressTopic(wallet);
  const bal = async (b: number) => {
    const v = await r<string>("eth_call", [{ to: token, data: `0x70a08231${wTopic.slice(2)}` }, hex(b)]);
    return v && v.length >= 66 ? BigInt(v.slice(0, 66)) : 0n;
  };
  const out: WalletHistory = { complete: false, reason: null, toPools: 0, transfersOut: 0, transfersOutRaw: 0n, firstReceipt: null, method: "", calls: 0 };
  const done = (w: Partial<WalletHistory>) => Object.assign(out, w, { calls });

  const nonceNow = o.firstReceiptOnly ? -1 : Number(await r<string>("eth_getTransactionCount", [wallet, "latest"]));
  if (nonceNow === 0) return done({ complete: true, method: "wallet has never sent a transaction (nonce 0)" });

  // First receipt: earliest block with a non-zero balance.
  const found = await kSearch(o.fromBlock, o.head, async (b) => (await bal(b)) > 0n, 16, Math.max(1, Math.floor((max - calls) / 16)));
  if (found == null) return done({ reason: `archive search stopped after ${calls} calls`, method: "balance search" });
  const first = found;
  const inLogs = await r<RpcLog[]>("eth_getLogs", [{ address: token, topics: [TRANSFER_TOPIC, null, wTopic], fromBlock: hex(first), toBlock: hex(first) }]).catch(() => []);
  out.firstReceipt = { block: first, from: inLogs[0] ? topicAddress(inLogs[0].topics[1]) : null };
  if (o.firstReceiptOnly) return done({ method: `first receipt at block ${first}` });
  const nonceAtFirst = Number(await r<string>("eth_getTransactionCount", [wallet, hex(first)]));
  if (nonceAtFirst === nonceNow) return done({ complete: true, method: `nonce unchanged (${nonceNow}) since the first receipt at block ${first}: no transaction sent since` });

  // Every balance change after the first receipt.
  const changes: number[] = [];
  const scan = async (a: number, b: number, ba: bigint, bb: bigint): Promise<void> => {
    if (ba === bb) return;
    if (!budgetLeft()) throw new Error("budget");
    if (b - a <= 1) {
      if (bb < ba) changes.push(b);
      return;
    }
    const m = Math.floor((a + b) / 2);
    const bm = await bal(m);
    await scan(a, m, ba, bm);
    await scan(m, b, bm, bb);
  };
  try {
    await scan(first, o.head, await bal(first), await bal(o.head));
  } catch {
    return done({ reason: `more balance changes than the ${max}-call budget reads (${changes.length} outflows found so far)`, method: "archive balance-change scan" });
  }
  const codes = new Map<string, string>();
  for (const b of changes) {
    if (!budgetLeft()) return done({ reason: `call budget reached while reading ${changes.length} outflows`, method: "archive balance-change scan" });
    const logs = await r<RpcLog[]>("eth_getLogs", [{ address: token, topics: [TRANSFER_TOPIC, wTopic], fromBlock: hex(b), toBlock: hex(b) }]);
    for (const l of logs) {
      const to = topicAddress(l.topics[2]);
      if (!codes.has(to)) codes.set(to, await r<string>("eth_getCode", [to, "latest"]).catch(() => "0x"));
      const receipt = await r<{ logs: { topics: string[] }[] } | null>("eth_getTransactionReceipt", [l.transactionHash]).catch(() => null);
      const swap = receipt?.logs.some((x) => SWAP_TOPICS.has(x.topics[0])) ?? false;
      if (swap || o.isPool?.(to) || codeKind(codes.get(to)) === "contract") out.toPools++;
      else {
        out.transfersOut++;
        out.transfersOutRaw += l.data && l.data !== "0x" ? BigInt(l.data) : 0n;
      }
    }
  }
  return done({
    complete: true,
    method: `archive balance-change scan from block ${first}: ${changes.length} outflow blocks read (an outflow exactly offset by an inflow between two probes is not seen)`,
  });
}

/** Creation block from archive state: the first block where the token has code. */
export async function creationBlockByCode(rpc: Rpc, token: string, head: number): Promise<number | null> {
  return kSearch(
    0,
    head,
    async (b) => {
      const c = await rpc<string>("eth_getCode", [token, hex(b)]);
      return c.length > 2;
    },
    16,
  );
}

/** The block closest to a unix time, by interpolation on block timestamps (a handful of calls). */
export async function blockAtTime(rpc: Rpc, unixSec: number, head: number): Promise<number> {
  const ts = async (b: number) => Number((await rpc<{ timestamp: string }>("eth_getBlockByNumber", [hex(b), false])).timestamp);
  const headTs = await ts(head);
  let ref = Math.max(1, head - 1_000_000);
  let refTs = await ts(ref);
  let rate = (headTs - refTs) / (head - ref) || 1;
  let est = Math.min(head, Math.max(1, Math.round(head - (headTs - unixSec) / rate)));
  for (let i = 0; i < 4; i++) {
    const t = await ts(est);
    if (Math.abs(t - unixSec) <= 2) break;
    if (est !== ref && t !== refTs) rate = Math.abs((t - refTs) / (est - ref)) || rate;
    ref = est;
    refTs = t;
    est = Math.min(head, Math.max(1, Math.round(est - (t - unixSec) / rate)));
  }
  return est;
}

/**
 * The token's first mint (Transfer from 0x0) near a known launch time: block by timestamp, then the
 * mint logs of a window around it (`span` = the endpoint's getLogs limit). Null when not in the window.
 */
export async function mintNear(rpc: Rpc, token: string, unixSec: number, head: number, span: number): Promise<{ block: number; sender: string | null } | null> {
  const b = await blockAtTime(rpc, unixSec, head);
  for (const [f, t] of [[b - Math.floor(span / 2), b + Math.floor(span / 2) - 1], [b - span - Math.floor(span / 2), b - Math.floor(span / 2) - 1]] as const) {
    const logs = await rpc<RpcLog[]>("eth_getLogs", [{ address: token, topics: [TRANSFER_TOPIC, `0x${"0".repeat(64)}`], fromBlock: hex(Math.max(0, f)), toBlock: hex(Math.min(head, t)) }]).catch(() => [] as RpcLog[]);
    const first = logs.sort((x, y) => Number(x.blockNumber) - Number(y.blockNumber))[0];
    if (first) {
      const tx = await rpc<{ from: string } | null>("eth_getTransactionByHash", [first.transactionHash]).catch(() => null);
      return { block: Number(first.blockNumber), sender: tx?.from.toLowerCase() ?? null };
    }
  }
  return null;
}

/** The sender of the token's first mint transaction (the creation tx), given its creation block. */
export async function creationSender(rpc: Rpc, token: string, block: number): Promise<string | null> {
  const logs = await rpc<RpcLog[]>("eth_getLogs", [{ address: token, topics: [TRANSFER_TOPIC, `0x${"0".repeat(64)}`], fromBlock: hex(block), toBlock: hex(block + 2) }]).catch(() => []);
  if (!logs[0]) return null;
  const tx = await rpc<{ from: string } | null>("eth_getTransactionByHash", [logs[0].transactionHash]).catch(() => null);
  return tx?.from.toLowerCase() ?? null;
}

export function classRow(p: Omit<HolderClassRow, "counted">): HolderClassRow {
  return { ...p, counted: p.class === "wallet" || p.class === "founder" || p.class === "treasury" };
}
