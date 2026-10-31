import { afterEach, describe, expect, it, vi } from "vitest";
import { rugcheck } from "@/lib/sources/rugcheck";
import { deriveMetrics, emptySnapshot, mergeSnapshots } from "@/lib/snapshot";

const MINT = "vRseBFqTy9QLmmo5qGiwo74AVpdqqMTnxPqWoWMpump";
const LOCKER = "7PbcoCNXi44oKuKM39yCJb5Lm9swygKsuhRz69EVi32v";
const WALLET = "8rmZuwoXfSpmsAs4xUuF1CupNCD7L1mrACjuoaPG9qtq";

afterEach(() => vi.unstubAllGlobals());

describe("v2.4 ceiling: RugCheck-labelled lockers are not holders in any source", () => {
  it("a Jupiter Locker escrow is excluded from the on-chain (Helius) holder list too", async () => {
    // Verse: RugCheck labels the 45% holder "Jupiter Locker"; Helius' largest accounts list it unlabelled.
    vi.stubGlobal("fetch", async (url: string) => {
      if (!String(url).includes("rugcheck")) throw new Error("offline");
      return new Response(
        JSON.stringify({
          mint: MINT,
          token: { supply: 1_000_000_000_000, decimals: 6 },
          tokenMeta: { name: "Verse", symbol: "Verse" },
          topHolders: [
            { owner: LOCKER, address: "BV98N6gi", pct: 45, uiAmount: 450_000 },
            { owner: WALLET, address: "31wF6L7n", pct: 5, uiAmount: 50_000 },
          ],
          knownAccounts: { [LOCKER]: { name: "Jupiter Locker", type: "LOCKER" } },
          markets: [],
        }),
      );
    });
    const rc = await rugcheck(MINT);
    expect(rc.data.holders!.map((h) => h.address)).toEqual([WALLET]);
    expect(rc.data.poolAddresses).toContain(LOCKER);

    const helius = { totalSupply: 1_000_000, holders: [{ address: LOCKER, qty: 450_000, pct: 45, buys: null, sells: null, isContract: null }, { address: WALLET, qty: 50_000, pct: 5, buys: null, sells: null, isContract: null }] };
    const s = deriveMetrics(mergeSnapshots(emptySnapshot("solana", MINT), [helius, { poolAddresses: rc.data.poolAddresses }]));
    expect(s.top1SharePct).toBe(5);
    expect(s.liquidityHeldPct).toBe(45);
  });
});
