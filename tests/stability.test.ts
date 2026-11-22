import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fx from "./fixtures/microduck.json";
import { MemoryKV, setKV } from "@/lib/kv";
import { SourceError } from "@/lib/sources/http";
import { isOutage } from "@/lib/sources/retry";
import { geckoterminal, OHLCV_FIELDS } from "@/lib/sources/geckoterminal";
import { withLastGood } from "@/lib/analyze";
import { applyHold, completeRunOf, holdTier, outageNulls } from "@/lib/hold";
import { deriveMetrics, mergeSnapshots } from "@/lib/snapshot";
import { scoreSnapshot } from "@/lib/scoring/engine";
import type { AdapterResult, ScoreReport, SourceStatus, TokenSnapshot } from "@/lib/types";

// Production stability fix: a source outage (429 / 5xx / timeout) must not flip a tier.
// Before: GeckoTerminal OHLCV 429 left trend + bundlers flushed null on microduck ⇒ A 84.1 ↔ S 87.2.

const A = fx.snapshot.address;
const POOL = "0x" + "b".repeat(40);
const MIN = 60_000;
const H = 60 * MIN;
const R429 = "GeckoTerminal OHLCV failed: rate limited (HTTP 429)";
const base = fx.snapshot as unknown as TokenSnapshot;
const sources = fx.sources as unknown as SourceStatus[];
/** microduck as production saw it on the flapping runs (buyers = sellers): A 83.9 clean, S 87.2 with OHLCV down
 * (84.3 / 87.7 since Holder Strength replaced the two accumulator factors, 2026-10-30; the flap is the same). */
const flapping: TokenSnapshot = { ...base, buyers24h: base.sellers24h, buyerSellerRatio: 1, smartMoneyNetUsd: 0 };

const factor = (r: ScoreReport, metric: string) => r.groups.flatMap((g) => g.factors).find((f) => f.metric === metric)!;

/** The snapshot with every OHLCV-derived field taken away, as when that call fails and nothing stands in. */
function withoutOhlcv(s: TokenSnapshot): TokenSnapshot {
  const out = { ...s, bundlersFlushed: null, patterns: [], nullReasons: { ...s.nullReasons } } as unknown as Record<string, unknown>;
  for (const k of OHLCV_FIELDS) if (k !== "patterns") out[k] = null;
  for (const k of [...OHLCV_FIELDS, "bundlersFlushed"]) delete (out.nullReasons as Record<string, string>)[k];
  return out as unknown as TokenSnapshot;
}

describe("isOutage", () => {
  it("429, any 5xx and timeouts are outages; a 404 or a bad answer is not", () => {
    expect(isOutage(new SourceError("HTTP 429: Too Many Requests", 429))).toBe(true);
    expect(isOutage(new SourceError("HTTP 500: oops", 500))).toBe(true);
    expect(isOutage(new SourceError("HTTP 522: origin", 522))).toBe(true);
    expect(isOutage(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))).toBe(true);
    expect(isOutage(new Error("Helius getSignaturesForAddress: rate limited (429)"))).toBe(true);
    expect(isOutage(new SourceError("HTTP 404: not found", 404))).toBe(false);
    expect(isOutage(new SourceError("Non-JSON response: <html>"))).toBe(false);
  });
});

