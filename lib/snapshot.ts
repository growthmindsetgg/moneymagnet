import type { Chain, SourceStatus, TokenSnapshot } from "./types";
import { defaultConfig } from "./scoring/config";

export function emptySnapshot(chain: Chain, address: string): TokenSnapshot {
  return {
    chain,
    address,
    name: null,
    symbol: null,
    launchpad: null,
    anchor: null,
    assetKind: null,
    tokenExists: null,
    priceUsd: null,
    fdvUsd: null,
    liquidityUsd: null,
    volume24hUsd: null,
    poolCount: null,
    mainPoolLiquidityUsd: null,
    mainPoolSharePct: null,
    liqFdvPct: null,
    liqChange24hPct: null,
    liqChange7dPct: null,
    liqChange24hWindow: null,
    liqChange7dWindow: null,
    liqHistoryPoints: null,
    liquidityTotalUsd: null,
    poolAddresses: [],
    createdAt: null,
    ageHours: null,
    ageMinutes: null,
    totalSupply: null,
    holderCount: null,
    top10SharePct: null,
    top1SharePct: null,
    accumulatorCount: null,
    accumulatorSupplyPct: null,
    earlyCohortSize: null,
    earlyExitRatePct: null,
    earlyRetentionPct: null,
    deployerAddress: null,
    deployerHoldingPct: null,
    holderClasses: [],
    largestHolder: null,
    founderNeverSold: null,
    founderSold: null,
    founderHoldDays: null,
    deployerSoldPct: null,
    deployerHasSold: null,
    deployerDistributedPct: null,
    insiderNetworks: null,
    holders: [],
    swapHolders: [],
    liquidityHolders: [],
    liquidityHeldPct: null,
    holderSource: null,
    staleFields: {},
    netFlowRatio24h: null,
    netFlowUsd24h: null,
    netFlowRatio7d: null,
    flowConsistent: null,
    buyers24h: null,
    sellers24h: null,
    buyerSellerRatio: null,
    singleTradeWalletSharePct: null,
    tradesPerWallet: null,
    smartMoneyNetUsd: null,
    smartBuyers: null,
    volLiqRatio: null,
    repeatedSizeSharePct: null,
    bundleSharePct: null,
    washFlag: null,
    honeypot: null,
    sellable: null,
    liquidityPulled: null,
    deadCurve: null,
    deadLaunch: null,
    lastTradeHoursAgo: null,
    launchBuyers: null,
    zeroActivity: [],
    roundTripLossPct: null,
    mintAuthority: null,
    freezeAuthority: null,
    verified: null,
    ownerRenounced: null,
    upgradeable: null,
    lpLockedPct: null,
    isLaunchpad: null,
    volMcRatio: null,
    volMcBar: null,
    volMcVsBar: null,
    feesSol: null,
    feesPerMcap15k: null,
    snipeRatioPct: null,
    feedWindow: null,
    bundleScore: null,
    organicScore: null,
    timingEntropy: null,
    devBuySol: null,
    devBuySharePct: null,
    freshWalletsTop20: null,
    fundingClusterMax: null,
    clusterSupplyPct: null,
    bundlerMajority: null,
    makersCount: null,
    makersHoldersRatio: null,
    creatorPriorMints: null,
    creatorRugRatePct: null,
    creatorHasSocials: null,
    socialLinks: null,
    curveProgressPct: null,
    realSolReserves: null,
    curveCirculatingPct: null,
    uniqueBuyers: null,
    sells24h: null,
    buyTxs24h: null,
    sellTxs24h: null,
    buyersBasis: null,
    allBuyersExited: null,
    insiderSupplyPct: null,
    first5mSharePct: null,
    launchPriceUsd: null,
    bundlersFlushed: null,
    launchRetraced30: null,
    launchWindow: null,
    identicalCandleSharePct: null,
    identicalWindow: null,
    hugeCandlesOnly: null,
    staircase: null,
    staircaseWindow: null,
    trendScore: null,
    trendWindow: null,
    brokeHigherLow: null,
    upOnlyChart: null,
    honeypotPattern: null,
    patterns: [],
    tmWinnerSimilarity: null,
    tmRugSimilarity: null,
    nullReasons: {},
    provenance: {},
    fakeSignals: [],
    links: [],
  };
}

