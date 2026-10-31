import { describe, expect, it } from "vitest";
import { deriveMetrics, emptySnapshot, mergeSnapshots } from "@/lib/snapshot";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { applyVerification, collectProvenance, summarizeVerification, verifyMetric, type SourceSlice } from "@/lib/verify";
import { VERIFIED_METRICS } from "@/lib/verify/metrics";
import type { Provenance, TokenSnapshot } from "@/lib/types";
import { perfectSnapshot } from "./helpers";

const def = (metric: string) => VERIFIED_METRICS.find((d) => d.metric === metric)!;
const reading = (source: string, value: Provenance["value"], onchain = false): Provenance => ({
  source,
  label: source,
  value,
  fetchedAt: "2026-10-24T00:00:00.000Z",
  onchain,
});

/** Runs the full collect path on synthetic slices: merge → verify → derive → score. */
function run(base: TokenSnapshot, slices: SourceSlice[]) {
  const { snapshot, flags } = applyVerification(mergeSnapshots(base, slices.map((s) => s.data)), slices);
  return { snapshot: deriveMetrics(snapshot), flags };
}
const blank = (chain: "robinhood" | "solana" = "robinhood") => emptySnapshot(chain, chain === "robinhood" ? "0x" + "b".repeat(40) : "So11111111111111111111111111111111111111112");

describe("agreement rule", () => {
  it("values within 15% are verified, beyond 15% disputed", () => {
    expect(verifyMetric(def("liquidityUsd"), [reading("a", 100_000), reading("b", 110_000)]).status).toBe("verified");
    expect(verifyMetric(def("liquidityUsd"), [reading("a", 100_000), reading("b", 130_000)]).status).toBe("disputed");
  });

  it("tiny absolute differences are not disputes (0.01% vs 0.02% deployer holding)", () => {
    expect(verifyMetric(def("deployerHoldingPct"), [reading("a", 0.01), reading("b", 0.02)]).status).toBe("verified");
  });

  it("booleans and addresses dispute on any difference", () => {
    expect(verifyMetric(def("mintAuthority"), [reading("a", false), reading("b", true)]).status).toBe("disputed");
    expect(verifyMetric(def("deployerAddress"), [reading("a", "0xAbC"), reading("b", "0xabc")]).status).toBe("verified");
    expect(verifyMetric(def("deployerAddress"), [reading("a", "0xabc"), reading("b", "0xdef")]).status).toBe("disputed");
  });

  it("a single source is single, not verified", () => {
    const v = verifyMetric(def("holderCount"), [reading("a", 10)]);
    expect(v.status).toBe("single");
    expect(v.chosen).toBe(10);
  });
});

describe("disputes resolve to the most conservative value", () => {
  const cases: [string, Provenance["value"][], Provenance["value"]][] = [
    ["liquidityUsd", [400_000, 190_000], 190_000], // lowest liquidity
    ["mainPoolLiquidityUsd", [100_000, 50_000], 50_000],
    ["top10SharePct", [12, 35], 35], // highest concentration
    ["top1SharePct", [2, 9], 9],
    ["holderCount", [5000, 1200], 1200], // fewest holders
    ["deployerHoldingPct", [1, 6], 6],
    ["fdvUsd", [1_000_000, 2_000_000], 2_000_000],
    ["roundTripLossPct", [2, 40], 40],
    ["lpLockedPct", [100, 20], 20],
    ["ageHours", [100, 30], 30], // youngest → stricter Launch rules
    ["deployerHasSold", [false, true], true], // "sold" over "not sold"
    ["mintAuthority", [false, true], true],
    ["freezeAuthority", [true, false], true],
    ["honeypot", [false, true], true],
    ["sellable", [true, false], false], // "not sellable" over "sellable"
    ["deployerAddress", ["0xaaa", "0xbbb"], null], // "unknown" over either wallet
  ];
  it.each(cases)("%s %j → %j", (metric, values, expected) => {
    const v = verifyMetric(def(metric), values.map((x, i) => reading(`src${i}`, x)));
    expect(v.status).toBe("disputed");
    expect(v.chosen).toBe(expected);
  });

  it("every registered metric has a conservative direction and its case is covered above", () => {
    const covered = new Set(cases.map((c) => c[0]));
    const uncovered = VERIFIED_METRICS.filter((d) => !covered.has(d.metric)).map((d) => d.metric);
    // Market-flow counts and price share the min/max code path tested above.
    expect(uncovered.sort()).toEqual(["buyers24h", "devBuySol", "priceUsd", "sellers24h", "totalSupply", "uniqueBuyers", "volume24hUsd"]);
    for (const d of VERIFIED_METRICS) expect(["min", "max", "unsafe-true", "unsafe-false", "unknown"]).toContain(d.direction);
  });
});

