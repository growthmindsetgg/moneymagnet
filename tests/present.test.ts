import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dedupeReasons, dedupeSegments, driftSince, plainSentence, shortVerdict } from "@/components/present";
import { scoreSnapshot } from "@/lib/scoring/engine";
import type { SourceStatus, TokenSnapshot } from "@/lib/types";

describe("'Why this tier' reasons: distinct, at most five", () => {
  it("collapses a label repeated inside its own evidence", () => {
    expect(dedupeSegments("Dead — no trades — dead — no trades for 15.9h+.")).toBe("Dead — no trades for 15.9h+.");
    expect(dedupeSegments("Micro-cap / illiquid (caps at D) — micro-cap / illiquid — $6.73K FDV — capped at D.")).toBe("Micro-cap / illiquid (caps at D) — $6.73K FDV — capped at D.");
  });

  it("drops repeats that differ only by punctuation or case (production microduck)", () => {
    const r = dedupeReasons([
      { kind: "positive", text: "8 large wallets bought 5+ times and never sold" },
      { kind: "positive", text: "net buying over 24h (+7.8%)" },
      { kind: "positive", text: "Largest non-LP wallet holds 3.0% of supply (guide bar: ≤ 3.5%)." },
      { kind: "positive", text: "Total pool liquidity moved +16.8% over 24h of history." },
      { kind: "positive", text: "8 large wallets bought 5+ times and never sold." },
    ]);
    expect(r.map((x) => x.text)).toEqual([
      "8 large wallets bought 5+ times and never sold",
      "net buying over 24h (+7.8%)",
      "Largest non-LP wallet holds 3.0% of supply (guide bar: ≤ 3.5%).",
      "Total pool liquidity moved +16.8% over 24h of history.",
    ]);
  });

  it("keeps the fuller of two overlapping reasons and caps the list at five", () => {
    const r = dedupeReasons([{ text: "wash trading" }, { text: "Wash trading — 24.9× liquidity turnover" }, ...["a1", "b2", "c3", "d4", "e5"].map((text) => ({ text }))]);
    expect(r.map((x) => x.text)).toEqual(["Wash trading — 24.9× liquidity turnover", "a1", "b2", "c3", "d4"]);
  });
});

describe("score drift since the last run", () => {
  const fx = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "microduck.json"), "utf8")) as { snapshot: TokenSnapshot; sources: SourceStatus[] };

  it("lists only factors whose points moved, with both displayed values", () => {
    const prev = scoreSnapshot(fx.snapshot, fx.sources);
    const cur = scoreSnapshot({ ...fx.snapshot, top10SharePct: 60 }, fx.sources);
    const d = driftSince(prev, cur);
    expect(d.length).toBeGreaterThan(0);
    const top10 = d.find((x) => x.label.toLowerCase().includes("top-10") || x.label.toLowerCase().includes("top 10"));
    expect(top10?.to).toContain("60");
    // Every listed factor really moved.
    const pts = (r: typeof cur, id: string) => r.groups.flatMap((g) => g.factors).find((f) => f.id === id)!.points;
    for (const x of d) expect(Math.abs(pts(cur, x.id) - pts(prev, x.id))).toBeGreaterThanOrEqual(0.01);
  });

  it("is empty with no previous run or no movement", () => {
    const r = scoreSnapshot(fx.snapshot, fx.sources);
    expect(driftSince(null, r)).toEqual([]);
    expect(driftSince(r, scoreSnapshot(fx.snapshot, fx.sources))).toEqual([]);
  });
});

describe("round 3 — fewer words", () => {
  it("plain sentences drop source names and guide pages", () => {
    expect(plainSentence("Top-10 wallets hold 19.5% of supply (source: onchain; pools, curves, routers and lockers excluded).", "Top-10 holder share")).toBe("Top-10 wallets hold 19.5% of supply.");
    expect(plainSentence("60% of the first-20 buyers (HoodScan 24h lens) still hold.", "Early-cohort retention")).toBe("60% of the first-20 buyers still hold.");
    expect(plainSentence("Largest non-LP wallet holds 3.0% of supply (guide bar: ≤ 3.5%).", "Top holder")).toBe("Largest non-LP wallet holds 3.0% of supply.");
    // A bare state gets its factor's name.
    expect(plainSentence("no activity — Helius: 0 buyers; pump.fun curve: 0%", "Unique buyers (24h)")).toBe("Unique buyers (24h): no activity.");
  });

  it("the verdict under the hero is at most 14 words", () => {
    const v = "Strong setup — 24h net flow ratio +23.6%, top holder (non-lp) 3.0%; main risk: track record ≥ 30 days.";
    const s = shortVerdict(v);
    expect(s.split(/\s+/).length).toBeLessThanOrEqual(14);
    expect(s).toBe("Strong setup — main risk: track record ≥ 30 days.");
    expect(shortVerdict("Avoid — liquidity removed.")).toBe("Avoid.");
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    expect(shortVerdict(long).split(/\s+/).length).toBeLessThanOrEqual(14);
    // A decimal inside the risk survives.
    expect(shortVerdict("Weak — thin book; main risk: VOL/MC 0.52× under the bar.")).toBe("Weak — main risk: VOL/MC 0.52× under the bar.");
  });
});
