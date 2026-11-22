import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scoreSnapshot, tierCeiling } from "@/lib/scoring/engine";
import { defaultConfig, loadConfig } from "@/lib/scoring/config";
import type { ScoreReport, SourceStatus, Tier, TokenSnapshot } from "@/lib/types";
import { perfectLaunch, perfectSnapshot } from "./helpers";

/**
 * thin_trading cap (2026-11-22, open item from the nad.fun sweep, docs/nadfun-sweep-2026-11-22.md §8):
 * GOCHI ($14 of 24h volume), EGG ($4, 6 makers) and MONIGGA ($25.9) reached A on holder structure alone.
 * A tier above C now needs ≥ $100 of 24h volume (buyer / seller counts are shown on the evidence line, not used
 * as a floor: swap indexers stall, e.g. live microduck read 0 / 0 beside $52k of volume).
 *
 * The raw sweep responses are not in the repo, so the three examples are TEST INPUTS: a synthetic Monad token
 * that clears every other factor (tests/helpers.ts perfectSnapshot) with the activity figures the sweep
 * recorded for each token. Anything the sweep did not record is marked "synthetic" beside it.
 */

const rule = (r: ScoreReport) => r.rules.find((x) => x.id === "thin_trading")!;
/** The same config without this rule: what the token scored before the fix. */
const withoutRule = loadConfig({ ...defaultConfig, rules: defaultConfig.rules.filter((r) => r.id !== "thin_trading") });
const ORDER: Tier[] = ["S", "A", "B", "C", "D", "F", "U"];

/** Activity fields kept consistent with the volume (VOL/MC follows it). */
function monad(o: { volume24hUsd: number | null; buyers24h: number | null; sellers24h: number | null } & Partial<TokenSnapshot>): TokenSnapshot {
  const fdv = o.fdvUsd ?? 1_000_000;
  const vol = o.volume24hUsd;
  const volMcRatio = vol == null ? null : vol / fdv;
  return perfectSnapshot("monad", {
    launchpad: "nad.fun",
    sells24h: o.sellers24h,
    buyerSellerRatio: o.buyers24h != null && o.sellers24h ? o.buyers24h / o.sellers24h : null,
    volMcRatio,
    volMcVsBar: volMcRatio == null ? null : volMcRatio / 0.8,
    ...o,
  });
}

describe("thin_trading: the sweep's top-tier-on-holder-structure-alone tokens are capped at C", () => {
  const cases: { name: string; snap: TokenSnapshot; volText: RegExp }[] = [
    // GOCHI 0x527d…7777: $14 24h volume (sweep); 17 buyers / 18 sellers is nad.fun's 1D count from the sweep.
    { name: "GOCHI-like", snap: monad({ volume24hUsd: 14, buyers24h: 17, sellers24h: 18 }), volText: /\$14\b/ },
    // EGG: $4 24h volume, 6 makers (sweep); the 4 buyers / 2 sellers split of those 6 is synthetic.
    { name: "EGG-like", snap: monad({ volume24hUsd: 4, buyers24h: 4, sellers24h: 2 }), volText: /\$4\b/ },
    // MONIGGA: $25.9 24h volume and $5.1k liquidity (sweep); buyer / seller counts were not recorded (null);
    // FDV $60k is synthetic.
    {
      name: "MONIGGA-like",
      snap: monad({ volume24hUsd: 25.9, buyers24h: null, sellers24h: null, liquidityUsd: 5_100, mainPoolLiquidityUsd: 5_100, fdvUsd: 60_000, liqFdvPct: 8.5 }),
      volText: /\$25\.9/,
    },
  ];

  for (const { name, snap, volText } of cases) {
    it(`${name}: A or better on holders alone before the fix, C with the measured volume and the floor on the evidence line now`, () => {
      const before = scoreSnapshot(snap, [], withoutRule);
      expect(["S", "A"], before.tierReason).toContain(before.tier);

      const r = scoreSnapshot(snap);
      expect(rule(r).state).toBe("fired");
      expect(r.tier).toBe("C");
      expect(r.binding).toEqual({ kind: "cap", text: "cap: Almost no trading (24h) ⇒ C" });
      expect(rule(r).evidence).toMatch(volText);
      expect(rule(r).evidence).toMatch(/below the \$100 24h volume a tier above C needs/);
      expect(rule(r).evidence).toMatch(/capped at C\.$/);
      // Monotone: clamped to the top of C, raw score kept beside it.
      expect(r.score).toBe(tierCeiling("C"));
      expect(r.rawScore).toBeGreaterThan(r.score!);
      expect(r.tierReason).toContain(`Displayed score clamped to ${tierCeiling("C")} (top of C).`);
    });
  }

  it("EGG-like states the measured buyer / seller counts; MONIGGA-like says 'no data' for the counts nobody recorded", () => {
    expect(rule(scoreSnapshot(cases[1].snap)).evidence).toMatch(/4 buyers \/ 2 sellers/);
    expect(rule(scoreSnapshot(cases[2].snap)).evidence).toMatch(/no data buyers \/ no data sellers/);
  });
});

