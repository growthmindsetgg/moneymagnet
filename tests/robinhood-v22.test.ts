import { describe, expect, it } from "vitest";
import { deployerStats } from "@/lib/onchain/creation";
import { addressTopic, TRANSFER_TOPIC, type Rpc, type RpcLog } from "@/lib/onchain/rpc";
import { infraEntry, isInfrastructure, launchpadOfFactory } from "@/lib/onchain/infra";
import { describeRevert, encodeQuote } from "@/lib/sources/robinhoodSim";
import { buildCandles, hugeCandles, type HsSwap } from "@/lib/sources/hoodscanCandles";
import { defaultConfig, setFor } from "@/lib/scoring/config";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { deriveMetrics } from "@/lib/snapshot";
import { perfectLaunch } from "./helpers";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const POSITION_MANAGER = "0x58daec3116aae6d93017baaea7749052e8a04fa7";
const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
const TOKEN = "0x" + "a".repeat(40);
const DEPLOYER = "0x" + "d".repeat(40);
const E18 = 10n ** 18n;
let n = 0;
const log = (from: string, to: string, v: bigint, tx: string, block = 100): RpcLog => ({
  address: TOKEN,
  topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to)],
  data: "0x" + v.toString(16),
  blockNumber: "0x" + block.toString(16),
  transactionHash: tx,
  logIndex: "0x" + (n++).toString(16),
});

describe("Robinhood infrastructure registry", () => {
  it("classifies the v4 PoolManager, PositionManager and routers as infrastructure, never holders", () => {
    for (const a of [POOL_MANAGER, POSITION_MANAGER, UNIVERSAL_ROUTER]) expect(isInfrastructure(a, "wallet")).toBe(true);
    expect(infraEntry(POOL_MANAGER)?.role).toBe("v4-pool-manager");
    expect(isInfrastructure("0x" + "1".repeat(40), "wallet")).toBe(false);
    expect(isInfrastructure("0x" + "1".repeat(40), "contract")).toBe(true);
  });

  it("detects the launchpad from the creation tx factory, not an indexer label", () => {
    expect(launchpadOfFactory("0xe33e9e479df8802cb0866d5d05258bec4cf62948")).toBe("Pons");
    expect(launchpadOfFactory("0x1eef016f22a943abc7dd11422edee9d235942104")).toBe("LONG");
    expect(launchpadOfFactory(null)).toBeNull(); // direct contract-creation tx
    expect(launchpadOfFactory(UNIVERSAL_ROUTER)).toBeNull(); // infrastructure, but not a launchpad
  });
});

describe("deployer sold excludes LP seeding", () => {
  // YMB-shaped history: mint 1e9 to the deployer, the whole supply sent to the PoolManager in a
  // PositionManager tx (LP seeding), later a real sell of 10 through the Universal Router.
  const logs = [
    log("0x0000000000000000000000000000000000000000", DEPLOYER, 1_000_000_000n * E18, "0xmint"),
    log(DEPLOYER, POOL_MANAGER, 1_000_000_000n * E18, "0xseed", 200),
    log(POOL_MANAGER, DEPLOYER, 100n * E18, "0xbuy", 300),
    log(DEPLOYER, POOL_MANAGER, 10n * E18, "0xsell", 400),
  ];
  const rpc: Rpc = async <T,>(method: string, params: unknown[]) => {
    if (method === "eth_getLogs") {
      const { topics } = params[0] as { topics: (string | null)[] };
      return logs.filter((l) => (topics[1] ? l.topics[1] === topics[1] : true) && (topics[2] ? l.topics[2] === topics[2] : true)) as T;
    }
    if (method === "eth_getCode") return ((params[0] as string) === POOL_MANAGER ? "0x" + "60".repeat(500) : "0x") as T;
    if (method === "eth_call") return ("0x" + (90n * E18).toString(16)) as T;
    if (method === "eth_getTransactionByHash") {
      const h = params[0] as string;
      return (h === "0xseed" ? { to: POSITION_MANAGER, input: "0xac9650d8" } : { to: UNIVERSAL_ROUTER, input: "0x3593564c" }) as T;
    }
    throw new Error(method);
  };

  it("counts the LP-seeding transfer as liquidity, not a sale", async () => {
    const d = await deployerStats(rpc, TOKEN, DEPLOYER, 100, 1000, 1_000_000_000n * E18, { creationTx: "0xmint", infraHeldRaw: 999_999_900n * E18 });
    expect(d.lpSeeded).toBe(1_000_000_000n * E18);
    expect(d.sentToContracts).toBe(10n * E18); // only the real sell
    // received 1e9+100, seeded 1e9 → 100 sellable, 10 sold → 10%
    expect(d.soldPct).toBe(10);
  });

  it("measures holding against supply outside infrastructure", async () => {
    const d = await deployerStats(rpc, TOKEN, DEPLOYER, 100, 1000, 1_000_000_000n * E18, { creationTx: "0xmint", infraHeldRaw: 999_999_000n * E18 });
    // balance 90 of a circulating 1,000
    expect(d.holdingPct).toBe(9);
  });
});

