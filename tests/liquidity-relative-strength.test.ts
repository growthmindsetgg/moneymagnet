import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { defaultConfig } from "@/lib/scoring/config";
import { deriveMetrics } from "@/lib/snapshot";
import { MemoryKV, kvGet, kvSet, setKV } from "@/lib/kv";
import {
  COHORT_MAX_AGE_MS,
  COHORT_MIN_PEERS,
  cohortKey,
  fetchCohort,
  median,
  pickPeers,
  priceChange7d,
  readCohort,
  type Cohort,
} from "@/lib/cohort";
import { relativeStrengthStep } from "@/lib/analyze";
import { deadlineIn } from "@/lib/budget";
import type { AdapterResult, ScoreReport, TokenSnapshot } from "@/lib/types";
import { perfectSnapshot, perfectLaunch, strip } from "./helpers";

// 2026-11-22: liq_fdv became "liquidity for its size" (fixed reference by market-cap band) and relative strength 7d
// (rose AND beat the peer cohort's median) joined the Established liquidity group. Recorded fixtures only — no network.

const factor = (r: ScoreReport, id: string) => r.groups.flatMap((g) => g.factors).find((f) => f.id === id)!;
const H = 3_600_000;
const D = 86_400;
const load = (name: string) => JSON.parse(readFileSync(path.join(__dirname, "fixtures", name), "utf8"));

describe("liquidity for its size (liq_fdv against a fixed reference by market-cap band)", () => {
  const liq = (fdvUsd: number, liqFdvPct: number) => factor(scoreSnapshot(perfectSnapshot("robinhood", { fdvUsd, liqFdvPct })), "liq_fdv");
  const W = defaultConfig.sets.established.groups.find((g) => g.id === "liquidity")!.factors.find((f) => f.id === "liq_fdv")!.weight;

  it("picks the band reference from FDV: < $100k 20%, $100k–1M 15%, $1M–10M 10%, > $10M 5%", () => {
    expect(liq(50_000, 20).points).toBe(W);
    expect(liq(50_000, 19).points).toBeLessThan(W);
    expect(liq(500_000, 15).points).toBe(W);
    expect(liq(500_000, 14).points).toBeLessThan(W);
    expect(liq(5_000_000, 10).points).toBe(W);
    expect(liq(50_000_000, 5).points).toBe(W);
    expect(liq(50_000_000, 4.9).points).toBeLessThan(W);
    // Band edges belong to the higher band.
    expect(liq(100_000, 15).points).toBe(W);
    expect(liq(10_000_000, 5).points).toBe(W);
  });

  it("the $1M–10M band reproduces the previous flat bars (10% / 5% / 2% / 1%)", () => {
    const old = (pct: number) => (pct >= 10 ? 1 : pct >= 5 ? 0.75 : pct >= 2 ? 0.45 : pct >= 1 ? 0.2 : 0);
    for (const pct of [0, 0.5, 1, 1.5, 2, 4.9, 5, 9.9, 10, 30]) expect(liq(2_000_000, pct).points).toBeCloseTo(old(pct) * W, 5);
  });

  it("the same liquidity share reads stronger on a larger coin, never weaker (fixed bands, monotone in size and depth)", () => {
    for (const pct of [1, 3, 6, 12]) {
      const pts = [50_000, 500_000, 5_000_000, 50_000_000].map((fdv) => liq(fdv, pct).points);
      for (let i = 1; i < pts.length; i++) expect(pts[i]).toBeGreaterThanOrEqual(pts[i - 1]);
    }
    for (const fdv of [50_000, 500_000, 5_000_000, 50_000_000]) {
      const pts = [0.2, 1, 2, 4, 8, 16, 40].map((pct) => liq(fdv, pct).points);
      for (let i = 1; i < pts.length; i++) expect(pts[i]).toBeGreaterThanOrEqual(pts[i - 1]);
    }
  });

  it("the evidence states the measured share, the FDV, the band, its reference and the ratio", () => {
    const f = liq(45_000_000, 4.27);
    expect(f.status).toBe("live");
    expect(f.value).toBe(4.27);
    expect(f.display).toBe("4.3% (0.85× ref)");
    expect(f.evidence).toBe("Active-pool liquidity is 4.3% of FDV ($45M); the fixed reference for the > $10M band is 5%, so it holds 0.85× of the reference — at least half the band reference.");
  });

  it("unknown FDV ⇒ null with the reason (never a default band)", () => {
    const r = scoreSnapshot({ ...perfectSnapshot("robinhood", { fdvUsd: null }), nullReasons: { fdvUsd: "DexScreener listed no fdv" } });
    const f = factor(r, "liq_fdv");
    expect(f.status).toBe("null");
    expect(f.points).toBe(0);
    expect(f.nullReason).toBe("market cap (FDV) unknown (DexScreener listed no fdv) — needed to pick the reference band");
  });

  it("a stale FDV makes the reading stale with its age", () => {
    const r = scoreSnapshot(perfectSnapshot("robinhood", { staleFields: { fdvUsd: 42 } }));
    expect(factor(r, "liq_fdv")).toMatchObject({ status: "stale", stale: "42m" });
  });

  it("recorded Base fixtures: BRETT ($46M, 4.3%) and TOSHI ($45M, 2.9%) read against the > $10M reference", () => {
    for (const [name, display] of [
      ["v3/base-brett.json", "4.3% (0.85× ref)"],
      ["v3/base-toshi.json", "2.9% (0.59× ref)"],
    ]) {
      const { snapshot, sources } = load(name);
      const f = factor(scoreSnapshot(snapshot, sources), "liq_fdv");
      expect(f.display).toBe(display);
      expect(f.evidence).toMatch(/the fixed reference for the > \$10M band is 5%/);
      expect(f.points).toBe(0.75 * f.max);
    }
  });
});

