import { afterEach, describe, expect, it, vi } from "vitest";
import { pumpMarket } from "@/lib/sources/pools";
import { deriveMetrics } from "@/lib/snapshot";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { eligibility, knownNonMeme, MEMES_ONLY } from "@/lib/memeFilter";
import { heliusRpc, heliusStats, resetHeliusQueue, HELIUS_CONCURRENCY } from "@/lib/sources/heliusQueue";
import { textOf } from "@/lib/sources/pumpfeed";
import { perfectLaunch, perfectSnapshot } from "./helpers";

const MEME_MINT = "HTLSJSroPYreXR6xQXL9MEcjSs9jLaRrS5pAeUCzpump";
const launch = (o: Parameters<typeof perfectLaunch>[1] = {}) => perfectLaunch("solana", { address: MEME_MINT, ...o });

describe("graduated pump.fun tokens use the AMM pool, never the dead curve market", () => {
  // cell, 2026-10-24: curve market reserve $0 / vol $64.6k, PumpSwap pool $2.2k / vol $97.5k.
  const rows = [
    { id: "GrxvDvVW", name: "cell/SOL", liquidityUsd: 0, volume24hUsd: 64_571, createdAt: "2026-10-23T00:00:00Z", dexId: "pumpfun" },
    { id: "GUgw7ADi", name: "cell/SOL", liquidityUsd: 2_200, volume24hUsd: 97_459, createdAt: "2026-10-23T02:00:00Z", dexId: "pumpswap" },
  ];
  it("liquidity, volume and main pool come from the graduated pool only", () => {
    const m = pumpMarket(rows)!;
    expect(m.metrics.liquidityUsd).toBe(2_200);
    expect(m.metrics.volume24hUsd).toBe(97_459); // curve volume is not added
    expect(m.note).toMatch(/graduated/);
  });
  it("before graduation the indexer liquidity is not used (the curve's SOL reserve is)", () => {
    const m = pumpMarket([rows[0]])!;
    expect(m.metrics.liquidityUsd).toBeUndefined();
    expect(m.nullReasons.liquidityUsd).toMatch(/real SOL reserve/);
  });
  it("tokens without a curve market keep the normal multi-pool metrics", () => {
    expect(pumpMarket([{ ...rows[1], dexId: "raydium" }])).toBeNull();
  });
  it("a $211 curve-liquidity reading can no longer drive the wash flag", () => {
    const m = pumpMarket([{ ...rows[0], liquidityUsd: 211 }, { ...rows[1], liquidityUsd: 50_000, volume24hUsd: 60_000 }])!;
    const d = deriveMetrics({ ...launch({ washFlag: null, volLiqRatio: null, repeatedSizeSharePct: null, bundleSharePct: null }), ...m.metrics });
    expect(d.liquidityUsd).toBe(50_000);
    expect(d.washFlag).toBe(false);
  });
});

describe("too early ⇒ U", () => {
  // Replaced (§7a): only "< 5 minutes AND < 10 buyers" is too early; everything else is scored.
  it("under 5 minutes with < 10 buyers ⇒ U with the reason; snipe and dev share null", () => {
    const d = deriveMetrics(launch({ uniqueBuyers: 4, ageHours: 3 / 60, snipeRatioPct: 100, devBuySharePct: 100 }));
    expect(d.snipeRatioPct).toBeNull();
    expect(d.devBuySharePct).toBeNull();
    expect(d.nullReasons.snipeRatioPct).toMatch(/by construction/);
    const r = scoreSnapshot(d);
    expect(r.tier).toBe("U");
    expect(r.tierReason).toMatch(/too early — 4 buyers, 3 minutes old/);
    expect(r.verdict).toMatch(/^Unrated — too early/);
  });
  it("older than 5 minutes with few buyers is scored (numeric score, a tier)", () => {
    const r = scoreSnapshot(deriveMetrics(launch({ uniqueBuyers: 4, ageHours: 0.5 })));
    expect(r.tier).not.toBe("U");
    expect(r.score).not.toBeNull();
  });
  it("under 5 minutes with 10+ buyers is scored", () => {
    expect(scoreSnapshot(deriveMetrics(launch({ uniqueBuyers: 40, ageHours: 3 / 60 }))).tier).not.toBe("U");
  });
  it("a proven rug with < 10 buyers is still F (evidence gates win over the buyer-count rule)", () => {
    const r = scoreSnapshot(deriveMetrics(launch({ uniqueBuyers: 8, allBuyersExited: true })));
    expect(r.tier).toBe("F");
  });
  it("under 5 minutes with < 10 buyers it is U even when a gate fires", () => {
    const r = scoreSnapshot(deriveMetrics(launch({ uniqueBuyers: 7, ageHours: 2.7 / 60, allBuyersExited: true })));
    expect(r.tier).toBe("U");
    expect(r.binding?.kind).toBe("too-early");
  });
  it("10+ buyers and 5+ minutes is rated normally", () => {
    expect(scoreSnapshot(deriveMetrics(launch({ uniqueBuyers: 40, ageHours: 2 }))).tier).not.toBe("U");
  });
});

