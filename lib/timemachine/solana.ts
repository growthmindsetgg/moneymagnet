import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { fetchJson } from "../sources/http";
import { heliusRpc } from "../sources/heliusQueue";
import { bondingCurveAddress, PUMP_PROGRAM } from "../sources/solanaCurve";
import { bucketFields } from "./core";
import { BUCKETS, type BalanceDelta, type BucketSnapshot, type FieldName, type PricePoint, type Reconstruction, type Trade, type WalletOrigin } from "./types";

const WSOL = "So11111111111111111111111111111111111111112";
const LAMPORTS = 1e9;
/** Rent for a new SPL token account (165 bytes) — paid by a first-time buyer, not part of the price. */
const TOKEN_ACCOUNT_RENT_SOL = 0.00203928;
/** Price points are 5-minute VWAPs of execution prices: single tiny trades are noise, not price. */
const PRICE_INTERVAL_S = 300;
/** Max transactions read per token (Helius credits). Buckets beyond it are null, never sampled. */
export const DEFAULT_MAX_TX = Number(process.env.TM_MAX_TX || 4000);

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { uiAmount: number | null; amount: string; decimals: number };
}
export interface FullTx {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: ({ pubkey: string } | string)[];
      instructions: { programId?: string; parsed?: { type?: string; info?: Record<string, unknown> } }[];
    };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
}

const keyOf = (k: { pubkey: string } | string) => (typeof k === "string" ? k : k.pubkey);

/** Wallets are ed25519 keys; pools, curves and vault authorities are off-curve program addresses. */
export function isProgramAddress(address: string): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bs58.decode(address));
    return false;
  } catch {
    return true;
  }
}

export function heliusClient(key: string) {
  // Same global Helius queue as the live adapter (≤ 2 in flight, 429 backoff, 2-minute cache).
  const { call } = heliusRpc(key);
  return <T,>(method: string, params: unknown): Promise<T> => call<T>(method, params);
}

export type Helius = ReturnType<typeof heliusClient>;

/** SOL/USD hourly closes from Coinbase's public candles (full history, no key). */
export async function solUsdHourly(fromT: number, toT: number): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let start = fromT - 3600; start < toT + 3600; start += 300 * 3600) {
    const end = Math.min(start + 300 * 3600, toT + 3600);
    const rows = await fetchJson<number[][]>(
      `https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=3600&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`,
      { timeoutMs: 15_000, headers: { "user-agent": "hoodtier" } },
    );
    for (const [t, , , , close] of rows) out.set(t, close);
  }
  return out;
}
const hourOf = (t: number) => Math.floor(t / 3600) * 3600;

/** Owner-level deltas of `mint` in one transaction. */
export function mintDeltas(tx: FullTx, mint: string): Map<string, number> {
  const out = new Map<string, number>();
  const add = (b: TokenBalance, sign: 1 | -1) => {
    if (b.mint !== mint || !b.owner) return;
    out.set(b.owner, (out.get(b.owner) ?? 0) + sign * (b.uiTokenAmount.uiAmount ?? Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals));
  };
  for (const b of tx.meta?.postTokenBalances ?? []) add(b, 1);
  for (const b of tx.meta?.preTokenBalances ?? []) add(b, -1);
  for (const [k, v] of out) if (Math.abs(v) < 1e-12) out.delete(k);
  return out;
}

/** SOL the fee payer spent (+) or received (−) in this tx, excluding the network fee, incl. wSOL. */
function payerSol(tx: FullTx, payer: string): number {
  const m = tx.meta!;
  let lamports = m.postBalances[0] - m.preBalances[0] + m.fee;
  const wsol = (list: TokenBalance[] | undefined) => (list ?? []).filter((b) => b.mint === WSOL && b.owner === payer).reduce((a, b) => a + Number(b.uiTokenAmount.amount), 0);
  lamports += wsol(m.postTokenBalances) - wsol(m.preTokenBalances);
  return -lamports / LAMPORTS;
}

export interface SolanaHistory {
  txs: FullTx[];
  complete: boolean;
}

