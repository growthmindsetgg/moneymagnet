export type Chain = "robinhood" | "solana" | "base" | "monad";

export type SourceState = "ok" | "partial" | "stale" | "failed" | "skipped";

export interface SourceStatus {
  id: string;
  label: string;
  state: SourceState;
  message?: string;
  ms?: number;
  url?: string;
  /** Cross-source verification findings, e.g. "API stale/wrong: liquidityUsd $1.2M vs on-chain $310k". */
  flags?: string[];
}

/** One source's reading of one metric. */
export interface Provenance {
  source: string;
  label: string;
  value: number | boolean | string | null;
  fetchedAt: string;
  /** Read from the chain itself (RPC / Helius) rather than an indexer API. */
  onchain: boolean;
  stale?: boolean;
}

export type VerificationStatus = "verified" | "single" | "disputed";

export interface MetricVerification {
  metric: string;
  label: string;
  kind: "number" | "boolean" | "address";
  status: VerificationStatus;
  values: Provenance[];
  /** The value scored: on-chain truth when present, else the most conservative reading. */
  chosen: number | boolean | string | null;
  chosenSource: string | null;
  /** How the value was picked, e.g. "on-chain wins" or "most conservative (lowest liquidity)". */
  resolution: string;
  /** Sources whose value disagreed with the on-chain truth. */
  wrongSources: string[];
}

export interface VerificationSummary {
  verified: number;
  single: number;
  disputed: number;
  metrics: MetricVerification[];
}

/**
 * Normalized token data. Every metric is nullable: null means "not known",
 * never zero. Scoring treats null as missing data (neutral), not as a flaw.
 */
export interface TokenSnapshot {
  chain: Chain;
  address: string;
  name: string | null;
  symbol: string | null;
  launchpad: string | null;
  anchor: string | null;
  /** HoodScan's classification ("meme", "stock", …) — used by the meme-only filter. */
  assetKind: string | null;
  /** false when the chain says there is no token here (no mint account / no contract code). */
  tokenExists: boolean | null;

  // Market
  priceUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  poolCount: number | null;
  mainPoolLiquidityUsd: number | null;
  mainPoolSharePct: number | null;
  liqFdvPct: number | null;
  liqChange24hPct: number | null;
  liqChange7dPct: number | null;
  /** Human-readable span the 24h/7d change was measured over, e.g. "24h" or "3.2h of history". */
  liqChange24hWindow: string | null;
  liqChange7dWindow: string | null;
  /** Number of stored liquidity observations for this token. */
  liqHistoryPoints: number | null;
  /** Sum of reserves across every known pool — the series stored for liquidity history. */
  liquidityTotalUsd: number | null;
  /** Pool / pair addresses from market sources, used to tell liquidity-held tokens from wallets. */
  poolAddresses: string[];
  createdAt: string | null;
  ageHours: number | null;
  /** Age in minutes (derived from ageHours) — used by the too-early rule. */
  ageMinutes: number | null;
  totalSupply: number | null;

  // Holder conviction
  holderCount: number | null;
  top10SharePct: number | null;
  top1SharePct: number | null;
  accumulatorCount: number | null;
  accumulatorSupplyPct: number | null;
  earlyCohortSize: number | null;
  earlyExitRatePct: number | null;
  earlyRetentionPct: number | null;
  deployerAddress: string | null;
  deployerHoldingPct: number | null;
  deployerSoldPct: number | null;
  deployerHasSold: boolean | null;
  /** Deployer tokens handed out by transfer (wallets, non-pool contracts) — shown, not penalised. */
  deployerDistributedPct: number | null;
  insiderNetworks: number | null;
  /** On-chain balances (Transfer-log replay) when available, else swap-index holders. */
  holders: HolderRow[];
  /** HoodScan swap-index holders with buy/sell counts (drives the accumulator factors). */
  swapHolders: HolderRow[];
  /** Pools, routers and other large contracts holding supply — shown separately, excluded from concentration. */
  liquidityHolders: HolderRow[];
  liquidityHeldPct: number | null;
  holderSource: "onchain" | "swap-index" | "rugcheck" | "helius" | "goplus" | null;
  /** The top-5 non-LP holders, each classified (wallet / founder / treasury multisig / vesting / locker / staking / unclassified contract). */
  holderClasses: HolderClassRow[];
  /** The largest holder counted in the top-holder rule, with its classification (null when no holder list). */
  largestHolder: HolderClassRow | null;
  /** Largest holder is the deployer, the token is ≥ 30 days old and that wallet never sold nor sent to a pool/router (whole history). */
  founderNeverSold: boolean | null;
  /** Largest holder is the deployer and that wallet has sold (a swap, or a transfer into a pool/router). */
  founderSold: boolean | null;
  /** Days the founder wallet has held (since its first receipt, else token age). */
  founderHoldDays: number | null;
  /** Metric name → age in minutes, for values served from the last good snapshot. */
  staleFields: Record<string, number>;

