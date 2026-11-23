import type { AdapterResult, Chain, HolderClassRow, HolderRow, TokenSnapshot } from "./types";
import { equalSplit } from "./snapshot";
import { isEvmChain, type EvmChain } from "./chain";
import { after } from "next/server";
import { archiveRpc, chainLogSpan, chainRpc, codeKind, logsRpc, makeRpc, MAX_SPAN, TRANSFER_TOPIC, addressTopic, hex, topicAddress, windowsBackward, type Rpc, type RpcLog } from "./onchain/rpc";
import { archiveWalletHistory, classifyContract, classRow, creationBlockByCode, creationSender, mintNear, monthOf, nativeFunder, outflowScan, SWAP_TOPICS, type OutflowState, type WalletHistory } from "./onchain/holderClass";
import { infraEntry } from "./onchain/infra";
import { chainCexLabel, chainInfraEntry } from "./onchain/chainInfra";
import { fetchJson } from "./sources/http";
import { solanaRpcUrl } from "./sources/solanaCurve";
import { isProgramAddress, heliusClient } from "./timemachine/solana";
import { kvGet, kvSet } from "./kv";
import { evmFounderLink, type FounderVerdict } from "./onchain/founderLink";

const firstReceiptKey = (chain: Chain, token: string, wallet: string) => `first-receipt:v2:${chain}:${token}:${wallet}`;

/** Who first sent the wallet tokens, and in which tx (archive search; immutable, cached for 30 days). */
async function firstReceipt(chain: EvmChain, archive: Rpc, token: string, wallet: string, fromBlock: number, head: number, deadline: number, cached?: Promise<{ block: number; from: string | null; tx: string | null } | null>): Promise<{ block: number; from: string | null; tx: string | null } | null> {
  const key = firstReceiptKey(chain, token, wallet);
  const hit = await (cached ?? kvGet<{ block: number; from: string | null; tx: string | null }>(key).catch(() => null));
  if (hit) return hit;
  const h = await archiveWalletHistory(archive, token, wallet, { fromBlock, head, maxCalls: 130, deadline: deadline - 1_000, firstReceiptOnly: true }).catch(() => null);
  if (h?.firstReceipt) await kvSet(key, h.firstReceipt, 30 * 86_400).catch(() => undefined);
  return h?.firstReceipt ?? null;
}

/** Who first sent the wallet native coin (archive search; immutable, cached for 30 days). */
async function firstNative(chain: EvmChain, archive: Rpc, wallet: string, head: number): Promise<{ block: number; from: string | null; tx: string | null } | null> {
  const key = `first-native:v1:${chain}:${wallet}`;
  const hit = await kvGet<{ block: number; from: string | null; tx: string | null }>(key).catch(() => null);
  if (hit) return hit;
  const out = await nativeFunder(archive, wallet, head).catch(() => null);
  if (out) await kvSet(key, out, 30 * 86_400).catch(() => undefined);
  return out;
}

/** A Transfer from the deployer is a plain transfer, not a swap, when its tx has no Swap event. */
async function isPlainTransfer(rpc: Rpc, tx: string | null): Promise<boolean> {
  if (!tx) return false;
  const receipt = await rpc<{ logs: { topics: string[] }[] } | null>("eth_getTransactionReceipt", [tx]).catch(() => null);
  return !!receipt && !receipt.logs.some((l) => SWAP_TOPICS.has(l.topics[0]));
}

/** Funders count only as an externally owned deployer (a launchpad / factory contract funds everyone). */
async function isEoa(rpc: Rpc, address: string): Promise<boolean> {
  const code = await rpc<string>("eth_getCode", [address, "latest"]).catch(() => null);
  return code != null && codeKind(code) === "wallet";
}

const TEAM_LABEL = "team wallet (deployer-funded)";
const FOUNDER_LINKED_LABEL = "founder wallet (linked to the deployer)";

/** Widest eth_getLogs span the chain's log-capable public endpoints serve. */
const logSpan = (chain: EvmChain) => chainLogSpan(chain);

/** Creation block and creation-tx sender from archive state — immutable, cached for 30 days. */
async function archiveCreation(chain: EvmChain, archive: Rpc, token: string, head: number, createdAt: string | null): Promise<{ block: number; sender: string | null } | null> {
  const key = `creation:archive:v1:${chain}:${token}`;
  const hit = await kvGet<{ block: number; sender: string | null }>(key).catch(() => null);
  if (hit) return hit;
  // Launch time known: the mint log near it (a few calls). Else bisect eth_getCode on archive state.
  const span = logSpan(chain);
  let out = createdAt ? await mintNear(chainRpc(chain), token, Math.floor(Date.parse(createdAt) / 1000), head, span).catch(() => null) : null;
  if (!out) {
    const block = await creationBlockByCode(archive, token, head).catch(() => null);
    if (block == null) return null;
    out = { block, sender: await creationSender(archive, token, block) };
  }
  if (out.sender) await kvSet(key, out, 30 * 86_400).catch(() => undefined);
  return out;
}

