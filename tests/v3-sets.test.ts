import { describe, expect, it } from "vitest";
import { defaultConfig, setFor } from "@/lib/scoring/config";
import { scoreSnapshot, SOURCE_CHAINS } from "@/lib/scoring/engine";
import { emptySnapshot, deriveMetrics } from "@/lib/snapshot";
import type { Chain, TokenSnapshot } from "@/lib/types";

const NEW = ["launch_base", "established_base", "launch_monad", "established_monad"] as const;
const chainOf = (set: string): Chain => (set.endsWith("base") ? "base" : "monad");

/** A Base / Monad token whose every metric the chain's sources fill is clean. */
function clean(chain: Chain, ageHours: number, over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return deriveMetrics({
    ...emptySnapshot(chain, "0x" + "b".repeat(40)),
    name: "Clean",
    symbol: "CLN",
    tokenExists: true,
    ageHours,
    priceUsd: 0.001,
    fdvUsd: 2_000_000,
    liquidityUsd: 300_000,
    mainPoolLiquidityUsd: 250_000,
    volume24hUsd: 3_000_000,
    poolCount: 2,
    liqChange24hPct: 2,
    liqChange7dPct: 5,
    totalSupply: 1e9,
    holderCount: 4000,
    top1SharePct: 2,
    top10SharePct: 12,
    deployerHoldingPct: 0.5,
    deployerSoldPct: 0,
    makersCount: 800,
    buyers24h: 600,
    sellers24h: 400,
    sells24h: 900,
    uniqueBuyers: 600,
    netFlowRatio24h: 0.2,
    tradesPerWallet: 2.5,
    sellable: true,
    honeypot: false,
    roundTripLossPct: 1,
    mintAuthority: false,
    verified: true,
    ownerRenounced: true,
    upgradeable: false,
    lpLockedPct: 100,
    isLaunchpad: true,
    launchpad: chain === "monad" ? "nad.fun V2" : "Clanker",
    launchRetraced30: true,
    identicalCandleSharePct: 5,
    staircase: false,
    trendScore: 80,
    brokeHigherLow: false,
    upOnlyChart: false,
    ...over,
  });
}

describe("v3 §1c Base / Monad factor sets", () => {
  it("each new set totals 100 with gate-only basics (0 points) and is used for its chain only", () => {
    for (const name of NEW) {
      const set = defaultConfig.sets[name];
      expect(set.groups.reduce((a, g) => a + g.weight, 0), name).toBe(100);
      const safety = set.groups.find((g) => g.id === "safety")!;
      expect(safety.weight).toBe(0);
      expect(safety.factors.every((f) => f.weight === 0 && f.gateOnly)).toBe(true);
    }
    expect(setFor(defaultConfig, "launch", "base")).toBe(defaultConfig.sets.launch_base);
    expect(setFor(defaultConfig, "established", "monad")).toBe(defaultConfig.sets.established_monad);
    // Robinhood / Solana untouched.
    expect(setFor(defaultConfig, "launch", "robinhood")).toBe(defaultConfig.sets.launch_robinhood);
    expect(setFor(defaultConfig, "established", "robinhood")).toBe(defaultConfig.sets.established);
    expect(setFor(defaultConfig, "launch", "solana")).toBe(defaultConfig.sets.launch);
  });

  it("built only from the chain's own sources: every factor has a source that serves the chain (absent, not null)", () => {
    for (const name of NEW) {
      const chain = chainOf(name);
      for (const f of defaultConfig.sets[name].groups.flatMap((g) => g.factors)) {
        expect(f.data.length, `${name}/${f.id}`).toBeGreaterThan(0);
        expect(f.data.some((d) => (SOURCE_CHAINS[d] ?? []).includes(chain)), `${name}/${f.id} ${f.data}`).toBe(true);
      }
    }
  });

  it("guide-sourced factors carry ≥ 60% of the new launch sets' weight", () => {
    for (const name of ["launch_base", "launch_monad"]) {
      const fs = defaultConfig.sets[name].groups.flatMap((g) => g.factors);
      expect(fs.filter((f) => f.source === "guide").reduce((a, f) => a + f.weight, 0), name).toBeGreaterThanOrEqual(60);
    }
  });

  it("factors no Base source fills are absent from the Base report (no swap index ⇒ no accumulators, no dev-sold)", () => {
    const r = scoreSnapshot(clean("base", 500));
    const ids = r.groups.flatMap((g) => g.factors).map((f) => f.id);
    for (const gone of ["accumulator_count", "early_retention", "bundlers_flushed", "smart_money_net", "deployer_sold", "freeze_authority"]) expect(ids).not.toContain(gone);
    expect(r.groups.flatMap((g) => g.factors).every((f) => !/not used on this chain/.test(f.nullReason ?? ""))).toBe(true);
  });

  it("a clean token scores A on both chains in both modes (S needs the swap-index accumulators these chains lack)", () => {
    for (const chain of ["base", "monad"] as const)
      for (const age of [10, 500]) {
        const r = scoreSnapshot(clean(chain, age));
        expect(r.coveragePct, `${chain} ${age}h`).toBeGreaterThanOrEqual(80);
        expect(["A", "S"], `${chain} ${age}h: ${r.tier} ${r.tierReason}`).toContain(r.tier);
      }
  });

  it("same gates: a sell-sim honeypot is F; zero activity is data; the dead-launch gate applies; the wash cap applies", () => {
    expect(scoreSnapshot(clean("base", 10, { sellable: false, honeypot: true })).tier).toBe("F");
    const wash = scoreSnapshot(clean("monad", 30, { volume24hUsd: 60_000_000, volMcRatio: null, volLiqRatio: null }));
    expect(wash.rules.find((r) => r.id === "wash")!.state).toBe("fired");
    const dead = scoreSnapshot(clean("monad", 5, { liquidityUsd: 40, deadLaunch: null }));
    expect(dead.rules.find((r) => r.id === "dead_launch")!.state).toBe("fired");
    expect(dead.tier).toBe("F");
    const tiny = scoreSnapshot(clean("base", 500, { fdvUsd: 1500, liqFdvPct: null }));
    expect(tiny.rules.find((r) => r.id === "dust")!.state).toBe("fired");
  });

  it("EVM rules: owner not renounced caps; mintable with a live owner forces F; mintable with renounced owner does not", () => {
    expect(scoreSnapshot(clean("base", 500, { ownerRenounced: false })).rules.find((r) => r.id === "owner_not_renounced")!.state).toBe("fired");
    const live = scoreSnapshot(clean("monad", 500, { mintAuthority: true, ownerRenounced: false }));
    expect(live.tier).toBe("F");
    expect(live.rules.find((r) => r.id === "evm_owner_mint")!.state).toBe("fired");
    const renounced = scoreSnapshot(clean("monad", 500, { mintAuthority: true, ownerRenounced: true }));
    expect(renounced.rules.find((r) => r.id === "evm_owner_mint")!.state).toBe("clear");
    expect(renounced.tier).not.toBe("F");
  });

  it("too early (< 5 min, < 10 buyers) is U on Base and Monad too", () => {
    const r = scoreSnapshot(clean("base", 3 / 60, { uniqueBuyers: 4, ageMinutes: 3 }));
    expect(r.tier).toBe("U");
  });
});