/**
 * Merges adapter slices into one snapshot. Slices are given in priority order:
 * the first non-null value for a field wins. Lists (signals, links) concatenate;
 * holders take the first non-empty list.
 */
export function mergeSnapshots(base: TokenSnapshot, slices: Partial<TokenSnapshot>[]): TokenSnapshot {
  const out: TokenSnapshot = { ...base, fakeSignals: [...base.fakeSignals], links: [...base.links], patterns: [...base.patterns] };
  const rec = out as unknown as Record<string, unknown>;
  for (const slice of slices) {
    for (const [k, v] of Object.entries(slice)) {
      if (v === null || v === undefined) continue;
      if (k === "fakeSignals" || k === "links" || k === "patterns") {
        (rec[k] as unknown[]).push(...(v as unknown[]));
      } else if (k === "holders" || k === "swapHolders" || k === "liquidityHolders") {
        if (!(rec[k] as unknown[]).length && (v as unknown[]).length) rec[k] = v;
      } else if (k === "poolAddresses") {
        out.poolAddresses = [...new Set([...out.poolAddresses, ...(v as string[]).map((x) => x.toLowerCase())])];
      } else if (k === "nullReasons") {
        // The first adapter to explain a null wins; a live value elsewhere makes the reason moot.
        out.nullReasons = { ...(v as Record<string, string>), ...out.nullReasons };
      } else if (k === "staleFields") {
        out.staleFields = { ...out.staleFields, ...(v as Record<string, number>) };
      } else if (k === "chain" || k === "address" || k === "provenance") {
        continue;
      } else if (rec[k] === null || rec[k] === undefined) {
        rec[k] = v;
      }
    }
  }
  return out;
}

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);

