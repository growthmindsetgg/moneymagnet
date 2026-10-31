import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bucketFields } from "@/lib/timemachine/core";
import { similarity, nearest, MIN_SHARED_FIELDS } from "@/lib/timemachine/similarity";
import { bucketFor, loadLibrary, LIBRARY_KEY, timeMachine } from "@/lib/timemachine";
import { emptyFields } from "@/lib/timemachine/solana";
import { isProgramAddress } from "@/lib/timemachine/solana";
import type { Archetype, ArchetypeLibrary, BucketFields, Reconstruction } from "@/lib/timemachine/types";
import { MemoryKV, setKV } from "@/lib/kv";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { defaultConfig } from "@/lib/scoring/config";
import { perfectLaunch, perfectSnapshot } from "./helpers";

const f = (over: Partial<BucketFields>): BucketFields => ({ ...emptyFields(), ...over });
const A = f({ holders: 500, mcapUsd: 80_000, top10SharePct: 30, earlyRetentionPct: 50, devSoldPct: 0, drawdownPct: 10, buyerSellerRatio: 3 });
const B = f({ holders: 120, mcapUsd: 9_000, top10SharePct: 70, earlyRetentionPct: 5, devSoldPct: 100, drawdownPct: 80, buyerSellerRatio: 0.8 });

const arch = (kind: "winner" | "rug", symbol: string, fields: BucketFields, bucket = 6): Archetype => ({
  chain: "solana",
  address: `${symbol}111111111111111111111111111111111111`,
  symbol,
  name: symbol,
  createdAt: "2026-01-01T00:00:00.000Z",
  creationTx: null,
  creator: null,
  launchpad: "pump.fun",
  methods: {},
  buckets: [{ bucket: bucket as 6, at: "2026-01-01T06:00:00.000Z", fields, nulls: {} }],
  notes: [],
  builtAt: "2026-10-24T00:00:00.000Z",
  buildMs: 1,
  kind,
  source: "test",
  peakMcapUsd: null,
});

describe("similarity", () => {
  it("is 100% for a token against itself", () => {
    expect(similarity(A, A).pct).toBe(100);
    expect(similarity(B, B).pct).toBe(100);
  });

  it("is symmetric", () => {
    expect(similarity(A, B).pct).toBe(similarity(B, A).pct);
    const C = f({ holders: 2000, mcapUsd: 1_000_000, top10SharePct: 15, devSoldPct: 40, drawdownPct: 30 });
    expect(similarity(A, C).pct).toBe(similarity(C, A).pct);
  });

  it("excludes fields that are null on either side from the distance", () => {
    const withExtra = { ...A, liquidityUsd: 1, freshWalletSharePct: 100 };
    const s = similarity(withExtra, A);
    expect(s.pct).toBe(100); // the extra fields are known on one side only
    expect(s.excluded.sort()).toEqual(["freshWalletSharePct", "liquidityUsd"]);
    expect(s.compared.map((c) => c.field)).not.toContain("liquidityUsd");
  });

  it("claims nothing with fewer than the minimum shared fields", () => {
    const thin = f({ holders: 10, top10SharePct: 50 });
    expect(MIN_SHARED_FIELDS).toBeGreaterThan(2);
    expect(similarity(thin, A).pct).toBeNull();
  });

  it("very different tokens score low, near ones high", () => {
    const nearA = { ...A, holders: 550, top10SharePct: 32 };
    expect(similarity(A, nearA).pct!).toBeGreaterThan(90);
    expect(similarity(A, B).pct!).toBeLessThan(40);
  });

  it("names matching and breaking fields, log-scaled phrases for sizes", () => {
    const thin = { ...A, liquidityUsd: 2_500 };
    const deep = { ...A, liquidityUsd: 10_000 };
    const s = similarity(thin, deep);
    expect(s.compared.find((c) => c.field === "liquidityUsd")!.phrase).toBe("liquidity 4.0× thinner");
    const [m] = nearest(A, 6, [arch("winner", "WIN", { ...A, holders: 50_000 })], "winner");
    expect(m.matches.map((c) => c.field)).toContain("top10SharePct");
    expect(m.breaks.map((c) => c.field)).toContain("holders");
  });

  it("only compares archetypes at the same bucket", () => {
    expect(nearest(A, 24, [arch("winner", "WIN", A, 6)], "winner")).toEqual([]);
    expect(nearest(A, 6, [arch("winner", "WIN", A, 6)], "winner")[0].pct).toBe(100);
  });
});

