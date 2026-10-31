import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scoreSnapshot } from "@/lib/scoring/engine";
import type { SourceStatus, TokenSnapshot } from "@/lib/types";
import { V3_FIXTURES } from "./fixtures/v3/addresses";

// v3 §1d: recorded Base / Monad snapshots (scripts/record-v3-fixtures.ts). Their own snapshot file — the
// Robinhood / Solana fixture snapshot (tests/__snapshots__/fixtures.test.ts.snap) stays byte-identical.
const load = (name: string): { snapshot: TokenSnapshot; sources: SourceStatus[] } => JSON.parse(readFileSync(path.join(__dirname, "fixtures", "v3", `${name}.json`), "utf8"));

describe("v3 Base / Monad recorded fixtures", () => {
  for (const fx of V3_FIXTURES) {
    it(`${fx.name} (${fx.kind}) scores in ${fx.expectTiers.join("/")}`, () => {
      const { snapshot, sources } = load(fx.name);
      const r = scoreSnapshot(snapshot, sources);
      expect(fx.expectTiers, r.tierReason).toContain(r.tier);
      expect(r.modeLabel).toMatch(fx.chain === "base" ? /Base/ : /Monad/);
      // Every factor shown belongs to the chain's set and says live / stale / null-with-reason.
      for (const f of r.groups.flatMap((g) => g.factors)) if (f.status === "null") expect(f.nullReason, f.id).toBeTruthy();
      expect({
        tier: r.tier,
        score: r.score,
        rawScore: r.rawScore,
        coveragePct: r.coveragePct,
        mode: r.mode,
        fired: r.rules.filter((x) => x.state === "fired").map((x) => x.id),
        factors: r.groups.flatMap((g) => g.factors.map((f) => [f.id, f.points, f.status])),
      }).toMatchSnapshot();
    });
  }

  it("rugs are F because the liquidity is gone (our sell sim), not because an indexer said so", () => {
    for (const name of ["base-rug", "monad-nad"]) {
      const { snapshot, sources } = load(name);
      const r = scoreSnapshot(snapshot, sources);
      expect(r.tier).toBe("F");
      expect(snapshot.liquidityPulled).toBe(true);
      expect(r.rules.find((x) => x.id === "liquidity_pulled")!.state).toBe("fired");
    }
  });

  it("a nad.fun curve token says our sell sim is its only sellability source", () => {
    const { sources } = load("monad-vibe");
    expect(sources.find((s) => s.id === "monad-sim")!.message).toMatch(/only sellability source/);
  });
});
