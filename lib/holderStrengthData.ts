import { after } from "next/server";
import type { AdapterResult, Chain, TokenSnapshot } from "./types";
import { isEvmChain, type EvmChain } from "./chain";
import { archiveRpc, chainLogSpan, chainRpc, codeKind, endpointList, hex, logsRpc, makeRpc, ROBINHOOD_RPC, TRANSFER_TOPIC, addressTopic, topicAddress, type Rpc, type RpcLog } from "./onchain/rpc";
import { nativeFunder } from "./onchain/holderClass";
import { infraEntry } from "./onchain/infra";
import { chainInfraEntry } from "./onchain/chainInfra";
import { mcpCall } from "./sources/http";
import { heliusClient, isProgramAddress, mintDeltas, walletOrigin, type FullTx, type Helius } from "./timemachine/solana";
import { kvGet, kvSet } from "./kv";
import { creationKey } from "./onchain/keys";
import { computeHolderStrength, type DayCandle, type HolderLedger, type HolderStrength, type LedgerClass, type LedgerEvent } from "./holderStrength";

/**
 * Gathers the top-20 holders' ledgers for Holder Strength, per chain:
 * - EVM (Robinhood Chain, Base, Monad): the token's Transfer logs to and from those wallets, read window by window and saved between
 *   requests (a pool / router / contract counterparty is a swap, a wallet counterparty a transfer);
 * - Solana: Helius history of each wallet's token account for this mint.
 * Wallet age: Base / Monad from archive state (first block holding native coin), Robinhood from HoodScan (first indexed
 * swap), Solana from Helius (first tx).
 */

export const STRENGTH_TOP = 20;
const DAY = 86_400;
const CEX = /\b(binance|coinbase|okx|okex|bybit|kraken|gate\.?io|kucoin|mexc|bitget|htx|huobi|crypto\.com|upbit|bitfinex|bitstamp|gemini|bithumb|robinhood exchange)\b/i;
/** How long an unfinished ledger keeps reading after the response. */
const BACKGROUND_MS = 35_000;

interface Ctx {
  chain: Chain;
  token: string;
  s: TokenSnapshot;
  results: AdapterResult[];
  deadline: number;
}

const rawOf = <T,>(results: AdapterResult[], id: string) => results.find((r) => r.status.id === id)?.raw as T | undefined;
const key = (a: string) => (a.startsWith("0x") ? a.toLowerCase() : a);

/** The top-20 non-LP, non-infra holders (counted wallets + vesting / locked supply), classified. */
export function strengthHolders(s: TokenSnapshot): { address: string; pct: number; cls: LedgerClass; label?: string; keyNeverSold?: boolean }[] {
  const classes = new Map((s.holderClasses ?? []).map((h) => [key(h.address), h]));
  const vesting = (s.holderClasses ?? []).filter((h) => h.class === "vesting" && h.pct != null).map((h) => ({ address: h.address, pct: h.pct! }));
  const rows: { address: string; pct: number; label?: string }[] = [...s.holders.filter((h) => h.pct != null).map((h) => ({ address: h.address, pct: h.pct!, label: h.label })), ...vesting]
    .sort((a, b) => b.pct - a.pct)
    .slice(0, STRENGTH_TOP);
  return rows.map((h) => {
    const c = classes.get(key(h.address));
    const label = c?.label ?? h.label;
    if (label && CEX.test(label)) return { address: h.address, pct: h.pct, cls: "cex" as const, label };
    if (c?.class === "founder") return { address: h.address, pct: h.pct, cls: "founder" as const, label: "founder wallet", keyNeverSold: s.founderNeverSold === true };
    if (c?.class === "team") return { address: h.address, pct: h.pct, cls: "team" as const, label: "team wallet (deployer-funded)", keyNeverSold: s.teamNeverSold === true };
    if (c?.class === "vesting") return { address: h.address, pct: h.pct, cls: "vesting" as const, label: c.label };
    if (c?.class === "treasury") return { address: h.address, pct: h.pct, cls: "treasury" as const, label: c.label };
    return { address: h.address, pct: h.pct, cls: "wallet" as const };
  });
}

