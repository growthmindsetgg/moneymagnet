import type { BalanceDelta, BucketFields, FieldName, PricePoint, Trade, WalletOrigin } from "./types";

export interface BucketInput {
  deltas: BalanceDelta[];
  trades: Trade[];
  prices: PricePoint[];
  /** Pool-side liquidity in USD over time (e.g. pump.fun curve SOL × SOL/USD), when reconstructable. */
  liquidity: { t: number; usd: number }[] | null;
  /** Events with pos ≤ cutoffPos belong to the bucket. */
  cutoffPos: number;
  /** Unix seconds of the bucket edge. */
  cutoffT: number;
  supply: number | null;
  deployer: string | null;
  /** Pools, curves, routers and other programs — excluded from holder math. */
  isPool: (owner: string) => boolean;
  /** First-tx time and funder per wallet, when the chain lets us look it up. */
  origins: Map<string, WalletOrigin> | null;
}

const EARLY_BUYERS = 20;
const TOP = 10;
const FRESH_WINDOW_S = 24 * 3600;

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Computes one age bucket's fields from real events only. A field whose inputs are missing stays
 * null and gets a reason; nothing is defaulted. Pure — the unit-tested heart of the Time Machine.
 */
export function bucketFields(inp: BucketInput): { fields: BucketFields; nulls: Partial<Record<FieldName, string>> } {
  const nulls: Partial<Record<FieldName, string>> = {};
  const balances = new Map<string, number>();
  for (const d of inp.deltas) if (d.pos <= inp.cutoffPos) balances.set(d.owner, (balances.get(d.owner) ?? 0) + d.delta);
  const dust = inp.supply ? inp.supply * 1e-9 : 1e-9;
  const wallets = [...balances].filter(([o, b]) => b > dust && !inp.isPool(o)).sort((a, b) => b[1] - a[1]);
  const top = wallets.slice(0, TOP);

  const trades = inp.trades.filter((t) => t.pos <= inp.cutoffPos);
  const buyerSet = new Set(trades.filter((t) => t.side === "buy").map((t) => t.wallet));
  const sellerSet = new Set(trades.filter((t) => t.side === "sell").map((t) => t.wallet));

  const early: string[] = [];
  for (const t of trades) {
    if (t.side === "buy" && !early.includes(t.wallet) && t.wallet !== inp.deployer) early.push(t.wallet);
    if (early.length >= EARLY_BUYERS) break;
  }

  const f: BucketFields = {
    holders: wallets.length,
    top10SharePct: inp.supply ? round((top.reduce((a, [, b]) => a + b, 0) / inp.supply) * 100) : null,
    earlyRetentionPct: early.length ? round((early.filter((w) => (balances.get(w) ?? 0) > dust).length / early.length) * 100) : null,
    buyers: buyerSet.size,
    sellers: sellerSet.size,
    // Smoothed so a launch with no sellers yet still has a finite ratio.
    buyerSellerRatio: round((buyerSet.size + 1) / (sellerSet.size + 1)),
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
  if (!inp.supply) nulls.top10SharePct = "total supply unknown";
  if (!early.length) nulls.earlyRetentionPct = "no buys before this age";

  // Dev behaviour.
  if (inp.deployer) {
    const bought = trades.filter((t) => t.side === "buy").reduce((a, t) => a + t.tokens, 0);
    const devBought = trades.filter((t) => t.side === "buy" && t.wallet === inp.deployer).reduce((a, t) => a + t.tokens, 0);
    f.devBuySharePct = bought > 0 ? round((devBought / bought) * 100) : null;
    if (bought <= 0) nulls.devBuySharePct = "no buys before this age";
    const received = inp.deltas.filter((d) => d.pos <= inp.cutoffPos && d.owner === inp.deployer && d.delta > 0).reduce((a, d) => a + d.delta, 0);
    const sold = trades.filter((t) => t.side === "sell" && t.wallet === inp.deployer).reduce((a, t) => a + t.tokens, 0);
    f.devSoldPct = received > 0 ? round(Math.min(100, (sold / received) * 100)) : null;
    if (received <= 0) nulls.devSoldPct = "deployer never held the token before this age";
  } else {
    nulls.devBuySharePct = nulls.devSoldPct = "creator wallet unknown";
  }

  // Wallet origins: fresh wallets and same-funder clusters among the top 10.
  if (inp.origins && top.length) {
    const known = top.map(([w]) => inp.origins!.get(w)).filter((o): o is WalletOrigin => !!o && o.firstT != null);
    if (known.length) {
      f.freshWalletSharePct = round((known.filter((o) => inp.cutoffT - o.firstT! < FRESH_WINDOW_S).length / known.length) * 100);
      const byFunder = new Map<string, number>();
      for (const o of known) if (o.funder) byFunder.set(o.funder, (byFunder.get(o.funder) ?? 0) + 1);
      f.fundingClusterMax = byFunder.size ? Math.max(...byFunder.values()) : 1;
    } else {
      nulls.freshWalletSharePct = nulls.fundingClusterMax = "first transaction of the top-10 wallets not found";
    }
  } else if (!inp.origins) {
    // Reason supplied by the chain builder (see methods).
  } else {
    nulls.freshWalletSharePct = nulls.fundingClusterMax = "no wallet holders at this age";
  }

  // Price path.
  const px = inp.prices.filter((p) => p.t <= inp.cutoffT);
  if (px.length) {
    const last = px[px.length - 1].priceUsd;
    const peak = Math.max(...px.map((p) => p.priceUsd));
    f.priceUsd = last;
    f.peakMultiple = px[0].priceUsd > 0 ? round(peak / px[0].priceUsd) : null;
    f.drawdownPct = peak > 0 ? round((1 - last / peak) * 100) : null;
    if (inp.supply) f.mcapUsd = round(last * inp.supply, 2);
    else nulls.mcapUsd = "total supply unknown";
    const window = px.filter((p) => p.t > inp.cutoffT - 24 * 3600);
    if (window.every((p) => p.volumeUsd != null)) {
      f.volume24hUsd = round(window.reduce((a, p) => a + (p.volumeUsd ?? 0), 0), 2);
      if (f.mcapUsd) f.volMc = round(f.volume24hUsd / f.mcapUsd);
    } else {
      nulls.volume24hUsd = nulls.volMc = "volume not known for every interval";
    }
  } else {
    for (const k of ["priceUsd", "mcapUsd", "volume24hUsd", "volMc", "drawdownPct", "peakMultiple"] as FieldName[]) nulls[k] = "no priced trade or candle before this age";
  }

  if (inp.liquidity) {
    const l = inp.liquidity.filter((p) => p.t <= inp.cutoffT);
    if (l.length) f.liquidityUsd = round(l[l.length - 1].usd, 2);
    else nulls.liquidityUsd = "no pool reserve observed before this age";
  }
  return { fields: f, nulls };
}
