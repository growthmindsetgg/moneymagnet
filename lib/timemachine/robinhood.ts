import { fetchJson, num } from "../sources/http";
import { findCreation } from "../onchain/creation";
import { codeKind, hex, makeRpc, TRANSFER_TOPIC, topicAddress, type Rpc, type RpcLog } from "../onchain/rpc";
import { bucketFields } from "./core";
import { emptyFields } from "./solana";
import { BUCKETS, type BalanceDelta, type BucketSnapshot, type FieldName, type PricePoint, type Reconstruction, type Trade } from "./types";

const ZERO = "0x0000000000000000000000000000000000000000";
const GT = "https://api.geckoterminal.com/api/v2";
/** Max Transfer logs read per token. Buckets beyond it are null, never sampled. */
export const DEFAULT_MAX_LOGS = Number(process.env.TM_MAX_LOGS || 400_000);

/** Wraps an RPC so rate limits (429) back off patiently instead of failing a long reconstruction. */
export function patientRpc(rpc: Rpc, attempts = 8): Rpc {
  return async <T,>(method: string, params: unknown[], timeoutMs?: number): Promise<T> => {
    for (let i = 0; ; i++) {
      try {
        return await rpc<T>(method, params, timeoutMs);
      } catch (err) {
        if (i >= attempts || !/\b429\b|rate/i.test((err as Error).message)) throw err;
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** i)));
      }
    }
  };
}

async function blockTime(rpc: Rpc, n: number): Promise<number> {
  const b = await rpc<{ timestamp: string }>("eth_getBlockByNumber", [hex(n), false], 15_000);
  return Number(b.timestamp);
}

/** The last block at or before unix time `t` (binary search over block timestamps). */
export async function blockAtTime(rpc: Rpc, t: number, lo: number, hi: number): Promise<number> {
  if ((await blockTime(rpc, hi)) <= t) return hi;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await blockTime(rpc, mid)) <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Transfer logs in [from, to], adaptive chunking under the RPC's 10k-logs-per-query limit. */
async function transferLogs(rpc: Rpc, token: string, from: number, to: number, maxLogs: number): Promise<{ logs: RpcLog[]; scannedTo: number }> {
  const logs: RpcLog[] = [];
  let cursor = from;
  let chunk = 20_000;
  let throttled = 0;
  while (cursor <= to) {
    const end = Math.min(to, cursor + chunk - 1);
    try {
      const got = await rpc<RpcLog[]>("eth_getLogs", [{ address: token, topics: [TRANSFER_TOPIC], fromBlock: hex(cursor), toBlock: hex(end) }], 30_000);
      logs.push(...got);
      cursor = end + 1;
      throttled = 0;
      if (got.length < 2500) chunk = Math.min(2_000_000, chunk * 2);
      if (logs.length >= maxLogs) return { logs, scannedTo: end };
    } catch (err) {
      // The public RPC throttles bursts: back off and retry the same range.
      if (/\b429\b|rate/i.test((err as Error).message) && throttled < 8) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** throttled++));
        continue;
      }
      if (chunk <= 50) throw err;
      chunk = Math.max(50, Math.floor(chunk / 2));
    }
  }
  return { logs, scannedTo: to };
}

interface GtPool {
  attributes: { address: string; reserve_in_usd: string | null; pool_created_at: string | null };
}

/** Hourly (and 5-minute for the first hours) candles of the token's main pool on GeckoTerminal. */
async function geckoPrices(token: string, t0: number, until: number): Promise<{ prices: PricePoint[]; pool: string | null; note?: string }> {
  const pools = await fetchJson<{ data: GtPool[] }>(`${GT}/networks/robinhood/tokens/${token}/pools?page=1`, { timeoutMs: 15_000 });
  const main = [...(pools.data ?? [])].sort((a, b) => (num(b.attributes.reserve_in_usd) ?? 0) - (num(a.attributes.reserve_in_usd) ?? 0))[0];
  if (!main) return { prices: [], pool: null, note: "GeckoTerminal lists no pool" };
  const q = (tf: string, agg: number, limit: number, before: number) =>
    fetchJson<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(
      `${GT}/networks/robinhood/pools/${main.attributes.address}/ohlcv/${tf}?aggregate=${agg}&limit=${limit}&before_timestamp=${before}&currency=usd&token=base`,
      { timeoutMs: 15_000 },
    ).then((r) => r.data?.attributes?.ohlcv_list ?? []);
  const fine = await q("minute", 5, 1000, Math.min(until, t0 + 24 * 3600) + 300);
  const coarse = until > t0 + 24 * 3600 ? await q("hour", 1, 1000, until + 3600) : [];
  const fineEnd = fine.length ? Math.max(...fine.map((c) => c[0])) : 0;
  const rows = [...fine.map((c) => ({ t: c[0] + 300, c })), ...coarse.filter((c) => c[0] > fineEnd).map((c) => ({ t: c[0] + 3600, c }))];
  // Each candle closes at the end of its interval; volume is in USD.
  const prices = rows
    .filter((r) => r.t > t0 && r.t <= until + 3600)
    .sort((a, b) => a.t - b.t)
    .map((r) => ({ t: r.t, priceUsd: r.c[4], volumeUsd: r.c[5] }));
  return { prices, pool: main.attributes.address };
}