/** Top non-LP holders classified per run. */
export const CLASSIFIED_TOP = 5;
/** Below this share the founder rules cannot bind, so the sell history is not read. */
const FOUNDER_MIN_PCT = 20;
/** The founder softening needs this much history (days). */
export const FOUNDER_MIN_DAYS = 30;
const ZERO = "0x0000000000000000000000000000000000000000";
/** EVM addresses compare case-insensitively; Solana base58 addresses are case-sensitive. */
const key = (a: string) => (a.startsWith("0x") ? a.toLowerCase() : a);

/** Solana programs whose accounts own locked / vesting / multisig balances. */
export const SOLANA_HOLDER_PROGRAMS: Record<string, { class: "vesting" | "treasury"; label: string }> = {
  strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m: { class: "vesting", label: "vesting contract (Streamflow)" },
  LocktDzaV1W2Bm9DeZeiyz4J9zs4fRqNiYqQyracRXw: { class: "vesting", label: "vesting contract (Jupiter Lock)" },
  CChTq6PthWU82YZkbveA3WDf7s97BWhBK4Vx9bmsT743: { class: "vesting", label: "vesting contract (Bonfida)" },
  SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu: { class: "treasury", label: "treasury (multisig, Squads v3)" },
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf: { class: "treasury", label: "treasury (multisig, Squads v4)" },
};

export { largestHolderLine } from "./holderLine";

interface Ctx {
  chain: Chain;
  token: string;
  s: TokenSnapshot;
  results: AdapterResult[];
  deadline: number;
  /** The archive creation lookup, shared by the classification and the history steps of one run. */
  creation?: Promise<{ block: number; sender: string | null } | null>;
}

const rawOf = <T,>(results: AdapterResult[], id: string) => results.find((r) => r.status.id === id)?.raw as T | undefined;

function deployersOf(ctx: Ctx): Set<string> {
  const set = new Set<string>();
  for (const r of ctx.results) if (r.data.deployerAddress) set.add(key(r.data.deployerAddress));
  if (ctx.s.deployerAddress) set.add(key(ctx.s.deployerAddress));
  const creation = rawOf<{ creation?: { deployer?: string } | null }>(ctx.results, "rpc")?.creation;
  if (creation?.deployer) set.add(key(creation.deployer));
  return set;
}

function isPoolish(chain: Chain, s: TokenSnapshot, address: string): boolean {
  const a = address.toLowerCase();
  if (a === ZERO || a.endsWith("dead") || s.poolAddresses.includes(a)) return true;
  if (chain === "robinhood") return !!infraEntry(a);
  if (isEvmChain(chain)) return !!chainInfraEntry(chain, a);
  return false;
}

/** The top-5 non-LP holders across the wallet and contract lists, largest first. */
function candidates(chain: Chain, s: TokenSnapshot): HolderRow[] {
  const seen = new Set<string>();
  return [...s.holders, ...s.liquidityHolders]
    .filter((h) => h.pct != null && !isPoolish(chain, s, h.address))
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
    .filter((h) => (seen.has(key(h.address)) ? false : (seen.add(key(h.address)), true)))
    .slice(0, CLASSIFIED_TOP);
}

/**
 * Classifies the top-5 non-LP holders and applies the classes to the holder math:
 * vesting / locker / staking / unclassified contracts stay excluded (listed apart, labelled); a Safe /
 * Squads treasury is counted and labelled. When the largest counted holder is the deployer, its whole
 * sell history decides the founder fields (founderNeverSold / founderSold / founderHoldDays).
 */