  // Flow & volume
  netFlowRatio24h: number | null;
  netFlowUsd24h: number | null;
  netFlowRatio7d: number | null;
  flowConsistent: boolean | null;
  buyers24h: number | null;
  sellers24h: number | null;
  buyerSellerRatio: number | null;
  singleTradeWalletSharePct: number | null;
  tradesPerWallet: number | null;
  smartMoneyNetUsd: number | null;
  smartBuyers: number | null;
  volLiqRatio: number | null;
  repeatedSizeSharePct: number | null;
  bundleSharePct: number | null;
  washFlag: boolean | null;

  // Contract safety
  honeypot: boolean | null;
  sellable: boolean | null;
  /** The traded pool's liquidity was removed (nothing to sell into). */
  liquidityPulled: boolean | null;
  /** pump.fun curve holds 0 SOL and the token never graduated (no AMM pool) — a dead launch. */
  deadCurve: boolean | null;
  /** §7c dead launch: age ≥ 1h and (≤ 2 buyers, < $100 liquidity, or a dead curve). */
  deadLaunch: boolean | null;
  /** Hours since the newest trade (HoodScan swaps exactly; DexScreener 6h/24h tx counts as a lower bound). */
  lastTradeHoursAgo: number | null;
  /** Buyer count quoted by the dead-launch evidence (lifetime unique buyers, else 24h buyers). */
  launchBuyers: number | null;
  /** Set when a source answered and activity is genuinely zero: what each source reported. */
  zeroActivity: string[];
  roundTripLossPct: number | null;
  mintAuthority: boolean | null;
  freezeAuthority: boolean | null;
  verified: boolean | null;
  ownerRenounced: boolean | null;
  upgradeable: boolean | null;
  lpLockedPct: number | null;

  // Launch mechanics & guide rules
  isLaunchpad: boolean | null;
  /** 24h volume / market cap. */
  volMcRatio: number | null;
  /** Age-adjusted VOL/MC bar from the guide (p.25): <6h 1.5, <24h 1.2, <72h 1.0, else 0.8. */
  volMcBar: number | null;
  /** volMcRatio / volMcBar — 1.0 means the bar is met exactly. */
  volMcVsBar: number | null;
  feesSol: number | null;
  feesPerMcap15k: number | null;
  snipeRatioPct: number | null;
  /** Which observation the feed-sourced launch metrics describe. */
  feedWindow: string | null;
  bundleScore: number | null;
  organicScore: number | null;
  timingEntropy: number | null;
  devBuySol: number | null;
  devBuySharePct: number | null;
  freshWalletsTop20: number | null;
  fundingClusterMax: number | null;
  clusterSupplyPct: number | null;
  bundlerMajority: boolean | null;
  makersCount: number | null;
  makersHoldersRatio: number | null;
  creatorPriorMints: number | null;
  creatorRugRatePct: number | null;
  creatorHasSocials: boolean | null;
  socialLinks: string | null;
  curveProgressPct: number | null;
  realSolReserves: number | null;
  /** Share of total supply outside the pump.fun curve (bought and not sold back), from curve reserves. */
  curveCirculatingPct: number | null;
  uniqueBuyers: number | null;
  sells24h: number | null;
  /** DexScreener 24h buy / sell transaction counts (not unique wallets). */
  buyTxs24h: number | null;
  sellTxs24h: number | null;
  /** What the buyer/seller counts are: unique wallets, or tx counts. */
  buyersBasis: string | null;
  allBuyersExited: boolean | null;
  insiderSupplyPct: number | null;
  first5mSharePct: number | null;
  launchPriceUsd: number | null;
  bundlersFlushed: boolean | null;

  // Chart patterns (OHLCV) — every detection is logged in `patterns` with its candle window.
  launchRetraced30: boolean | null;
  launchWindow: string | null;
  identicalCandleSharePct: number | null;
  identicalWindow: string | null;
  hugeCandlesOnly: boolean | null;
  staircase: boolean | null;
  staircaseWindow: string | null;
  trendScore: number | null;
  trendWindow: string | null;
  brokeHigherLow: boolean | null;
  upOnlyChart: boolean | null;
  honeypotPattern: boolean | null;
  patterns: PatternDetection[];

  // Time Machine (information; its score effect is a factors.json rule)
  /** Best similarity (0–100) to a winner archetype at the same age bucket. */
  tmWinnerSimilarity: number | null;
  /** Best similarity (0–100) to a rug archetype at the same age bucket. */
  tmRugSimilarity: number | null;

  /** Metric → exact reason it is null (set by adapters that know why). */
  nullReasons: Record<string, string>;
  /** Metric → every source that supplied it, with value and fetch time. */
  provenance: Record<string, Provenance[]>;

  fakeSignals: FakeSignal[];
  links: { label: string; url: string }[];
}

export interface HolderRow {
  address: string;
  qty: number | null;
  pct: number | null;
  buys: number | null;
  sells: number | null;
  isContract: boolean | null;
  label?: string;
  kind?: "wallet" | "liquidity";
}

export type HolderClass = "wallet" | "founder" | "treasury" | "vesting" | "locker" | "staking" | "contract";