export interface RobinhoodOptions {
  rpc?: Rpc;
  maxLogs?: number;
  maxBucket?: number;
}

/**
 * Rebuilds a Robinhood Chain token at +1h / +6h / +24h / +72h: holder balances from a Transfer-log
 * replay to the block at each bucket edge (binary-searched by timestamp), buys/sells as transfers
 * against contracts (pools, routers, launchpads — by bytecode), price path from GeckoTerminal.
 */
export async function reconstructRobinhood(address: string, opts: RobinhoodOptions = {}): Promise<Reconstruction> {
  const t0ms = Date.now();
  const rpc = opts.rpc ?? patientRpc(makeRpc());
  const token = address.toLowerCase();
  const maxLogs = opts.maxLogs ?? DEFAULT_MAX_LOGS;
  const notes: string[] = [];
  const head = Number(await rpc<string>("eth_blockNumber", []));
  const creation = await findCreation(rpc, token, head);
  if (!creation) throw new Error("no mint (Transfer from 0x0) found");
  const t0 = creation.timestamp ?? (await blockTime(rpc, creation.creationBlock));
  const buckets = BUCKETS.filter((b) => b <= (opts.maxBucket ?? 72) && t0 + b * 3600 <= Date.now() / 1000);

  const [supplyHex, decHex, symHex] = await Promise.all([
    rpc<string>("eth_call", [{ to: token, data: "0x18160ddd" }, "latest"]).catch(() => null),
    rpc<string>("eth_call", [{ to: token, data: "0x313ce567" }, "latest"]).catch(() => null),
    rpc<string>("eth_call", [{ to: token, data: "0x95d89b41" }, "latest"]).catch(() => null),
  ]);
  const decimals = decHex && decHex !== "0x" ? Number(BigInt(decHex)) : 18;
  const scale = 10 ** decimals;
  const supply = supplyHex && supplyHex !== "0x" ? Number(BigInt(supplyHex)) / scale : null;
  const symbol = symHex && symHex.length > 130 ? Buffer.from(symHex.slice(130), "hex").toString("utf8").replace(/\0+$/g, "").trim() || null : null;

  // Bucket edges as blocks.
  const edges = new Map<number, number>();
  let lo = creation.creationBlock;
  for (const b of buckets) {
    const blk = await blockAtTime(rpc, t0 + b * 3600, lo, head);
    edges.set(b, blk);
    lo = blk;
  }
  const lastEdge = buckets.length ? edges.get(buckets[buckets.length - 1])! : creation.creationBlock;
  const { logs, scannedTo } = await transferLogs(rpc, token, creation.creationBlock, lastEdge, maxLogs);
  if (scannedTo < lastEdge) notes.push(`read ${logs.length.toLocaleString("en-US")} Transfer logs (budget ${maxLogs.toLocaleString("en-US")}) — history covered to block ${scannedTo}`);

  // Classify counterparties: the busiest senders/receivers and every bucket's top holders, by bytecode.
  const fan = new Map<string, Set<string>>();
  const deltas: BalanceDelta[] = [];
  for (const l of logs) {
    if (l.topics.length !== 3) continue;
    const from = topicAddress(l.topics[1]);
    const to = topicAddress(l.topics[2]);
    const v = (l.data && l.data !== "0x" ? Number(BigInt(l.data)) : 0) / scale;
    const pos = Number(l.blockNumber);
    if (from !== ZERO) deltas.push({ pos, owner: from, delta: -v });
    if (to !== ZERO) deltas.push({ pos, owner: to, delta: v });
    if (!fan.has(from)) fan.set(from, new Set());
    fan.get(from)!.add(to);
  }
  const candidates = new Set([...fan].sort((a, b) => b[1].size - a[1].size).slice(0, 25).map(([a]) => a));
  for (const b of buckets) {
    const cut = edges.get(b)!;
    const bal = new Map<string, number>();
    for (const d of deltas) if (d.pos <= cut) bal.set(d.owner, (bal.get(d.owner) ?? 0) + d.delta);
    for (const [a] of [...bal].sort((x, y) => y[1] - x[1]).slice(0, 30)) candidates.add(a);
  }
  candidates.delete(ZERO);
  const kinds = new Map<string, "wallet" | "contract">();
  await Promise.all([...candidates].map(async (a) => kinds.set(a, codeKind(await rpc<string>("eth_getCode", [a, "latest"]).catch(() => "0x")))));
  const isContract = (a: string) => kinds.get(a) === "contract" || a.endsWith("dead");

  // Buys = transfers from a contract to a wallet, sells = wallet → contract.
  const trades: Trade[] = [];
  for (const l of logs) {
    if (l.topics.length !== 3) continue;
    const from = topicAddress(l.topics[1]);
    const to = topicAddress(l.topics[2]);
    if (from === ZERO) continue;
    const pos = Number(l.blockNumber);
    const tokens = (l.data && l.data !== "0x" ? Number(BigInt(l.data)) : 0) / scale;
    if (isContract(from) && !isContract(to)) trades.push({ pos, wallet: to, side: "buy", tokens });
    else if (!isContract(from) && isContract(to)) trades.push({ pos, wallet: from, side: "sell", tokens });
  }

  const px = await geckoPrices(token, t0, t0 + (buckets[buckets.length - 1] ?? 1) * 3600).catch((e: Error) => ({ prices: [] as PricePoint[], pool: null, note: `GeckoTerminal OHLCV failed: ${e.message.slice(0, 80)}` }));
  if (px.note) notes.push(px.note);

  const methods: Partial<Record<FieldName, string>> = {
    holders: "Transfer-log replay to the block at the bucket edge (Robinhood RPC); contracts (pools, routers, launchpads by bytecode) excluded",
    top10SharePct: "same balances, top 10 wallets / totalSupply()",
    earlyRetentionPct: "first 20 wallets receiving tokens from a contract still holding",
    buyers: "wallets receiving tokens from a contract (pool / router)",
    sellers: "wallets sending tokens to a contract",
    buyerSellerRatio: "(buyers + 1) / (sellers + 1)",
    devBuySharePct: "deployer (sender of the first mint tx) share of tokens bought from contracts",
    devSoldPct: "deployer tokens sent to contracts / tokens received",
    freshWalletSharePct: "not reconstructable",
    fundingClusterMax: "not reconstructable",
    priceUsd: "GeckoTerminal main-pool candle close (5m to +24h, then 1h)",
    mcapUsd: "price × current totalSupply()",
    liquidityUsd: "not reconstructable",
    volume24hUsd: "sum of GeckoTerminal candle USD volume over the trailing 24h (main pool)",
    volMc: "trailing-24h volume / market cap",
    drawdownPct: "last close vs highest close so far",
    peakMultiple: "highest close / first close",
  };
  const NO_ORIGIN = "Robinhood RPC has no per-address history index and no archive state — wallet age and funder are not reconstructable";
  const NO_LIQ = "pool reserves at past blocks need archive state (the Robinhood RPC has none)";

  const out: BucketSnapshot[] = [];
  for (const b of buckets) {
    const cut = edges.get(b)!;
    const at = new Date((t0 + b * 3600) * 1000).toISOString();
    if (cut > scannedTo) {
      const reason = `history to +${b}h exceeds the reconstruction budget (${maxLogs.toLocaleString("en-US")} Transfer logs)`;
      out.push({ bucket: b, at, fields: emptyFields(), nulls: Object.fromEntries(Object.keys(methods).map((k) => [k, reason])) });
      continue;
    }
    const { fields, nulls } = bucketFields({
      deltas,
      trades,
      prices: px.prices,
      liquidity: null,
      cutoffPos: cut,
      cutoffT: t0 + b * 3600,
      supply,
      deployer: creation.deployer,
      isPool: isContract,
      origins: null,
    });
    nulls.freshWalletSharePct = nulls.fundingClusterMax = NO_ORIGIN;
    nulls.liquidityUsd = NO_LIQ;
    out.push({ bucket: b, at, fields, nulls });
  }
  return {
    chain: "robinhood",
    address: token,
    symbol,
    name: null,
    createdAt: new Date(t0 * 1000).toISOString(),
    creationTx: creation.mintTx,
    creator: creation.deployer,
    launchpad: null,
    methods,
    buckets: out,
    notes,
    builtAt: new Date().toISOString(),
    buildMs: Date.now() - t0ms,
  };
}