/** Oldest-first history of the mint up to `untilT`, at most `maxTx` transactions. */
export async function fetchHistory(helius: Helius, mint: string, untilT: number | null, maxTx: number): Promise<SolanaHistory> {
  const txs: FullTx[] = [];
  let token: string | undefined;
  for (;;) {
    const page = await helius<{ data: FullTx[]; paginationToken?: string | null }>("getTransactionsForAddress", [
      mint,
      { sortOrder: "asc", limit: 100, transactionDetails: "full", encoding: "jsonParsed", maxSupportedTransactionVersion: 1, ...(token ? { paginationToken: token } : {}) },
    ]);
    for (const tx of page.data) {
      if (untilT != null && tx.blockTime != null && txs.length && tx.blockTime > untilT) return { txs, complete: true };
      txs.push(tx);
    }
    if (!page.paginationToken || !page.data.length) return { txs, complete: true };
    if (txs.length >= maxTx) return { txs, complete: false };
    token = page.paginationToken;
  }
}

/** First transaction of a wallet: when it appeared, and who funded it (sender of its first SOL). */
export async function walletOrigin(helius: Helius, wallet: string): Promise<WalletOrigin> {
  const page = await helius<{ data: FullTx[] }>("getTransactionsForAddress", [
    wallet,
    { sortOrder: "asc", limit: 1, transactionDetails: "full", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 },
  ]).catch(() => null);
  const tx = page?.data[0];
  if (!tx) return { firstT: null, funder: null };
  const transfer = tx.transaction.message.instructions.find((ix) => ix.parsed?.type === "transfer" && ix.parsed.info?.destination === wallet);
  const payer = keyOf(tx.transaction.message.accountKeys[0]);
  return { firstT: tx.blockTime, funder: (transfer?.parsed?.info?.source as string | undefined) ?? (payer !== wallet ? payer : null) };
}

export interface SolanaOptions {
  maxTx?: number;
  /** Only rebuild buckets up to this age (hours) — a young token needs nothing past its age. */
  maxBucket?: number;
}

/**
 * Rebuilds the token at +1h / +6h / +24h / +72h from its own on-chain history (Helius), priced
 * by its swaps' execution prices × Coinbase SOL/USD. Nothing is sampled or estimated: a bucket
 * past the transaction budget is null with that reason.
 */