describe("GeckoTerminal OHLCV 429 on microduck ⇒ last good candles, stale, same tier", () => {
  let ohlcvDown = false;
  const created = Date.parse(base.createdAt ?? new Date(Date.now() - base.ageHours! * H).toISOString());
  const candles = (n: number, step: number, from: number) =>
    Array.from({ length: n }, (_, i) => {
      const p = 0.004 + 0.00001 * Math.sin(i / 3) + i * 1e-6;
      return [Math.floor((from + i * step) / 1000), p, p * 1.01, p * 0.99, p * 1.002, 50];
    });

  beforeEach(() => {
    setKV(new MemoryKV());
    ohlcvDown = false;
    vi.stubGlobal("fetch", async (url: string) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/ohlcv/")) {
        if (ohlcvDown) return new Response('{"status":"429","title":"Rate Limited"}', { status: 429 });
        const now = Date.now();
        const list = url.includes("/ohlcv/day") ? candles(60, 24 * H, created) : url.includes("/ohlcv/hour") ? candles(168, H, now - 168 * H) : candles(300, 5 * MIN, now - 300 * 5 * MIN);
        return json({ data: { attributes: { ohlcv_list: list.reverse() } } });
      }
      if (url.includes("/pools?page=1"))
        return json({
          data: [
            {
              id: `robinhood_${POOL}`,
              attributes: {
                name: "microduck / WETH",
                address: POOL,
                reserve_in_usd: "40000",
                pool_created_at: new Date(created).toISOString(),
                fdv_usd: "4800000",
                base_token_price_usd: "0.0048",
                volume_usd: { h24: "12000" },
                transactions: { h24: { buys: 400, sells: 400, buyers: 341, sellers: 341 } },
              },
              relationships: { base_token: { data: { id: `robinhood_${A}` } }, dex: { data: { id: "uniswap-v3-robinhood" } } },
            },
          ],
        });
      throw new Error(`unmocked ${url}`);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setKV(null);
  });

  const run = async (now: number): Promise<AdapterResult> => withLastGood("geckoterminal", "robinhood", A, await geckoterminal("robinhood", A), now);
  const scored = (r: AdapterResult) => {
    const snap = deriveMetrics(mergeSnapshots(withoutOhlcv(flapping), [r.data]));
    return scoreSnapshot(snap, [...sources.filter((s) => s.id !== "geckoterminal"), r.status]);
  };

  it("serves trend and launch price from the last good run, labelled stale; tier and score identical", async () => {
    const t0 = Date.now();
    const clean = await run(t0);
    expect(clean.status.state).toBe("ok");
    expect(clean.data.trendScore).not.toBeNull();
    const cleanReport = scored(clean);

    ohlcvDown = true;
    const down = await run(t0 + 10 * MIN);
    expect(down.status.state).toBe("stale");
    expect(down.status.message).toMatch(/^stale \(10m old\) for \d+ fields — 1 pools · OHLCV failed: HTTP 429/);
    expect(down.data.trendScore).toBe(clean.data.trendScore);
    expect(down.data.launchPriceUsd).toBe(clean.data.launchPriceUsd);
    expect(down.data.staleFields).toMatchObject({ trendScore: 10, launchPriceUsd: 10 });
    // Pool fields came back live this run and are not stale.
    expect(down.data.staleFields?.liquidityUsd).toBeUndefined();
    expect(down.data.nullReasons?.trendScore).toBeUndefined();

    const downReport = scored(down);
    expect(downReport.tier).toBe(cleanReport.tier);
    expect(downReport.score).toBe(cleanReport.score);
    expect(downReport.rawScore).toBe(cleanReport.rawScore);
    const trend = factor(downReport, "trendScore");
    expect(trend.status).toBe("stale");
    expect(trend.stale).toBe("10m");
    expect(trend.evidence).toMatch(/\(stale, 10m old\)$/);
    expect(factor(downReport, "bundlersFlushed").status).toBe("stale");
  }, 30_000);

  it("a source that never answered stays null with the exact reason (no stand-in value)", async () => {
    ohlcvDown = true;
    const down = await run(Date.now());
    expect(down.status.state).toBe("partial");
    expect(down.data.trendScore).toBeUndefined();
    const r = scored(down);
    expect(factor(r, "trendScore").status).toBe("null");
    expect(factor(r, "trendScore").nullReason).toBe(R429);
  }, 30_000);

  it("a last good run older than 6h is not used", async () => {
    const t0 = Date.now();
    await run(t0);
    ohlcvDown = true;
    const down = await run(t0 + 6 * H + MIN);
    expect(down.status.state).toBe("partial");
    expect(down.data.trendScore).toBeUndefined();
  }, 30_000);
});