/** Daily candles of the main pool (GeckoTerminal, kept by its adapter). */
function dayCandles(ctx: Ctx): { candles: DayCandle[] | null; reason?: string } {
  const raw = rawOf<{ dayCandles?: DayCandle[] }>(ctx.results, "geckoterminal");
  if (raw?.dayCandles?.length) return { candles: raw.dayCandles };
  const st = ctx.results.find((r) => r.status.id === "geckoterminal")?.status;
  return { candles: null, reason: st && st.state === "failed" ? `GeckoTerminal failed: ${st.message ?? "error"}` : "no daily candles from GeckoTerminal for this token" };
}

/** Holder Strength for an Established token; null (with the exact reason) when the ledgers are not complete enough. */
export async function holderStrength(chain: Chain, token: string, s: TokenSnapshot, results: AdapterResult[], deadline: number): Promise<HolderStrength> {
  const ctx: Ctx = { chain, token: key(token), s, results, deadline };
  const holders = strengthHolders(s);
  const nowT = Math.floor(Date.now() / 1000);
  const createdT = s.createdAt ? Math.floor(Date.parse(s.createdAt) / 1000) : s.ageHours != null ? nowT - Math.round(s.ageHours * 3600) : null;
  const { candles, reason: candleReason } = dayCandles(ctx);
  if (!isEvmChain(chain) && !process.env.HELIUS_API_KEY) {
    return { score: null, label: null, components: [], sentences: [], keyPerson: [], wallets: 0, excluded: [], nullReason: "Helius key not set — Solana holder histories need it", method: "Helius key not set", pending: false };
  }
  const read = isEvmChain(chain) ? await evmLedgers(ctx, chain, holders) : await solanaLedgers(ctx, holders);
  const hs = computeHolderStrength({
    ledgers: read.ledgers,
    createdT,
    nowT,
    candles,
    candleReason,
    accumulatorSupplyPct: s.accumulatorSupplyPct,
    accumulatorReason: s.nullReasons?.accumulatorSupplyPct ?? (chain === "robinhood" ? "no swap-index holder list" : "per-wallet buy / sell counts come from HoodScan's swap index (Robinhood Chain only)"),
    method: read.method,
  });
  return { ...hs, pending: hs.score == null && read.pending };
}

const base = (h: ReturnType<typeof strengthHolders>[number]): Omit<HolderLedger, "events" | "complete" | "walletFirstSeenT" | "tokensHeld"> => ({ address: h.address, pct: h.pct, cls: h.cls, label: h.label, keyNeverSold: h.keyNeverSold });

// ── EVM (Robinhood Chain, Base, Monad): Transfer-log ledger, resumable ─────────────────────────────────────────────────

interface LedgerLog {
  /** tx hash + log index. */
  id: string;
  b: number;
  from: string;
  to: string;
  /** Token units (raw / 10^decimals). */
  qty: number;
}
interface LedgerState {
  v: 1;
  /** Per wallet: every block up to this one is read. */
  scanned: Record<string, number>;
  logs: LedgerLog[];
  /** Counterparty → pool / router / contract (true) or wallet (false). */
  kinds: Record<string, boolean>;
  /** Block → unix seconds. */
  times: Record<string, number>;
  /** Current eth_getLogs span; halves on a timeout / range error, grows back on success. */
  span?: number;
}
const ledgerKey = (chain: Chain, token: string) => `hs-ledger:v1:${chain}:${token}`;
const logSpan = (chain: EvmChain) => chainLogSpan(chain);
const MAX_LOGS = 6_000;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function isPoolish(chain: EvmChain, s: TokenSnapshot, a: string): boolean {
  const x = a.toLowerCase();
  if (x === ZERO_ADDR || s.poolAddresses.includes(x)) return true;
  return chain === "robinhood" ? !!infraEntry(x) : !!chainInfraEntry(chain, x);
}

