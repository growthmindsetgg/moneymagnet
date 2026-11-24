import type { Chain } from "../types";
import { isEvmChain, type EvmChain } from "../chain";
import { kvMget, kvSet } from "../kv";
import { archiveRpc, codeKind, hex, type Rpc } from "./rpc";
import { kSearch } from "./holderClass";
import { isProgramAddress, type FullTx, type Helius } from "../timemachine/solana";
import disperse from "../../data/disperse-contracts.json";

/**
 * Where a wallet's first native coin came from — the one lookup the wallet-cluster meter, and later the other wallet
 * readers, share (docs/research/2026-11-23-team-review-plan.md §3.4).
 *
 * Never a guess: a funder is set only with proof; otherwise `funder: null` with the exact `reason`, and the result is
 * not final (cached ≤ 1h, re-read later). Final results (found or proven excluded, past finality) are cached forever.
 */

export type FunderKind = "eoa" | "contract" | "multisend" | "cex" | "bridge" | "launchpad" | "router" | "hub" | "bot_infra" | "relayer" | "aa_bundler" | "program" | "deployer" | "unknown";

export interface Origin {
  wallet: string;
  /** Unix seconds of the first native-coin receipt. */
  fundT: number | null;
  /** Block number (EVM) or slot (Solana) of that receipt. */
  fundRef: number | null;
  funder: string | null;
  funderKind: FunderKind;
  /** EVM: the funding tx's nonce (consecutive-spray test). */
  funderNonce?: number;
  /** A registered disperse / multi-send contract or program the coin came through. */
  via: string | null;
  /** Accounts credited by the same source in the funding tx (batch-withdrawal test). */
  viaRecipients?: number;
  fundTx: string | null;
  method: "helius-gtfa" | "helius-sigs" | "archive-2stage" | "unreadable";
  final: boolean;
  proof?: "balance0+nonce0" | "first-tx" | "not-proven-7702";
  reason?: string;
}

/** The one cache / memo key for a wallet's origin (also used by lib/cluster/collect.ts for the in-request memo). */
export const originKey = (chain: Chain, wallet: string) => `origin:v3:${chain}:${chain === "solana" ? wallet : wallet.toLowerCase()}`;
const KEY = originKey;
/** Non-final results are re-read after at most an hour (a read error is never cached as a fact). */
const NON_FINAL_TTL_S = 3_600;
/** EVM blocks deep before a funding receipt counts as final. */
const EVM_FINALITY_BLOCKS = 64;
/** Solana: a receipt this old (seconds) is past finalisation. */
const SOLANA_FINAL_AGE_S = 120;
/** k-ary bisection: ~6 probes per round over ~10 rounds ≈ 60 archive calls per search (vs ~100 at k = 16). */
const SEARCH_K = 6;
/** Solana: a wallet's first transactions read in one call. 25 covers wallets that received tokens before their first SOL. */
const SOLANA_FIRST_TXS = 25;
const SEARCH_ROUNDS = 14;

const DISPERSE: Record<string, { address: string; label: string }[]> = (disperse as { chains: Record<string, { address: string; label: string }[]> }).chains;
/** Disperse-style selectors (keccak of the signature, first 4 bytes): disperseEther / disperseToken / disperseTokenSimple. */
export const DISPERSE_SELECTORS = new Set(["0xe63d38ed", "0xc73a2d60", "0x51ba162c"]);
const registeredDisperse = (chain: string, address: string) => (DISPERSE[chain] ?? []).find((d) => d.address.toLowerCase() === address.toLowerCase());

export interface OriginCtx {
  /** Absolute epoch-ms deadline: no new lookup starts past it. */
  deadline: number;
  /** One promise per wallet per request, shared by every reader in the request. */
  memo?: Map<string, Promise<Origin>>;
  helius?: Helius | null;
  /** EVM archive RPC override (tests). */
  archive?: Rpc | null;
  now?: () => number;
}