export interface HolderClassRow {
  address: string;
  pct: number | null;
  class: HolderClass;
  /** e.g. "founder wallet (deployer)", "vesting contract (Hedgey)", "treasury (multisig, Safe 2/3)". */
  label: string;
  /** Counted in the top-holder / top-10 rules (wallets, founder, treasury) or excluded (vesting, lockers, staking, unclassified contracts). */
  counted: boolean;
  /** Short facts for the page line: "0 sells in 116d", "unlocks 2027-03". */
  detail: string | null;
  /** When the locked balance unlocks, when the contract exposes it (ISO). */
  unlocksAt: string | null;
  /** How the class was decided (code, signature match, calls made). */
  evidence: string;
}

export interface FakeSignal {
  kind: "wash" | "bundle" | "bot" | "insider" | "other";
  level: FlagLevel;
  text: string;
  source: string;
}

export type FlagLevel = "none" | "info" | "warn" | "danger";

/** An auditable chart-pattern detection: what was checked, on which candles, and the result. */
export interface PatternDetection {
  id: string;
  result: boolean | number | null;
  detail: string;
  timeframe: string;
  from: string | null;
  to: string | null;
  candles: number;
}

/** What an adapter hands back: a slice of the snapshot plus its own status and raw payload. */
export interface AdapterResult {
  status: SourceStatus;
  data: Partial<TokenSnapshot>;
  raw?: unknown;
  /** Fields whose producing call hit an outage (429 / 5xx / timeout) this run: served stale when a last good value exists. */
  failedFields?: string[];
}

/** U = Unrated (too little data to place in S–F). */
export type Tier = "S" | "A" | "B" | "C" | "D" | "F" | "U";

export interface FactorResult {
  /** v2.4 gate-only basics: how the check read (they carry no points). */
  basic?: "pass" | "partial" | "fail" | "unknown";
  id: string;
  label: string;
  metric: string;
  points: number;
  max: number;
  value: number | boolean | null;
  display: string;
  evidence: string;
  flag: FlagLevel;
  missing: boolean;
  applicable: boolean;
  gate: boolean;
  /** Set when the value came from a stale snapshot, e.g. "12m". */
  stale?: string;
  /** "guide" or "hoodtier". */
  source: string;
  note?: string;
  /** Labels of the adapters that can supply this metric. */
  dataSources: string[];
  status: "live" | "stale" | "null" | "n/a";
  /** For status "null": the exact reason. */
  nullReason?: string;
  /** Cross-source verification of this factor's metric. */
  verification?: { status: VerificationStatus; sources: number; resolution: string; values: Provenance[] };
}

export interface GroupResult {
  id: string;
  label: string;
  weight: number;
  points: number;
  max: number;
  available: number;
  factors: FactorResult[];
  hasData: boolean;
}

export interface PenaltyResult {
  id: string;
  label: string;
  points: number;
  evidence: string;
}

export interface GateResult {
  id: string;
  label: string;
  state: "pass" | "fail" | "unknown" | "n/a";
  evidence: string;
}

export interface RuleResult {
  id: string;
  label: string;
  source: string;
  note?: string;
  gate: boolean;
  state: "fired" | "clear" | "unknown";
  points: number;
  capTier?: Tier;
  forceF?: boolean;
  forceU?: boolean;
  overridesGates?: boolean;
  flag?: string;
  evidence: string;
}

export interface RequirementResult {
  id: string;
  label: string;
  tier: "S" | "A";
  state: "pass" | "fail" | "unknown";
  evidence: string;
}

export interface ScoreReport {
  chain: Chain;
  address: string;
  tier: Tier;
  /** Displayed score, clamped into the final tier band. Null when Unrated. */
  score: number | null;
  rawScore: number;
  coveragePct: number;
  mode: "launch" | "established";
  modeLabel: string;
  rules: RuleResult[];
  manualChecks: { id: string; text: string; note: string }[];
  verdict: string;
  tierReason: string;
  /** The single binding constraint behind the tier (gate, cap, coverage, requirement or plain score). */
  binding?: { kind: "coverage" | "gate" | "too-early" | "cap" | "requirement" | "score" | "held"; text: string };
  /** Set when the tier is held from the last complete run because a source is down (lib/hold.ts). */
  hold?: import("./hold").TierHold;
  penalties: PenaltyResult[];
  /** Bonus rules that fired (track record, Time Machine) — points are positive here. */
  bonuses: PenaltyResult[];
  gates: GateResult[];
  requirements: RequirementResult[];
  groups: GroupResult[];
  fakeSignals: FakeSignal[];
  sourceStatus: SourceStatus[];
  verification: VerificationSummary;
  token: TokenSnapshot;
  generatedAt: string;
  raw?: Record<string, unknown>;
  /** Same-age comparison with the archetype library (absent when not computed). */
  timeMachine?: import("./timemachine").TimeMachineResult;
  /** SOCIAL panel (information only — no score effect). Absent when the social sources did not finish in time. */
  social?: import("./social").SocialPanel;
  /** Meme-only filter: non-memes are refused with the reason. */
  eligibility?: import("./memeFilter").Eligibility;
}
