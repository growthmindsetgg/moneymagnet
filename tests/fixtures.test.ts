import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scoreSnapshot } from "@/lib/scoring/engine";
import type { SourceStatus, TokenSnapshot } from "@/lib/types";
import { FIXTURES } from "./fixtures/addresses";

function load(name: string): { snapshot: TokenSnapshot; sources: SourceStatus[] } {
  return JSON.parse(readFileSync(path.join(__dirname, "fixtures", `${name}.json`), "utf8"));
}

describe("recorded fixture snapshots", () => {
  for (const fx of FIXTURES) {
    it(`${fx.name} scores in ${fx.expectTiers.join("/")}`, () => {
      const { snapshot, sources } = load(fx.name);
      const r = scoreSnapshot(snapshot, sources);
      expect(fx.expectTiers as readonly string[]).toContain(r.tier);
      expect({
        tier: r.tier,
        score: r.score,
        rawScore: r.rawScore,
        coveragePct: r.coveragePct,
        mode: r.mode,
        fired: r.rules.filter((x) => x.state === "fired").map((x) => x.id),
        gates: r.gates.map((g) => [g.id, g.state]),
        factors: r.groups.flatMap((g) => g.factors.map((f) => [f.id, f.points, f.flag, f.status])),
      }).toMatchSnapshot();
    });
  }

  it("microduck is A or S with ≥ 80% coverage on full HoodScan data", () => {
    const { snapshot, sources } = load("microduck");
    const r = scoreSnapshot(snapshot, sources);
    expect(["A", "S"]).toContain(r.tier);
    expect(r.coveragePct).toBeGreaterThanOrEqual(80);
    expect(r.mode).toBe("established");
    expect(r.groups.find((g) => g.id === "holders")!.hasData).toBe(true);
  });

  it("the offline pump.fun launch is never B or better, and a named guide rule caught it", () => {
    const { snapshot, sources } = load("offline");
    const r = scoreSnapshot(snapshot, sources);
    expect(r.mode).toBe("launch");
    expect(["C", "D", "F"]).toContain(r.tier);
    const caught = r.rules.filter((x) => x.state === "fired" && (x.forceF || x.capTier)).map((x) => x.id);
    expect(caught.some((id) => ["all_buyers_exited", "vol_mc_bundle", "dev_buy_big", "dev_sold"].includes(id))).toBe(true);
  });

  it("offline: snipe_ratio, bundle_score and dev_buy_sol are live from the three.ws feed", () => {
    const { snapshot, sources } = load("offline");
    const r = scoreSnapshot(snapshot, sources);
    const f = (id: string) => r.groups.flatMap((g) => g.factors).find((x) => x.id === id)!;
    expect(sources.find((s) => s.id === "pumpfeed")!.state).toBe("ok");
    expect(f("snipe_ratio").status).toBe("live");
    expect(f("bundle_score").status).toBe("live");
    expect(f("dev_buy_share").status).toBe("live");
    expect(snapshot.devBuySol).toBeGreaterThan(0);
    expect(f("dev_buy_share").evidence).toMatch(/SOL \(three\.ws launch observation/);
  });

  it("the pump.fun graduate has mint and freeze authority disabled", () => {
    const { snapshot } = load("fartcoin");
    expect(snapshot.mintAuthority).toBe(false);
    expect(snapshot.freezeAuthority).toBe(false);
    const r = scoreSnapshot(snapshot);
    expect(r.gates.find((g) => g.id === "mint_enabled")!.state).toBe("pass");
  });

  it("the honeypot fixture is F with score 0", () => {
    const r = scoreSnapshot(load("pangea-honeypot").snapshot);
    expect(r.tier).toBe("F");
    expect(r.score).toBe(0);
    expect(r.rules.find((x) => x.id === "honeypot")!.state).toBe("fired");
  });
});
