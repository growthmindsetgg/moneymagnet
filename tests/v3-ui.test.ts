import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { scoreSnapshot } from "@/lib/scoring/engine";
import type { ScoreReport, SourceStatus, TokenSnapshot } from "@/lib/types";
import { clipWords, MAX_WORDS, prosCons } from "@/components/prosCons";
import { clusterSummary, deployerLine, holdersTable, poolList } from "@/components/research";
import Report from "@/components/Report";
import { perfectSnapshot } from "./helpers";
import { FIXTURES } from "./fixtures/addresses";

const load = (name: string): { snapshot: TokenSnapshot; sources: SourceStatus[] } => JSON.parse(readFileSync(path.join(__dirname, "fixtures", `${name}.json`), "utf8"));
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const reports = (): [string, ScoreReport][] => FIXTURES.map((fx) => { const { snapshot, sources } = load(fx.name); return [fx.name, scoreSnapshot(snapshot, sources)]; });

describe("§4 pros / cons", () => {
  it("is deterministic: two runs over the same report give the same text in the same order", () => {
    for (const [name, r] of reports()) {
      const a = prosCons(r);
      const b = prosCons(JSON.parse(JSON.stringify(r)));
      expect(b, name).toEqual(a);
    }
  });

  it("gives 2–4 bullets per column, each ≤ 12 words, on every fixture", () => {
    for (const [name, r] of reports()) {
      const { pros, cons } = prosCons(r);
      for (const col of [pros, cons]) {
        expect(col.length, name).toBeGreaterThanOrEqual(2);
        expect(col.length, name).toBeLessThanOrEqual(4);
        for (const p of col) expect(words(p.text), `${name}: ${p.text}`).toBeLessThanOrEqual(MAX_WORDS);
      }
    }
  });

  it("pros are neon; cons are orange, red only for a gate / cap", () => {
    for (const [, r] of reports()) {
      const { pros, cons } = prosCons(r);
      expect(pros.every((p) => p.sev === "good")).toBe(true);
      for (const c of cons) {
        if (c.sev === "bad") expect(["rule", "coverage"]).toContain(c.from);
        else expect(c.sev).toBe("warn");
      }
    }
  });

  it("a forcing gate is the first con, in red", () => {
    const r = scoreSnapshot(load("pangea-honeypot").snapshot);
    const { cons } = prosCons(r);
    expect(cons[0]).toMatchObject({ sev: "bad", from: "rule" });
    expect(cons[0].text).toMatch(/forces F/);
  });

  it("the top-scoring factors are the pros of a clean token", () => {
    const r = scoreSnapshot(perfectSnapshot());
    const { pros } = prosCons(r);
    expect(pros.length).toBe(4);
    expect(pros.every((p) => p.from === "factor")).toBe(true);
  });

  it("clips long text to 12 words", () => {
    expect(words(clipWords("one two three four five six seven eight nine ten eleven twelve thirteen fourteen"))).toBe(12);
    expect(clipWords("short text")).toBe("short text");
  });
});

const render = (r: ScoreReport) => renderToStaticMarkup(createElement(Report, { report: r }));

describe("§3 deep-research CTA", () => {
  it("shows for B and above only", () => {
    const base = scoreSnapshot(perfectSnapshot());
    for (const tier of ["S", "A", "B"] as const) {
      const html = render({ ...base, tier });
      expect(html, tier).toContain('data-testid="research-cta"');
      expect(html).not.toContain('data-testid="no-research"');
    }
    for (const tier of ["C", "D", "F", "U"] as const) {
      const html = render({ ...base, tier, binding: { kind: "score", text: "score 40 ⇒ C (no cap binds)" } });
      expect(html, tier).not.toContain('data-testid="research-cta"');
      expect(html).toContain("Not worth deeper research at this score");
      expect(html).toContain("score 40 ⇒ C");
    }
  });

  it("the research view gets holders, deployer line, pools and the cluster summary", () => {
    const { snapshot, sources } = load("microduck");
    const r = { ...scoreSnapshot(snapshot, sources), raw: { geckoterminal: { pools: [{ id: "0xpool", name: "MD / WETH", liquidityUsd: 1000, dexId: "uniswap" }] } } };
    const html = render(r);
    for (const id of ["holders-table", "deployer-line", "pool-list", "cluster-summary"]) expect(html, id).toContain(`data-testid="${id}"`);
    const table = holdersTable(r);
    expect(table.rows.length).toBeGreaterThan(0);
    expect(table.rows.length).toBeLessThanOrEqual(20);
    expect(table.firstSeenNote).toMatch(/no address index/);
    expect(poolList(r)[0]).toMatchObject({ address: "0xpool", liquidityUsd: 1000 });
    expect(deployerLine(r)).toMatch(/^Deployer/);
    expect(clusterSummary(r).length).toBeGreaterThan(0);
  });
});
