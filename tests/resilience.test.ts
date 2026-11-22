import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKV, setKV } from "@/lib/kv";
import { SourceError } from "@/lib/sources/http";
import { BACKOFF_MS, isTransient, withRetry } from "@/lib/sources/retry";
import { fillFromStale, mergeGood, STALE_MAX_MS } from "@/lib/stale";
import { addPoint, historyMetrics, liquidityChange, recordLiquidity, type LiqPoint } from "@/lib/history";
import { advanceReplay, applyTransferLogs, newReplayState, rankHolders, toRecord } from "@/lib/onchain/replay";
import { deployerStats, findCreation } from "@/lib/onchain/creation";
import { addressTopic, TRANSFER_TOPIC, ZERO_TOPIC, type Rpc, type RpcLog } from "@/lib/onchain/rpc";
import { deriveMetrics, emptySnapshot, mergeSnapshots } from "@/lib/snapshot";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { hoodscan } from "@/lib/sources/hoodscan";

const H = 3_600_000;
const noSleep = async () => {};

// ---------------------------------------------------------------------------------------------
describe("withRetry (exponential backoff)", () => {
  it("retries transient failures with 1s, 2s, 4s backoff and returns the eventual success", async () => {
    const delays: number[] = [];
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 4) throw new SourceError("HTTP 503: trade index is busy", 503);
        return "ok";
      },
      { sleep: async (ms) => void delays.push(ms) },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(4);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it("gives up after 4 retries (1s, 2s, 4s, 8s) and rethrows", async () => {
    const delays: number[] = [];
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new SourceError("trade index is busy", 503);
        },
        { sleep: async (ms) => void delays.push(ms) },
      ),
    ).rejects.toThrow(/busy/);
    expect(calls).toBe(5);
    expect(delays).toEqual(BACKOFF_MS);
  });

  it("does not retry non-transient errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new SourceError("HTTP 404: not found", 404);
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it("classifies timeouts, 503s and 'busy' as transient", () => {
    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    expect(isTransient(timeout)).toBe(true);
    expect(isTransient(new SourceError("x", 503))).toBe(true);
    expect(isTransient(new Error("the trade index is busy, try again"))).toBe(true);
    expect(isTransient(new Error("invalid address"))).toBe(false);
  });

  it("stops retrying when the next backoff would pass the deadline", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new SourceError("busy", 503);
        },
        { sleep: noSleep, deadline: Date.now() + 1500 },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(2); // the 1s backoff fits before the deadline, the 2s one does not
  });
});

// ---------------------------------------------------------------------------------------------
describe("stale snapshot fallback", () => {
  const t0 = Date.UTC(2026, 9, 23, 12);

  it("fills missing fields from the last good values and reports their age", () => {
    const stored = mergeGood(null, { buyers24h: 370, sellers24h: 648, earlyExitRatePct: 30 }, t0);
    const fill = fillFromStale({ buyers24h: null, sellers24h: null, earlyExitRatePct: null }, stored, t0 + 12 * 60_000);
    expect(fill.data.buyers24h).toBe(370);
    expect(fill.staleFields).toEqual({ buyers24h: 12, sellers24h: 12, earlyExitRatePct: 12 });
    expect(fill.oldestMinutes).toBe(12);
  });

  it("never uses values older than 6 hours", () => {
    const stored = mergeGood(null, { buyers24h: 370 }, t0);
    expect(fillFromStale({}, stored, t0 + 5.9 * H).data.buyers24h).toBe(370);
    const expired = fillFromStale({}, stored, t0 + STALE_MAX_MS + 60_000);
    expect(expired.data.buyers24h).toBeUndefined();
    expect(expired.staleFields).toEqual({});
  });

  it("keeps live values and only fills allowed fields", () => {
    const stored = mergeGood(null, { buyers24h: 1, washFlag: true }, t0);
    const fill = fillFromStale({ buyers24h: 99, washFlag: null }, stored, t0 + 60_000, new Set(["buyers24h"]));
    expect(fill.data.buyers24h).toBe(99); // live wins
    expect(fill.data.washFlag).toBeNull(); // not allowed: its producing call succeeded
    expect(fill.staleFields).toEqual({});
  });

  it("per-field timestamps survive partial updates", () => {
    const a = mergeGood(null, { buyers24h: 1, earlyExitRatePct: 20 }, t0);
    const b = mergeGood(a, { buyers24h: 2 }, t0 + H);
    expect(b.fields.buyers24h).toEqual({ v: 2, at: t0 + H });
    expect(b.fields.earlyExitRatePct.at).toBe(t0);
  });
});