const unreadable = (wallet: string, reason: string, method: Origin["method"] = "unreadable"): Origin => ({ wallet, fundT: null, fundRef: null, funder: null, funderKind: "unknown", via: null, fundTx: null, method, final: false, reason });

/** Cached origins for many wallets in one KV round trip (final ones forever, others ≤ 1h). */
export async function cachedOrigins(chain: Chain, wallets: string[]): Promise<Map<string, Origin>> {
  const rows = await kvMget<Origin>(wallets.map((w) => KEY(chain, w)));
  const out = new Map<string, Origin>();
  rows.forEach((o, i) => {
    if (o) out.set(wallets[i], o);
  });
  return out;
}

async function store(chain: Chain, o: Origin): Promise<void> {
  await kvSet(KEY(chain, o.wallet), o, o.final ? undefined : NON_FINAL_TTL_S);
}

/** The wallet's first funding, read live (memoised per request; the caller reads the cache first via cachedOrigins). */
export function originOf(chain: Chain, wallet: string, ctx: OriginCtx): Promise<Origin> {
  const k = KEY(chain, wallet);
  const hit = ctx.memo?.get(k);
  if (hit) return hit;
  const run = (async () => {
    if (Date.now() >= ctx.deadline) return unreadable(wallet, "time budget spent before this wallet's funding was read");
    let o: Origin;
    try {
      if (chain === "solana") o = ctx.helius ? await solanaOrigin(ctx.helius, wallet, ctx) : unreadable(wallet, "Helius key not set");
      else if (chain === "robinhood" && !ctx.archive) o = unreadable(wallet, "Robinhood RPC keeps no historical state; native funding not readable");
      else if (isEvmChain(chain)) {
        const archive = ctx.archive ?? archiveRpc(chain as EvmChain);
        o = archive ? await evmOrigin(chain as EvmChain, archive, wallet, ctx) : unreadable(wallet, `no archive ${chain} RPC configured`);
      } else o = unreadable(wallet, `funding not readable on ${chain}`);
    } catch (e) {
      o = unreadable(wallet, `funding lookup failed: ${(e as Error).message.slice(0, 80)}`);
    }
    await store(chain, o).catch(() => undefined);
    return o;
  })();
  ctx.memo?.set(k, run);
  return run;
}

// ---------------------------------------------------------------------------------------------------------------
// Solana

const keyOf = (k: { pubkey: string } | string) => (typeof k === "string" ? k : k.pubkey);
let gtfaUnavailable = false;

/**
 * From one transaction: is it the wallet's first SOL receipt, and who paid it? The funder is the non-program account
 * with the largest lamport drop (balance deltas cover inner instructions and disperse programs). No fee-payer fallback.
 */
export function solanaReceipt(tx: FullTx, wallet: string): { funder: string | null; credited: number; why?: string } | null {
  if (!tx.meta || tx.meta.err) return null;
  const keys = tx.transaction.message.accountKeys.map(keyOf);
  const i = keys.indexOf(wallet);
  if (i < 0) return null;
  const rise = (tx.meta.postBalances[i] ?? 0) - (tx.meta.preBalances[i] ?? 0);
  if (rise <= 0) return null;
  let funder: string | null = null;
  let drop = 0;
  let credited = 0;
  keys.forEach((k, j) => {
    const d = (tx.meta!.postBalances[j] ?? 0) - (tx.meta!.preBalances[j] ?? 0);
    if (d > 0 && j !== i) credited++;
    if (j === i || d >= 0) return;
    // The fee payer's drop includes the fee: compare what left beyond the fee.
    const out = -d - (j === 0 ? tx.meta!.fee : 0);
    if (out > drop && !isProgramAddress(k)) {
      drop = out;
      funder = k;
    }
  });
  if (!funder) return { funder: null, credited: credited + 1, why: "SOL arrived from a program-owned account (not attributable to a wallet)" };
  return { funder, credited: credited + 1 };
}