describe("on-chain is truth", () => {
  it("the chain wins over a more conservative API value, and the API is flagged", () => {
    const v = verifyMetric(def("top10SharePct"), [reading("rpc", 19.6, true), reading("hoodscan", 60)]);
    expect(v.status).toBe("disputed");
    expect(v.chosen).toBe(19.6);
    expect(v.wrongSources).toEqual(["hoodscan"]);
    expect(v.resolution).toMatch(/on-chain wins/);
  });

  it("flags the disagreeing API in the Sources list as 'API stale/wrong'", () => {
    const { snapshot, flags } = run(blank(), [
      { id: "rpc", label: "Robinhood RPC", data: { createdAt: new Date(Date.now() - 10 * 3_600_000).toISOString() } },
      { id: "geckoterminal", label: "GeckoTerminal", data: { createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString() } },
    ]);
    expect(snapshot.ageHours).toBeCloseTo(10, 1);
    expect(flags.geckoterminal?.[0]).toMatch(/^API stale\/wrong: Age/);
    expect(flags.rpc).toBeUndefined();
  });

  it("agreeing APIs are not flagged", () => {
    const v = verifyMetric(def("mintAuthority"), [reading("solana-rpc", false, true), reading("rugcheck", false)]);
    expect(v.status).toBe("verified");
    expect(v.wrongSources).toEqual([]);
  });
});

describe("sellability", () => {
  it("a disputed sellability can never pass the gate", () => {
    const base = perfectSnapshot("robinhood", { sellable: null, honeypot: null });
    const { snapshot } = run(base, [
      { id: "scanhood", label: "ScanHood", data: { sellable: true, honeypot: false } },
      { id: "other", label: "Other simulator", data: { sellable: false } },
    ]);
    expect(snapshot.sellable).toBe(false);
    const r = scoreSnapshot(snapshot);
    expect(r.gates.find((g) => g.id === "honeypot")!.state).not.toBe("pass");
    expect(r.tier).toBe("F");
    expect(r.verification.metrics.find((m) => m.metric === "sellable")!.status).toBe("disputed");
  });

  it("agreeing sellable sources still pass", () => {
    const base = perfectSnapshot("robinhood", { sellable: null, honeypot: null });
    const { snapshot } = run(base, [
      { id: "scanhood", label: "ScanHood", data: { sellable: true } },
      { id: "other", label: "Other simulator", data: { sellable: true } },
    ]);
    expect(scoreSnapshot(snapshot).gates.find((g) => g.id === "honeypot")!.state).toBe("pass");
  });
});