/** Fills metrics that can be computed from other metrics, and the composite wash flag. */
export function deriveMetrics(s: TokenSnapshot): TokenSnapshot {
  const d: TokenSnapshot = { ...s, fakeSignals: [...s.fakeSignals], staleFields: { ...s.staleFields } };
  // A derived metric is as stale as its stalest input.
  const inherit = (target: keyof TokenSnapshot, inputs: (keyof TokenSnapshot)[]) => {
    const ages = inputs.map((i) => d.staleFields[i as string]).filter((x): x is number => x != null);
    if (ages.length && d[target] != null) d.staleFields[target as string] = Math.max(...ages);
  };

  if (d.ageHours == null && d.createdAt) {
    const t = Date.parse(d.createdAt);
    if (Number.isFinite(t)) d.ageHours = Math.max(0, (Date.now() - t) / 3_600_000);
  }
  if (d.ageHours != null) d.ageMinutes = Math.round(d.ageHours * 600) / 10;
  // Buyer / seller counts: unique wallets when a source counts them, else DexScreener tx counts (labelled).
  if (d.buyers24h != null) d.buyersBasis ??= "unique wallets";
  else if (d.buyTxs24h != null) {
    d.buyers24h = d.buyTxs24h;
    if (d.sellers24h == null) d.sellers24h = d.sellTxs24h;
    d.buyersBasis = "tx counts, not unique wallets (DexScreener)";
  }
  // The feed's "dev has not sold" is a measurement: 0% sold (Helius' exact share wins when present).
  if (d.chain === "solana" && d.deployerSoldPct == null && d.deployerHasSold === false) d.deployerSoldPct = 0;
  // A Solana token younger than 24h: GeckoTerminal's 24h unique buyers cover its whole life.
  if (d.uniqueBuyers == null && d.chain === "solana" && d.ageHours != null && d.ageHours < 24 && d.buyers24h != null) {
    d.uniqueBuyers = d.buyers24h;
  }
  // Below 10 buyers, snipe ratio and dev-buy share are ~100% by construction — not a measurement.
  if (d.chain === "solana" && d.uniqueBuyers != null && d.uniqueBuyers < 10) {
    const why = `only ${d.uniqueBuyers} buyers — below 10 this share is ~100% by construction`;
    if (d.snipeRatioPct != null) d.snipeRatioPct = null;
    if (d.devBuySharePct != null) d.devBuySharePct = null;
    d.nullReasons = { ...d.nullReasons, snipeRatioPct: why, devBuySharePct: why };
  }
  if (d.buyerSellerRatio == null && d.buyers24h != null && d.sellers24h != null && d.sellers24h > 0) {
    d.buyerSellerRatio = d.buyers24h / d.sellers24h;
    inherit("buyerSellerRatio", ["buyers24h", "sellers24h"]);
  }
  if (d.liqFdvPct == null && d.liquidityUsd != null && d.fdvUsd) d.liqFdvPct = pct(d.liquidityUsd, d.fdvUsd);
  if (d.mainPoolSharePct == null && d.mainPoolLiquidityUsd != null && d.liquidityUsd) {
    d.mainPoolSharePct = pct(d.mainPoolLiquidityUsd, d.liquidityUsd);
  }
  if (d.volLiqRatio == null && d.volume24hUsd != null && d.liquidityUsd) d.volLiqRatio = d.volume24hUsd / d.liquidityUsd;
  if (d.earlyRetentionPct == null && d.earlyExitRatePct != null) {
    d.earlyRetentionPct = 100 - d.earlyExitRatePct;
    inherit("earlyRetentionPct", ["earlyExitRatePct"]);
  }
  if (d.earlyExitRatePct == null && d.earlyRetentionPct != null) d.earlyExitRatePct = 100 - d.earlyRetentionPct;
  // Unsellable because the LP was pulled is not a honeypot contract — it is reported as its own rule.
  if (d.honeypot == null && d.sellable === false && d.liquidityPulled !== true) d.honeypot = true;
  // Without an RPC answer, circulating supply ≈ FDV / price is close enough for holder percentages.
  if (d.totalSupply == null && d.fdvUsd && d.priceUsd) d.totalSupply = d.fdvUsd / d.priceUsd;
  if (d.deployerHasSold == null && d.deployerSoldPct != null) d.deployerHasSold = d.deployerSoldPct > 0;

  // Holder concentration: on-chain balances when the replay is complete, else swap-index holders.
  if (!d.holders.length && d.swapHolders.length) {
    d.holders = d.swapHolders;
    d.holderSource = d.holderSource ?? "swap-index";
    if (d.staleFields.swapHolders != null) d.staleFields.holders = d.staleFields.swapHolders;
  }
  if (d.holders.length && d.totalSupply) {
    const pools = new Set(d.poolAddresses.map((x) => x.toLowerCase()));
    const rows = d.holders
      .filter((h) => h.qty != null)
      .map((h) => {
        const isLiquidity = h.kind === "liquidity" || h.isContract === true || pools.has(h.address.toLowerCase());
        return { ...h, pct: h.pct ?? pct(h.qty!, d.totalSupply!), kind: isLiquidity ? ("liquidity" as const) : ("wallet" as const) };
      })
      .sort((a, b) => (b.qty ?? 0) - (a.qty ?? 0));
    const wallets = rows.filter((h) => h.kind === "wallet");
    const liquidity = rows.filter((h) => h.kind === "liquidity");
    d.holders = wallets;
    if (!d.liquidityHolders.length) d.liquidityHolders = liquidity;
    if (d.liquidityHeldPct == null && liquidity.length) d.liquidityHeldPct = liquidity.reduce((a, h) => a + (h.pct ?? 0), 0);
    if (d.top10SharePct == null) {
      d.top10SharePct = wallets.slice(0, 10).reduce((a, h) => a + (h.pct ?? 0), 0);
      inherit("top10SharePct", ["holders"]);
    }
    if (d.top1SharePct == null && rows.length) {
      // No wallet holds anything (only pools / curves do): the top wallet's share is genuinely 0%.
      d.top1SharePct = wallets[0]?.pct ?? 0;
      inherit("top1SharePct", ["holders"]);
    }
  }
  // 0-sell accumulators need per-wallet buy/sell counts, which only the swap index has.
  if (d.swapHolders.length && d.totalSupply && d.accumulatorCount == null) {
    const acc = d.swapHolders.filter((h) => h.buys != null && h.sells != null && h.buys >= 5 && h.sells === 0);
    d.accumulatorCount = acc.length;
    d.accumulatorSupplyPct = acc.reduce((a, h) => a + (h.pct ?? (h.qty != null ? (pct(h.qty, d.totalSupply!) ?? 0) : 0)), 0);
    inherit("accumulatorCount", ["swapHolders"]);
    inherit("accumulatorSupplyPct", ["swapHolders"]);
  }

  // Sellability: an explicit honeypot verdict decides it when no source reported sellable directly.
  if (d.sellable == null && d.honeypot != null) d.sellable = !d.honeypot;

  // Guide p.25: VOL/MC against an age-adjusted bar (<6h 1.5×, <24h 1.2×, <72h 1.0×, otherwise 0.8).
  if (d.volMcRatio == null && d.volume24hUsd != null && d.fdvUsd) {
    d.volMcRatio = d.volume24hUsd / d.fdvUsd;
    inherit("volMcRatio", ["volume24hUsd", "fdvUsd"]);
  }
  if (d.volMcRatio != null) {
    const age = d.ageHours;
    d.volMcBar = age == null || age >= 72 ? 0.8 : age < 6 ? 1.5 : age < 24 ? 1.2 : 1.0;
    d.volMcVsBar = d.volMcRatio / d.volMcBar;
    inherit("volMcVsBar", ["volMcRatio"]);
  }

  // All buyers exited, proven from chain state: when < 0.01% of supply sits outside the pump.fun
  // curve (dust), every bought token has been sold back, so no buyer wallet holds any. Buyer/seller counts come from the 24h
  // window, which covers the whole life of a < 24h token (older tokens need Helius trade history).
  if (
    d.allBuyersExited == null &&
    d.chain === "solana" &&
    d.curveCirculatingPct != null &&
    d.curveCirculatingPct < 0.01 &&
    d.ageHours != null &&
    d.ageHours < 24 &&
    d.buyers24h != null &&
    d.sellers24h != null
  ) {
    d.allBuyersExited = d.buyers24h >= 5 && d.sellers24h > 0;
    if (d.uniqueBuyers == null) d.uniqueBuyers = d.buyers24h;
  }

  // Guide p.27: makers vs holders.
  if (d.makersHoldersRatio == null && d.makersCount != null && d.holderCount) {
    d.makersHoldersRatio = d.makersCount / d.holderCount;
    inherit("makersHoldersRatio", ["makersCount", "holderCount"]);
  }

  // Guide p.37: bundlers flushed = 3d+ token, ≥ 70% of the first-20 buyers gone, price above launch.
  if (d.bundlersFlushed == null && d.ageHours != null && d.ageHours >= 72 && d.earlyExitRatePct != null && d.priceUsd != null && d.launchPriceUsd != null) {
    d.bundlersFlushed = d.earlyExitRatePct >= 70 && d.priceUsd > d.launchPriceUsd;
    inherit("bundlersFlushed", ["earlyExitRatePct", "priceUsd", "launchPriceUsd"]);
  }

  // Guide p.19 honeypot triad: up-only chart + low volume (< $10k/24h) + few holders (< 50).
  if (d.honeypotPattern == null) {
    if (d.upOnlyChart === false) d.honeypotPattern = false;
    else if (d.upOnlyChart === true && d.volume24hUsd != null && d.holderCount != null) {
      d.honeypotPattern = d.volume24hUsd < 10_000 && d.holderCount < 50;
    }
  }

  // Dead pump.fun curve: 0 SOL left and never graduated (graduation sets progress to 100%).
  if (d.deadCurve == null && d.chain === "solana" && d.realSolReserves != null && d.curveProgressPct != null) {
    d.deadCurve = d.realSolReserves < 0.001 && d.curveProgressPct < 100;
  }
  if (d.deadCurve == null && d.chain === "robinhood") d.deadCurve = false; // no bonding curve on Robinhood Chain
  d.launchBuyers = d.uniqueBuyers ?? d.buyers24h;
  d.deadLaunch = deadLaunchOf(d);

  if (d.flowConsistent == null && d.netFlowRatio24h != null && d.netFlowRatio7d != null) {
    d.flowConsistent = d.netFlowRatio24h >= -0.05 && d.netFlowRatio7d >= -0.05;
    inherit("flowConsistent", ["netFlowRatio24h", "netFlowRatio7d"]);
  }

  // Composite wash heuristic. Individual sub-signals are surfaced even when the flag stays off.
  if (d.washFlag !== true) {
    const vl = d.volLiqRatio ?? 0;
    const rep = d.repeatedSizeSharePct ?? 0;
    const bun = d.bundleSharePct ?? 0;
    const triggers: string[] = [];
    // v2.4: VOL/MC > 20× on a token ≥ 1h old is wash by definition.
    if (d.volMcRatio != null && d.volMcRatio > 20 && d.ageHours != null && d.ageHours >= 1) triggers.push(`24h volume is ${d.volMcRatio.toFixed(1)}× market cap on a token ${d.ageHours.toFixed(1)}h old (> 20× ⇒ wash)`);
    if (vl >= 25) triggers.push(`24h volume is ${vl.toFixed(1)}× liquidity`);
    // v2.4: wash means manufactured volume, so repeated sizes / bundles only count with elevated
    // turnover (≥ 2× liquidity). On a deep pool at normal turnover they are routing / arbitrage.
    const busy = d.volLiqRatio != null && vl >= 2;
    if (rep >= 40 && busy) triggers.push(`${rep.toFixed(0)}% of recent swaps repeat the same size at ${vl.toFixed(1)}× liquidity turnover`);
    if (bun >= 40 && busy) triggers.push(`${bun.toFixed(0)}% of recent swaps land in same-block bundles at ${vl.toFixed(1)}× liquidity turnover`);
    const quiet = [rep >= 40 ? `${rep.toFixed(0)}% repeated sizes` : "", bun >= 40 ? `${bun.toFixed(0)}% same-block bundles` : ""].filter(Boolean);
    if (quiet.length && !busy) d.fakeSignals.push({ kind: "wash", level: "warn", text: `${quiet.join(", ")} in recent swaps, but turnover is ${d.volLiqRatio == null ? "unknown" : `only ${vl.toFixed(1)}× liquidity`} — not counted as wash`, source: "HoodTier heuristic" });
    if (vl >= 8 && (rep >= 20 || bun >= 20)) {
      triggers.push(`high turnover (${vl.toFixed(1)}× liquidity) with repeated sizes/bundles`);
    }
    const anyInput = d.volMcRatio != null || d.volLiqRatio != null || d.repeatedSizeSharePct != null || d.bundleSharePct != null;
    if (triggers.length) {
      d.washFlag = true;
      for (const t of triggers) d.fakeSignals.push({ kind: "wash", level: "danger", text: t, source: "HoodTier heuristic" });
    } else if (d.washFlag == null && anyInput) {
      d.washFlag = false;
      inherit("washFlag", ["volLiqRatio", "repeatedSizeSharePct", "bundleSharePct"]);
    }
    if (!triggers.length && vl >= 8) {
      d.fakeSignals.push({ kind: "wash", level: "warn", text: `24h volume is ${vl.toFixed(1)}× liquidity (elevated turnover)`, source: "HoodTier heuristic" });
    }
  }
  return d;
}