describe("bucket reconstruction core", () => {
  const POOL = "pool";
  const base = {
    prices: [
      { t: 100, priceUsd: 1, volumeUsd: 10 },
      { t: 200, priceUsd: 4, volumeUsd: 20 },
      { t: 300, priceUsd: 2, volumeUsd: 30 },
    ],
    liquidity: null,
    cutoffT: 1000,
    supply: 1000,
    deployer: "dev",
    isPool: (o: string) => o === POOL,
    origins: null,
  };
  const deltas = [
    { pos: 1, owner: POOL, delta: 900 },
    { pos: 1, owner: "dev", delta: 100 },
    { pos: 2, owner: POOL, delta: -50 },
    { pos: 2, owner: "a", delta: 50 },
    { pos: 3, owner: POOL, delta: -30 },
    { pos: 3, owner: "b", delta: 30 },
    { pos: 4, owner: "dev", delta: -100 },
    { pos: 4, owner: POOL, delta: 100 },
    { pos: 5, owner: "a", delta: -50 },
    { pos: 5, owner: POOL, delta: 50 },
  ];
  const trades = [
    { pos: 1, wallet: "dev", side: "buy" as const, tokens: 100 },
    { pos: 2, wallet: "a", side: "buy" as const, tokens: 50 },
    { pos: 3, wallet: "b", side: "buy" as const, tokens: 30 },
    { pos: 4, wallet: "dev", side: "sell" as const, tokens: 100 },
    { pos: 5, wallet: "a", side: "sell" as const, tokens: 50 },
  ];

  it("computes holders, concentration, retention and dev behaviour from events only", () => {
    const { fields } = bucketFields({ ...base, deltas, trades, cutoffPos: 5 });
    expect(fields.holders).toBe(1); // only b still holds; the pool is excluded
    expect(fields.top10SharePct).toBe(3);
    expect(fields.earlyRetentionPct).toBe(50); // a exited, b held (the dev is not an early buyer)
    expect(fields.buyers).toBe(3);
    expect(fields.sellers).toBe(2);
    expect(fields.devBuySharePct).toBeCloseTo((100 / 180) * 100, 2);
    expect(fields.devSoldPct).toBe(100);
    expect(fields.peakMultiple).toBe(4);
    expect(fields.drawdownPct).toBe(50);
    expect(fields.mcapUsd).toBe(2000);
    expect(fields.volume24hUsd).toBe(60);
  });

  it("an earlier cutoff sees only earlier events", () => {
    const { fields } = bucketFields({ ...base, deltas, trades, cutoffPos: 3, cutoffT: 150 });
    expect(fields.holders).toBe(3);
    expect(fields.devSoldPct).toBe(0);
    expect(fields.priceUsd).toBe(1);
  });

  it("never fills a value it cannot reconstruct", () => {
    const { fields, nulls } = bucketFields({ ...base, deltas, trades, cutoffPos: 5, supply: null, deployer: null, prices: [] });
    expect(fields.top10SharePct).toBeNull();
    expect(fields.devSoldPct).toBeNull();
    expect(fields.priceUsd).toBeNull();
    expect(fields.mcapUsd).toBeNull();
    expect(nulls.devSoldPct).toBe("creator wallet unknown");
    expect(nulls.priceUsd).toMatch(/no priced trade/);
    expect(fields.freshWalletSharePct).toBeNull();
  });

  it("wallet origins give fresh-wallet share and the largest same-funder cluster", () => {
    const origins = new Map([
      ["b", { firstT: 900, funder: "F" }],
      ["c", { firstT: -200_000, funder: "F" }],
    ]);
    const { fields } = bucketFields({ ...base, deltas: [...deltas, { pos: 5, owner: "c", delta: 1 }], trades, cutoffPos: 5, origins });
    expect(fields.freshWalletSharePct).toBe(50);
    expect(fields.fundingClusterMax).toBe(2);
  });

  it("tells wallets from program addresses on Solana", () => {
    expect(isProgramAddress("DiFVDcnxubBDpdJNVLQN59qZPjwdp4hEygxmybDKE6qu")).toBe(true); // pump.fun curve PDA
    expect(isProgramAddress("2dE3XMa3y4um1XXstv1ZUdNk96NctLW1cP5ewnLBUsRV")).toBe(false); // a wallet
  });
});

describe("archetype loader", () => {
  afterEach(() => setKV(null));

  it("uses the KV copy when present, else the bundled library", async () => {
    setKV(new MemoryKV());
    const bundled = await loadLibrary();
    expect(bundled.version).toBe(1);
    const kv = new MemoryKV();
    const lib: ArchetypeLibrary = { version: 1, builtAt: "2026-10-24T00:00:00.000Z", buildMs: 1, archetypes: [arch("winner", "KVW", A)], skipped: [] };
    await kv.set(LIBRARY_KEY, lib);
    setKV(kv);
    expect((await loadLibrary()).archetypes[0].symbol).toBe("KVW");
  });

  it("every bundled archetype is real history: a creation time, buckets at fixed ages, a method or reason per field", async () => {
    const lib = JSON.parse(readFileSync(path.join(__dirname, "..", "data", "archetypes", "library.json"), "utf8")) as ArchetypeLibrary;
    for (const a of lib.archetypes) {
      expect(a.createdAt).toBeTruthy();
      for (const b of a.buckets) {
        expect([1, 6, 24, 72]).toContain(b.bucket);
        expect(Date.parse(b.at) - Date.parse(a.createdAt!)).toBe(b.bucket * 3_600_000);
        for (const [k, v] of Object.entries(b.fields)) if (v == null) expect(b.nulls[k as keyof BucketFields], `${a.symbol} +${b.bucket}h ${k}`).toBeTruthy();
      }
    }
  });
});

