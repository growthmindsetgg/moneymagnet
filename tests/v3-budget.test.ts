import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKV, setKV } from "@/lib/kv";
import type { AdapterResult } from "@/lib/types";

// §2b: a source that never answers is cut off by the analysis budget; the route still answers in time.
const ok = (id: string, data: AdapterResult["data"] = {}): AdapterResult => ({ status: { id, label: id, state: "ok" }, data });
const never = () => new Promise<AdapterResult>(() => undefined);

vi.mock("@/lib/sources/rugcheck", () => ({ rugcheck: async () => ok("rugcheck", { name: "Slow", symbol: "SLOW", tokenExists: true, mintAuthority: false, freezeAuthority: false }) }));
vi.mock("@/lib/sources/pumpfeed", () => ({ pumpfeed: async () => ok("pumpfeed"), rejectLateObservation: (r: AdapterResult) => r }));
vi.mock("@/lib/sources/helius", () => ({ helius: async () => ok("helius") }));
vi.mock("@/lib/sources/solanaCurve", () => ({ solanaCurve: async () => ok("solana-rpc") }));
vi.mock("@/lib/sources/jupiter", () => ({ jupiter: async () => ok("jupiter", { sellable: true }) }));
vi.mock("@/lib/sources/geckoterminal", () => ({ geckoterminal: async () => ok("geckoterminal", { liquidityUsd: 50_000, fdvUsd: 500_000 }) }));
// The mocked slow source: DexScreener hangs forever.
vi.mock("@/lib/sources/dexscreener", () => ({ dexscreener: never }));

const MINT = "S1owSourceTest111111111111111111111111111111";

describe("§2b analysis budget with a mocked slow source", () => {
  beforeEach(() => setKV(new MemoryKV()));

  it("collect() returns within the budget and reports the hung source as failed with the budget reason", async () => {
    const { collect } = await import("@/lib/analyze");
    const t0 = Date.now();
    const { sources, snapshot } = await collect("solana", MINT, { budgetMs: 1_500 });
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(4_000);
    const ds = sources.find((s) => s.id === "dexscreener")!;
    expect(ds.state).toBe("failed");
    expect(ds.message).toMatch(/timed out: 2s analysis budget reached|timed out: 1s analysis budget reached/);
    // The other sources' data is still there.
    expect(snapshot.liquidityUsd).toBe(50_000);
    expect(snapshot.name).toBe("Slow");
  });

  it("analyzeAddress() still produces a scored report, never a hang", async () => {
    const { analyzeAddress } = await import("@/lib/analyze");
    const t0 = Date.now();
    const report = await analyzeAddress(MINT, { budgetMs: 1_500 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(report.tier).toMatch(/^[SABCDFU]$/);
    expect(report.sourceStatus.find((s) => s.id === "dexscreener")!.state).toBe("failed");
  });

  it("a per-source cap applies before the overall budget", async () => {
    const { within, sourceCap, deadlineIn, BudgetError } = await import("@/lib/budget");
    const cap = sourceCap("dexscreener", deadlineIn(60_000));
    expect(cap.ms).toBe(30_000);
    expect(cap.label).toBe("timed out after 30s (per-source limit)");
    await expect(within(never(), 20, "x")).rejects.toBeInstanceOf(BudgetError);
    await expect(within(Promise.resolve(7), 1_000, "x")).resolves.toBe(7);
  });
});