const endpointFile = (chain: EvmChain) => endpointList(chain);

/** Reads windows of Transfer logs for the lagging cohort of wallets until the deadline; mutates `st`. */
async function advanceLedger(chain: EvmChain, token: string, wallets: string[], st: LedgerState, start: number, head: number, deadline: number, decimals: number): Promise<void> {
  // Robinhood: the official endpoint only (it answers 429 under load — retried with backoff; the other log endpoint hangs).
  const rpc = chain === "robinhood" ? makeRpc(ROBINHOOD_RPC, [500, 1_000, 2_000, 4_000]) : logsRpc(chain);
  const maxSpan = logSpan(chain);
  // Robinhood's official RPC serves 10M-block windows for one address but only 100k for an OR list: one query per wallet.
  const perWallet = chain === "robinhood";
  // Nothing before the token existed: a wallet saved from an earlier, wider start is moved up to the creation block.
  for (const w of wallets) st.scanned[w] = Math.max(st.scanned[w] ?? start - 1, start - 1);
  const seen = new Set(st.logs.map((l) => l.id));
  const errors: string[] = [];
  while (Date.now() < deadline - 1_500 && st.logs.length < MAX_LOGS) {
    const lag = wallets.filter((w) => st.scanned[w] < head).sort((x, y) => st.scanned[x] - st.scanned[y]);
    if (!lag.length) return;
    const span = Math.min(maxSpan, st.span ?? (perWallet ? maxSpan : Math.min(maxSpan, 2_000_000)));
    // Jobs: per wallet its next window (Robinhood), else the lagging cohort's next windows up to the next wallet's progress.
    const jobs: { ws: string[]; a: number; b: number }[] = [];
    if (perWallet) for (const w of lag.slice(0, 4)) jobs.push({ ws: [w], a: st.scanned[w] + 1, b: Math.min(head, st.scanned[w] + span) });
    else {
      const min = st.scanned[lag[0]];
      const cohort = lag.filter((w) => st.scanned[w] === min);
      const stop = Math.min(head, ...lag.filter((w) => st.scanned[w] > min).map((w) => st.scanned[w]));
      for (let x = min + 1; jobs.length < 10 && x <= stop; x += span) jobs.push({ ws: cohort, a: x, b: Math.min(stop, x + span - 1) });
    }
    const left = Math.max(800, Math.floor(deadline - Date.now() - 1_000));
    const got = await Promise.all(
      jobs.map(async (j) => {
        const topics = j.ws.length === 1 ? addressTopic(j.ws[0]) : j.ws.map(addressTopic);
        const q = (t: (string | string[] | null)[]) => rpc<RpcLog[]>("eth_getLogs", [{ address: token, topics: t, fromBlock: hex(j.a), toBlock: hex(j.b) }], left);
        const [outs, ins] = await Promise.all([q([TRANSFER_TOPIC, topics]), q([TRANSFER_TOPIC, null, topics])]);
        return [...outs, ...ins];
      }).map((p) => p.catch((e: Error) => (errors.push(e.message), null))),
    );
    // Only an explicit range / result-size refusal narrows the window; anything else (rate limit, timeout, a busy
    // node) is transient — back off at the same width. All answered: wider.
    const tooWide = errors.some((m) => /range|too many results|more than \d+ (results|logs)|query returned|limited to|block range|exceed/i.test(m) && !/429|too many requests/i.test(m));
    const limited = errors.length > 0 && !tooWide;
    st.span = tooWide ? Math.max(1_000, Math.floor(span / 2)) : errors.length ? span : Math.min(maxSpan, Math.round(span * 1.5));
    errors.length = 0;
    if (limited) await new Promise((r) => setTimeout(r, 1_500));
    // Per wallet every answered job counts; a cohort only counts its contiguous answered prefix.
    const take = perWallet ? jobs.map((_, i) => got[i] !== null) : jobs.map((_, i) => got.slice(0, i + 1).every((x) => x !== null));
    if (!take.some(Boolean)) {
      if (span <= 1_000 && !limited) return;
      continue;
    }
    jobs.forEach((j, i) => {
      if (!take[i]) return;
      for (const l of got[i]!) {
        const id = `${l.transactionHash}:${Number(l.logIndex)}`;
        if (seen.has(id) || l.topics.length !== 3) continue;
        seen.add(id);
        st.logs.push({ id, b: Number(l.blockNumber), from: topicAddress(l.topics[1]), to: topicAddress(l.topics[2]), qty: Number(BigInt(l.data && l.data !== "0x" ? l.data : "0x0")) / 10 ** decimals });
      }
      for (const w of j.ws) st.scanned[w] = Math.max(st.scanned[w], j.b);
    });
  }
}