describe("v4 sell simulation encoding", () => {
  it("encodes quoteExactInputSingle with the pool key, direction, amount and empty hook data", () => {
    const data = encodeQuote({ id: "0x", manager: POOL_MANAGER, currency0: "0x0000000000000000000000000000000000000000", currency1: TOKEN, fee: 100, tickSpacing: -1, hooks: "0x0000000000000000000000000000000000000000" }, true, 10n ** 16n);
    const words = data.slice(10).match(/.{64}/g)!;
    expect(data.slice(0, 10)).toMatch(/^0x[0-9a-f]{8}$/);
    expect(words).toHaveLength(10);
    expect(BigInt("0x" + words[0])).toBe(32n);
    expect(words[2].endsWith("a".repeat(40))).toBe(true);
    expect(BigInt("0x" + words[3])).toBe(100n);
    expect(words[4]).toBe("f".repeat(64)); // int24 −1, two's complement
    expect(BigInt("0x" + words[6])).toBe(1n);
    expect(BigInt("0x" + words[7])).toBe(10n ** 16n);
    expect(BigInt("0x" + words[8])).toBe(256n);
  });

  it("tells a dry pool from a hook that blocks sells", () => {
    const wrapped = (inner: string) => "0x6190b2b0" + "0".repeat(62) + "20" + "0".repeat(62) + "24" + inner + "0".repeat(56);
    expect(describeRevert(wrapped("7a5ed734")).dry).toBe(true); // NotEnoughLiquidity
    const hook = describeRevert(wrapped("90bfb865"));
    expect(hook.dry).toBe(false);
    expect(hook.reason).toBe("swap reverted with 0x90bfb865"); // WrappedError from the hook
  });

  it("a pulled-liquidity token is unsellable but not labelled a honeypot contract", () => {
    const d = deriveMetrics({ ...perfectLaunch("robinhood"), sellable: false, honeypot: null, liquidityPulled: true });
    expect(d.honeypot).toBeNull();
    const r = scoreSnapshot(d);
    expect(r.tier).toBe("F");
    expect(r.rules.find((x) => x.id === "liquidity_pulled")!.state).toBe("fired");
  });
});

