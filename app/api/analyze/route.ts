import { NextResponse } from "next/server";
import { analyzeCached, CACHE_TTL_MS, InvalidAddressError, NotAMemeError, peekCached } from "@/lib/analyze";
import { addressKind, isEvmChain } from "@/lib/chain";
import { resolveEvmChain } from "@/lib/resolveChain";
import { clientId, takeLiveSlot } from "@/lib/rateLimit";
import { logError, newErrorId } from "@/lib/errorId";
import type { Chain } from "@/lib/types";
import { ageCachedReport, type CacheMarker } from "@/lib/normalizeReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// §2b: the analysis stops waiting at 45s (lib/budget.ts), well inside this limit, so the route never 504s.
export const maxDuration = 60;

const CACHE_HEADER = `public, max-age=${CACHE_TTL_MS / 1000}, s-maxage=${CACHE_TTL_MS / 1000}, stale-while-revalidate=60`;

export async function POST(req: Request) {
  let address: unknown;
  let fresh: unknown;
  let simulate: unknown;
  let chainIn: unknown;
  let freshTag: unknown;
  try {
    ({ address, fresh, simulate, chain: chainIn, freshTag } = await req.json());
  } catch {
    return NextResponse.json({ error: "Body must be JSON: { \"address\": \"...\" }" }, { status: 400 });
  }
  if (typeof address !== "string" || !address.trim()) {
    return NextResponse.json({ error: "Missing \"address\"" }, { status: 400 });
  }
  if (chainIn != null && chainIn !== "auto" && !isEvmChain(String(chainIn)) && chainIn !== "solana") {
    return NextResponse.json({ error: `Unknown "chain": use robinhood, base, monad, ethereum, solana or auto` }, { status: 400 });
  }
  let chain: Chain | undefined = isEvmChain(String(chainIn)) ? (chainIn as Chain) : undefined;
  // §1a: an 0x address without a chain is resolved across Robinhood Chain, Base, Monad and Ethereum first.
  if (!chain && addressKind(address) === "evm") {
    const res = await resolveEvmChain(address.trim().toLowerCase()).catch(() => null);
    if (res && res.candidates.length > 1) {
      return NextResponse.json(
        { error: "This address is a token on more than one chain — pass \"chain\".", ambiguous: true, candidates: res.candidates, picker: `/t/auto/${address.trim().toLowerCase()}` },
        { status: 300 },
      );
    }
    chain = res?.candidates[0]?.chain;
  }
  if (fresh === true || !peekCached(address, { chain })) {
    const slot = await takeLiveSlot(clientId(req));
    if (!slot.ok) {
      return NextResponse.json({ error: `Rate limit: too many live analyses from this client. Retry in ${slot.retryAfter}s.`, retryAfter: slot.retryAfter }, { status: 429, headers: { "retry-after": String(slot.retryAfter) } });
    }
  }
  try {
    const { report, cached } = await analyzeCached(address, {
      chain,
      fresh: fresh === true,
      freshTag: typeof freshTag === "string" ? freshTag.slice(0, 40) : undefined,
      simulate: simulate === "hoodscan-down" ? "hoodscan-down" : undefined,
      simulateToken: req.headers.get("x-hoodtier-simulate-token"),
    });
    // A token the collected data shows is not a meme (e.g. a Robinhood stock token missing from HoodScan's
    // roster, caught by its "• Robinhood Token" name) is refused like a known one: 422, never a tier.
    if (report.eligibility && !report.eligibility.meme) {
      const rejected = report.eligibility.rejected ?? "not a memecoin";
      return NextResponse.json({ rejected, reason: report.eligibility.reason, error: rejected, meme: false }, { status: 422, headers: { "x-hoodtier-cache": cached ? "hit" : "miss" } });
    }
    // The body says whether it was served from the cache and how old it is; stale ages count from the fetch.
    const body = cached ? (() => { const a = ageCachedReport(report); return { ...a.report, cache: a.cache }; })() : { ...report, cache: { cached: false, generatedAt: report.generatedAt, ageSeconds: 0 } satisfies CacheMarker };
    return NextResponse.json(body, { headers: { "cache-control": CACHE_HEADER, "x-hoodtier-cache": cached ? "hit" : "miss" } });
  } catch (err) {
    if (err instanceof InvalidAddressError) return NextResponse.json({ error: err.message, rejected: "paste a contract address" }, { status: 400 });
    if (err instanceof NotAMemeError) return NextResponse.json({ rejected: err.message, reason: err.reason, error: err.message, meme: false }, { status: 422 });
    const errorId = newErrorId();
    logError(errorId, `POST /api/analyze ${String(address).slice(0, 64)}`, err);
    return NextResponse.json({ error: "Analysis failed unexpectedly", errorId }, { status: 500 });
  }
}