/** Block timestamps by JSON-RPC batch (50 per request), falling back to single calls. */
async function fillTimes(rpc: Rpc, url: string | null, blocks: number[], st: LedgerState, deadline: number): Promise<void> {
  const need = [...new Set(blocks)].filter((b) => st.times[b] == null);
  for (let i = 0; i < need.length && Date.now() < deadline - 1_000; i += 50) {
    const chunk = need.slice(i, i + 50);
    let done = false;
    if (url) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(chunk.map((b, j) => ({ jsonrpc: "2.0", id: j, method: "eth_getBlockByNumber", params: [hex(b), false] }))),
        signal: AbortSignal.timeout(Math.max(1_000, Math.min(10_000, deadline - Date.now()))),
      })
        .then((r) => (r.ok ? (r.json() as Promise<{ id: number; result?: { timestamp: string } }[]>) : null))
        .catch(() => null);
      if (Array.isArray(res)) {
        for (const r of res) if (r.result) st.times[chunk[r.id]] = Number(r.result.timestamp);
        done = chunk.every((b) => st.times[b] != null);
      }
    }
    if (!done) {
      await mapLimit(
        chunk.filter((b) => st.times[b] == null),
        12,
        async (b) => {
          const r = await rpc<{ timestamp: string } | null>("eth_getBlockByNumber", [hex(b), false], 8_000).catch(() => null);
          if (r) st.times[b] = Number(r.timestamp);
        },
      );
    }
  }
}

