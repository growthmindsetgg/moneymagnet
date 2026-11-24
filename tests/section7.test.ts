import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { applyZeroActivity, deadLaunchOf, deriveMetrics } from "@/lib/snapshot";
import type { SourceStatus, TokenSnapshot } from "@/lib/types";
import { perfectLaunch } from "./helpers";
import { defaultConfig, setFor } from "@/lib/scoring/config";

const load = (name: string): { snapshot: TokenSnapshot; sources: SourceStatus[] } => JSON.parse(readFileSync(path.join(__dirname, "fixtures", `${name}.json`), "utf8"));
const MEME = "HTLSJSroPYreXR6xQXL9MEcjSs9jLaRrS5pAeUCzpump";

describe("§7 always score — PEEK fixture", () => {
  it("PEEK (never traded, ~15h) is F with coverage ≥ 90% and a numeric score", () => {
    const { snapshot, sources } = load("peek");
    const r = scoreSnapshot(snapshot, sources);
    expect(r.tier).toBe("F");
    expect(r.coveragePct).toBeGreaterThanOrEqual(90);
    expect(typeof r.score).toBe("number");
    expect(r.rules.find((x) => x.id === "dead_launch")!.evidence).toMatch(/^dead launch — 0 buyers, \$0(\.00)? liquidity at /);
  });
});

describe("§7b zero is data, not missing", () => {
  // A launch at 2h whose sources all answered: no buyers, no trades, no pool, curve at 0%.
  const answered: SourceStatus[] = [
    { id: "helius", label: "Helius", state: "ok", message: "1 curve trades: 0 buyers" },
    { id: "solana-rpc", label: "Solana RPC", state: "ok" },
    { id: "geckoterminal", label: "GeckoTerminal", state: "partial", message: "No pools" },
    { id: "dexscreener", label: "DexScreener", state: "ok", message: "1 pairs" },
    { id: "rugcheck", label: "RugCheck", state: "ok" },
    { id: "pumpfeed", label: "pump.fun intel feed", state: "ok" },
  ];
  const zeroLaunch = (): TokenSnapshot => {
    const base = perfectLaunch("solana", {
      address: MEME,
      ageHours: 2,
      uniqueBuyers: 0,
      buyers24h: null,
      sellers24h: null,
      sells24h: null,
      volume24hUsd: 0,
      liquidityUsd: null,
      curveProgressPct: 0,
      realSolReserves: 0,
      buyerSellerRatio: null,
      volMcVsBar: null,
      volMcRatio: null,
      snipeRatioPct: null,
      devBuySharePct: null,
      launchRetraced30: null,
      identicalCandleSharePct: null,
      staircase: null,
      hugeCandlesOnly: null,
      trendScore: null,
    });
    return applyZeroActivity(deriveMetrics(base), answered);
  };

  it("a 0-buyer token at 2h scores F with coverage ≥ 90%", () => {
    const d = zeroLaunch();
    const r = scoreSnapshot({ ...d, deadLaunch: deadLaunchOf(d) }, answered);
    expect(r.tier).toBe("F");
    expect(r.coveragePct).toBeGreaterThanOrEqual(90);
    expect(r.score).toBe(0);
    expect(r.binding).toMatchObject({ kind: "gate", text: expect.stringMatching(/Dead launch/) });
  });

  it("activity factors are 0, live, minimum points, evidence 'no activity'", () => {
    const d = zeroLaunch();
    expect(d.zeroActivity).toEqual(expect.arrayContaining(["Helius: 0 buyers", "GeckoTerminal: no pools", "pump.fun curve: 0% / 0 SOL"]));
    expect(d.liquidityUsd).toBe(0);
    const r = scoreSnapshot(d, answered);
    for (const id of ["unique_buyers", "buyer_seller_ratio", "vol_mc", "launch_retrace", "chart_staircase", "trend"]) {
      const f = r.groups.flatMap((g) => g.factors).find((x) => x.id === id)!;
      expect(f.status, id).toBe("live");
      expect(f.missing, id).toBe(false);
      // Its own minimum: the lowest threshold band × weight.
      const def = setFor(defaultConfig, "launch", "solana").groups.flatMap((g) => g.factors).find((x) => x.id === id)!;
      expect(f.points, id).toBeCloseTo(Math.min(...def.thresholds.map((t) => t.points)) * def.weight);
      expect(f.evidence, id).toMatch(/^no activity — /);
    }
  });

  it("any positive reading vetoes zero activity", () => {
    const d = applyZeroActivity(deriveMetrics(perfectLaunch("solana", { address: MEME, uniqueBuyers: 0, volume24hUsd: 15 })), answered);
    expect(d.zeroActivity).toEqual([]);
  });

  it("without any source saying 'nothing happened', nulls stay null", () => {
    const d = applyZeroActivity(deriveMetrics(perfectLaunch("solana", { address: MEME, uniqueBuyers: null, volume24hUsd: null, liquidityUsd: null, curveProgressPct: null, realSolReserves: null, buyers24h: null, sells24h: null })), []);
    expect(d.zeroActivity).toEqual([]);
  });
});