describe("tier hold: a factor still null after the stale fallback cannot move the tier across a band", () => {
  beforeEach(() => setKV(new MemoryKV()));
  afterEach(() => setKV(null));

  const downSnap = (s: TokenSnapshot = flapping) => ({ ...withoutOhlcv(s), nullReasons: { ...withoutOhlcv(s).nullReasons, trendScore: R429, launchPriceUsd: R429 } });
  const score = (s: TokenSnapshot) => scoreSnapshot(s, sources);

  it("reproduces the production flap without the hold (A clean, S with OHLCV down)", () => {
    expect(score(flapping)).toMatchObject({ tier: "A", score: 84.3 });
    expect(score(downSnap())).toMatchObject({ tier: "S", score: 87.7 });
    expect(outageNulls(score(downSnap())).map((f) => f.metric)).toEqual(["trendScore"]);
  });

  it("holds the last complete run's tier and score, marked unchanged (source down), until the factor returns", async () => {
    const t0 = Date.now();
    const clean = await holdTier(score(flapping), flapping, sources, t0);
    expect(clean.hold).toBeUndefined();
    // Three runs while GeckoTerminal is down: the same tier every time.
    for (const m of [5, 10, 15]) {
      const held = await holdTier(score(downSnap()), downSnap(), sources, t0 + m * MIN);
      expect(held).toMatchObject({ tier: "A", score: 84.3, verdict: clean.verdict });
      expect(held.hold).toMatchObject({ liveTier: "S", liveScore: 87.7, minutesAgo: m, factors: ["Bundlers flushed out", "Trend structure"] });
      expect(held.binding).toEqual({ kind: "held", text: `unchanged (source down): Bundlers flushed out, Trend structure missing ⇒ A from ${m}m ago` });
    }
    // The factor is back: the live tier, no hold.
    const back = await holdTier(score(flapping), flapping, sources, t0 + 20 * MIN);
    expect(back.tier).toBe("A");
    expect(back.hold).toBeUndefined();
  });

  it("no hold when the factor never had a value (null is for sources that never answered)", async () => {
    const r = await holdTier(score(downSnap()), downSnap(), sources, Date.now());
    expect(r.tier).toBe("S");
    expect(r.hold).toBeUndefined();
  });

  it("no hold once the last complete run is older than 6h", async () => {
    const t0 = Date.now();
    await holdTier(score(flapping), flapping, sources, t0);
    const r = await holdTier(score(downSnap()), downSnap(), sources, t0 + 6 * H + MIN);
    expect(r.tier).toBe("S");
    expect(r.hold).toBeUndefined();
  });

  it("no hold when the missing factor is not what moved the tier", () => {
    const now = Date.now();
    const prev = completeRunOf(score(flapping), now - 5 * MIN);
    // Smart money turned positive this run: S with or without the trend reading.
    const moved = { ...flapping, smartMoneyNetUsd: 500 };
    const live = score(downSnap(moved));
    expect(live.tier).toBe("S");
    expect(score(moved).tier).toBe("S");
    expect(applyHold(live, downSnap(moved), sources, prev, now)).toBe(live);
  });

  it("no hold when the tier did not move (only the score), and complete inputs are untouched", () => {
    const now = Date.now();
    const prev = completeRunOf(score(base), now - 5 * MIN);
    const live = score(downSnap(base));
    expect(live.tier).toBe(prev.tier);
    expect(applyHold(live, downSnap(base), sources, prev, now)).toBe(live);
    const complete = score(base);
    expect(applyHold(complete, base, sources, prev, now)).toBe(complete);
  });
});

describe("Helius partial outage ⇒ only the lost fields come back stale", () => {
  beforeEach(() => setKV(new MemoryKV()));
  afterEach(() => setKV(null));

  it("fills failedFields from the last good run and leaves live fields live", async () => {
    const mint = "So11111111111111111111111111111111111111112";
    const t0 = Date.now();
    const ok: AdapterResult = { status: { id: "helius", label: "Helius", state: "ok" }, data: { freshWalletsTop20: 3, fundingClusterMax: 2, creatorPriorMints: 4 } };
    await withLastGood("helius", "solana", mint, ok, t0);
    const lost: AdapterResult = {
      status: { id: "helius", label: "Helius", state: "partial", message: "3 fields lost to a Helius outage" },
      data: { creatorPriorMints: 5, nullReasons: { freshWalletsTop20: "Helius call failed: (429)", fundingClusterMax: "Helius call failed: (429)" } },
      failedFields: ["freshWalletsTop20", "fundingClusterMax", "clusterSupplyPct"],
    };
    const res = await withLastGood("helius", "solana", mint, lost, t0 + 30 * MIN);
    expect(res.status.state).toBe("stale");
    expect(res.data).toMatchObject({ freshWalletsTop20: 3, fundingClusterMax: 2, creatorPriorMints: 5 });
    expect(res.data.staleFields).toEqual({ freshWalletsTop20: 30, fundingClusterMax: 30 });
    expect(res.data.nullReasons).toEqual({});
    // clusterSupplyPct never had a value: it stays null with its reason from the adapter.
    expect(res.data.clusterSupplyPct).toBeUndefined();
  });
});