describe("Robinhood launch factor set", () => {
  const set = setFor(defaultConfig, "launch", "robinhood");
  const ids = set.groups.flatMap((g) => g.factors.map((f) => f.id));

  it("is chain-specific and sums to 100", () => {
    expect(set).toBe(defaultConfig.sets.launch_robinhood);
    expect(setFor(defaultConfig, "launch", "solana")).toBe(defaultConfig.sets.launch);
    expect(set.groups.reduce((a, g) => a + g.factors.reduce((b, f) => b + f.weight, 0), 0)).toBe(100);
  });

  it("has no feed- or Helius-only factors — absent, not null", () => {
    for (const id of ["snipe_ratio", "bundle_score", "organic_score", "timing_entropy", "creator_history", "insider_supply", "creator_socials", "fees_vs_mcap", "funding_cluster", "curve_progress", "mint_authority", "freeze_authority"]) expect(ids).not.toContain(id);
    const r = scoreSnapshot(perfectLaunch("robinhood"));
    expect(r.groups.flatMap((g) => g.factors).map((f) => f.id)).not.toContain("snipe_ratio");
  });

  it("uses Robinhood-native signals: same-block bundles, dev buy share, fresh wallets, repeated sizes", () => {
    for (const id of ["bundle_share", "dev_buy_share", "fresh_wallets", "repeated_size", "first5m_share", "top10_share"]) expect(ids).toContain(id);
  });

  // Replaced (§7e): U is decided by failed sources, still ahead of forcing gates.
  it("≥ 40% of weight lost to failed sources is U, even when a forcing rule would fire", () => {
    const empty = Object.fromEntries(Object.keys(perfectLaunch("robinhood")).filter((k) => !["chain", "address", "name", "symbol", "holders", "swapHolders", "liquidityHolders", "poolAddresses", "staleFields", "patterns", "nullReasons", "provenance", "fakeSignals", "links", "ageHours", "zeroActivity"].includes(k)).map((k) => [k, null]));
    const failed = ["hoodscan", "rpc", "geckoterminal", "dexscreener", "rh-launch"].map((id) => ({ id, label: id, state: "failed" as const, message: "timeout" }));
    const r = scoreSnapshot({ ...perfectLaunch("robinhood"), ...empty, sellable: false }, failed);
    expect(r.tier).toBe("U");
    expect(r.tierReason).toMatch(/sources failed: /);
    // Without failed sources the same token is rated: the forcing gate decides.
    expect(scoreSnapshot({ ...perfectLaunch("robinhood"), ...empty, sellable: false }).tier).toBe("F");
  });
});

describe("candles from HoodScan swaps", () => {
  const sw = (ts: number, usd: number, tokens: number): HsSwap => ({ ts, block: ts, trader: "0xt", side: "buy", usd, tokenIn: { address: "0xeth" }, amountIn: 0.001, tokenOut: { address: TOKEN }, amountOut: tokens });
  it("builds OHLCV with trade counts from real swaps", () => {
    const cs = buildCandles([sw(0, 10, 100), sw(30, 30, 100), sw(59, 5, 100), sw(61, 20, 100)], TOKEN, 60);
    expect(cs).toHaveLength(2);
    expect(cs[0]).toMatchObject({ t: 0, o: 0.1, h: 0.3, l: 0.05, c: 0.05, v: 45, n: 3 });
    expect(cs[1]).toMatchObject({ t: 60, n: 1 });
  });
  it("'only huge candles' is measurable once trade counts exist", () => {
    const big = Array.from({ length: 12 }, (_, i) => ({ t: i * 300, o: 1, h: 1.2, l: 1, c: 1.1 + (i % 2) * 0.05, v: 100, n: 3 }));
    expect(hugeCandles(big).value).toBe(true);
    const calm = big.map((c) => ({ ...c, c: 1.01, n: 50 }));
    expect(hugeCandles(calm).value).toBe(false);
  });
});