async function solanaOrigin(helius: Helius, wallet: string, ctx: OriginCtx): Promise<Origin> {
  const now = (ctx.now ?? Date.now)() / 1000;
  let txs: FullTx[] | null = null;
  let method: Origin["method"] = "helius-gtfa";
  if (!gtfaUnavailable) {
    try {
      const r = await helius<{ data: FullTx[] }>("getTransactionsForAddress", [wallet, { sortOrder: "asc", limit: SOLANA_FIRST_TXS, transactionDetails: "full", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
      txs = r.data ?? [];
    } catch (e) {
      // The plan may not offer the method: remember it for this instance and use the signatures path.
      if (/method not found|not supported|-32601|unsupported/i.test((e as Error).message)) gtfaUnavailable = true;
      else throw e;
    }
  }
  if (txs == null) {
    method = "helius-sigs";
    const sigs = await helius<{ signature: string }[]>("getSignaturesForAddress", [wallet, { limit: 1000 }]);
    if (!sigs.length) return unreadable(wallet, "no transactions found for this wallet", method);
    if (sigs.length >= 1000) return unreadable(wallet, "active wallet: first funding not reachable inline (≥ 1000 transactions); read in background", method);
    const oldest = await helius<FullTx>("getTransaction", [sigs[sigs.length - 1].signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    txs = oldest ? [oldest] : [];
  }
  for (const tx of txs) {
    const r = solanaReceipt(tx, wallet);
    if (!r) continue;
    const t = tx.blockTime ?? null;
    const final = t != null && now - t > SOLANA_FINAL_AGE_S;
    if (!r.funder) return { wallet, fundT: t, fundRef: tx.slot, funder: null, funderKind: "program", via: null, viaRecipients: r.credited, fundTx: tx.transaction.signatures[0] ?? null, method, final, proof: "first-tx", reason: r.why };
    return { wallet, fundT: t, fundRef: tx.slot, funder: r.funder, funderKind: "eoa", via: null, viaRecipients: r.credited, fundTx: tx.transaction.signatures[0] ?? null, method, final, proof: "first-tx" };
  }
  return unreadable(wallet, method === "helius-gtfa" ? `first ${txs.length} transaction${txs.length === 1 ? "" : "s"} carry no SOL receipt (token-first wallet: tokens arrived before any SOL)` : "the oldest transaction carries no SOL receipt", method);
}

// ---------------------------------------------------------------------------------------------------------------
// EVM (Base, Monad, Ethereum; Robinhood only with an archive override)

interface BlockTx {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  input?: string;
  nonce?: string;
}

async function evmOrigin(chain: EvmChain, rpc: Rpc, wallet: string, ctx: OriginCtx): Promise<Origin> {
  const w = wallet.toLowerCase();
  const head = Number(await rpc<string>("eth_blockNumber", []));
  const code = await rpc<string>("eth_getCode", [w, "latest"]);
  const is7702 = !!code && code.toLowerCase().startsWith("0xef0100");
  const bal = async (b: number) => BigInt((await rpc<string>("eth_getBalance", [w, hex(b)])) || "0x0") > 0n;
  const nonce = async (b: number) => Number(await rpc<string>("eth_getTransactionCount", [w, hex(b)]));
  const [balNow, nonceNow] = await Promise.all([bal(head), nonce(head)]);
  const timeUp = () => unreadable(w, "time budget spent during the funding search", "archive-2stage");
  // Two-stage search. Before an EOA's first outgoing tx its balance can only rise, so a balance bisection below that
  // block is exact. A wallet that never sent a tx never lost coin: the whole range is monotone.
  let block: number | null = null;
  let viaProof = false;
  if (balNow && Date.now() < ctx.deadline) {
    // Fast path: one bisection over the whole range; the proof below (balance 0 and nonce 0 just before) confirms it.
    block = await kSearch(0, head, bal, SEARCH_K, SEARCH_ROUNDS);
    if (block != null) viaProof = (await nonce(block - 1)) === 0;
  }
  if (!viaProof) {
    if (nonceNow === 0) {
      // Not final: the wallet can still be funded later.
      if (!balNow) return unreadable(w, "never held native coin (token-only wallet)", "archive-2stage");
      if (block == null) return unreadable(w, "funding block not found within the search rounds", "archive-2stage");
      viaProof = true; // nonce 0 throughout: the balance never fell, so the first non-zero block is the first funding
    } else {
      if (Date.now() >= ctx.deadline) return timeUp();
      const firstTx = await kSearch(0, head, async (b) => (await nonce(b)) > 0, SEARCH_K, SEARCH_ROUNDS);
      if (firstTx == null) return unreadable(w, "first outgoing transaction not found within the search rounds", "archive-2stage");
      if (!(await bal(firstTx - 1))) return unreadable(w, `no native coin before its first transaction (block ${firstTx}): gas was sponsored or paid in the same block`, "archive-2stage");
      if (Date.now() >= ctx.deadline) return timeUp();
      block = await kSearch(0, firstTx - 1, bal, SEARCH_K, SEARCH_ROUNDS);
      if (block == null) return unreadable(w, "funding block not found within the search rounds", "archive-2stage");
      viaProof = true;
    }
  }
  const b = await rpc<{ timestamp: string; transactions: BlockTx[] } | null>("eth_getBlockByNumber", [hex(block!), true]);
  if (!b) return unreadable(w, `funding block ${block} unreadable`, "archive-2stage");
  const fundT = Number(b.timestamp);
  const final = head - block! > EVM_FINALITY_BLOCKS;
  const proof: Origin["proof"] = is7702 ? "not-proven-7702" : "balance0+nonce0";
  const direct = b.transactions.find((t) => t.to?.toLowerCase() === w && BigInt(t.value || "0x0") > 0n);
  if (direct) {
    return { wallet: w, fundT, fundRef: block, funder: direct.from.toLowerCase(), funderKind: "eoa", funderNonce: direct.nonce != null ? Number(direct.nonce) : undefined, via: null, fundTx: direct.hash, method: "archive-2stage", final: final && !is7702, proof, ...(is7702 ? { reason: "first funding not proven (7702 wallet)" } : {}) };
  }
  // No plain transfer: the coin came through a contract. A registered / disperse-selector contract → its sender funded
  // the wallet; any other contract (bridge fill, relayer, 4337 handleOps, router unwrap) is the funder, excluded later.
  const addr = w.slice(2);
  const carrier = b.transactions.find((t) => (t.input ?? "").toLowerCase().includes(addr));
  if (!carrier || !carrier.to) return { ...unreadable(w, `coin arrived through an internal call in block ${block} (sender not attributable without traces)`, "archive-2stage"), fundRef: block, fundT };
  const to = carrier.to.toLowerCase();
  const selector = (carrier.input ?? "").slice(0, 10).toLowerCase();
  const reg = registeredDisperse(chain, to);
  const recipients = Math.max(1, ((carrier.input ?? "").length - 10) / 64 / 2);
  if (reg || DISPERSE_SELECTORS.has(selector)) {
    return { wallet: w, fundT, fundRef: block, funder: carrier.from.toLowerCase(), funderKind: "multisend", funderNonce: carrier.nonce != null ? Number(carrier.nonce) : undefined, via: to, viaRecipients: Math.round(recipients), fundTx: carrier.hash, method: "archive-2stage", final, proof };
  }
  const toCode = await rpc<string>("eth_getCode", [to, "latest"]).catch(() => null);
  return { wallet: w, fundT, fundRef: block, funder: to, funderKind: toCode && codeKind(toCode) === "contract" ? "contract" : "eoa", via: null, fundTx: carrier.hash, method: "archive-2stage", final, proof };
}