async function evmLedgers(ctx: Ctx, chain: EvmChain, holders: ReturnType<typeof strengthHolders>): Promise<{ ledgers: HolderLedger[]; method: string; pending: boolean }> {
  const rpc = chain === "robinhood" ? makeRpc() : chainRpc(chain);
  const archive = chain === "robinhood" ? null : archiveRpc(chain);
  const head = Number(await rpc<string>("eth_blockNumber", []));
  const k = ledgerKey(chain, ctx.token);
  const st: LedgerState = (await kvGet<LedgerState>(k).catch(() => null)) ?? { v: 1, scanned: {}, logs: [], kinds: {}, times: {} };
  const decimals = Number(await rpc<string>("eth_call", [{ to: ctx.token, data: "0x313ce567" }, "latest"]).catch(() => "0x12")) || 18;
  const start = (await creationFromSources(ctx)) ?? (await kvGet<{ block: number }>(`creation:archive:v1:${chain}:${ctx.token}`).catch(() => null))?.block ?? 0;
  const wallets = holders.filter((h) => h.cls !== "vesting" && h.cls !== "cex").map((h) => key(h.address));
  // Wallet age is a wallet's: treasuries (multisig contracts) are not looked up.
  const people = holders.filter((h) => h.cls === "wallet" || h.cls === "founder" || h.cls === "team").map((h) => key(h.address));
  const run = async (deadline: number) => {
    // A quarter of the time (≥ 3s) is kept for the counterparty checks and block timestamps after the log reads.
    const reserve = Math.max(3_000, Math.floor((deadline - Date.now()) / 4));
    await advanceLedger(chain, ctx.token, wallets, st, start, head, deadline - reserve, decimals);
    // Counterparty kinds (pool / router / contract vs wallet).
    // Every counterparty, top-20 wallets included (a transfer between two of them needs both sides typed).
    const cps = [...new Set(st.logs.flatMap((l) => [l.from, l.to]))].filter((a) => st.kinds[a] == null && a !== ZERO_ADDR);
    await mapLimit(cps, 12, async (a) => {
      if (Date.now() > deadline - 1_000) return;
      if (isPoolish(chain, ctx.s, a)) st.kinds[a] = true;
      else {
        const code = await rpc<string>("eth_getCode", [a, "latest"], 6_000).catch(() => null);
        if (code != null) st.kinds[a] = codeKind(code) === "contract";
      }
    });
    // Batch-capable endpoint for block timestamps: an archive one where the chain has it, else the official log endpoint.
    const batchUrl = endpointFile(chain).find((e) => e.historical === true)?.url ?? endpointFile(chain).find((e) => e.logs === "full" || e.logs === true)?.url ?? null;
    await fillTimes(archive ?? rpc, batchUrl, st.logs.map((l) => l.b), st, deadline);
    await kvSet(k, st, 7 * DAY).catch(() => undefined);
  };
  await run(ctx.deadline);
  const incomplete = wallets.some((w) => st.scanned[w] < head);
  if (incomplete) {
    try {
      after(() => run(Date.now() + BACKGROUND_MS).catch(() => undefined));
    } catch {
      // Outside a request (scripts): the next call resumes from the saved state.
    }
  }
  // Wallet age: first block holding native coin (archive, Base / Monad); Robinhood keeps no historical state, so its
  // first indexed swap (HoodScan) stands in, labelled. Distinct tokens: HoodScan's open positions (Robinhood only).
  const ages = new Map<string, number | null>();
  const tokens = new Map<string, number | null>();
  const ageReason = chain === "robinhood" ? null : archive ? null : `no archive ${chain} RPC configured — wallet age unknown`;
  if (archive) {
    await mapLimit(people, 4, async (w) => {
      if (Date.now() > ctx.deadline - 2_000) return;
      const ck = `wallet-first-seen:v1:${chain}:${w}`;
      const hit = await kvGet<{ t: number | null }>(ck).catch(() => null);
      if (hit) return void ages.set(w, hit.t);
      const nf = await nativeFunder(archive, w, head).catch(() => null);
      if (!nf) return;
      const b = await archive<{ timestamp: string } | null>("eth_getBlockByNumber", [hex(nf.block), false]).catch(() => null);
      const t = b ? Number(b.timestamp) : null;
      ages.set(w, t);
      if (t != null) await kvSet(ck, { t }, 30 * DAY).catch(() => undefined);
    });
  } else if (chain === "robinhood") {
    await mapLimit(people, 6, async (w) => {
      if (Date.now() > ctx.deadline - 2_000) return;
      const ck = `hs-trader:v1:${w}`;
      const hit = await kvGet<{ first: number | null; tokens: number | null }>(ck).catch(() => null);
      const got = hit ?? (await hoodscanTrader(w, Math.min(8_000, ctx.deadline - Date.now() - 1_000)));
      if (!got) return;
      if (!hit) await kvSet(ck, got, DAY).catch(() => undefined);
      ages.set(w, got.first);
      tokens.set(w, got.tokens);
    });
  }
  const pct = Math.round((wallets.filter((w) => st.scanned[w] >= head).length / Math.max(1, wallets.length)) * 100);
  const ledgers = holders.map((h): HolderLedger => {
    const w = key(h.address);
    const mine = st.logs.filter((l) => l.from === w || l.to === w);
    const events: LedgerEvent[] = [];
    let timed = true;
    for (const l of mine) {
      const t = st.times[l.b];
      if (t == null) {
        timed = false;
        continue;
      }
      const inbound = l.to === w;
      const cp = inbound ? l.from : l.to;
      const pool = cp === ZERO_ADDR ? false : st.kinds[cp];
      events.push({ t, kind: inbound ? (pool ? "buy" : "in") : pool ? "sell" : "out", qty: l.qty, priceUsd: null });
    }
    const complete = (st.scanned[w] ?? -1) >= head && timed && mine.every((l) => st.kinds[l.to === w ? l.from : l.to] != null || (l.to === w ? l.from : l.to) === ZERO_ADDR);
    return {
      ...base(h),
      events,
      complete,
      walletFirstSeenT: ages.get(w) ?? null,
      walletAgeReason: ageReason ?? (ages.has(w) ? undefined : chain === "robinhood" ? "HoodScan trader lookup failed or timed out" : "archive search for the wallet's first native coin did not finish in time"),
      tokensHeld: tokens.get(w) ?? null,
      tokensReason: chain === "robinhood" ? "HoodScan trader lookup failed or timed out" : chain === "ethereum" ? "no keyless token-list API for Ethereum (Etherscan's token-holdings endpoint is Pro-only; Blockscout answers behind a browser challenge)" : `no keyless token-list API for ${chain === "base" ? "Base" : "Monad"} (Blockscout answers behind a browser challenge)`,
    };
  });
  const ageNote = chain === "robinhood" ? "; wallet age = first swap HoodScan indexed, tokens = its open positions" : archive ? "; wallet age = first block holding native coin (archive state)" : "";
  return { ledgers, pending: incomplete, method: `Transfer logs of the top-20 wallets since creation (${pct}% of wallets read to the head${incomplete ? " — continues in the background" : ""}); a pool / router / contract counterparty is a swap${ageNote}` };
}