describe("age buckets", () => {
  it("rounds age down to 1h / 6h / 24h / 72h", () => {
    expect(bucketFor(null)).toBeNull();
    expect(bucketFor(0.5)).toBeNull();
    expect(bucketFor(1)).toBe(1);
    expect(bucketFor(5.9)).toBe(1);
    expect(bucketFor(30)).toBe(24);
    expect(bucketFor(5000)).toBe(72);
  });

  it("falls back to the latest complete bucket and says so", async () => {
    const lib: ArchetypeLibrary = { version: 1, builtAt: "x", buildMs: 1, archetypes: [arch("winner", "W", A, 1), arch("rug", "R", B, 1)], skipped: [] };
    const rec = (): Promise<Reconstruction> =>
      Promise.resolve({
        ...arch("winner", "T", A, 1),
        buckets: [
          { bucket: 1, at: "x", fields: A, nulls: {} },
          { bucket: 6, at: "y", fields: emptyFields(), nulls: { holders: "history to +6h exceeds the reconstruction budget" } },
        ],
      });
    const tm = await timeMachine("solana", "T", 10, { library: lib, reconstruct: rec });
    expect(tm.bucket).toBe(1);
    expect(tm.ageBucket).toBe(6);
    expect(tm.reason).toMatch(/compared at \+1h/);
    expect(tm.winnerPct).toBe(100);
    expect(tm.verdict).toBe("closer to winners");
  });
});

describe("Time Machine score effect is bounded and Launch-only", () => {
  const rules = defaultConfig.rules.filter((r) => r.id.startsWith("tm_"));

  it("factors.json documents it and the rules are ±5", () => {
    expect((defaultConfig as unknown as { timeMachine: { bonus: { points: number }; malus: { points: number } } }).timeMachine.bonus.points).toBe(5);
    expect(rules.map((r) => [r.id, r.points, r.sets])).toEqual([
      ["tm_winner_like", -5, ["launch"]],
      ["tm_rug_like", 5, ["launch"]],
    ]);
  });

  it("winner-like (≥ 70%, rug ≤ 40%) adds exactly 5; rug-like (≥ 70%) subtracts exactly 5", () => {
    const base = perfectLaunch("solana", { tmWinnerSimilarity: null, tmRugSimilarity: null });
    const neutral = scoreSnapshot(base).rawScore;
    const up = scoreSnapshot({ ...base, tmWinnerSimilarity: 80, tmRugSimilarity: 30 });
    const down = scoreSnapshot({ ...base, tmWinnerSimilarity: 50, tmRugSimilarity: 75 });
    const fired = (r: ReturnType<typeof scoreSnapshot>) => r.rules.filter((x) => x.state === "fired").map((x) => x.id);
    expect(fired(up)).toContain("tm_winner_like");
    expect(fired(down)).toContain("tm_rug_like");
    expect(up.rawScore).toBe(neutral);
    // Bonuses are listed apart from penalties (§7); both are exactly 5.
    expect(up.bonuses.find((p) => p.id === "tm_winner_like")?.points).toBe(5);
    expect(down.penalties.find((p) => p.id === "tm_rug_like")?.points).toBe(5);
    // Not both: winner-like needs the rug similarity ≤ 40.
    expect(fired(scoreSnapshot({ ...base, tmWinnerSimilarity: 90, tmRugSimilarity: 75 }))).not.toContain("tm_winner_like");
  });

  it("has no effect in Established mode", () => {
    const r = scoreSnapshot(perfectSnapshot("solana", { tmWinnerSimilarity: 95, tmRugSimilarity: 95 }));
    expect(r.mode).toBe("established");
    expect(r.rules.map((x) => x.id)).not.toContain("tm_rug_like");
    expect(r.rules.map((x) => x.id)).not.toContain("tm_winner_like");
  });
});

describe("Time Machine stays information-only while the library is small", () => {
  it("feeds no similarity to scoring below 10 winners and 10 rugs, and says why", async () => {
    const { tmScoringInputs } = await import("@/lib/analyze");
    const base = { status: "ok" as const, reason: null, bucket: 6 as const, ageBucket: 6 as const, token: null, methods: {}, winners: [], rugs: [], winnerPct: 82, rugPct: 74, verdict: "closer to winners" as const };
    const thin = tmScoringInputs({ ...base, library: { winners: 12, rugs: 3, builtAt: "x" } });
    expect(thin).toMatchObject({ winner: null, rug: null });
    expect(thin.reason).toMatch(/12 winners, 3 rugs; needs ≥ 10 of each/);
    expect(tmScoringInputs({ ...base, library: { winners: 12, rugs: 10, builtAt: "x" } })).toEqual({ winner: 82, rug: 74, reason: null });
  });
});