// ---------------------------------------------------------------------------------------------
const TOKEN = "0x" + "d".repeat(40);
const LAUNCHPAD = "0x" + "1".repeat(40);
const POOL = "0x" + "2".repeat(40);
const W = (i: number) => "0x" + i.toString(16).padStart(40, "a");
const E18 = 10n ** 18n;

function transfer(from: string, to: string, amount: bigint, block: number): RpcLog {
  return {
    address: TOKEN,
    topics: [TRANSFER_TOPIC, from === "0x0" ? ZERO_TOPIC : addressTopic(from), addressTopic(to)],
    data: "0x" + amount.toString(16),
    blockNumber: "0x" + block.toString(16),
    transactionHash: "0x" + block.toString(16).padStart(64, "0"),
    logIndex: "0x0",
  };
}

/** Launch: 1B minted to the launchpad, 600M seeded into a pool, wallets buy from the pool. */
const LOGS: RpcLog[] = [
  transfer("0x0", LAUNCHPAD, 1_000_000_000n * E18, 100),
  transfer(LAUNCHPAD, POOL, 600_000_000n * E18, 101),
  ...Array.from({ length: 12 }, (_, i) => transfer(POOL, W(i + 1), BigInt(10 + i) * 1_000_000n * E18, 200 + i * 10)),
  transfer(W(1), POOL, 5_000_000n * E18, 400), // wallet 1 sells half
];

