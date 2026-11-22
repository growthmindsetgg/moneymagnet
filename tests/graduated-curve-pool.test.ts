import { describe, expect, it } from "vitest";
import { dropGraduatedCurveMarket, pumpMarket } from "@/lib/sources/pools";
import { emptySnapshot, mergeSnapshots } from "@/lib/snapshot";
import { scoreSnapshot } from "@/lib/scoring/engine";
import type { AdapterResult } from "@/lib/types";
import { perfectLaunch } from "./helpers";

// NIKO (A2MgdY1o…pump), 2026-11-20: graduated. GeckoTerminal lists only the dead curve pool (5V9AHzDK…, $0 / $0),
// DexScreener lists the PumpSwap pool (F1YmADER…, $72k volume, 599 buys / 510 sells). The curve's zeros won the
// merge and scored NIKO as "0 buyers, 0 sells, VOL/MC 0.00× ⇒ bundle −20" (B 66 ⇒ D 29.3).
const MINT = "A2MgdY1oU6pqsREQ8eCPhR6DSMrGYaCPXUWUMRXgpump";
const curveRow = { id: "5V9AHzDK6XFUz8oNXrB5XXmVbZFgbakLLhA3iXmFs4Pf", name: "NIKO / TTWO", liquidityUsd: 0, volume24hUsd: 0, createdAt: "2026-11-18T14:53:34Z", dexId: "pump-fun" };

const gecko: AdapterResult = {
  status: { id: "geckoterminal", label: "GeckoTerminal", state: "ok", message: "1 pools + OHLCV" },
  data: { ...pumpMarket([curveRow])!.metrics, priceUsd: 0.00004534, buyers24h: 0, sellers24h: 0, sells24h: 0, trendScore: 0.5, identicalCandleSharePct: 18.5, launchRetraced30: true },
  raw: { pools: [curveRow], mainPool: curveRow.id, curveOnly: pumpMarket([curveRow])!.curveOnly },
};
const dex: AdapterResult = {
  status: { id: "dexscreener", label: "DexScreener", state: "ok", message: "1 pairs" },
  data: { volume24hUsd: 72_003, liquidityUsd: 24_232, priceUsd: 0.00008947, fdvUsd: 86_287, sells24h: 510, buyTxs24h: 599, sellTxs24h: 510 },
  raw: { pairs: [] },
};

describe("graduated pump.fun token whose curve pool is the only one an indexer lists", () => {
  it("pumpMarket marks a curve-only pool list", () => {
    expect(pumpMarket([curveRow])!.curveOnly).toBe(true);
    expect(pumpMarket([curveRow, { ...curveRow, id: "F1Ym", dexId: "pumpswap", liquidityUsd: 24_000, volume24hUsd: 72_000 }])!.curveOnly).toBe(false);
  });

  it("the curve-only source supplies no market fields, each null with the reason; launch candles stay", () => {
    const r = dropGraduatedCurveMarket(gecko);
    for (const k of ["volume24hUsd", "priceUsd", "buyers24h", "sellers24h", "sells24h", "trendScore", "identicalCandleSharePct"] as const) {
      expect(r.data[k]).toBeUndefined();
      expect(r.data.nullReasons?.[k]).toMatch(/only the pump\.fun curve pool.*graduated/);
    }
    expect(r.data.launchRetraced30).toBe(true);
    expect(r.status.state).toBe("partial");
    expect(r.status.message).toMatch(/curve pool only \(graduated\)/);
  });

  it("a source that indexes the AMM pool is left alone", () => {
    expect(dropGraduatedCurveMarket(dex)).toBe(dex);
  });

  it("merged, the AMM pool's live volume, trades and price win over the curve's zeros", () => {
    const m = mergeSnapshots(emptySnapshot("solana", MINT), [dropGraduatedCurveMarket(gecko).data, dex.data]);
    expect(m.volume24hUsd).toBe(72_003);
    expect(m.sells24h).toBe(510);
    expect(m.priceUsd).toBe(0.00008947);
    expect(m.buyers24h).toBeNull(); // DexScreener has buy transactions, not unique buyers: no 0 stands in
  });

  it("without the fix the curve's zeros would have won (guards the merge order this relies on)", () => {
    const m = mergeSnapshots(emptySnapshot("solana", MINT), [gecko.data, dex.data]);
    expect(m.volume24hUsd).toBe(0);
  });
});

describe("Why this tier names penalties when they, not a cap, move the score", () => {
  it("binding text carries raw − penalties (top holder 4.0% on a launch token, as NIKO)", () => {
    const r = scoreSnapshot(perfectLaunch("solana", { address: MINT, top1SharePct: 4.0 }));
    expect(r.penalties.map((p) => p.id)).toContain("top_holder_bundle");
    expect(r.binding?.kind).toBe("score");
    expect(r.binding?.text).toMatch(/^score [\d.]+ \(raw [\d.]+ − [\d.]+ penalties\) ⇒ [SABCDF] \(no cap binds\)$/);
  });
  it("with no penalty or bonus the binding text stays plain", () => {
    const r = scoreSnapshot(perfectLaunch("solana", { address: MINT }));
    expect(r.penalties).toHaveLength(0);
    expect(r.bonuses).toHaveLength(0);
    expect(r.binding?.text).toMatch(/^score [\d.]+ ⇒ [SABCDF] \(no cap binds\)$/);
  });
});