describe("relative strength 7d — derived metric", () => {
  const derive = (p: number | null, m: number | null, reasons: Record<string, string> = {}) =>
    deriveMetrics(perfectSnapshot("robinhood", { priceChange7dPct: p, cohortMedian7dPct: m, relStrength7dPp: null, nullReasons: reasons }));

  it("is min(change, change − median): positive only when the token rose AND beat the median", () => {
    expect(derive(25, 5).relStrength7dPp).toBe(20);
    expect(derive(8, 5).relStrength7dPp).toBe(3);
    expect(derive(3, 10).relStrength7dPp).toBe(-7); // rose, lagged
    expect(derive(-5, -30).relStrength7dPp).toBe(-5); // beat, fell
    expect(derive(-20, 10).relStrength7dPp).toBe(-30); // fell and lagged
    for (const p of [-40, -5, 0, 5, 40]) for (const m of [-30, 0, 30]) expect(derive(p, m).relStrength7dPp! > 0).toBe(p > 0 && p > m);
  });

  it("a missing input leaves it null with that input's reason", () => {
    expect(derive(10, null, { cohortMedian7dPct: "peer cohort unreadable: GeckoTerminal pool listing failed: rate limited (HTTP 429)" }).nullReasons.relStrength7dPp).toBe(
      "the peer cohort's 7d median is unknown (peer cohort unreadable: GeckoTerminal pool listing failed: rate limited (HTTP 429))",
    );
    const own = derive(null, 4, { priceChange7dPct: "GeckoTerminal daily candles start 2026-11-18 — a 7d change needs a close from 2026-11-15 or earlier" });
    expect(own.relStrength7dPp).toBeNull();
    expect(own.nullReasons.relStrength7dPp).toMatch(/^the token's own 7d price change is unknown \(GeckoTerminal daily candles start/);
  });

  it("inherits the cohort's stale age", () => {
    const d = deriveMetrics(perfectSnapshot("robinhood", { priceChange7dPct: 25, cohortMedian7dPct: 5, relStrength7dPp: null, staleFields: { cohortMedian7dPct: 37 } }));
    expect(d.staleFields.relStrength7dPp).toBe(37);
  });
});

describe("relative strength 7d — factor", () => {
  const rel = (p: number, m: number, extra: Partial<TokenSnapshot> = {}) =>
    factor(scoreSnapshot(perfectSnapshot("robinhood", { priceChange7dPct: p, cohortMedian7dPct: m, relStrength7dPp: Math.min(p, p - m), ...extra })), "rel_strength_7d");

  it("is an Established-mode factor with a modest weight (2) in every Established set, absent from Launch sets", () => {
    for (const [name, set] of Object.entries(defaultConfig.sets)) {
      const f = set.groups.flatMap((g) => g.factors).find((x) => x.id === "rel_strength_7d");
      if (name.startsWith("established")) expect(f?.weight, name).toBe(2);
      else expect(f, name).toBeUndefined();
    }
    expect(scoreSnapshot(perfectLaunch("solana")).groups.flatMap((g) => g.factors).some((f) => f.id === "rel_strength_7d")).toBe(false);
  });

  it("reads strong only when the token rose AND beat the peer median", () => {
    expect(rel(25, 5).points).toBe(2); // +20 pp
    expect(rel(8, 5).points).toBe(1.5); // rose and beat, by < 10 pp
    expect(rel(3, 10)).toMatchObject({ points: 0.8, flag: "info" }); // rose, lagged
    expect(rel(-5, -30)).toMatchObject({ points: 0.8, flag: "info" }); // beat, but fell
    expect(rel(-20, 10).points).toBe(0); // fell and lagged
    for (const p of [-40, -5, 0, 5, 40]) for (const m of [-30, 0, 30]) expect(rel(p, m).points >= 1.5).toBe(p > 0 && p > m);
  });

  it("the evidence states the token's 7d change, the cohort median, its size and who the peers are", () => {
    expect(rel(25, 5).evidence).toBe(
      "7d price change +25% (daily close 2026-11-15 → latest 2026-11-22) against a median of +5% across 8 test-dex peers on Robinhood Chain; strength = the lesser of the change and its excess over the median = +20 pp (derived) — rose and beat the peer median by ≥ 10 pp.",
    );
  });

  it("a cohort from the KV cache is labelled stale with its age", () => {
    expect(rel(25, 5, { staleFields: { relStrength7dPp: 25 } })).toMatchObject({ status: "stale", stale: "25m" });
  });

  it("an unreadable cohort ⇒ null with the exact reason, 0 points, not a number", () => {
    const why = "the peer cohort's 7d median is unknown (peer cohort unreadable: GeckoTerminal pool listing failed: rate limited (HTTP 429))";
    const r = scoreSnapshot({ ...strip(perfectSnapshot(), ["relStrength7dPp", "cohortMedian7dPct"]), nullReasons: { relStrength7dPp: why } });
    expect(factor(r, "rel_strength_7d")).toMatchObject({ status: "null", points: 0, value: null, nullReason: why });
  });

  it("age never penalises: a token younger than 7 days is not applicable (no coverage loss), not null", () => {
    const young = scoreSnapshot(strip(perfectSnapshot("robinhood", { ageHours: 100 }), ["relStrength7dPp", "priceChange7dPct"]));
    const f = factor(young, "rel_strength_7d");
    expect(f.status).toBe("n/a");
    expect(f.evidence).toMatch(/age never penalises/);
    expect(young.coveragePct).toBe(100);
  });
});

describe("priceChange7d (daily closes)", () => {
  const now = Date.UTC(2026, 10, 22, 15); // 2026-11-22 15:00Z
  const day = (offset: number, c: number) => ({ t: Math.floor(Date.UTC(2026, 10, 22) / 1000) - offset * D, o: c, h: c, l: c, c, v: 1 });

  it("compares the latest close with the close of the last candle at or before the day 7 days back", () => {
    const r = priceChange7d([day(9, 1), day(7, 2), day(3, 2.5), day(0, 3)], now);
    expect(r.pct).toBeCloseTo(50);
    expect(r.window).toBe("daily close 2026-11-15 → latest 2026-11-22");
  });

  it("no candle on the anchor day ⇒ the last close before it (no trade means the price stood)", () => {
    expect(priceChange7d([day(10, 2), day(2, 1)], now).pct).toBeCloseTo(-50);
    expect(priceChange7d([day(12, 2), day(9, 2)], now)).toMatchObject({ pct: 0, window: "daily close 2026-11-13 → latest 2026-11-13 (no trade since 2026-11-13)" });
  });

  it("fewer than 7 days of candles ⇒ null with the reason", () => {
    expect(priceChange7d([day(5, 1), day(0, 2)], now)).toEqual({ pct: null, window: null, reason: "daily candles start 2026-11-17 — a 7d change needs a close from 2026-11-15 or earlier" });
    expect(priceChange7d([], now).reason).toBe("no daily candles");
  });
});

describe("peer cohort (GeckoTerminal), replayed from recorded responses", () => {
  beforeEach(() => setKV(new MemoryKV()));
  afterEach(() => setKV(null));

  const fixtureFile = path.join(__dirname, "fixtures", "cohort", "robinhood-pons-dot-family.json");
  const fx = existsSync(fixtureFile) ? JSON.parse(readFileSync(fixtureFile, "utf8")) : null;
  const replay = <T,>(url: string): Promise<T> => (url in fx.responses ? Promise.resolve(fx.responses[url] as T) : Promise.reject(new Error(`not recorded: ${url}`)));

  it("median helper", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("pickPeers keeps established, non-dust, non-major pools, one per token", () => {
    const now = Date.UTC(2026, 10, 22);
    const pool = (sym: string, addr: string, reserve: string | null, daysOld: number, quote = "WETH") => ({
      attributes: { name: `${sym} / ${quote}`, address: `pool-${addr}-${daysOld}`, reserve_in_usd: reserve, pool_created_at: new Date(now - daysOld * D * 1000).toISOString() },
      relationships: { base_token: { data: { id: `robinhood_${addr}` } } },
    });
    const peers = pickPeers(
      [pool("OLD", "0xA", "50000", 30), pool("OLD", "0xa", "90000", 40), pool("NEW", "0xb", "50000", 2), pool("DUST", "0xc", "900", 30), pool("NORES", "0xd", null, 30), pool("WETH", "0xe", "5000000", 300, "USDC"), pool("USDC", "0xf", "5000000", 300, "WETH")],
      "robinhood",
      now,
    );
    expect(peers.map((p) => p.symbol)).toEqual(["OLD"]);
  });

  it.runIf(fx)("recorded robinhood/pons-dot-family: the venue's own peers, median of their 7d changes", async () => {
    const c = await fetchCohort("robinhood", "pons-dot-family", { get: replay, now: fx.now, concurrency: 1 });
    expect(c.scope).toBe(fx.expected.scope);
    expect(c.label).toBe(fx.expected.label);
    expect(c.peers.length).toBe(fx.expected.size);
    expect(c.peers.length).toBeGreaterThanOrEqual(COHORT_MIN_PEERS);
    expect(c.median).toBeCloseTo(fx.expected.median, 6);
    expect(c.median).toBeCloseTo(median(c.peers.map((p) => p.change7dPct)), 9);
  });

  it.runIf(fx)("every listing call failing ⇒ CohortError naming the cause", async () => {
    const rateLimited = () => Promise.reject(new Error("HTTP 429: rate limit"));
    await expect(fetchCohort("robinhood", "pons-dot-family", { get: rateLimited, now: fx.now })).rejects.toThrow("GeckoTerminal pool listing failed: rate limited (HTTP 429)");
  });

  it.runIf(fx)("candle reads failing for too many peers ⇒ CohortError with the count, never a partial median below the minimum", async () => {
    const listingsOnly = <T,>(url: string): Promise<T> => (url.includes("/ohlcv/") ? Promise.reject(new Error("HTTP 429")) : replay<T>(url));
    await expect(fetchCohort("robinhood", "pons-dot-family", { get: listingsOnly, now: fx.now })).rejects.toThrow(/only 0 of \d+ peers' 7d changes could be read \(.*rate limited \(HTTP 429\).*\) — needs ≥ 5/);
  });

  it("a venue with too few qualifying pools falls back to the chain's top pools, and the label says so", async () => {
    const now = Date.UTC(2026, 10, 22, 12);
    const pool = (i: number, daysOld: number) => ({
      attributes: { name: `P${i} / SOL`, address: `pool${i}`, reserve_in_usd: "50000", pool_created_at: new Date(now - daysOld * D * 1000).toISOString() },
      relationships: { base_token: { data: { id: `solana_Mint${i}` } } },
    });
    const candles = (from: number, to: number) => ({ data: { attributes: { ohlcv_list: [[Math.floor(now / 1000 / D) * D - 8 * D, from, from, from, from, 1], [Math.floor(now / 1000 / D) * D, to, to, to, to, 1]] } } });
    const get = <T,>(url: string): Promise<T> => {
      if (url.includes("/dexes/pumpswap/pools")) return Promise.resolve({ data: [pool(0, 1), pool(1, 2), pool(2, 30)] } as T);
      if (url.includes("/networks/solana/pools?")) return Promise.resolve({ data: [3, 4, 5, 6, 7, 8].map((i) => pool(i, 40)) } as T);
      const i = Number(/pool(\d+)\//.exec(url)?.[1]);
      return Promise.resolve(candles(1, 1 + i / 10) as T);
    };
    const c = await fetchCohort("solana", "pumpswap", { get, now });
    expect(c.scope).toBe("chain");
    expect(c.label).toBe("top-volume Solana pools (only 1 qualifying pumpswap pools)");
    expect(c.peers.map((p) => p.address)).toEqual(["Mint3", "Mint4", "Mint5", "Mint6", "Mint7", "Mint8"]);
    expect(c.median).toBeCloseTo(55); // +30 … +80%
  });
});

describe("readCohort — KV cache, stale label, 6h expiry, exact reasons", () => {
  beforeEach(() => setKV(new MemoryKV()));
  afterEach(() => setKV(null));
  const now = Date.UTC(2026, 10, 22, 12);
  const cohort = (at: number, changes = [10, 20, 30, 40, 50, 60]): Cohort => ({
    key: cohortKey("robinhood", "pons-dot-family"),
    chain: "robinhood",
    dex: "pons-dot-family",
    scope: "dex",
    label: "pons-dot-family peers on Robinhood Chain",
    median: median(changes),
    peers: changes.map((c, i) => ({ address: `0x${i}`, symbol: `P${i}`, pool: `pool${i}`, change7dPct: c })),
    unread: 0,
    at,
  });
  const never = () => Promise.reject(new Error("must not fetch"));

  it("a fresh read is live and stored for 6h", async () => {
    const r = await readCohort("robinhood", "pons-dot-family", "0xsubject", { budgetMs: 5_000, now, fetch: async () => cohort(now) });
    expect(r).toMatchObject({ median: 35, size: 6, ageMinutes: null, reason: null, status: { id: "cohort", state: "ok" } });
    expect(r.status.message).toBe("pons-dot-family peers on Robinhood Chain: median 7d +35.0% across 6 peers");
    expect((await kvGet<Cohort>(cohortKey("robinhood", "pons-dot-family")))?.median).toBe(35);
  });

  it("within the refresh window the cached cohort is used, labelled stale with its age", async () => {
    await kvSet(cohortKey("robinhood", "pons-dot-family"), cohort(now - 20 * 60_000));
    const r = await readCohort("robinhood", "pons-dot-family", "0xsubject", { budgetMs: 5_000, now, fetch: never });
    expect(r).toMatchObject({ median: 35, ageMinutes: 20, status: { state: "stale" } });
    expect(r.status.message).toMatch(/stale 20m \(refreshed every 60m\)$/);
  });

  it("a failed refresh falls back to the cached cohort (≤ 6h) with the failure stated", async () => {
    await kvSet(cohortKey("robinhood", "pons-dot-family"), cohort(now - 3 * H));
    const r = await readCohort("robinhood", "pons-dot-family", "0xsubject", { budgetMs: 5_000, now, fetch: () => Promise.reject(new Error("GeckoTerminal pool listing failed: rate limited (HTTP 429)")) });
    expect(r).toMatchObject({ median: 35, ageMinutes: 180, status: { state: "stale" } });
    expect(r.status.message).toMatch(/stale 3h \(refresh failed: GeckoTerminal pool listing failed: rate limited \(HTTP 429\)\)$/);
  });

  it("a cohort older than 6h is never used: null with the exact reason, and the failure is remembered for 5 minutes", async () => {
    await kvSet(cohortKey("robinhood", "pons-dot-family"), cohort(now - COHORT_MAX_AGE_MS - 60_000));
    const fail = () => Promise.reject(new Error("GeckoTerminal pool listing failed: rate limited (HTTP 429)"));
    const r = await readCohort("robinhood", "pons-dot-family", "0xsubject", { budgetMs: 5_000, now, fetch: fail });
    expect(r).toMatchObject({ median: null, size: null, reason: "peer cohort unreadable: GeckoTerminal pool listing failed: rate limited (HTTP 429)", status: { state: "failed" } });
    const again = await readCohort("robinhood", "pons-dot-family", "0xsubject", { budgetMs: 5_000, now: now + 60_000, fetch: never });
    expect(again.reason).toBe("peer cohort read failed 1m ago (GeckoTerminal pool listing failed: rate limited (HTTP 429)); retried after 5m");
  });

  it("the budget cuts a slow read off with the budget reason", async () => {
    const slow = () => new Promise<Cohort>(() => undefined);
    const r = await readCohort("robinhood", "pons-dot-family", "0xsubject", { budgetMs: 1_600, now, fetch: slow });
    expect(r).toMatchObject({ median: null, reason: "peer cohort unreadable: peer cohort timed out after 2s", status: { state: "failed" } });
  });

  it("no request time left ⇒ no fetch: the cache if any, else null with that reason", async () => {
    const none = await readCohort("robinhood", "pons-dot-family", "0xsubject", { budgetMs: 200, now, fetch: never });
    expect(none).toMatchObject({ median: null, reason: "no analysis time left to read the peer cohort" });
    await kvSet(cohortKey("robinhood", "pons-dot-family"), cohort(now - 2 * H));
    expect(await readCohort("robinhood", "pons-dot-family", "0xsubject", { budgetMs: 200, now, fetch: never })).toMatchObject({ median: 35, ageMinutes: 120 });
  });

  it("the token never counts in its own cohort", async () => {
    const r = await readCohort("robinhood", "pons-dot-family", "0x5", { budgetMs: 5_000, now, fetch: async () => cohort(now) });
    expect(r).toMatchObject({ median: 30, size: 5 }); // 60 (0x5) dropped
    const thin = await readCohort("robinhood", "pons-dot-family", "0x0", { budgetMs: 5_000, now: now + 60_000, fetch: async () => cohort(now, [1, 2, 3, 4, 5]) });
    // Cached cohort (1m old, 6 peers) is used; dropping 0x0 leaves 5.
    expect(thin.size).toBe(5);
  });

  it("too few peers besides the token ⇒ null with the count", async () => {
    const r = await readCohort("robinhood", "pons-dot-family", "0x0", { budgetMs: 5_000, now, fetch: async () => cohort(now, [1, 2, 3, 4, 5]) });
    expect(r).toMatchObject({ median: null, reason: "pons-dot-family peers on Robinhood Chain: only 4 peers besides this token (needs ≥ 5)", status: { state: "partial" } });
  });
});

describe("relativeStrengthStep (analysis wiring)", () => {
  const gecko = (dexId: string | null): AdapterResult => ({
    status: { id: "geckoterminal", label: "GeckoTerminal", state: "ok" },
    data: {},
    raw: { pools: [{ id: "0xpool", dexId }], mainPool: "0xpool" },
  });
  const snap = (over: Partial<TokenSnapshot>) => perfectSnapshot("robinhood", { cohortMedian7dPct: null, cohortSize: null, cohortLabel: null, relStrength7dPp: null, nullReasons: {}, staleFields: {}, ...over });

  it("reads the cohort of the main pool's venue and sets the inputs, stale-labelled when cached", async () => {
    const merged = snap({ priceChange7dPct: 12 });
    const results = [gecko("pons-dot-family")];
    const calls: (string | null)[] = [];
    await relativeStrengthStep("robinhood", merged.address, merged, results, deadlineIn(30_000), async (_c, dex) => {
      calls.push(dex);
      return { median: 4, size: 7, label: "pons-dot-family peers on Robinhood Chain", ageMinutes: 15, reason: null, status: { id: "cohort", label: "Peer cohort (GeckoTerminal)", state: "stale", message: "…" } };
    });
    expect(calls).toEqual(["pons-dot-family"]);
    expect(merged).toMatchObject({ cohortMedian7dPct: 4, cohortSize: 7, cohortLabel: "pons-dot-family peers on Robinhood Chain" });
    expect(merged.staleFields.cohortMedian7dPct).toBe(15);
    expect(results.at(-1)!.status).toMatchObject({ id: "cohort", state: "stale" });
    const d = deriveMetrics(merged);
    expect(d.relStrength7dPp).toBe(8);
    expect(factor(scoreSnapshot(d), "rel_strength_7d")).toMatchObject({ status: "stale", stale: "15m", points: 1.5 });
  });

  it("an unreadable cohort leaves the inputs null with the reason, and the source line says failed", async () => {
    const merged = snap({ priceChange7dPct: 12 });
    const results = [gecko("pons-dot-family")];
    await relativeStrengthStep("robinhood", merged.address, merged, results, deadlineIn(30_000), async () => ({
      median: null,
      size: null,
      label: null,
      ageMinutes: null,
      reason: "peer cohort unreadable: GeckoTerminal pool listing failed: rate limited (HTTP 429)",
      status: { id: "cohort", label: "Peer cohort (GeckoTerminal)", state: "failed", message: "peer cohort unreadable: …" },
    }));
    expect(merged.cohortMedian7dPct).toBeNull();
    expect(merged.nullReasons.cohortMedian7dPct).toBe("peer cohort unreadable: GeckoTerminal pool listing failed: rate limited (HTTP 429)");
    const r = scoreSnapshot(deriveMetrics(merged), results.map((x) => x.status));
    expect(factor(r, "rel_strength_7d")).toMatchObject({ status: "null", points: 0 });
    expect(factor(r, "rel_strength_7d").nullReason).toMatch(/rate limited \(HTTP 429\)/);
    expect(r.sourceStatus.find((s) => s.id === "cohort")!.state).toBe("failed");
  });

  it("no cohort call when the token's own 7d change is unknown, or in Launch mode — the source line says why", async () => {
    const never = () => Promise.reject(new Error("must not read"));
    const unknown = snap({ priceChange7dPct: null, nullReasons: { priceChange7dPct: "GeckoTerminal no daily candles" } });
    const r1 = [gecko("pumpswap")];
    await relativeStrengthStep("solana", unknown.address, unknown, r1, deadlineIn(30_000), never);
    expect(r1.at(-1)!.status).toMatchObject({ id: "cohort", state: "skipped", message: "the token's own 7d price change is unknown (GeckoTerminal no daily candles) — peer cohort not read" });
    const young = snap({ ageHours: 10, priceChange7dPct: null });
    const r2 = [gecko("pumpswap")];
    await relativeStrengthStep("solana", young.address, young, r2, deadlineIn(30_000), never);
    expect(r2.at(-1)!.status.message).toMatch(/^Launch mode \(< 72h\)/);
  });
});