/** HoodScan's trader profile: its first indexed swap (unix s) and open positions (distinct tokens held, swap-observed). */
async function hoodscanTrader(wallet: string, timeoutMs: number): Promise<{ first: number | null; tokens: number | null } | null> {
  if (timeoutMs < 1_000) return null;
  const r = await mcpCall<{ stats?: { firstTrade?: string | null }; openPositionCount?: number }>("https://hoodscan.co/mcp", "get_trader", { address: wallet, positions_limit: 1, recent_limit: 0 }, timeoutMs).catch(() => null);
  if (!r) return null;
  const first = r.stats?.firstTrade ? Math.floor(Date.parse(r.stats.firstTrade) / 1000) : null;
  return { first: first != null && Number.isFinite(first) ? first : null, tokens: typeof r.openPositionCount === "number" ? r.openPositionCount : null };
}

/** Creation block: this run's RPC adapter, else its cached creation record (Robinhood), else null. */
async function creationFromSources(ctx: Ctx): Promise<number | null> {
  const c = rawOf<{ creation?: { creationBlock?: number } | null }>(ctx.results, "rpc")?.creation;
  if (c?.creationBlock != null) return c.creationBlock;
  if (ctx.chain !== "robinhood") return null;
  return (await kvGet<{ creationBlock?: number }>(creationKey(ctx.token)).catch(() => null))?.creationBlock ?? null;
}

// ── Solana: Helius history of each holder's token account ────────────────────────────────────────

