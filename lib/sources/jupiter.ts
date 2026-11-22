import type { AdapterResult } from "../types";
import { fetchJson } from "./http";

/**
 * Solana sell check through Jupiter's public quote API (free, no key): quote 0.1 SOL → token,
 * then the tokens received → SOL. Round-trip loss = 1 − SOL out / SOL in (AMM fees + impact +
 * any transfer tax Jupiter's routing sees). A sell with no route is reported, not guessed.
 */
const SOL = "So11111111111111111111111111111111111111112";
const IN_LAMPORTS = 100_000_000n; // 0.1 SOL
const ENDPOINTS = [process.env.JUPITER_QUOTE_URL, "https://lite-api.jup.ag/swap/v1/quote", "https://quote-api.jup.ag/v6/quote"].filter((x): x is string => !!x);

interface JupQuote {
  outAmount?: string;
  priceImpactPct?: string;
  routePlan?: { swapInfo?: { label?: string; ammKey?: string } }[];
  error?: string;
  errorCode?: string;
}

async function quote(inputMint: string, outputMint: string, amount: bigint): Promise<JupQuote> {
  let last: unknown = null;
  for (const base of ENDPOINTS) {
    try {
      return await fetchJson<JupQuote>(`${base}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=5000`, { timeoutMs: 12_000 });
    } catch (err) {
      // A 400 with "no route" is an answer; anything else tries the next endpoint.
      const m = (err as Error).message;
      if (/route|TOKEN_NOT_TRADABLE|COULD_NOT_FIND/i.test(m)) return { error: m.slice(0, 120) };
      last = err;
    }
  }
  throw last ?? new Error("Jupiter quote API unavailable");
}

export async function jupiter(mint: string): Promise<AdapterResult> {
  const t0 = Date.now();
  const buy = await quote(SOL, mint, IN_LAMPORTS);
  const status = (state: "ok" | "partial", message: string) => ({ id: "jupiter", label: "Jupiter quote", state, message, ms: Date.now() - t0, url: `https://jup.ag/swap/SOL-${mint}` });
  if (!buy.outAmount || buy.outAmount === "0") {
    const reason = `no buy route on Jupiter${buy.error ? ` (${buy.error})` : ""}`;
    return { status: status("partial", reason), data: { nullReasons: { roundTripLossPct: reason } }, raw: buy };
  }
  const sell = await quote(mint, SOL, BigInt(buy.outAmount));
  const via = (q: JupQuote) => [...new Set((q.routePlan ?? []).map((r) => r.swapInfo?.label).filter(Boolean))].join(" → ") || "?";
  if (!sell.outAmount || sell.outAmount === "0") {
    // Buyable but no route back: Jupiter cannot sell what it just bought. No sell was measured, so the
    // round-trip loss stays null (not 100%); the boolean carries the finding.
    const why = `no sell route back on Jupiter (${sell.error ?? "zero output"}) — no round trip measured`;
    return {
      status: status("ok", `buy routes via ${via(buy)}, but no sell route back (${sell.error ?? "zero output"})`),
      data: { sellable: false, nullReasons: { roundTripLossPct: why } },
      raw: { buy, sell },
    };
  }
  const out = BigInt(sell.outAmount);
  const loss = Math.max(0, Number(((IN_LAMPORTS - out) * 10_000n) / IN_LAMPORTS) / 100);
  return {
    status: status("ok", `0.1 SOL round trip via ${via(buy)}: ${loss.toFixed(2)}% loss`),
    data: { sellable: loss < 50, roundTripLossPct: loss },
    raw: { buy, sell },
  };
}