export async function reconstructSolana(mint: string, helius: Helius, opts: SolanaOptions = {}): Promise<Reconstruction> {
  const t0ms = Date.now();
  const maxTx = opts.maxTx ?? DEFAULT_MAX_TX;
  const buckets = BUCKETS.filter((b) => b <= (opts.maxBucket ?? 72));
  const notes: string[] = [];
  const asset = await helius<{ content?: { metadata?: { name?: string; symbol?: string } }; token_info?: { supply?: number; decimals?: number } }>("getAsset", { id: mint });
  const decimals = asset.token_info?.decimals ?? 6;
  const supply = asset.token_info?.supply != null ? asset.token_info.supply / 10 ** decimals : null;

  const first = await fetchHistory(helius, mint, null, 1).then((h) => h.txs[0]);
  if (!first?.blockTime) throw new Error("no history for this mint");
  const t0 = first.blockTime;
  const lastBucket = buckets[buckets.length - 1];
  const hist = await fetchHistory(helius, mint, t0 + lastBucket * 3600, maxTx);
  const ok = hist.txs.filter((tx) => tx.meta && !tx.meta.err && tx.blockTime != null);
  const coveredT = hist.complete ? t0 + lastBucket * 3600 : (ok[ok.length - 1]?.blockTime ?? t0);
  if (!hist.complete) notes.push(`read the first ${hist.txs.length} transactions (budget ${maxTx}) — history covered to +${((coveredT - t0) / 3600).toFixed(1)}h`);

  const creator = keyOf(first.transaction.message.accountKeys[0]);
  const isPump = first.transaction.message.instructions.some((ix) => ix.programId === PUMP_PROGRAM) || mint.endsWith("pump");
  const curve = isPump ? bondingCurveAddress(mint) : null;

  // SOL/USD for the window (needed to price trades).
  const sol = await solUsdHourly(t0, coveredT).catch((e: Error) => {
    notes.push(`SOL/USD candles failed: ${e.message.slice(0, 80)}`);
    return new Map<number, number>();
  });
  const solAt = (t: number) => sol.get(hourOf(t)) ?? sol.get(hourOf(t) - 3600) ?? null;

  const deltas: BalanceDelta[] = [];
  const trades: Trade[] = [];
  const prices: PricePoint[] = [];
  const liquidity: { t: number; usd: number }[] = [];
  let graduatedAt: number | null = null;
  const buckets5m = new Map<number, { sol: number; tokens: number; usd: number }>();
  for (const tx of ok) {
    const t = tx.blockTime!;
    const isCreation = tx === ok[0] && tx.transaction.signatures[0] === first.transaction.signatures[0];
    const d = mintDeltas(tx, mint);
    for (const [owner, delta] of d) deltas.push({ pos: t, owner, delta });
    const keys = tx.transaction.message.accountKeys.map(keyOf);
    const payer = keys[0];
    const own = d.get(payer);
    const poolSide = [...d].some(([o, v]) => isProgramAddress(o) && own != null && Math.sign(v) === -Math.sign(own));
    if (isCreation && own && own > 0) {
      // The creator's buy inside the creation tx: the curve is created (gains supply) rather than paying out,
      // and the SOL spent includes account creation — counted as a buy, not used as a price.
      trades.push({ pos: t, t, wallet: payer, side: "buy", tokens: own });
    } else if (own && poolSide && !isProgramAddress(payer)) {
      const newAccount = own > 0 && !(tx.meta?.preTokenBalances ?? []).some((b) => b.mint === mint && b.owner === payer);
      const spent = payerSol(tx, payer) - (newAccount ? TOKEN_ACCOUNT_RENT_SOL : 0);
      trades.push({ pos: t, t, wallet: payer, side: own > 0 ? "buy" : "sell", tokens: Math.abs(own) });
      const usd = solAt(t);
      if (Math.abs(spent) >= 0.001 && Math.sign(spent) === Math.sign(own) && usd) {
        const k = Math.floor(t / PRICE_INTERVAL_S) * PRICE_INTERVAL_S;
        const agg = buckets5m.get(k) ?? { sol: 0, tokens: 0, usd: 0 };
        agg.sol += Math.abs(spent);
        agg.tokens += Math.abs(own);
        agg.usd += Math.abs(spent) * usd;
        buckets5m.set(k, agg);
      }
    }
    if (curve && graduatedAt == null) {
      const i = keys.indexOf(curve);
      if (i >= 0 && tx.meta) {
        const solBal = tx.meta.postBalances[i] / LAMPORTS;
        const usd = solAt(t);
        const prev = liquidity.length ? liquidity[liquidity.length - 1].usd : 0;
        if (usd) {
          // The curve hands its SOL to the AMM on graduation; its pool reserves are not followed.
          if (prev > 1000 && solBal * usd < prev * 0.05) graduatedAt = t;
          else liquidity.push({ t, usd: solBal * usd });
        }
      }
    }
  }
  for (const [k, a] of [...buckets5m].sort((x, y) => x[0] - y[0])) {
    // Stamped at the interval's end so a bucket edge never sees a partial future interval.
    prices.push({ t: k + PRICE_INTERVAL_S, priceUsd: a.usd / a.tokens, volumeUsd: a.usd });
  }
  if (graduatedAt) notes.push(`graduated from the pump.fun curve at +${((graduatedAt - t0) / 3600).toFixed(1)}h`);

  // Wallet origins for the top-10 wallets of every bucket (Helius history, first tx).
  const origins = new Map<string, WalletOrigin>();
  const methods: Partial<Record<FieldName, string>> = {
    holders: "Helius mint history (oldest first): owner balances from token-balance deltas; off-curve owners (pools, curves) excluded",
    top10SharePct: "same balances, top 10 wallets / supply (Helius getAsset)",
    earlyRetentionPct: "first 20 buyers (fee payer gaining tokens against a pool) still holding",
    buyers: "fee payers buying against a pool/curve",
    sellers: "fee payers selling to a pool/curve",
    buyerSellerRatio: "(buyers + 1) / (sellers + 1)",
    devBuySharePct: "creator (fee payer of the creation tx) share of tokens bought",
    devSoldPct: "creator tokens sold / tokens received",
    freshWalletSharePct: "top-10 wallets whose first-ever tx (Helius, oldest first) is < 24h before the bucket edge",
    fundingClusterMax: "largest group of top-10 wallets sharing the sender of their first SOL",
    priceUsd: "5-minute VWAP of swap execution prices (SOL paid / tokens, ex token-account rent) × Coinbase SOL/USD hourly close",
    mcapUsd: "price × current supply",
    liquidityUsd: isPump ? "pump.fun curve SOL reserve × SOL/USD (until graduation)" : "not reconstructed",
    volume24hUsd: "SOL value of swaps in the trailing 24h × SOL/USD",
    volMc: "trailing-24h volume / market cap",
    drawdownPct: "last 5-minute VWAP vs the highest 5-minute VWAP so far",
    peakMultiple: "highest 5-minute VWAP / first 5-minute VWAP",
  };

  const out: BucketSnapshot[] = [];
  for (const b of buckets) {
    const cutoffT = t0 + b * 3600;
    const at = new Date(cutoffT * 1000).toISOString();
    if (cutoffT > Date.now() / 1000) continue;
    if (cutoffT > coveredT) {
      const reason = `history to +${b}h exceeds the reconstruction budget (${maxTx} transactions read, covering +${((coveredT - t0) / 3600).toFixed(1)}h)`;
      out.push({ bucket: b, at, fields: emptyFields(), nulls: Object.fromEntries(Object.keys(methods).map((k) => [k, reason])) });
      continue;
    }
    // Look up origins for this bucket's top 10.
    const bal = new Map<string, number>();
    for (const d of deltas) if (d.pos <= cutoffT) bal.set(d.owner, (bal.get(d.owner) ?? 0) + d.delta);
    const top = [...bal].filter(([o, v]) => v > 0 && !isProgramAddress(o)).sort((a, c) => c[1] - a[1]).slice(0, 10).map(([o]) => o);
    for (const w of top) if (!origins.has(w)) origins.set(w, await walletOrigin(helius, w));

    const { fields, nulls } = bucketFields({
      deltas,
      trades,
      prices,
      liquidity: isPump ? liquidity : null,
      cutoffPos: cutoffT,
      cutoffT,
      supply,
      deployer: creator,
      isPool: (o) => isProgramAddress(o) || o === curve,
      origins,
    });
    if (!isPump) nulls.liquidityUsd = "AMM pool reserves at past times need archive account state (not available)";
    else if (graduatedAt && cutoffT >= graduatedAt) {
      fields.liquidityUsd = null;
      nulls.liquidityUsd = "graduated off the pump.fun curve before this age — AMM pool reserves are not reconstructed";
    }
    if (!sol.size) for (const k of ["priceUsd", "mcapUsd", "volume24hUsd", "volMc", "liquidityUsd"] as FieldName[]) nulls[k] = "SOL/USD history unavailable";
    out.push({ bucket: b, at, fields, nulls });
  }

  return {
    chain: "solana",
    address: mint,
    symbol: asset.content?.metadata?.symbol ?? null,
    name: asset.content?.metadata?.name ?? null,
    createdAt: new Date(t0 * 1000).toISOString(),
    creationTx: first.transaction.signatures[0] ?? null,
    creator,
    launchpad: isPump ? "pump.fun" : null,
    methods,
    buckets: out,
    notes,
    builtAt: new Date().toISOString(),
    buildMs: Date.now() - t0ms,
  };
}

export function emptyFields() {
  return {
    holders: null,
    top10SharePct: null,
    earlyRetentionPct: null,
    buyers: null,
    sellers: null,
    buyerSellerRatio: null,
    devBuySharePct: null,
    devSoldPct: null,
    freshWalletSharePct: null,
    fundingClusterMax: null,
    priceUsd: null,
    mcapUsd: null,
    liquidityUsd: null,
    volume24hUsd: null,
    volMc: null,
    drawdownPct: null,
    peakMultiple: null,
  };
}