export async function classifyTopHolders(chain: Chain, token: string, s: TokenSnapshot, results: AdapterResult[], deadline: number): Promise<void> {
  const ctx: Ctx = { chain, token: key(token), s, results, deadline };
  const top = candidates(chain, s);
  if (!top.length) {
    s.nullReasons = { ...s.nullReasons, largestHolder: "no holder list from any source" };
    return;
  }
  const rows = isEvmChain(chain) ? await classifyEvm(ctx, chain, top) : await classifySolana(ctx, top);
  s.holderClasses = rows;
  applyHolderClasses(s, rows);
  const largest = s.holders[0] ? rows.find((r) => r.address === key(s.holders[0].address)) ?? null : null;
  s.largestHolder = largest;
  const role = largest?.class === "founder" || largest?.class === "team" ? largest.class : null;
  if (largest && role && (largest.pct ?? 0) > FOUNDER_MIN_PCT) {
    if (role === "founder") s.teamNeverSold = false;
    else s.founderNeverSold = false;
    s.nullReasons = { ...s.nullReasons, [role === "founder" ? "teamSold" : "founderSold"]: role === "founder" ? (largest.label === FOUNDER_LINKED_LABEL ? `largest holder is the founder (${largest.label})` : "largest holder is the deployer itself") : "largest holder is a team wallet, not the deployer" };
    await keyHolderHistory(ctx, largest, role);
  } else if (largest) {
    // Not the deployer nor a deployer-funded wallet (or below the 20% the rules start at): the normal caps apply.
    s.founderNeverSold = false;
    s.teamNeverSold = false;
    const why = role ? `${role === "founder" ? "founder" : "team wallet"} holds ≤ ${FOUNDER_MIN_PCT}% — sell history not read` : null;
    s.nullReasons = { ...s.nullReasons, founderSold: why ?? "largest holder is not the deployer", teamSold: why ?? "largest holder is not a deployer-funded wallet" };
  }
}

/** Moves Safe treasuries into the counted list and vesting / lockers out of it, then re-derives the concentration metrics. */
export function applyHolderClasses(s: TokenSnapshot, rows: HolderClassRow[]) {
  const byAddr = new Map(rows.map((r) => [r.address, r]));
  let changed = false;
  const label = (h: HolderRow): HolderRow => {
    const r = byAddr.get(key(h.address));
    return r ? { ...h, label: r.label } : h;
  };
  const wallets: HolderRow[] = [];
  const held: HolderRow[] = [];
  for (const h of s.holders.map(label)) {
    const r = byAddr.get(key(h.address));
    if (r && !r.counted) {
      held.push({ ...h, kind: "liquidity" });
      changed = true;
    } else wallets.push(h);
  }
  for (const h of s.liquidityHolders.map(label)) {
    const r = byAddr.get(key(h.address));
    if (r?.counted) {
      wallets.push({ ...h, kind: "wallet" });
      changed = true;
    } else held.push(h);
  }
  s.holders = wallets.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  s.liquidityHolders = held.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  if (!changed) return;
  const now = new Date().toISOString();
  const top1 = s.holders[0]?.pct ?? 0;
  const top10 = Math.round(s.holders.slice(0, 10).reduce((a, h) => a + (h.pct ?? 0), 0) * 100) / 100;
  const prov = (metric: string, value: number) => {
    s.provenance = { ...s.provenance, [metric]: [...(s.provenance[metric] ?? []), { source: "holder-class", label: "Holder classification (derived)", value, fetchedAt: now, onchain: true }] };
  };
  s.top1SharePct = top1;
  s.top10SharePct = top10;
  const split = equalSplit(s.holders);
  s.equalSplitPct = split.pct;
  s.equalSplitCount = split.count;
  prov("top1SharePct", top1);
  prov("top10SharePct", top10);
  s.liquidityHeldPct = Math.round(s.liquidityHolders.reduce((a, h) => a + (h.pct ?? 0), 0) * 100) / 100;
}

