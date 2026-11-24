import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKV, setKV } from "@/lib/kv";
import { defaultConfig } from "@/lib/scoring/config";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { geckoterminal } from "@/lib/sources/geckoterminal";
import type { SourceStatus, TokenSnapshot } from "@/lib/types";
import { perfectLaunch, perfectSnapshot } from "./helpers";

// funding_cluster removed 2026-11-24 (replaced by the wallet-cluster meter and its caps, which apply in every mode).
const LAUNCH_ONLY_RULES = ["vol_mc_bundle", "insider_18", "insider_40", "fees_low", "fresh_wallets", "bot_inflated", "supply_controlled"];
const LAUNCH_ONLY_METRICS = ["volMcVsBar", "insiderSupplyPct", "feesPerMcap15k", "fundingClusterMax", "freshWalletsTop20", "makersHoldersRatio", "launchRetraced30"];

const load = (name: string): { snapshot: TokenSnapshot; sources: SourceStatus[] } =>
  JSON.parse(readFileSync(path.join(__dirname, "fixtures", `${name}.json`), "utf8"));

describe("launch-only guide rules are absent from Established mode", () => {
  it("the established factor set has no launch-only factor, and still sums to 100", () => {
    const factors = defaultConfig.sets.established.groups.flatMap((g) => g.factors);
    for (const f of factors) expect(LAUNCH_ONLY_METRICS).not.toContain(f.metric);
    expect(defaultConfig.sets.established.groups.reduce((a, g) => a + g.factors.reduce((b, f) => b + f.weight, 0), 0)).toBe(100);
  });

  it("launch-only rules are restricted to the launch set", () => {
    for (const id of LAUNCH_ONLY_RULES) expect(defaultConfig.rules.find((r) => r.id === id)!.sets).toEqual(["launch"]);
  });

  it("established reports do not list them at all (not null, not neutral — absent)", () => {
    const r = scoreSnapshot(perfectSnapshot("solana", { insiderSupplyPct: 80, volMcRatio: 0.1, volMcVsBar: 0.1, freshWalletsTop20: 9, fundingClusterMax: 9 }));
    expect(r.mode).toBe("established");
    for (const id of LAUNCH_ONLY_RULES) expect(r.rules.map((x) => x.id)).not.toContain(id);
    expect(r.groups.flatMap((g) => g.factors).map((f) => f.metric)).not.toContain("volMcVsBar");
    expect(r.tier).toBe("S");
  });

  it("the same signals still bite in Launch mode", () => {
    const r = scoreSnapshot(perfectLaunch("solana", { insiderSupplyPct: 80 }));
    expect(r.rules.find((x) => x.id === "insider_40")!.state).toBe("fired");
  });

  it("microduck carries no VOL/MC factor", () => {
    const { snapshot, sources } = load("microduck");
    const r = scoreSnapshot(snapshot, sources);
    expect(r.mode).toBe("established");
    expect(r.groups.flatMap((g) => g.factors).find((f) => f.id === "vol_mc")).toBeUndefined();
    expect(r.rules.find((x) => x.id === "vol_mc_bundle")).toBeUndefined();
  });

  it("Fartcoin is not capped by insider networks", () => {
    const { snapshot, sources } = load("fartcoin");
    const r = scoreSnapshot(snapshot, sources);
    expect(r.mode).toBe("established");
    expect(r.rules.find((x) => x.id === "insider_40")).toBeUndefined();
    expect(r.rules.find((x) => x.id === "insider_18")).toBeUndefined();
    expect(r.tierReason).not.toMatch(/Insider/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("trend timeframe by mode", () => {
  // Each mode is its own scenario on the same address: a fresh store per test (the GeckoTerminal response cache).
  beforeEach(() => setKV(new MemoryKV()));
  afterEach(() => {
    vi.unstubAllGlobals();
    setKV(null);
  });

  function mockGecko(createdHoursAgo: number, seen: string[]) {
    const created = new Date(Date.now() - createdHoursAgo * 3_600_000).toISOString();
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.includes("/pools?page=1")) {
        return json({
          data: [
            {
              id: "x",
              attributes: { name: "T/USD", address: "0x" + "1".repeat(40), reserve_in_usd: "50000", pool_created_at: created, fdv_usd: "1000000", base_token_price_usd: "1", volume_usd: { h24: "1000" }, transactions: { h24: { buys: 10, sells: 10, buyers: 5, sellers: 5 } } },
              relationships: { base_token: { data: { id: "robinhood_0x" + "a".repeat(40) } } },
            },
          ],
        });
      }
      // A clean uptrend: higher highs and higher lows.
      const prices = [1, 1.2, 1.5, 1.2, 1.1, 1.3, 1.7, 1.4, 1.25, 1.5, 1.9, 1.6, 1.45, 1.6, 1.7];
      const step = url.includes("/hour") ? 3600 : url.includes("/day") ? 86400 : 300;
      const t0 = Math.floor(Date.now() / 1000) - prices.length * step;
      return json({ data: { attributes: { ohlcv_list: prices.map((p, i) => [t0 + i * step, p, p * 1.01, p * 0.99, p, 100]).reverse() } } });
    });
  }

  it("Established mode reads 1h candles over 7d and records that window", async () => {
    const seen: string[] = [];
    mockGecko(500, seen);
    const r = await geckoterminal("robinhood", "0x" + "a".repeat(40));
    expect(seen.some((u) => /\/ohlcv\/hour\?aggregate=1&limit=168/.test(u))).toBe(true);
    expect(r.data.trendScore).toBe(1);
    expect(r.data.trendWindow).toMatch(/× 1h candles/);
    expect(r.data.patterns?.find((p) => p.id === "trend")?.timeframe).toBe("1h");
  });

  it("Launch mode reads 5m candles over the token's life", async () => {
    const seen: string[] = [];
    mockGecko(10, seen);
    const r = await geckoterminal("robinhood", "0x" + "a".repeat(40));
    expect(seen.some((u) => u.includes("/ohlcv/hour"))).toBe(false);
    expect(seen.some((u) => /\/ohlcv\/minute\?aggregate=5&limit=12[23]&/.test(u))).toBe(true); // ceil(10h × 12) + 2
    expect(r.data.trendWindow).toMatch(/× 5m candles/);
    expect(r.data.patterns?.find((p) => p.id === "trend")?.timeframe).toBe("5m");
  });
});

describe("production outage simulation is secret-gated", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is off in production unless the caller presents HOODTIER_SIMULATE_TOKEN", async () => {
    const { simulationAllowed } = await import("@/lib/analyze");
    vi.stubEnv("HOODTIER_ALLOW_SIMULATE", "");
    vi.stubEnv("HOODTIER_SIMULATE_TOKEN", "");
    expect(simulationAllowed({ simulateToken: "anything" })).toBe(false);
    vi.stubEnv("HOODTIER_SIMULATE_TOKEN", "s3cret-token-0123456789");
    expect(simulationAllowed({ simulateToken: null })).toBe(false);
    expect(simulationAllowed({ simulateToken: "wrong" })).toBe(false);
    expect(simulationAllowed({ simulateToken: "s3cret-token-0123456789" })).toBe(true);
    vi.stubEnv("HOODTIER_SIMULATE_TOKEN", "short");
    expect(simulationAllowed({ simulateToken: "short" })).toBe(false);
  });
});