async function solanaLedgers(ctx: Ctx, holders: ReturnType<typeof strengthHolders>): Promise<{ ledgers: HolderLedger[]; method: string; pending: boolean }> {
  const helius = heliusClient(process.env.HELIUS_API_KEY!);
  const mint = ctx.s.address;
  const one = async (h: ReturnType<typeof strengthHolders>[number]): Promise<HolderLedger> => {
    const ck = `hs-sol:v1:${mint}:${h.address}`;
    const hit = await kvGet<{ events: LedgerEvent[]; complete: boolean; firstT: number | null; tokens: number | null }>(ck).catch(() => null);
    const got = hit ?? (await solanaWallet(helius, h.address, mint, ctx.deadline).catch(() => null));
    if (!got) return { ...base(h), events: [], complete: false, walletFirstSeenT: null, walletAgeReason: "Helius lookup failed", tokensHeld: null, tokensReason: "Helius lookup failed" };
    if (!hit && got.complete) await kvSet(ck, got, 2 * 3600).catch(() => undefined);
    return { ...base(h), events: got.events, complete: got.complete, walletFirstSeenT: got.firstT, walletAgeReason: got.firstT == null ? "Helius returned no first transaction" : undefined, tokensHeld: got.tokens, tokensReason: got.tokens == null ? "Helius token-account list failed" : undefined };
  };
  const ledgers = await mapLimit(holders.filter((h) => h.cls !== "vesting"), 4, one);
  const locked = holders.filter((h) => h.cls === "vesting").map((h): HolderLedger => ({ ...base(h), events: [], complete: true, walletFirstSeenT: null, tokensHeld: null }));
  // Wallets not finished in time: read on after the response (complete ones are cached for 2h), so the next analysis has them.
  const left = holders.filter((h) => h.cls !== "vesting" && !ledgers.find((l) => l.address === h.address)?.complete);
  if (left.length) {
    try {
      after(() => mapLimit(left, 2, async (h) => {
        const got = await solanaWallet(helius, h.address, mint, Date.now() + BACKGROUND_MS).catch(() => null);
        if (got?.complete) await kvSet(`hs-sol:v1:${mint}:${h.address}`, got, 2 * 3600).catch(() => undefined);
      }).then(() => undefined));
    } catch {
      // Outside a request (scripts): the next call reads them.
    }
  }
  return { ledgers: [...ledgers, ...locked], pending: left.length > 0, method: `Helius history of each holder's token account (a SOL leg or a program-owned counterparty is a swap)${left.length ? ` — ${left.length} wallets continue in the background` : ""}` };
}

async function solanaWallet(helius: Helius, owner: string, mint: string, deadline: number): Promise<{ events: LedgerEvent[]; complete: boolean; firstT: number | null; tokens: number | null }> {
  const accts = await helius<{ value: { pubkey: string }[] }>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
  const events: LedgerEvent[] = [];
  let complete = true;
  for (const a of accts.value) {
    let token: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 3 || Date.now() > deadline - 1_500) {
        complete = false;
        break;
      }
      const r = await helius<{ data: FullTx[]; paginationToken?: string | null }>("getTransactionsForAddress", [a.pubkey, { sortOrder: "asc", limit: 100, transactionDetails: "full", encoding: "jsonParsed", maxSupportedTransactionVersion: 1, ...(token ? { paginationToken: token } : {}) }]);
      for (const tx of r.data) {
        if (!tx.meta || tx.meta.err || tx.blockTime == null) continue;
        const d = mintDeltas(tx, mint);
        const mine = d.get(owner) ?? 0;
        if (!mine) continue;
        const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
        const i = keys.indexOf(owner);
        const sol = i >= 0 ? tx.meta.postBalances[i] - tx.meta.preBalances[i] : 0;
        const others = [...d.entries()].filter(([o, v]) => o !== owner && Math.sign(v) === -Math.sign(mine)).map(([o]) => o);
        const swap = others.some(isProgramAddress) || (mine > 0 ? sol < -tx.meta.fee : sol > 0);
        events.push({ t: tx.blockTime, kind: mine > 0 ? (swap ? "buy" : "in") : swap ? "sell" : "out", qty: Math.abs(mine), priceUsd: null });
      }
      if (!r.paginationToken || !r.data.length) break;
      token = r.paginationToken;
    }
  }
  const origin = await walletOrigin(helius, owner).catch(() => null);
  const count = async (program: string) => (await helius<{ value: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }[] }>("getTokenAccountsByOwner", [owner, { programId: program }, { encoding: "jsonParsed" }])).value.filter((v) => (v.account.data.parsed.info.tokenAmount.uiAmount ?? 0) > 0).length;
  const tokens = await Promise.all([count("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), count("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")]).then(([a, b]) => a + b).catch(() => null);
  return { events, complete, firstT: origin?.firstT ?? null, tokens };
}

/** Runs `fn` over `items` with at most `limit` in flight; results in input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

