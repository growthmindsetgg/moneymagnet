import { beforeEach, describe, expect, it } from "vitest";
import { MemoryKV, setKV } from "@/lib/kv";
import { originOf } from "@/lib/onchain/origin";
import type { FullTx, Helius } from "@/lib/timemachine/solana";

const W = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const F = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const T = 1_700_000_000;
const receipt: FullTx = { slot: 5, blockTime: T, transaction: { signatures: ["sig1"], message: { accountKeys: [{ pubkey: F }, { pubkey: W }], instructions: [] } }, meta: { err: null, fee: 5000, preBalances: [10_000_000, 0], postBalances: [8_995_000, 1_000_000] } };

/** A fake Helius client: `gtfa` decides what getTransactionsForAddress does; the signatures path always works. */
function fake(gtfa: (params: unknown) => Promise<unknown>) {
  const calls: { method: string; params: unknown }[] = [];
  const h = (async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === "getTransactionsForAddress") return gtfa(params);
    if (method === "getSignaturesForAddress") return [{ signature: "sig1" }];
    if (method === "getTransaction") return receipt;
    throw new Error(`unexpected ${method}`);
  }) as Helius;
  return { h, calls };
}
const ctx = (helius: Helius) => ({ deadline: Date.now() + 10_000, helius, memo: new Map() });

// Order matters: the "Method not found" case flips a per-process flag, so it runs last.
describe("Solana origin: getTransactionsForAddress, and when to fall back", () => {
  beforeEach(() => setKV(new MemoryKV()));

  it("uses the same params as the app's working calls (maxSupportedTransactionVersion 1) and finds the funder", async () => {
    const { h, calls } = fake(async () => ({ data: [receipt] }));
    const o = await originOf("solana", W, ctx(h));
    expect(o).toMatchObject({ funder: F, method: "helius-gtfa", fundRef: 5, proof: "first-tx" });
    expect(calls[0].params).toEqual([W, { sortOrder: "asc", limit: 25, transactionDetails: "full", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
  });

  it("a non-outage error falls back to signatures for THIS wallet only — the next wallet still uses the method", async () => {
    let n = 0;
    const { h, calls } = fake(async () => {
      if (n++ === 0) throw new Error("Helius getTransactionsForAddress: Transaction version unsupported");
      return { data: [receipt] };
    });
    const first = await originOf("solana", W, ctx(h));
    expect(first).toMatchObject({ funder: F, method: "helius-sigs" });
    const second = await originOf("solana", F, ctx(h));
    expect(second.method).toBe("helius-gtfa");
    expect(calls.filter((c) => c.method === "getTransactionsForAddress")).toHaveLength(2);
  });

  it("an outage (429 / timeout) leaves the wallet retryable, not resolved through the weaker path", async () => {
    const { h, calls } = fake(async () => {
      throw new Error("Helius getTransactionsForAddress: rate limited (429)");
    });
    const o = await originOf("solana", W, ctx(h));
    expect(o.funder).toBeNull();
    expect(o.final).toBe(false);
    expect(o.reason).toMatch(/funding lookup failed: .*429/);
    expect(calls.some((c) => c.method === "getSignaturesForAddress")).toBe(false);
  });

  it("'Method not found' switches the process to the signatures path", async () => {
    const { h } = fake(async () => {
      throw new Error("Helius getTransactionsForAddress: Method not found");
    });
    expect((await originOf("solana", W, ctx(h))).method).toBe("helius-sigs");
    const after = fake(async () => ({ data: [receipt] }));
    expect((await originOf("solana", F, ctx(after.h))).method).toBe("helius-sigs");
    expect(after.calls.some((c) => c.method === "getTransactionsForAddress")).toBe(false);
  });
});