describe("provenance and counts", () => {
  it("records every source that supplied a metric, with value and fetch time", () => {
    const prov = collectProvenance(blank(), [
      { id: "geckoterminal", label: "GeckoTerminal", data: { liquidityUsd: 1000, priceUsd: 1 } },
      { id: "dexscreener", label: "DexScreener", data: { liquidityUsd: 1050 } },
    ]);
    expect(prov.liquidityUsd.map((p) => [p.source, p.value])).toEqual([
      ["geckoterminal", 1000],
      ["dexscreener", 1050],
    ]);
    expect(prov.priceUsd).toHaveLength(1);
    expect(Date.parse(prov.liquidityUsd[0].fetchedAt)).toBeGreaterThan(0);
  });

  it("stale readings keep their age in the fetch time", () => {
    const now = Date.parse("2026-10-24T12:00:00Z");
    const prov = collectProvenance(blank(), [{ id: "hoodscan", label: "HoodScan", data: { fdvUsd: 5, staleFields: { fdvUsd: 30 } } }], now);
    expect(prov.fdvUsd[0]).toMatchObject({ stale: true, fetchedAt: "2026-10-24T11:30:00.000Z" });
  });

  it("top-10 share is computed separately from each source's holder list", () => {
    const holders = (pcts: number[]) => pcts.map((p, i) => ({ address: `w${i}`, qty: p * 1e7, pct: null, buys: null, sells: null, isContract: false }));
    const prov = collectProvenance({ ...blank("solana"), totalSupply: 1e9 }, [
      { id: "rugcheck", label: "RugCheck", data: { holders: holders([10, 5]) } },
      { id: "helius", label: "Helius", data: { holders: holders([10, 5, 5]) } },
    ]);
    expect(prov.top10SharePct.map((p) => Math.round(Number(p.value)))).toEqual([15, 20]);
  });

  it("verified / single / disputed counts are correct", () => {
    const s = summarizeVerification({
      liquidityUsd: [reading("a", 100), reading("b", 101)], // verified
      fdvUsd: [reading("a", 1000)], // single
      holderCount: [reading("a", 10)], // single
      top10SharePct: [reading("a", 10), reading("b", 40)], // disputed
      mintAuthority: [reading("a", false), reading("b", true)], // disputed
      name: [reading("a", "x"), reading("b", "y")], // not a verified metric
    });
    expect([s.verified, s.single, s.disputed]).toEqual([1, 2, 2]);
    expect(s.metrics).toHaveLength(5);
  });

  it("a disputed address with no chain reading is scored unknown with the reason", () => {
    const { snapshot } = run(blank("solana"), [
      { id: "rugcheck", label: "RugCheck", data: { deployerAddress: "AAA" } },
      { id: "pumpfeed", label: "pump.fun intel feed", data: { deployerAddress: "BBB" } },
    ]);
    expect(snapshot.deployerAddress).toBeNull();
    expect(snapshot.nullReasons.deployerAddress).toMatch(/disputed: RugCheck says AAA, pump.fun intel feed says BBB/);
  });

  it("the report exposes verification on each factor", () => {
    const { snapshot } = run(perfectSnapshot("robinhood", { top10SharePct: null, totalSupply: 1e9 }), [
      { id: "rpc", label: "Robinhood RPC", data: { holders: [{ address: "w", qty: 2e8, pct: 20, buys: null, sells: null, isContract: false }] } },
      { id: "hoodscan", label: "HoodScan", data: { swapHolders: [{ address: "w", qty: 5e7, pct: 5, buys: 1, sells: 0, isContract: false }] } },
    ]);
    const r = scoreSnapshot(snapshot);
    const f = r.groups.flatMap((g) => g.factors).find((x) => x.metric === "top10SharePct")!;
    expect(f.verification?.status).toBe("disputed");
    expect(f.verification?.values.map((v) => v.source)).toEqual(["rpc", "hoodscan"]);
    expect(snapshot.top10SharePct).toBe(20);
  });
});

describe("source sanity checks found by cross-verification", () => {
  it("drops a three.ws launch observation that started long after the token's creation", async () => {
    const { rejectLateObservation } = await import("@/lib/sources/pumpfeed");
    const result = {
      status: { id: "pumpfeed", label: "pump.fun intel feed", state: "ok" as const },
      data: { snipeRatioPct: 0, devBuySol: 0, deployerAddress: "C1pU", mintAuthority: false, totalSupply: 1e9 },
      raw: { found: true, first_seen_at: "2026-10-12T00:25:09.226Z" },
    };
    const out = rejectLateObservation(result, "2024-10-19T00:00:00.000Z");
    expect(out.status.state).toBe("partial");
    expect(out.data.snipeRatioPct).toBeUndefined();
    expect(out.data.deployerAddress).toBeUndefined();
    expect(out.data.mintAuthority).toBe(false); // on-chain reads are kept
    expect(out.data.nullReasons?.snipeRatioPct).toMatch(/observation started \d+d after the token's creation/);
    // An observation at launch is kept as is.
    expect(rejectLateObservation(result, "2026-10-12T00:20:00.000Z")).toBe(result);
  });

  it("platform authorities are never counted as a creator reading", async () => {
    const { PLATFORM_AUTHORITIES } = await import("@/lib/sources/helius");
    expect(PLATFORM_AUTHORITIES.has("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM")).toBe(true);
  });
});
