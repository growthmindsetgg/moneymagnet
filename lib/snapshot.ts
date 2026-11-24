import type { Chain, SourceStatus, TokenSnapshot } from "./types";
import { defaultConfig } from "./scoring/config";
import { formatAge } from "./scoring/format";

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
    priceChange24hPct: null,
    priceChangeWindow: null,
    priceChange7dPct: null,
    priceChange7dWindow: null,
    cohortMedian7dPct: null,
    cohortSize: null,
    cohortLabel: null,
    relStrength7dPp: null,
    liqHistoryPoints: null,
    liquidityTotalUsd: null,
    poolAddresses: [],
    createdAt: null,
    ageHours: null,
    ageMinutes: null,
    totalSupply: null,
    holderCount: null,
    top10SharePct: null,
    equalSplitPct: null,
    equalSplitCount: null,
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
    teamNeverSold: null,
    teamSold: null,
    teamHoldDays: null,
    holderStrength: null,
    holderStrengthLabel: null,
    holderStrengthDetail: null,
    vestingDiamond: null,
    holderStrengthPending: null,
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
    lastTradeWithinHours: null,
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
    // Fields whose value this slice supplied to the merged snapshot: only their stale ages may be copied.
    const won = new Set<string>();
    for (const [k, v] of Object.entries(slice)) {
      if (v === null || v === undefined) continue;
      if (k === "fakeSignals" || k === "links" || k === "patterns") {
        (rec[k] as unknown[]).push(...(v as unknown[]));
      } else if (k === "holders" || k === "swapHolders" || k === "liquidityHolders") {
        if (!(rec[k] as unknown[]).length && (v as unknown[]).length) {
          rec[k] = v;
          won.add(k);
        }
      } else if (k === "poolAddresses") {
        out.poolAddresses = [...new Set([...out.poolAddresses, ...(v as string[]).map((x) => x.toLowerCase())])];
        won.add(k);
      } else if (k === "nullReasons" || k === "staleFields") {
        continue;
      } else if (k === "chain" || k === "address" || k === "provenance") {
        continue;
      } else if (rec[k] === null || rec[k] === undefined) {
        rec[k] = v;
        won.add(k);
      }
    }
    // The first adapter to explain a null wins; a live value elsewhere makes the reason moot.
    if (slice.nullReasons) out.nullReasons = { ...slice.nullReasons, ...out.nullReasons };
    // A stale age describes this slice's value: when that value lost the merge, the winning value is not stale.
    if (slice.staleFields) {
      const ages = Object.fromEntries(Object.entries(slice.staleFields).filter(([k]) => won.has(k)));
      out.staleFields = { ...out.staleFields, ...ages };
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
  // The feed's "dev has not sold" covers only its launch observation window, not the token's life: it is never
  // turned into a lifetime 0% sold (Helius' exact share is the measurement).
  if (d.chain === "solana" && d.deployerSoldPct == null && d.deployerHasSold === false && !d.nullReasons.deployerSoldPct) {
    d.nullReasons = { ...d.nullReasons, deployerSoldPct: `only the launch observation says the dev had not sold${d.feedWindow ? ` (${d.feedWindow})` : ""} — not a lifetime share` };
  }
  // A Solana token younger than 24h: GeckoTerminal's 24h unique buyers cover its whole life. DexScreener tx
  // counts are not unique wallets (tx counts ≥ wallets), so they never stand in for unique buyers.
  if (d.uniqueBuyers == null && d.chain === "solana" && d.ageHours != null && d.ageHours < 24 && d.buyers24h != null && d.buyersBasis === "unique wallets") {
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
    if (d.equalSplitPct == null) {
      const g = equalSplit(wallets);
      d.equalSplitPct = g.pct;
      d.equalSplitCount = g.count;
      inherit("equalSplitPct", ["holders"]);
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
    if (d.uniqueBuyers == null && d.buyersBasis === "unique wallets") d.uniqueBuyers = d.buyers24h;
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
  // A stalled trade index (HoodScan's swap list once trailed the chain by 17h while DexScreener counted trades in the
  // last hour) must not read as "no trades": when DexScreener counts a trade inside a shorter window, the index's
  // last-trade age is contradicted and becomes null with both readings stated.
  if (d.lastTradeHoursAgo != null && d.lastTradeWithinHours != null && d.lastTradeHoursAgo > d.lastTradeWithinHours) {
    d.nullReasons = {
      ...d.nullReasons,
      lastTradeHoursAgo: `contradicted: the trade index's newest swap is ${formatAge(d.lastTradeHoursAgo)} old, but DexScreener counts trades in the last ${d.lastTradeWithinHours}h — the index is behind`,
    };
    d.lastTradeHoursAgo = null;
  }
  d.deadLaunch = deadLaunchOf(d);

  // The 24h price change covers the pair's whole life when it is younger than 24h: say so on the evidence line.
  if (d.priceChange24hPct != null && d.priceChangeWindow == null) {
    d.priceChangeWindow = d.ageHours == null ? "24h (since launch if the pair is younger)" : d.ageHours < 24 ? `since launch (${formatAge(d.ageHours)})` : "24h";
  }

  // Relative strength (7d vs the peer cohort's median): min(change, change − median) is > 0 only when the token rose
  // AND beat the median. Derived from two measured inputs; either missing leaves it null with that input's reason.
  if (d.relStrength7dPp == null) {
    if (d.priceChange7dPct != null && d.cohortMedian7dPct != null) {
      d.relStrength7dPp = Math.min(d.priceChange7dPct, d.priceChange7dPct - d.cohortMedian7dPct);
      inherit("relStrength7dPp", ["priceChange7dPct", "cohortMedian7dPct"]);
    } else if (!d.nullReasons.relStrength7dPp) {
      const why =
        d.priceChange7dPct == null
          ? `the token's own 7d price change is unknown (${d.nullReasons.priceChange7dPct ?? "no daily candles from GeckoTerminal"})`
          : `the peer cohort's 7d median is unknown (${d.nullReasons.cohortMedian7dPct ?? "peer cohort not read"})`;
      d.nullReasons = { ...d.nullReasons, relStrength7dPp: why };
    }
  }

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
    // "No wash" claims turnover and swap patterns are normal: it needs volume/liquidity, plus at least one
    // swap-pattern input (repeated sizes or same-block bundles) on Robinhood Chain, where HoodScan supplies them.
    // Elsewhere no source reads swap patterns, so turnover is the whole heuristic. Missing inputs are never read as 0.
    const swapPattern = d.repeatedSizeSharePct != null || d.bundleSharePct != null;
    const canClear = d.volLiqRatio != null && (swapPattern || d.chain !== "robinhood");
    if (triggers.length) {
      d.washFlag = true;
      for (const t of triggers) d.fakeSignals.push({ kind: "wash", level: "danger", text: t, source: "HoodTier heuristic" });
    } else if (d.washFlag == null && canClear) {
      d.washFlag = false;
      inherit("washFlag", ["volLiqRatio", "repeatedSizeSharePct", "bundleSharePct"]);
    } else if (d.washFlag == null && !d.nullReasons.washFlag) {
      const missing = [d.volLiqRatio == null ? "volume/liquidity" : "", !swapPattern && d.chain === "robinhood" ? "repeated-size / same-block-bundle shares" : ""].filter(Boolean).join(" and ");
      d.nullReasons = { ...d.nullReasons, washFlag: `wash heuristic not cleared: no ${missing} reading` };
    }
    if (!triggers.length && vl >= 8) {
      d.fakeSignals.push({ kind: "wash", level: "warn", text: `24h volume is ${vl.toFixed(1)}× liquidity (elevated turnover)`, source: "HoodTier heuristic" });
    }
  }
  applyFounderExclusion(d);
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
  const answered = (id: string) => {
    const x = src(id);
    return !!x && x.state !== "failed" && x.state !== "skipped";
  };
  if (s.uniqueBuyers === 0) said.push(`${s.chain === "solana" ? "Helius" : "swap index"}: 0 buyers`);
  const curveZero = s.curveProgressPct === 0 && (s.realSolReserves ?? 0) <= 0.001;
  if (curveZero) said.push("pump.fun curve: 0% / 0 SOL");
  const gt = src("geckoterminal");
  if (gt && gt.state !== "failed" && /no pools/i.test(gt.message ?? "")) said.push("GeckoTerminal: no pools");
  const ds = src("dexscreener");
  if (ds && ds.state !== "failed" && /no pairs/i.test(ds.message ?? "")) said.push("DexScreener: no pairs");
  if (s.volume24hUsd === 0) said.push("24h volume $0");
  if (!said.length) return s;
  // Indexer silence ("no pools", "no pairs", a $0 volume that may be a defaulted pool sum) is not proof of no
  // trades: a source that reads the token's trades must have answered (H7/H12).
  if (!tradeWitness(s, sources, answered, curveZero)) return s;
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
 * Did a source that sees the token's trades answer? Solana: Helius' curve replay (0 buyers) or the pump.fun
 * curve itself at 0% / 0 SOL (chain state). Robinhood: HoodScan's trades or stats call. Monad: nad.fun.
 * Other chains have no trade reader, so the market indexers' answers stand there.
 */
function tradeWitness(s: TokenSnapshot, sources: SourceStatus[], answered: (id: string) => boolean, curveZero: boolean): boolean {
  switch (s.chain) {
    case "solana": {
      if (curveZero && answered("solana-rpc")) return true;
      const fromHelius = !s.provenance?.uniqueBuyers?.length || s.provenance.uniqueBuyers.some((p) => p.source === "helius" && p.value === 0);
      return s.uniqueBuyers === 0 && answered("helius") && fromHelius;
    }
    case "robinhood": {
      const hs = sources.find((x) => x.id === "hoodscan");
      if (!hs || hs.state === "failed" || hs.state === "skipped") return false;
      if (hs.state === "ok") return true;
      // Partial / stale: the failed calls are listed as "trades: …" / "stats: …".
      const msg = hs.message ?? "";
      return !(/\btrades:/.test(msg) && /\bstats:/.test(msg));
    }
    case "monad":
      return answered("nadfun");
    default:
      return true;
  }
}

/**
 * §7c dead launch: age ≥ 1h AND (≤ 2 unique buyers OR < $100 liquidity OR a dead curve). Lifetime
 * buyers are exact when known; 24h buyers are a lower bound (more than 2 in 24h ⇒ not ≤ 2 ever).
 * True when any leg is true, false when every leg is known false, else null.
 */
export function deadLaunchOf(d: TokenSnapshot): boolean | null {
  if (d.ageHours == null) return null;
  if (d.ageHours < 1) return false;
  // Tx counts are not a lower bound on wallets (one wallet can trade 3 times): only unique-wallet counts clear the leg.
  const walletCounts = !/tx counts/i.test(d.buyersBasis ?? "");
  // Live unique-wallet buyers in 24h (> 2) contradict a "≤ 2 buyers" reading from another source: not dead by buyers.
  const liveBuyers = walletCounts && d.buyers24h != null && d.buyers24h > 2;
  const byBuyers = d.uniqueBuyers != null ? d.uniqueBuyers <= 2 && !liveBuyers : liveBuyers ? false : null;
  const byLiquidity = d.liquidityUsd != null ? d.liquidityUsd < 100 : null;
  const byCurve = d.deadCurve;
  const legs = [byBuyers, byLiquidity, byCurve];
  if (legs.includes(true)) return true;
  return legs.every((x) => x === false) ? false : null;
}

/**
 * One holder split into equal parts: the largest group of ≥ 5 of the top-20 counted wallets whose balances lie
 * within 10% of the group's largest. Organic holder lists fall off like a power law; near-identical balances
 * holding a real share of supply are a split. Derived from the holder list (the evidence says so).
 */
/**
 * Founder exclusion for the concentration factors: when the largest counted holder is the founder (the deployer or a
 * wallet founder-link due diligence ties to it) and that wallet is proven never to have sold, the top-holder and
 * top-10 factors score the holders other than the founder. The rules keep reading top1SharePct, so the founder cap
 * (A) still applies while the founder holds. Derived — the factor evidence says so.
 */
export function applyFounderExclusion(s: TokenSnapshot): void {
  const f = s.largestHolder;
  const lead = s.holders[0];
  const on = s.founderNeverSold === true && f?.class === "founder" && !!lead && lead.address.toLowerCase() === f.address.toLowerCase();
  if (!on) {
    s.founderExcluded = false;
    s.top1ExFounderPct = null;
    s.top10ExFounderPct = null;
    return;
  }
  const rest = s.holders.slice(1);
  s.founderExcluded = true;
  s.top1ExFounderPct = Math.round((rest[0]?.pct ?? 0) * 100) / 100;
  s.top10ExFounderPct = Math.round(rest.slice(0, 10).reduce((a, h) => a + (h.pct ?? 0), 0) * 100) / 100;
  for (const [m, src] of [["top1ExFounderPct", "top1SharePct"], ["top10ExFounderPct", "top10SharePct"]] as const) {
    const age = s.staleFields?.[src];
    if (age != null) s.staleFields = { ...s.staleFields, [m]: age };
  }
}

export function equalSplit(wallets: { pct: number | null }[]): { pct: number; count: number } {
  const p = wallets.slice(0, 20).map((h) => h.pct ?? 0).filter((x) => x > 0).sort((a, b) => b - a);
  let best = { pct: 0, count: 0 };
  for (let i = 0; i < p.length; i++) {
    let j = i;
    while (j + 1 < p.length && p[j + 1] >= p[i] * 0.9) j++;
    const count = j - i + 1;
    const sum = p.slice(i, j + 1).reduce((a, x) => a + x, 0);
    if (count >= 5 && sum > best.pct) best = { pct: Math.round(sum * 100) / 100, count };
  }
  return best;
}