async function classifyEvm(ctx: Ctx, chain: EvmChain, top: HolderRow[]): Promise<HolderClassRow[]> {
  const rpc: Rpc = chain === "robinhood" ? makeRpc() : chainRpc(chain);
  const deployers = deployersOf(ctx);
  const codes = await Promise.all(top.map((h) => rpc<string>("eth_getCode", [h.address, "latest"], 10_000).catch(() => null)));
  const rows = await Promise.all(
    top.map(async (h, i): Promise<HolderClassRow> => {
      const a = h.address.toLowerCase();
      const code = codes[i];
      if (code == null) return classRow({ address: a, pct: h.pct, class: h.kind === "wallet" ? "wallet" : "contract", label: h.kind === "wallet" ? "wallet" : "unclassified contract", detail: null, unlocksAt: null, evidence: "eth_getCode failed — class from the source's contract flag" });
      if (codeKind(code) === "wallet") {
        const what = code.length > 2 ? `EIP-7702 / minimal code (${(code.length - 2) / 2} B)` : "no code (EOA)";
        if (deployers.has(a)) return classRow({ address: a, pct: h.pct, class: "founder", label: "founder wallet (deployer)", detail: null, unlocksAt: null, evidence: `${what}; equals the deployer / creator` });
        // A registered exchange wallet keeps its name (still a counted wallet; Holder Strength excludes CEX-labelled rows).
        const cex = chain === "robinhood" ? undefined : chainCexLabel(chain, a);
        return classRow({ address: a, pct: h.pct, class: "wallet", label: cex ?? "wallet", detail: null, unlocksAt: null, evidence: `${what}; not the deployer (${[...deployers].map((d) => d.slice(0, 8) + "…").join(", ") || "deployer unknown"})${cex ? `; ${cex} (data/${chain}-infra.json → cexWallets)` : ""}` });
      }
      const v = await classifyContract(rpc, a, ctx.token, code).catch((e: Error) => ({ class: "contract" as const, label: "unclassified contract", unlocksAt: null, detail: null, evidence: `classification failed: ${e.message.slice(0, 80)}` }));
      return classRow({ address: a, pct: h.pct, class: v.class, label: v.label, detail: v.detail ?? (v.unlocksAt ? `unlocks ${monthOf(v.unlocksAt)}` : null), unlocksAt: v.unlocksAt, evidence: v.evidence });
    }),
  );
  // A large EOA that no source names as deployer: the creation tx's sender is the deployer too (archive state).
  // Not the deployer either: founder-link due diligence (lib/onchain/founderLink.ts) — one direct clue (its first
  // tokens by plain transfer from the deployer, or its first native coin from the deployer) makes a team wallet;
  // two or more clues make a founder wallet linked to the deployer.
  const big = rows.find((r) => r.class === "wallet" && (r.pct ?? 0) > FOUNDER_MIN_PCT);
  const archive = chain === "robinhood" ? null : archiveRpc(chain);
  const link = (r: HolderClassRow, v: FounderVerdict, from: string, tx: string | null) => {
    if (v.role === "founder") Object.assign(r, classRow({ ...r, class: "founder", label: FOUNDER_LINKED_LABEL, fundingTx: tx, evidence: `${r.evidence}; linked to the deployer ${from} — ${v.summary}` }));
    else if (v.role === "team") Object.assign(r, classRow({ ...r, class: "team", label: TEAM_LABEL, fundingTx: tx, evidence: `${r.evidence}; funded by the deployer ${from} — ${v.summary}` }));
    else r.evidence = `${r.evidence}; ${v.summary}`;
  };
  if (big && archive && Date.now() < ctx.deadline - 3_000) {
    // The cached first receipt is fetched alongside the creation lookup (two KV round trips side by side).
    const cachedFirst = kvGet<{ block: number; from: string | null; tx: string | null }>(firstReceiptKey(chain, ctx.token, big.address)).catch(() => null);
    const head = Number(await archive<string>("eth_blockNumber", []));
    const created = await (ctx.creation ??= archiveCreation(chain, archive, ctx.token, head, ctx.s.createdAt));
    const block = created?.block ?? null;
    const sender = created?.sender ?? null;
    if (sender) deployers.add(sender);
    if (sender && sender === big.address) Object.assign(big, classRow({ ...big, class: "founder", label: "founder wallet (deployer)", evidence: `${big.evidence.split(";")[0]}; sent the creation tx (block ${block})` }));
    else {
      // Who funded it: the first Transfer into the wallet (archive bisection on balanceOf).
      const fr = await firstReceipt(chain, archive, ctx.token, big.address, block ?? 0, head, ctx.deadline, cachedFirst);
      const from = fr?.from ?? null;
      big.evidence = `${big.evidence.split(";")[0]}; not the deployer (${sender ? `creation tx sent by ${sender}` : "creation tx not found"}${[...deployers].filter((d) => d !== sender).map((d) => `, creator ${d}`).join("")})${from ? `; first tokens received from ${from} at block ${fr!.block}` : ""}`;
      const tokensFrom = from && deployers.has(from) && (await isEoa(archive, from)) ? from : null;
      const plain = tokensFrom ? await isPlainTransfer(archive, fr!.tx) : false;
      const coin = chain === "monad" ? "MON" : "ETH";
      const gasTime = Date.now() < ctx.deadline - 2_000;
      const nf = gasTime ? await firstNative(chain, archive, big.address, head) : null;
      const gasFrom = nf?.from && deployers.has(nf.from) && (await isEoa(archive, nf.from)) ? nf.from : null;
      const d = (plain ? tokensFrom : null) ?? gasFrom ?? tokensFrom;
      if (d) {
        const dGas = Date.now() < ctx.deadline - 2_000 ? await firstNative(chain, archive, d, head) : null;
        const gasReason = !gasTime ? "time budget spent before the native-coin lookup" : !nf ? `first ${coin} receipt not found` : !dGas ? `deployer's first ${coin} receipt not read (time budget or not found)` : undefined;
        const v = await evmFounderLink(archive, { token: ctx.token, wallet: big.address, deployer: d, first: fr, firstPlain: plain && tokensFrom === d, walletGas: nf, deployerGas: dGas, gasReason, isExchange: (a) => !!chainCexLabel(chain, a) });
        link(big, v, d, plain && tokensFrom === d ? fr!.tx : nf?.tx ?? null);
      } else if (nf) big.evidence = `${big.evidence}; first ${coin} ${nf.from ? `from ${nf.from}` : "through an internal call (sender not attributable)"} at block ${nf.block}`;
    }
  }
  if (big && chain === "robinhood" && Date.now() < ctx.deadline - 3_000) {
    const creation = rawOf<{ creation?: { creationBlock: number } | null }>(ctx.results, "rpc")?.creation;
    if (creation) {
      const head = Number(await rpc<string>("eth_blockNumber", []));
      const first = await firstInbound(rpc, ctx.token, big.address, creation.creationBlock, head).catch(() => null);
      if (first) {
        big.evidence = `${big.evidence}; first tokens received from ${first.from} at block ${first.block}`;
        if (deployers.has(first.from) && (await isEoa(rpc, first.from))) {
          const plain = await isPlainTransfer(rpc, first.tx);
          const v = await evmFounderLink(rpc, { token: ctx.token, wallet: big.address, deployer: first.from, first, firstPlain: plain, walletGas: null, deployerGas: null, gasReason: "native-coin funding not read on Robinhood Chain (no archive RPC)" });
          link(big, v, first.from, first.tx);
        }
      }
    }
  }
  return rows;
}