/**
 * Zero is data, not missing: when sources answered and the token's activity is genuinely zero
 * (no buyers, no trades, no volume, no liquidity, curve at 0%), every activity metric becomes 0
 * (its factor then scores its minimum, status live, evidence "no activity"). Any positive reading
 * anywhere vetoes it. Null stays reserved for a failed source or a field nobody provides.
 */
export function applyZeroActivity(s: TokenSnapshot, sources: SourceStatus[], metrics: string[] = defaultConfig.zeroActivity?.metrics ?? []): TokenSnapshot {
  const positive =
    (s.volume24hUsd ?? 0) > 0 ||
    (s.buyers24h ?? 0) > 0 ||
    (s.uniqueBuyers ?? 0) > 0 ||
    (s.sells24h ?? 0) > 0 ||
    (s.liquidityUsd ?? 0) >= 1 ||
    (s.realSolReserves ?? 0) > 0.001 ||
    (s.curveProgressPct ?? 0) > 0;
  if (positive) return s;
  const said: string[] = [];
  const src = (id: string) => sources.find((x) => x.id === id);
  if (s.uniqueBuyers === 0) said.push(`${s.chain === "solana" ? "Helius" : "swap index"}: 0 buyers`);
  if (s.curveProgressPct === 0 && (s.realSolReserves ?? 0) <= 0.001) said.push("pump.fun curve: 0% / 0 SOL");
  const gt = src("geckoterminal");
  if (gt && gt.state !== "failed" && /no pools/i.test(gt.message ?? "")) said.push("GeckoTerminal: no pools");
  const ds = src("dexscreener");
  if (ds && ds.state !== "failed" && /no pairs/i.test(ds.message ?? "")) said.push("DexScreener: no pairs");
  if (s.volume24hUsd === 0) said.push("24h volume $0");
  if (!said.length) return s;
  const d: TokenSnapshot = { ...s, nullReasons: { ...s.nullReasons }, zeroActivity: said };
  const rec = d as unknown as Record<string, unknown>;
  const BOOLEAN = new Set(["launchRetraced30", "hugeCandlesOnly", "staircase", "upOnlyChart"]);
  for (const m of metrics) {
    // Numeric activity metrics become 0; boolean chart patterns stay null (no candles exist) and
    // their factors are scored at the minimum by the engine because zeroActivity is set.
    if (!BOOLEAN.has(m) && rec[m] == null) rec[m] = 0;
    delete d.nullReasons[m];
  }
  return d;
}

/**
 * §7c dead launch: age ≥ 1h AND (≤ 2 unique buyers OR < $100 liquidity OR a dead curve). Lifetime
 * buyers are exact when known; 24h buyers are a lower bound (more than 2 in 24h ⇒ not ≤ 2 ever).
 * True when any leg is true, false when every leg is known false, else null.
 */
export function deadLaunchOf(d: TokenSnapshot): boolean | null {
  if (d.ageHours == null) return null;
  if (d.ageHours < 1) return false;
  const byBuyers = d.uniqueBuyers != null ? d.uniqueBuyers <= 2 : d.buyers24h != null && d.buyers24h > 2 ? false : null;
  const byLiquidity = d.liquidityUsd != null ? d.liquidityUsd < 100 : null;
  const byCurve = d.deadCurve;
  const legs = [byBuyers, byLiquidity, byCurve];
  if (legs.includes(true)) return true;
  return legs.every((x) => x === false) ? false : null;
}