describe("bundling caps (guide p.24)", () => {
  it("bundle score ≥ 60 caps at C; snipe ≥ 50% caps at B (Pepechi: 67 / 100 ⇒ ≤ C)", () => {
    const pepechi = scoreSnapshot(deriveMetrics(launch({ uniqueBuyers: 60, bundleScore: 67, snipeRatioPct: 100 })));
    expect(["C", "D", "F"]).toContain(pepechi.tier);
    expect(pepechi.rules.find((r) => r.id === "bundle_cap")!.state).toBe("fired");
    const sniped = scoreSnapshot(deriveMetrics(launch({ uniqueBuyers: 60, bundleScore: 10, snipeRatioPct: 55 })));
    expect(["B", "C", "D", "F"]).toContain(sniped.tier);
    expect(sniped.rules.find((r) => r.id === "snipe_cap")!.state).toBe("fired");
  });
});

describe("Helius global queue", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetHeliusQueue();
  });
  it("never has more than 2 requests in flight, retries 429 and caches per address for 2 minutes", async () => {
    resetHeliusQueue();
    let inFlight = 0;
    let maxSeen = 0;
    let first429 = true;
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      inFlight++;
      maxSeen = Math.max(maxSeen, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      const body = JSON.parse(init.body);
      if (body.params[0] === "x3" && first429) {
        first429 = false;
        return new Response("Too Many Requests", { status: 429 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: body.params[0] }), { status: 200 });
    });
    const h = heliusRpc("k");
    const out = await Promise.all(Array.from({ length: 8 }, (_, i) => h.call<string>("getBalance", [`x${i}`])));
    expect(out).toEqual(["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"]);
    expect(maxSeen).toBeLessThanOrEqual(HELIUS_CONCURRENCY);
    expect(heliusStats.retries429).toBe(1);
    await h.call("getBalance", ["x1"]);
    expect(heliusStats.cacheHits).toBe(1);
  });
});

describe("feed adapter tolerates object reasons", () => {
  it("stringifies { pillar, text } entries instead of failing", () => {
    expect(textOf({ pillar: "momentum", text: "more sellers than buyers" })).toBe("more sellers than buyers");
    expect(textOf("plain")).toBe("plain");
    expect(textOf({ a: 1 })).toBe('{"a":1}');
  });
});

describe("meme-only, CA-only", () => {
  it("rejects stock tokens with the exact message", () => {
    const e = eligibility(perfectSnapshot("robinhood", { assetKind: "stock", name: "NVIDIA • Robinhood Token" }));
    expect(e.rejected).toBe(`stock token — ${MEMES_ONLY}`);
    expect(eligibility(perfectSnapshot("robinhood", { assetKind: "unknown", name: "Apple • Robinhood Token" })).rejected).toBe(`stock token — ${MEMES_ONLY}`);
    const stocks = { addresses: new Set(["0x" + "a".repeat(40)]), tickers: new Set(["NVDA"]) };
    expect(knownNonMeme("robinhood", "0x" + "A".repeat(40), stocks)?.rejected).toBe(`stock token — ${MEMES_ONLY}`);
  });
  it("rejects Solana blue chips without a launchpad origin, keeps pump.fun memes", () => {
    const blue = eligibility(perfectSnapshot("solana", { address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", launchpad: null, isLaunchpad: null, fdvUsd: 2e9 }));
    expect(blue.rejected).toBe(`blue chip — ${MEMES_ONLY}`);
    expect(eligibility(perfectSnapshot("solana", { address: MEME_MINT, launchpad: null, isLaunchpad: null, fdvUsd: 2e9 })).meme).toBe(true);
    expect(knownNonMeme("solana", "So11111111111111111111111111111111111111112")?.rejected).toMatch(/memecoins only/);
  });
});

describe("why this tier: the single binding constraint", () => {
  it("names the gate, cap, coverage or score that decided the tier", () => {
    expect(scoreSnapshot(perfectSnapshot("robinhood", { sellable: false })).binding).toMatchObject({ kind: "gate", text: expect.stringMatching(/^gate: Honeypot/) });
    expect(scoreSnapshot(perfectSnapshot("robinhood", { deployerSoldPct: 60 })).binding?.kind).toBe("cap");
    expect(scoreSnapshot(deriveMetrics(launch({ uniqueBuyers: 3, ageHours: 2 / 60 }))).binding?.kind).toBe("too-early");
    expect(scoreSnapshot(perfectSnapshot("robinhood")).binding).toMatchObject({ kind: "score", text: expect.stringMatching(/no cap binds/) });
  });
});