async function classifySolana(ctx: Ctx, top: HolderRow[]): Promise<HolderClassRow[]> {
  const deployers = deployersOf(ctx);
  const owners = top.map((h) => h.address);
  const res = await fetchJson<{ result?: { value: ({ owner: string; executable: boolean } | null)[] } }>(solanaRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [owners, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }] }),
    timeoutMs: 10_000,
  }).catch(() => null);
  const accts = res?.result?.value ?? owners.map(() => undefined);
  const rows = top.map((h, i): HolderClassRow => {
    const a = h.address;
    const acct = accts[i];
    const program = acct?.owner ?? null;
    const known = program ? SOLANA_HOLDER_PROGRAMS[program] : undefined;
    if (known) return classRow({ address: a, pct: h.pct, class: known.class, label: known.label, detail: null, unlocksAt: null, evidence: `account owned by program ${program} — schedule not read` });
    if (acct === undefined) return classRow({ address: a, pct: h.pct, class: "wallet", label: "wallet", detail: null, unlocksAt: null, evidence: "getMultipleAccounts failed — kept as listed by the source" });
    const offCurve = isProgramAddress(a);
    if (deployers.has(a) && !offCurve) return classRow({ address: a, pct: h.pct, class: "founder", label: "founder wallet (deployer)", detail: null, unlocksAt: null, evidence: "on-curve key; equals the creator" });
    // Off-curve, not a known lock / multisig program: kept where the source put it (counted), labelled.
    return classRow({
      address: a,
      pct: h.pct,
      class: "wallet",
      label: offCurve ? "program-owned address (unclassified)" : "wallet",
      detail: null,
      unlocksAt: null,
      evidence: offCurve ? `off-curve address${program ? ` (account owner ${program})` : ""}; no lock / multisig program matched` : `on-curve key${program ? ` (account owner ${program})` : ""}; not the creator`,
    });
  });
  // A large on-curve wallet the creator funded (its first SOL, or its first tokens by plain transfer): a team wallet.
  const big = rows.find((r) => r.class === "wallet" && r.label === "wallet" && (r.pct ?? 0) > FOUNDER_MIN_PCT);
  if (big && deployers.size && Date.now() < ctx.deadline - 3_000) {
    const f = await solanaFunding(big.address, deployers, ctx.s.address).catch(() => null);
    if (f?.from) Object.assign(big, classRow({ ...big, class: "team", label: TEAM_LABEL, fundingTx: f.tx, evidence: `${big.evidence}; funded by the creator ${f.from}: ${f.how} in tx ${f.tx}` }));
    else if (f) big.evidence = `${big.evidence}; ${f.how}`;
  }
  return rows;
}

