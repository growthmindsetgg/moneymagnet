import { describe, expect, it, vi } from "vitest";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { equalSplit } from "@/lib/snapshot";
import { evmMintAuthority, mintSelectorsIn } from "@/lib/onchain/mintScan";
import { verifyMetric, verifiedMetricDef } from "@/lib/verify";
import { perfectLaunch, perfectSnapshot } from "./helpers";

/**
 * The six logic fixes of 2026-11-19 (REPORT.md): each holes the red-team / audit agents reproduced, asserted closed.
 */

describe("fix 1 — sell tax is a gate, not just a small factor", () => {
  it("a 60% round trip is F even when a source calls it sellable", () => {
    const r = scoreSnapshot(perfectSnapshot("solana", { sellable: true, roundTripLossPct: 60 }));
    expect(r.tier).toBe("F");
    expect(r.rules.find((x) => x.id === "sell_tax_50")!.state).toBe("fired");
  });
  it("25–50% caps at D, 10–25% caps at B, ≤ 10% is untouched", () => {
    expect(scoreSnapshot(perfectSnapshot("base", { roundTripLossPct: 30 })).tier).toBe("D");
    expect(scoreSnapshot(perfectSnapshot("robinhood", { roundTripLossPct: 15 })).tier).toBe("B");
    expect(scoreSnapshot(perfectSnapshot("robinhood", { roundTripLossPct: 6.9 })).tier).toBe("S");
  });
});

describe("fix 2 — an unlocked LP with no launchpad proof is not passed", () => {
  it("isLaunchpad unknown + 0% LP locked on a young token caps at D", () => {
    const r = scoreSnapshot(perfectSnapshot("base", { isLaunchpad: null, lpLockedPct: 0, ageHours: 100 }));
    expect(r.tier).toBe("D");
    expect(r.tierReason).toMatch(/LP unlocked, launchpad not proven/);
  });
  it("an old pool (≥ 14 days, the LP-lock window) is not re-litigated", () => {
    const r = scoreSnapshot(perfectSnapshot("base", { isLaunchpad: null, lpLockedPct: 0, ageHours: 24 * 400 }));
    expect(r.rules.find((x) => x.id === "lp_unlocked_unproven")!.state).not.toBe("fired");
  });
  it("S needs the LP lock or the launchpad proven on a token < 14 days", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { isLaunchpad: null, lpLockedPct: null, ageHours: 100 }));
    expect(r.tier).not.toBe("S");
    expect(r.requirements.find((q) => q.id === "s_lp:S")!.state).not.toBe("pass");
  });
});

describe("fix 3 — Robinhood: too-early U and the owner-mint gate", () => {
  it("a 3-minute Robinhood token with 5 buyers is U", () => {
    const r = scoreSnapshot(perfectLaunch("robinhood", { ageHours: 0.05, ageMinutes: 3, uniqueBuyers: 5 }));
    expect(r.tier).toBe("U");
  });
  it("bytecode with mint(address,uint256) and a live owner is mint authority; renounced is not", () => {
    const code = "0x6080604052" + "6340c10f19" + "14";
    expect(mintSelectorsIn(code)).toEqual(["mint(address,uint256)"]);
    expect(evmMintAuthority(code, false, false).mintAuthority).toBe(true);
    expect(evmMintAuthority(code, true, false).mintAuthority).toBe(false);
    expect(evmMintAuthority("0x60806040", false, false).mintAuthority).toBe(false);
    expect(evmMintAuthority("0x60806040", false, true).mintAuthority).toBeNull();
  });
  it("Robinhood owner-mint forces F", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { mintAuthority: true, ownerRenounced: false }));
    expect(r.tier).toBe("F");
    expect(r.rules.find((x) => x.id === "evm_owner_mint")!.state).toBe("fired");
  });
  it("the size floor applies when the age is unknown", () => {
    const r = scoreSnapshot(perfectSnapshot("solana", { ageHours: null, fdvUsd: 5_000 }));
    expect(["D", "F", "U"]).toContain(r.tier);
  });
});

describe("fix 4 — concentration split across wallets", () => {
  it("equalSplit finds ≥ 5 near-identical top balances", () => {
    expect(equalSplit(Array.from({ length: 10 }, () => ({ pct: 3.4 })))).toEqual({ pct: 34, count: 10 });
    // A power-law holder list has no such group.
    expect(equalSplit([10, 6, 4, 3, 2.2, 1.6, 1.2, 0.9, 0.7, 0.5].map((pct) => ({ pct }))).count).toBe(0);
  });
  it("10 wallets of 3.4% cap at C", () => {
    const r = scoreSnapshot(perfectSnapshot("base", { top1SharePct: 3.4, top10SharePct: 34, equalSplitPct: 34, equalSplitCount: 10 }));
    expect(r.tier).toBe("C");
    expect(r.tierReason).toMatch(/Equal-size wallet cluster/);
  });
});

describe("fix 5 — our own sell simulation outranks a scanner's 'not sellable'", () => {
  it("rh-sim sellable=true wins over ScanHood false (the scanner is flagged, not obeyed)", () => {
    const def = verifiedMetricDef("sellable")!;
    const v = verifyMetric(def, [
      { source: "scanhood", label: "ScanHood", value: false, fetchedAt: "", onchain: false },
      { source: "rh-sim", label: "HoodTier sell simulation", value: true, fetchedAt: "", onchain: true },
    ]);
    expect(v.chosen).toBe(true);
    expect(v.wrongSources).toEqual(["scanhood"]);
  });
  it("ScanHood's self-contradicting sellable=false (2% round trip, no honeypot flag) is not counted", async () => {
    vi.resetModules();
    vi.doMock("@/lib/sources/http", async (orig) => ({
      ...(await orig<typeof import("@/lib/sources/http")>()),
      mcpCall: async () => ({ verdict: "DANGER", sellable: false, roundTripLossPct: 2, flags: [] }),
    }));
    const { scanhood } = await import("@/lib/sources/scanhood");
    const r = await scanhood("0x" + "1".repeat(40));
    expect(r.data.sellable).toBeNull();
    expect(r.data.honeypot).toBeNull();
    expect(r.data.nullReasons?.sellable).toMatch(/contradicts itself/);
    vi.doUnmock("@/lib/sources/http");
  });
});