describe("transfer probe uses real balances", () => {
  it("skips holders whose indexer quantity is stale (zero on-chain) and probes the next one", async () => {
    const { simulateRobinhood } = await import("@/lib/sources/robinhoodSim");
    const STALE = "0x" + "5".repeat(40);
    const REAL = "0x" + "6".repeat(40);
    const calls: { from?: string; data: string }[] = [];
    const key = { id: "0x" + "1".repeat(64), manager: POOL_MANAGER, currency0: "0x0000000000000000000000000000000000000000", currency1: TOKEN, fee: 100, tickSpacing: 1, hooks: "0x0000000000000000000000000000000000000000" };
    const { setKV, MemoryKV } = await import("@/lib/kv");
    const kv = new MemoryKV();
    await kv.set(`sim:poolkey:${key.id}`, key);
    await kv.set("sim:v4quoter:mainnet", "0x" + "00".repeat(30) + "000000000004444c5dc75cb358380d2e3de08a90");
    setKV(kv);
    const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
    const rpc: Rpc = async <T,>(method: string, params: unknown[]) => {
      if (method === "eth_getStorageAt") return word(1000n) as T; // in-range liquidity
      if (method === "eth_blockNumber") return "0x10" as T; // pool discovery (v2.3): no extra pools
      // Pool discovery (v2.3): the PoolManager's Initialize log for the listed pool.
      if (method === "eth_getLogs") {
        const t = (params[0] as { topics: (string | null)[] }).topics;
        if (t[3] !== "0x" + "0".repeat(24) + TOKEN.slice(2)) return [] as T;
        return [{ topics: [t[0], key.id, "0x" + "0".repeat(64), t[3]], data: "0x" + word(100n).slice(2) + word(1n).slice(2) + "0".repeat(64) + word(0n).slice(2) + word(0n).slice(2) }] as T;
      }
      if (method === "eth_call") {
        const c = params[0] as { from?: string; to: string; data: string };
        calls.push({ from: c.from, data: c.data });
        if (c.data.startsWith("0x70a08231")) return word(c.data.endsWith(REAL.slice(2)) ? 10n ** 21n : 0n) as T; // balanceOf
        if (c.data.startsWith("0xa9059cbb")) return word(1n) as T; // transfer ok
        return (word(10n ** 18n) + "0".repeat(64)) as T; // quotes
      }
      throw new Error(method);
    };
    const r = await simulateRobinhood({ token: TOKEN, pools: [{ id: key.id, volume24hUsd: 1, reserveUsd: 1 }], holder: STALE, holders: [REAL], holderBalanceRaw: null, totalSupplyRaw: 10n ** 27n, creationBlock: 1, rpc });
    setKV(null);
    expect(r.detail).toMatch(/transfers from a holder succeed/);
    const transfers = calls.filter((c) => c.data.startsWith("0xa9059cbb"));
    expect(transfers.length).toBe(2);
    expect(transfers.every((c) => c.from === REAL)).toBe(true);
  });
});

describe("v2.3 §5 dev sold = swaps only; transfers are distribution", () => {
  const MULTISIG = "0x" + "7".repeat(40);
  const SWAP_V4 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
  const logs = [
    log("0x0000000000000000000000000000000000000000", DEPLOYER, 1000n * E18, "0xmint"),
    log(DEPLOYER, MULTISIG, 900n * E18, "0xtomultisig", 200), // a contract, but not a pool, no Swap
    log(DEPLOYER, POOL_MANAGER, 50n * E18, "0xsell", 300), // a real sale: the tx emits a v4 Swap
  ];
  const rpc: Rpc = async <T,>(method: string, params: unknown[]) => {
    if (method === "eth_getLogs") {
      const { topics } = params[0] as { topics: (string | null)[] };
      return logs.filter((l) => (topics[1] ? l.topics[1] === topics[1] : true) && (topics[2] ? l.topics[2] === topics[2] : true)) as T;
    }
    if (method === "eth_getCode") return ([POOL_MANAGER, MULTISIG].includes(params[0] as string) ? "0x" + "60".repeat(500) : "0x") as T;
    if (method === "eth_call") return ("0x" + (50n * E18).toString(16)) as T;
    if (method === "eth_getTransactionByHash") return { to: UNIVERSAL_ROUTER, input: "0x3593564c" } as T;
    if (method === "eth_getTransactionReceipt") return { logs: (params[0] as string) === "0xsell" ? [{ topics: [SWAP_V4] }] : [{ topics: [TRANSFER_TOPIC] }] } as T;
    throw new Error(method);
  };

  it("a transfer to a non-pool contract is distributed, not sold; a swap is sold", async () => {
    const d = await deployerStats(rpc, TOKEN, DEPLOYER, 100, 1000, 1000n * E18, { creationTx: "0xmint" });
    expect(d.sentToContracts).toBe(50n * E18);
    expect(d.distributed).toBe(900n * E18);
    expect(d.soldPct).toBe(5);
    expect(d.distributedPct).toBe(90);
  });
});