describe("§7c dead-launch gate", () => {
  const gate = (o: Partial<TokenSnapshot>) => deadLaunchOf({ ...perfectLaunch("solana", { address: MEME }), ...o });
  it("fires at ≥ 1h on ≤ 2 buyers, < $100 liquidity or a dead curve; never before 1h", () => {
    // ≤ 2 buyers and none live in 24h (live unique buyers > 2 would contradict it, 2026-11-24).
    expect(gate({ ageHours: 2, uniqueBuyers: 2, buyers24h: 2 })).toBe(true);
    expect(gate({ ageHours: 2, uniqueBuyers: 50, liquidityUsd: 80 })).toBe(true);
    expect(gate({ ageHours: 2, uniqueBuyers: 50, liquidityUsd: 5_000, deadCurve: true })).toBe(true);
    expect(gate({ ageHours: 0.5, uniqueBuyers: 0, liquidityUsd: 0 })).toBe(false);
    expect(gate({ ageHours: 2, uniqueBuyers: 50, liquidityUsd: 5_000, deadCurve: false })).toBe(false);
    // 24h buyers are a lower bound on lifetime buyers.
    expect(gate({ ageHours: 300, uniqueBuyers: null, buyers24h: 900, liquidityUsd: 50_000, deadCurve: false })).toBe(false);
  });
});

describe("§7e U only when sources failed", () => {
  it("Helius and the pump.fun feed both failed ⇒ U naming both", () => {
    // A launch whose holder, wallet and launch-mechanics data all come from Helius / the feed.
    const s = perfectLaunch("solana", {
      address: MEME,
      uniqueBuyers: 40,
      snipeRatioPct: null,
      bundleScore: null,
      organicScore: null,
      timingEntropy: null,
      devBuySharePct: null,
      feesPerMcap15k: null,
      freshWalletsTop20: null,
      fundingClusterMax: null,
      creatorRugRatePct: null,
      makersHoldersRatio: null,
      deployerSoldPct: null,
      top1SharePct: null,
      mintAuthority: null,
      freezeAuthority: null,
      insiderSupplyPct: null,
      creatorHasSocials: null,
      volMcVsBar: null,
      launchRetraced30: null,
      identicalCandleSharePct: null,
      hugeCandlesOnly: null,
      staircase: null,
    });
    const sources: SourceStatus[] = [
      { id: "helius", label: "Helius", state: "failed", message: "HTTP 429" },
      { id: "pumpfeed", label: "pump.fun intel feed", state: "failed", message: "Timed out" },
      { id: "rugcheck", label: "RugCheck", state: "ok" },
      { id: "solana-rpc", label: "Solana RPC", state: "ok" },
      { id: "geckoterminal", label: "GeckoTerminal", state: "ok" },
      { id: "dexscreener", label: "DexScreener", state: "ok" },
    ];
    const r = scoreSnapshot(s, sources);
    expect(r.tier).toBe("U");
    expect(r.tierReason).toMatch(/sources failed: .*Helius/);
    expect(r.tierReason).toMatch(/pump\.fun intel feed/);
    expect(r.binding?.text).toMatch(/Helius.*pump\.fun intel feed|pump\.fun intel feed.*Helius/);
  });

  it("the same nulls with every source answering are scored, not U", () => {
    const s = perfectLaunch("solana", { address: MEME, uniqueBuyers: 40, snipeRatioPct: null, bundleScore: null, freshWalletsTop20: null });
    const ok: SourceStatus[] = ["helius", "pumpfeed", "rugcheck", "solana-rpc", "geckoterminal", "dexscreener"].map((id) => ({ id, label: id, state: "ok" }));
    expect(scoreSnapshot(s, ok).tier).not.toBe("U");
  });
});