describe("thin_trading does not touch real markets", () => {
  it("a healthy high-volume token ($1.2M, 400 buyers / 300 sellers) is not capped and keeps its S", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood"));
    expect(rule(r).state).toBe("clear");
    expect(r.tier).toBe("S");
  });

  it("a healthy Monad token with the same holders as the examples is not capped", () => {
    const r = scoreSnapshot(monad({ volume24hUsd: 50_000, buyers24h: 120, sellers24h: 90 }));
    expect(rule(r).state).toBe("clear");
    expect(["S", "A"]).toContain(r.tier);
  });

  const load = (p: string): { snapshot: TokenSnapshot; sources: SourceStatus[] } => JSON.parse(readFileSync(path.join(__dirname, "fixtures", p), "utf8"));

  it("recorded fixtures: microduck ($578k) and CHOG ($131.54, the lowest-volume fixture above C) keep their A", () => {
    for (const p of ["microduck.json", "v3/monad-chog.json"]) {
      const { snapshot, sources } = load(p);
      const r = scoreSnapshot(snapshot, sources);
      expect(rule(r).state, p).toBe("clear");
      expect(r.tier, p).toBe("A");
    }
  });

  it("boundaries: $100 clears the volume floor, $99.99 does not", () => {
    expect(rule(scoreSnapshot(monad({ volume24hUsd: 100, buyers24h: 20, sellers24h: 20 }))).state).toBe("clear");
    expect(rule(scoreSnapshot(monad({ volume24hUsd: 99.99, buyers24h: 20, sellers24h: 20 }))).state).toBe("fired");
  });

  it("a stalled swap index (0 buyers / 0 sellers) beside real volume does not fire the cap (live microduck, 2026-11-22: $52k)", () => {
    const r = scoreSnapshot(monad({ volume24hUsd: 52_262.66, buyers24h: 0, sellers24h: 0 }));
    expect(rule(r).state).toBe("clear");
  });

  it("unknown volume is not evaluable: no cap is invented from missing data", () => {
    const r = scoreSnapshot(monad({ volume24hUsd: null, buyers24h: 2, sellers24h: 1 }));
    expect(rule(r).state).toBe("unknown");
    expect(r.binding?.kind).not.toBe("cap");
  });
});

describe("thin_trading: zero activity is a value and age never gates", () => {
  it("zero activity is still scored (a tier in S–F and a number, never U) and capped with $0 on the evidence line", () => {
    const s = monad({ volume24hUsd: 0, buyers24h: 0, sellers24h: 0, zeroActivity: ["nad.fun: 0 buyers / 0 sellers", "24h volume $0"] });
    const r = scoreSnapshot(s);
    expect(r.tier).not.toBe("U");
    expect(typeof r.score).toBe("number");
    expect(rule(r).state).toBe("fired");
    expect(rule(r).evidence).toMatch(/^24h trading: \$0\.00 volume, 0 buyers \/ 0 sellers/);
    expect(["C", "D", "F"]).toContain(r.tier);
  });

  it("the same thin market is capped the same way at 30h (launch set) and at 40d (established set); a busy launch is not", () => {
    const launch = scoreSnapshot(perfectLaunch("monad", { volume24hUsd: 14, buyers24h: 17, sellers24h: 18 }));
    const old = scoreSnapshot(monad({ volume24hUsd: 14, buyers24h: 17, sellers24h: 18 }));
    expect(launch.mode).toBe("launch");
    expect(old.mode).toBe("established");
    expect(rule(launch).state).toBe("fired");
    expect(rule(old).state).toBe("fired");
    expect(rule(scoreSnapshot(perfectLaunch("monad"))).state).toBe("clear");
  });
});

describe("thin_trading keeps tier and displayed score monotone", () => {
  it("across a volume / holder sweep a higher displayed score never means a lower tier; capped scores sit in C with raw beside them", () => {
    const reports: ScoreReport[] = [];
    for (const volume24hUsd of [0, 4, 14, 25.9, 99.99, 100, 131.54, 1_000, 50_000, 1_200_000]) {
      for (const [buyers24h, sellers24h] of [[0, 0], [4, 2], [17, 18], [400, 300]]) {
        for (const top10SharePct of [12, 30, 45]) {
          for (const holderStrength of [30, 60, 88]) {
            reports.push(scoreSnapshot(monad({ volume24hUsd, buyers24h, sellers24h, top10SharePct, holderStrength })));
          }
        }
      }
    }
    const rated = reports.filter((r) => r.tier !== "U" && r.score != null);
    expect(rated.length).toBe(reports.length);
    for (const a of rated) {
      for (const b of rated) {
        if (a.score! > b.score!) expect(ORDER.indexOf(a.tier), `${a.score} ${a.tier} vs ${b.score} ${b.tier}`).toBeLessThanOrEqual(ORDER.indexOf(b.tier));
      }
    }
    const capped = rated.filter((r) => r.binding?.kind === "cap" && r.binding.text.includes("Almost no trading"));
    expect(capped.length).toBeGreaterThan(0);
    for (const r of capped) {
      expect(r.tier).toBe("C");
      expect(r.score!).toBeLessThanOrEqual(tierCeiling("C"));
      expect(r.score!).toBeLessThanOrEqual(r.rawScore);
      if (r.rawScore > tierCeiling("C")) expect(r.tierReason).toContain(`Displayed score clamped to ${tierCeiling("C")} (top of C).`);
    }
  });
});