describe("holder replay from Transfer logs", () => {
  it("rebuilds balances exactly", () => {
    const m = new Map<string, bigint>();
    expect(applyTransferLogs(m, LOGS)).toBe(LOGS.length);
    expect(m.get(LAUNCHPAD)).toBe(400_000_000n * E18);
    expect(m.get(W(1))).toBe(5_000_000n * E18);
    const total = [...m.values()].reduce((a, b) => a + b, 0n);
    expect(total).toBe(1_000_000_000n * E18); // supply conserved
  });

  it("ignores ERC-721-style transfers (4 topics)", () => {
    const m = new Map<string, bigint>();
    const nft = { ...transfer(W(1), W(2), 1n, 1), topics: [...transfer(W(1), W(2), 1n, 1).topics, "0x01"] };
    expect(applyTransferLogs(m, [nft])).toBe(0);
  });

  it("top-10 excludes pool / contract addresses and reports them as liquidity-held", () => {
    const m = new Map<string, bigint>();
    applyTransferLogs(m, LOGS);
    const { top, count } = rankHolders(toRecord(m), 60);
    expect(count).toBe(14); // launchpad + pool + 12 wallets
    const supply = 1_000_000_000;
    const holders = top.map((h) => ({
      address: h.address,
      qty: Number(h.raw / E18),
      pct: null,
      buys: null,
      sells: null,
      isContract: h.address === LAUNCHPAD ? true : null, // eth_getCode says big contract
      kind: h.address === LAUNCHPAD ? ("liquidity" as const) : ("wallet" as const),
    }));
    const snap = deriveMetrics({
      ...mergeSnapshots(emptySnapshot("robinhood", TOKEN), [{ poolAddresses: [POOL] }]),
      totalSupply: supply,
      holders,
    });
    expect(snap.holders.map((h) => h.address)).not.toContain(POOL);
    expect(snap.holders.map((h) => h.address)).not.toContain(LAUNCHPAD);
    expect(snap.liquidityHolders.map((h) => h.address).sort()).toEqual([LAUNCHPAD, POOL].sort());
    // Top-10 wallets: 21M..12M minus wallet 1's sale → (12+…+21)M = 165M ⇒ 16.5%
    expect(snap.top10SharePct).toBeCloseTo(16.5, 5);
    expect(snap.top1SharePct).toBeCloseTo(2.1, 5);
    expect(snap.liquidityHeldPct).toBeGreaterThan(70);
  });

  it("advances in adaptive chunks, shrinking when the RPC rejects a range, and resumes", async () => {
    let calls = 0;
    const rpc: Rpc = async <T,>(method: string, params: unknown[]) => {
      calls++;
      const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
      const f = Number(fromBlock);
      const t = Number(toBlock);
      if (t - f > 150) throw new Error("query exceeds limit of 10000"); // forces chunk shrinking
      return LOGS.filter((l) => Number(l.blockNumber) >= f && Number(l.blockNumber) <= t) as T;
    };
    let state = newReplayState(TOKEN, 100);
    state.chunk = 1000;
    state = await advanceReplay(rpc, state, 500, { budgetMs: 10_000, sleep: noSleep, minChunk: 10 });
    expect(state.complete).toBe(true);
    expect(state.scannedTo).toBe(500);
    expect(state.logCount).toBe(LOGS.length);
    expect(BigInt(state.balances[W(12)])).toBe(21_000_000n * E18);
    expect(calls).toBeGreaterThan(3);
  });

  it("backs off on HTTP 429 instead of failing", async () => {
    let first = true;
    const sleeps: number[] = [];
    const rpc: Rpc = async <T,>(_m: string, params: unknown[]) => {
      if (first) {
        first = false;
        throw new Error("RPC HTTP 429");
      }
      const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
      return LOGS.filter((l) => Number(l.blockNumber) >= Number(fromBlock) && Number(l.blockNumber) <= Number(toBlock)) as T;
    };
    const s = await advanceReplay(rpc, newReplayState(TOKEN, 100), 500, { budgetMs: 60_000, sleep: async (ms) => void sleeps.push(ms) });
    expect(s.complete).toBe(true);
    expect(sleeps).toEqual([1000]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("deployer detection", () => {
  const DEPLOYER = "0x" + "9".repeat(40);

  it("takes the sender of the earliest mint transaction across 10M-block windows", async () => {
    const mintA = transfer("0x0", LAUNCHPAD, 1n, 47_404_695);
    const mintLater = transfer("0x0", W(1), 1n, 60_000_000);
    const rpc: Rpc = async <T,>(method: string, params: unknown[]) => {
      if (method === "eth_getLogs") {
        const { fromBlock, toBlock, topics } = params[0] as { fromBlock: string; toBlock: string; topics: string[] };
        expect(topics[1]).toBe(ZERO_TOPIC);
        expect(Number(toBlock) - Number(fromBlock)).toBeLessThan(10_000_000);
        return [mintA, mintLater].filter((l) => Number(l.blockNumber) >= Number(fromBlock) && Number(l.blockNumber) <= Number(toBlock)) as T;
      }
      if (method === "eth_getTransactionByHash") {
        expect(params[0]).toBe(mintA.transactionHash);
        return { from: DEPLOYER.toUpperCase().replace("0X", "0x") } as T;
      }
      throw new Error(`unexpected ${method}`);
    };
    const c = await findCreation(rpc, TOKEN, 96_000_000);
    expect(c).toEqual({ creationBlock: 47_404_695, mintTx: mintA.transactionHash, mintedTo: LAUNCHPAD, deployer: DEPLOYER });
  });

  it("returns null when the token has no mint", async () => {
    const rpc: Rpc = async <T,>() => [] as T;
    expect(await findCreation(rpc, TOKEN, 25_000_000)).toBeNull();
  });

  it("computes deployer holding and the share it sold into pools", async () => {
    const logs = [
      transfer(LAUNCHPAD, DEPLOYER, 100n * E18, 150),
      transfer(DEPLOYER, POOL, 60n * E18, 300),
      transfer(DEPLOYER, W(3), 10n * E18, 310),
    ];
    const rpc: Rpc = async <T,>(method: string, params: unknown[]) => {
      if (method === "eth_getLogs") {
        const { topics } = params[0] as { topics: (string | null)[] };
        const dTopic = addressTopic(DEPLOYER);
        return logs.filter((l) => (topics[1] ? l.topics[1] === topics[1] : true) && (topics[2] ? l.topics[2] === topics[2] : true) && (topics[1] === dTopic || topics[2] === dTopic)) as T;
      }
      if (method === "eth_getCode") return ((params[0] as string) === POOL ? "0x" + "60".repeat(500) : "0x") as T;
      if (method === "eth_call") return ("0x" + (30n * E18).toString(16)) as T;
      throw new Error(method);
    };
    const d = await deployerStats(rpc, TOKEN, DEPLOYER, 100, 1000, 1000n * E18);
    expect(d.received).toBe(100n * E18);
    expect(d.sentToContracts).toBe(60n * E18);
    expect(d.sentToWallets).toBe(10n * E18);
    expect(d.soldPct).toBe(60);
    expect(d.holdingPct).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
describe("liquidity history", () => {
  const t0 = Date.UTC(2026, 9, 1);

  it("needs at least two observations", () => {
    expect(liquidityChange([{ t: t0, liq: 100 }], 24 * H, "24h")).toBeNull();
    expect(historyMetrics([{ t: t0, liq: 100 }])).toMatchObject({ liqHistoryPoints: 1, liqChange24hPct: null });
  });

  it("measures change against the newest point at least one window old", () => {
    const pts: LiqPoint[] = [
      { t: t0, liq: 200 },
      { t: t0 + 20 * H, liq: 150 },
      { t: t0 + 26 * H, liq: 120 },
      { t: t0 + 48 * H, liq: 90 },
    ];
    const d = liquidityChange(pts, 24 * H, "24h")!;
    expect(d.window).toBe("24h");
    expect(d.pct).toBeCloseTo(-40); // vs 150 at t0+20h (28h earlier)
  });

  // Replaced (2026-11-19): a 3h history used to be scored as the 7d change ("3.0h of history"); production showed
  // "+5.5% over 9m of history" taking full 7d points. Under half the window is not a measurement of it: null.
  it("labels short histories honestly, and refuses one under half the window (or half the token's life)", () => {
    const short: LiqPoint[] = [
      { t: t0, liq: 100 },
      { t: t0 + 3 * H, liq: 50 },
    ];
    expect(liquidityChange(short, 7 * 24 * H, "7d")).toBeNull();
    expect(historyMetrics(short).nullReasons.liqChange7dPct).toMatch(/only 3\.0h of liquidity history — a 7d change needs ≥ 84h/);
    const fourDays: LiqPoint[] = [
      { t: t0, liq: 100 },
      { t: t0 + 96 * H, liq: 50 },
    ];
    const d = liquidityChange(fourDays, 7 * 24 * H, "7d")!;
    expect(d.pct).toBeCloseTo(-50);
    expect(d.window).toBe("96h of history");
    // A 4h-old token observed for 3h: its whole life is covered, so the 24h change is a measurement.
    const young = liquidityChange(short, 24 * H, "24h", 4 * H)!;
    expect(young.pct).toBeCloseTo(-50);
    expect(young.window).toBe("3.0h of history");
  });

  it("spaces observations and persists them in KV", async () => {
    setKV(new MemoryKV());
    await recordLiquidity("robinhood", TOKEN, 100, t0);
    await recordLiquidity("robinhood", TOKEN, 90, t0 + 10_000); // < 60s apart → replaces
    const pts = await recordLiquidity("robinhood", TOKEN, 50, t0 + 2 * H);
    expect(pts).toEqual([
      { t: t0 + 10_000, liq: 90 },
      { t: t0 + 2 * H, liq: 50 },
    ]);
    expect(addPoint(pts, { t: t0 + 40 * 24 * H, liq: 1 })).toHaveLength(1); // >30d old points pruned
    setKV(null);
  });

  it("a >40% 7d drop triggers the liquidity-drain penalty", () => {
    const pts: LiqPoint[] = [
      { t: t0, liq: 1000 },
      { t: t0 + 7 * 24 * H, liq: 500 },
    ];
    const snap = { ...emptySnapshot("robinhood", TOKEN), ...historyMetrics(pts) };
    const r = scoreSnapshot(snap);
    expect(r.penalties.map((p) => p.id)).toContain("liq_drain");
  });
});

// ---------------------------------------------------------------------------------------------
describe("HoodScan outage → stale holder data (simulated 503)", () => {
  const A = "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725";
  const holders = [
    { trader: W(1), qty: 13_879_043, buys: 28, sells: 0 },
    { trader: W(2), qty: 11_966_333, buys: 353, sells: 0 },
    { trader: W(3), qty: 11_135_728, buys: 361, sells: 0 },
    { trader: W(4), qty: 3_664_304, buys: 15, sells: 14 },
  ];
  let mode: "up" | "down" = "up";

  beforeEach(() => {
    setKV(new MemoryKV());
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (mode === "down") return new Response("trade index is busy", { status: 503 });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/mcp")) {
        const { id, params } = JSON.parse(String(init?.body));
        const sc =
          params.name === "get_token"
            ? { identity: { symbol: "microduck", name: "microduck" }, market: { priceUsd: 0.004, topHolders: holders, h24: { buyUsd: 260, sellUsd: 188, buyers: 370, sellers: 648 }, d7: { buyUsd: 1, sellUsd: 1 } } }
            : { item: { metrics: { netFlowRatio: 0.17 }, risk: { suspicious: false, flags: [] } }, confidence: { features: { earlyExitRate: 0.3, earlyCohort: 20, oneTradeWalletShare: 0.66, tradesPerWallet: 2.7 } } };
        return json({ jsonrpc: "2.0", id, result: { structuredContent: sc } });
      }
      if (url.includes("/swaps-api/trades")) return json({ items: [] });
      if (url.includes("/swaps-api/token/")) return json({ available: true, holders, buyers24: 370, sellers24: 648 });
      throw new Error(`unmocked ${url}`);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setKV(null);
    mode = "up";
  });

  it("serves holder data from the last good snapshot, marked stale, and still scores it", async () => {
    const t0 = Date.now();
    const live = await hoodscan(A, { sleep: noSleep, now: () => t0 });
    expect(live.status.state).toBe("ok");

    mode = "down";
    const res = await hoodscan(A, { sleep: noSleep, now: () => t0 + 25 * 60_000 });
    expect(res.status.state).toBe("stale");
    expect(res.status.message).toMatch(/^stale \(25m old\)/);
    expect(res.data.swapHolders).toHaveLength(4);
    expect(res.data.staleFields).toMatchObject({ swapHolders: 25, earlyExitRatePct: 25, buyers24h: 25 });

    const snap = deriveMetrics({ ...mergeSnapshots(emptySnapshot("robinhood", A), [res.data]), totalSupply: 1_000_000_000 });
    const report = scoreSnapshot(snap, [res.status]);
    const holdersGroup = report.groups.find((g) => g.id === "holders")!;
    expect(holdersGroup.hasData).toBe(true);
    // The 0-sell accumulators are an input to Holder Strength now (no factor of their own): the metric itself is stale.
    expect(snap.accumulatorCount).toBe(3);
    expect(snap.staleFields.accumulatorCount).toBe(25);
    expect(holdersGroup.factors.find((f) => f.id === "accumulator_count")).toBeUndefined();
    expect(holdersGroup.factors.find((f) => f.id === "early_retention")!.stale).toBe("25m");
    // stale-but-present counts toward coverage
    expect(report.coveragePct).toBeGreaterThan(0);
  });

  it("retries each call with backoff before falling back", async () => {
    const sleeps: number[] = [];
    mode = "down";
    await expect(hoodscan(A, { sleep: async (ms) => void sleeps.push(ms) })).rejects.toThrow(/503/);
    // 4 calls × backoff 1,2,4,8s
    expect(sleeps.filter((s) => s === 1000)).toHaveLength(4);
    expect(sleeps.filter((s) => s === 8000)).toHaveLength(4);
  });

  it("does not use a snapshot older than 6 hours", async () => {
    const t0 = Date.now();
    await hoodscan(A, { sleep: noSleep, now: () => t0 });
    mode = "down";
    await expect(hoodscan(A, { sleep: noSleep, now: () => t0 + 6 * H + 60_000 })).rejects.toThrow();
  });

  it("the simulateDown switch behaves like a real 503", async () => {
    const t0 = Date.now();
    await hoodscan(A, { sleep: noSleep, now: () => t0 });
    const res = await hoodscan(A, { sleep: noSleep, simulateDown: true, now: () => t0 + 60_000 });
    expect(res.status.state).toBe("stale");
    expect(res.data.swapHolders?.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------
describe("last-good fallback for every other adapter (no outage-driven tier flips)", () => {
  it("a failed ScanHood call reuses the last good sellability, labelled stale", async () => {
    const { withLastGood } = await import("@/lib/analyze");
    setKV(new MemoryKV());
    const ok = { status: { id: "scanhood", label: "ScanHood", state: "ok" as const }, data: { sellable: true, roundTripLossPct: 2 } };
    await withLastGood("scanhood", "robinhood", TOKEN, ok);
    const failed = { status: { id: "scanhood", label: "ScanHood", state: "failed" as const, message: "Timed out" }, data: {} };
    const res = await withLastGood("scanhood", "robinhood", TOKEN, failed);
    expect(res.status.state).toBe("stale");
    expect(res.status.message).toMatch(/^stale \(0m old\) for 2 fields — live call failed: Timed out/);
    expect(res.data.sellable).toBe(true);
    expect(res.data.staleFields).toEqual({ sellable: 0, roundTripLossPct: 0 });
    setKV(null);
  });

  it("without a prior good snapshot the failure stays a failure", async () => {
    const { withLastGood } = await import("@/lib/analyze");
    setKV(new MemoryKV());
    const failed = { status: { id: "rugcheck", label: "RugCheck", state: "failed" as const, message: "HTTP 500" }, data: {} };
    expect((await withLastGood("rugcheck", "solana", "x", failed)).status.state).toBe("failed");
    setKV(null);
  });
});