/** The wallet's earliest transactions (Helius, oldest first): did a creator send it its first SOL or its first tokens by plain transfer? */
async function solanaFunding(wallet: string, creators: Set<string>, mint: string): Promise<{ from: string | null; tx: string | null; how: string } | null> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return null;
  const page = await heliusClient(key)<{ data: (SolTx & { transaction: { signatures: string[] } })[] }>("getTransactionsForAddress", [wallet, { sortOrder: "asc", limit: 100, transactionDetails: "full", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
  const amt = (list: TokenBal[] | undefined, owner: string) => (list ?? []).filter((b) => b.mint === mint && b.owner === owner).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  let solChecked = false;
  for (const tx of page.data) {
    const m = tx.meta;
    if (!m || m.err) continue;
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
    const wi = keys.indexOf(wallet);
    const sig = tx.transaction.signatures[0] ?? null;
    if (!solChecked && wi >= 0 && m.postBalances[wi] > m.preBalances[wi]) {
      solChecked = true;
      const payer = [...creators].find((c) => keys.includes(c) && m.postBalances[keys.indexOf(c)] < m.preBalances[keys.indexOf(c)]);
      if (payer) return { from: payer, tx: sig, how: "first SOL it ever received" };
    }
    if (amt(m.postTokenBalances, wallet) > amt(m.preTokenBalances, wallet)) {
      // A swap moves tokens out of an off-curve pool; a plain transfer moves them out of the creator's own account.
      const sender = [...creators].find((c) => amt(m.preTokenBalances, c) > amt(m.postTokenBalances, c));
      return sender ? { from: sender, tx: sig, how: "first tokens by plain transfer" } : { from: null, tx: sig, how: "first tokens not from the creator" };
    }
  }
  return { from: null, tx: null, how: "first token receipt not in the wallet's first 100 transactions" };
}

/** How long an unfinished outbound scan keeps reading after the response. */
const OUTFLOW_BACKGROUND_MS = 35_000;

/** Resumable outbound scan state, per token and wallet (past blocks never change). */
const outflowKey = (chain: Chain, token: string, wallet: string) => `outflows:v1:${chain}:${token}:${wallet}`;

/**
 * The founder's / team wallet's whole sell history (chain-specific), then the role's fields. EVM: the cheap
 * archive proofs first (never sent a tx, or none since its first receipt), else every outbound Transfer
 * log since its first receipt, read window by window and resumed across requests until complete.
 */
async function keyHolderHistory(ctx: Ctx, f: HolderClassRow, role: "founder" | "team"): Promise<void> {
  const { s } = ctx;
  const age = s.ageHours;
  let sells: number | null = null;
  let complete = false;
  let reason: string | null = null;
  let method = "";
  let sellTx: string | null = null;
  let days = age != null ? Math.floor(age / 24) : null;
  const savedOutflow = kvGet<OutflowState>(outflowKey(ctx.chain, ctx.token, f.address)).catch(() => null);
  const scan = async (rpc: Rpc, fromBlock: number, head: number, span: number, nonceAt?: (b: number) => Promise<number>) => {
    const k = outflowKey(ctx.chain, ctx.token, f.address);
    let first = true;
    const run = async (deadline: number) => {
      // The first read uses the state fetched when the step started (KV round trips run side by side).
      const saved = first ? await savedOutflow : await kvGet<OutflowState>(k).catch(() => null);
      first = false;
      const r = await outflowScan(rpc, ctx.token, f.address, { fromBlock, head, span, deadline, isPool: (a) => isPoolish(ctx.chain, s, a), state: saved, nonceAt });
      const state: OutflowState = { fromBlock: r.fromBlock, scannedTo: r.scannedTo, toPools: r.toPools, transfersOut: r.transfersOut, transfersOutRaw: r.transfersOutRaw, sellTxs: r.sellTxs, nonceSkipped: r.nonceSkipped };
      await kvSet(k, state, 30 * 86_400).catch(() => undefined);
      return r;
    };
    const r = await run(ctx.deadline - 2_500);
    // Unfinished: keep reading after the response (Vercel `after`), so the next analysis starts further on.
    if (!r.complete) {
      try {
        after(() => run(Date.now() + OUTFLOW_BACKGROUND_MS).then(() => undefined, () => undefined));
      } catch {
        // Outside a request (scripts): the next call resumes from the saved state.
      }
    }
    return r;
  };
  try {
    if (ctx.chain === "robinhood") {
      const raw = rawOf<{ creation?: { deployer: string; creationBlock: number } | null; deployer?: { sentToContracts: string; sentToWallets: string } }>(ctx.results, "rpc");
      const swap = s.swapHolders.find((h) => h.address.toLowerCase() === f.address);
      if (role === "founder" && raw?.creation?.deployer?.toLowerCase() === f.address && raw.deployer) {
        const sold = BigInt(raw.deployer.sentToContracts) > 0n;
        sells = (sold ? 1 : 0) + (swap?.sells ?? 0);
        complete = true;
        method = `deployer Transfer logs since creation: ${sold ? "tokens moved in swaps / into contracts" : "nothing sold or sent to a pool / router"}${swap?.sells != null ? `; HoodScan swap index: ${swap.sells} sells` : ""}`;
      } else if (raw?.creation) {
        const rpc = makeRpc();
        const head = Number(await rpc<string>("eth_blockNumber", []));
        const r = await scan(rpc, raw.creation.creationBlock, head, MAX_SPAN);
        sells = r.toPools + (swap?.sells ?? 0);
        sellTx = r.sellTxs[0] ?? null;
        complete = r.complete;
        if (!r.complete) reason = `outbound transfer scan read to block ${r.scannedTo} of ${head} — continues on the next analysis`;
        method = `outbound Transfer logs since creation: ${r.toPools} into pools / routers / contracts, ${r.transfersOut} to wallets${swap?.sells != null ? `; HoodScan swap index: ${swap.sells} sells` : ""}`;
      } else reason = "token creation block unknown (Robinhood RPC)";
    } else if (ctx.chain === "base" || ctx.chain === "monad" || ctx.chain === "ethereum") {
      const archive = archiveRpc(ctx.chain);
      if (!archive) reason = `no archive ${ctx.chain} RPC configured`;
      else {
        // Independent lookups side by side: head, the cached first receipt, nad.fun's swap history.
        const nadfun = ctx.chain === "monad" ? nadfunSells(ctx.token, f.address) : null;
        const [head, knownFirst] = await Promise.all([
          archive<string>("eth_blockNumber", []).then(Number),
          kvGet<{ block: number; from: string | null; tx: string | null }>(firstReceiptKey(ctx.chain, ctx.token, f.address)).catch(() => null),
        ]);
        const from = (await (ctx.creation ??= archiveCreation(ctx.chain, archive, ctx.token, head, s.createdAt)))?.block ?? 0;
        const h: WalletHistory = await archiveWalletHistory(archive, ctx.token, f.address, { fromBlock: from, head, maxCalls: 160, deadline: ctx.deadline - 1_000, isPool: (a) => isPoolish(ctx.chain, s, a), proofsOnly: true, knownFirst });
        let swapSells = 0;
        let swapNote = "";
        if (ctx.chain === "monad") {
          const nf = await nadfun!;
          if (nf.sells == null) reason = nf.note;
          else {
            swapSells = nf.sells;
            swapNote = `; nad.fun swap history: ${nf.note}`;
          }
        }
        if (h.complete) {
          sells = h.toPools + swapSells;
          complete = reason == null;
          method = `${h.method}${swapNote}`;
        } else {
          const start = h.firstReceipt?.block ?? from;
          const nonceAt = (b: number) => archive<string>("eth_getTransactionCount", [f.address, hex(b)], 8_000).then(Number);
          const r = await scan(logsRpc(ctx.chain), start, head, logSpan(ctx.chain), nonceAt);
          sells = r.toPools + swapSells;
          sellTx = r.sellTxs[0] ?? null;
          complete = r.complete && reason == null;
          if (!r.complete) reason = reason ?? `outbound transfer scan read blocks ${start}–${r.scannedTo} of ${head} (${Math.round(((r.scannedTo - start) / Math.max(1, head - start)) * 100)}%) — continues on the next analysis`;
          method = `outbound Transfer logs since the first receipt (block ${start}): ${r.toPools} into pools / routers / contracts, ${r.transfersOut} to wallets${r.nonceSkipped ? ` (${Math.round((r.nonceSkipped / Math.max(1, r.scannedTo - start)) * 100)}% of the blocks skipped: the wallet's nonce did not change there, so it sent nothing)` : ""}${swapNote}`;
        }
        if (h.firstReceipt) {
          const b = await archive<{ timestamp: string } | null>("eth_getBlockByNumber", [hex(h.firstReceipt.block), false]).catch(() => null);
          if (b) days = Math.floor((Date.now() / 1000 - Number(b.timestamp)) / 86_400);
        }
      }
    } else {
      const r = await solanaWalletHistory(f.address, s);
      sells = r.sells;
      complete = r.complete;
      reason = r.reason;
      method = r.method;
    }
  } catch (e) {
    reason = `sell history lookup failed: ${(e as Error).message.slice(0, 80)}`;
  }
  const who = role === "founder" ? "founder" : "team wallet";
  if (role === "founder") s.founderHoldDays = days;
  else s.teamHoldDays = days;
  f.evidence = `${f.evidence}; ${method || reason}${sellTx ? `; first sell / pool transfer in tx ${sellTx}` : ""}`;
  if (sells != null && sells > 0) {
    if (role === "founder") Object.assign(s, { founderSold: true, founderNeverSold: false });
    else Object.assign(s, { teamSold: true, teamNeverSold: false });
    f.detail = `${sells} sell${sells === 1 ? "" : "s"} — ${who} started selling`;
    return;
  }
  if (!complete) {
    const why = reason ?? "sell history incomplete";
    s.nullReasons = { ...s.nullReasons, ...(role === "founder" ? { founderNeverSold: why, founderSold: why } : { teamNeverSold: why, teamSold: why }) };
    f.detail = `sell history not fully read (${why})`;
    return;
  }
  const never = days != null && days >= FOUNDER_MIN_DAYS;
  if (role === "founder") Object.assign(s, { founderSold: false, founderNeverSold: never });
  else Object.assign(s, { teamSold: false, teamNeverSold: never });
  if (days == null) s.nullReasons = { ...s.nullReasons, [role === "founder" ? "founderHoldDays" : "teamHoldDays"]: "token age unknown" };
  f.detail = `0 sells in ${days ?? "?"}d`;
}

/** nad.fun's swap index for one account on one token (curve and DEX), every page. */
async function nadfunSells(token: string, account: string): Promise<{ sells: number | null; note: string }> {
  const headers = process.env.NAD_API_KEY ? { "X-API-Key": process.env.NAD_API_KEY } : undefined;
  let sells = 0;
  let buys = 0;
  for (let page = 1; page <= 5; page++) {
    const r = await fetchJson<{ swaps?: { swap_info: { event_type: string } }[]; total_count?: number }>(`https://api.nad.fun/agent/swap-history/${token}?limit=100&page=${page}&account_id=${account}`, { headers, timeoutMs: 10_000 }).catch((e: Error) => e);
    if (r instanceof Error) return { sells: null, note: `nad.fun swap history failed: ${r.message.slice(0, 80)}` };
    for (const x of r.swaps ?? []) {
      if (x.swap_info.event_type === "SELL") sells++;
      else buys++;
    }
    if ((r.swaps?.length ?? 0) < 100 || buys + sells >= (r.total_count ?? 0)) return { sells, note: `${buys} buys, ${sells} sells` };
  }
  return { sells: sells > 0 ? sells : null, note: `more than 500 swaps — only the latest 500 read` };
}

interface TokenBal {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}
interface SolTx {
  meta: { err: unknown; preBalances: number[]; postBalances: number[]; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | null;
  transaction: { message: { accountKeys: ({ pubkey: string } | string)[] } };
}

/** A wallet's whole history when it has < 100 transactions (Helius): a token outflow paid in SOL, or into an off-curve owner, is a sell. */
async function solanaWalletHistory(creator: string, s: TokenSnapshot): Promise<{ sells: number | null; complete: boolean; reason: string | null; method: string }> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return { sells: null, complete: false, reason: "Helius key not set", method: "" };
  const call = heliusClient(key);
  const page = await call<{ data: SolTx[] }>("getTransactionsForAddress", [creator, { sortOrder: "asc", limit: 100, transactionDetails: "full", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
  if (page.data.length >= 100) return { sells: null, complete: false, reason: "creator has ≥ 100 transactions — whole history not read per request", method: "" };
  const mint = s.address;
  const amt = (list: TokenBal[] | undefined, owner: string) => (list ?? []).filter((b) => b.mint === mint && b.owner === owner).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  let sells = 0;
  let transfers = 0;
  for (const tx of page.data) {
    const m = tx.meta;
    if (!m || m.err) continue;
    if (amt(m.preTokenBalances, creator) - amt(m.postTokenBalances, creator) <= 0n) continue;
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
    const i = keys.indexOf(creator);
    const solIn = i >= 0 ? m.postBalances[i] - m.preBalances[i] : 0;
    const gainers = [...new Set((m.postTokenBalances ?? []).filter((b) => b.mint === mint && b.owner && b.owner !== creator).map((b) => b.owner!))].filter((o) => amt(m.postTokenBalances, o) > amt(m.preTokenBalances, o));
    if (solIn > 0 || gainers.some(isProgramAddress)) sells++;
    else transfers++;
  }
  return { sells, complete: true, reason: null, method: `whole creator history (${page.data.length} txs, Helius): ${sells} sells / pool transfers, ${transfers} transfers to wallets` };
}

// Robinhood: the earliest Transfer into a wallet (who funded it), from filtered logs.
export async function firstInbound(rpc: Rpc, token: string, wallet: string, fromBlock: number, head: number): Promise<{ from: string; block: number; tx: string } | null> {
  for (const [f, t] of windowsBackward(fromBlock, head, MAX_SPAN).reverse()) {
    const logs = await rpc<RpcLog[]>("eth_getLogs", [{ address: token, topics: [TRANSFER_TOPIC, null, addressTopic(wallet)], fromBlock: hex(f), toBlock: hex(t) }]);
    if (logs.length) return { from: topicAddress(logs[0].topics[1]), block: Number(logs[0].blockNumber), tx: logs[0].transactionHash };
  }
  return null;
}