describe("v2.3 §1 every pool is simulated; F reasons are separated", () => {
  it("a hooked pool that fails while an unhooked pool passes is sellable with an info flag, not a honeypot", async () => {
    const { verdictOf } = await import("@/lib/sources/robinhoodSim");
    const v = verdictOf([
      { pool: "0x" + "a".repeat(64), kind: "v4", hooks: "0x1b1902e18cf94b755a2206ce84ee401c9b790144", feePct: 0.01, liquidityUsd: 72_000, result: "revert", lossPct: null, detail: "sell reverts" },
      { pool: "0x" + "b".repeat(64), kind: "v4", hooks: null, feePct: 1, liquidityUsd: 5_000, result: "pass", lossPct: 2.1, detail: "2.10% loss" },
    ]);
    expect(v.sellable).toBe(true);
    expect(v.honeypot).toBe(false);
    expect(v.roundTripLossPct).toBe(2.1);
    expect(v.info[0]).toMatch(/^hooked pool unsellable — trade via pool 0xbbbbbbbb… \(v4, no hook, fee 1%\)/);
    expect(v.detail).toMatch(/pool 0xaaaaaaaa… \(v4, hook 0x1b19…, fee 0.01%\): sell reverts/);
  });

  it("quoter-verified pools rank before pools computed from state; the best pool's loss is the factor", async () => {
    const { verdictOf } = await import("@/lib/sources/robinhoodSim");
    const v = verdictOf([
      { pool: "0x" + "c".repeat(40), kind: "v3", hooks: null, feePct: 0.01, liquidityUsd: 9_000, result: "pass", lossPct: 0.02, detail: "computed" },
      { pool: "0x" + "d".repeat(64), kind: "v4", hooks: null, feePct: 0.3, liquidityUsd: 9_000, result: "pass", lossPct: 0.6, detail: "quoted" },
    ]);
    expect(v.roundTripLossPct).toBe(0.6);
  });

  it("every pool dry ⇒ liquidity removed (never honeypot)", async () => {
    const { verdictOf } = await import("@/lib/sources/robinhoodSim");
    const v = verdictOf([{ pool: "0x" + "e".repeat(64), kind: "v4", hooks: null, feePct: 0.3, liquidityUsd: null, result: "dry", lossPct: null, detail: "0 in-range liquidity" }]);
    expect(v.liquidityPulled).toBe(true);
    expect(v.honeypot).toBe(false);
    const r = scoreSnapshot(deriveMetrics({ ...perfectLaunch("robinhood"), sellable: false, honeypot: null, liquidityPulled: true }));
    expect(r.binding?.text).toBe("gate: Liquidity removed ⇒ F");
    expect(r.rules.find((x) => x.id === "honeypot")!.state).not.toBe("fired");
  });

  it("a sell that reverts on every pool with liquidity ⇒ honeypot", async () => {
    const { verdictOf } = await import("@/lib/sources/robinhoodSim");
    const v = verdictOf([{ pool: "0x" + "f".repeat(64), kind: "v4", hooks: "0x" + "9".repeat(40), feePct: 0, liquidityUsd: 9_000, result: "revert", lossPct: null, detail: "sell reverts" }]);
    expect(v.honeypot).toBe(true);
    expect(v.detail).toMatch(/^honeypot — sell reverts on every pool with liquidity/);
    const r = scoreSnapshot(deriveMetrics({ ...perfectLaunch("robinhood"), sellable: false, honeypot: true, liquidityPulled: false }));
    expect(r.binding?.text).toBe("gate: Honeypot — cannot sell ⇒ F");
  });

  it("no trades for 12h+ ⇒ F 'dead'", () => {
    const r = scoreSnapshot({ ...perfectLaunch("robinhood"), ageHours: 40, lastTradeHoursAgo: 14 });
    expect(r.tier).toBe("F");
    expect(r.rules.find((x) => x.id === "dead_no_trades")!.evidence).toMatch(/^dead — no trades for /);
  });
});
