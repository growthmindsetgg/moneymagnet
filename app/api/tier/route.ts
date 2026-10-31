import { NextResponse } from "next/server";
import { analyzeCached, CACHE_TTL_MS, InvalidAddressError, NotAMemeError, peekCached } from "@/lib/analyze";
import { addressKind, detectChain, isEvmChain, normalizeAddress } from "@/lib/chain";
import { resolveEvmChain } from "@/lib/resolveChain";
import { kvGet, kvSet } from "@/lib/kv";
import { knownNonMeme, NOT_A_CA, stockRegistry } from "@/lib/memeFilter";
import { clientId, takeLiveSlot } from "@/lib/rateLimit";
import { summarize, type TierSummary } from "@/lib/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TTL_S = CACHE_TTL_MS / 1000;
const summaryKey = (chain: string, address: string) => `tier:v1:${chain}:${address}`;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => NextResponse.json(body, { status, headers });

/**
 * The compact endpoint: paste a CA, get a tier, conviction vs churn and ≤ 5 short reasons.
 *   GET /api/tier?ca=<address>[&chain=base][&fresh=1]      POST /api/tier { "ca": "<address>", "chain"?: "base", "fresh"?: true }
 * An 0x address without a chain is resolved across Robinhood Chain, Base and Monad; on more than one ⇒ 300 + candidates.
 * Cached for 2 minutes in the shared KV; live analyses are rate limited per client (429 + Retry-After).
 * Non-memes get 422 with the reason. The full evidence is GET /t/<chain>/<address> or POST /api/analyze.
 */
async function handle(req: Request, input: unknown, fresh: boolean, chainIn: unknown = null) {
  if (typeof input !== "string" || !input.trim()) return json({ error: 'Missing contract address: ?ca=<address> or { "ca": "<address>" }' }, 400);
  let hint = typeof chainIn === "string" && isEvmChain(chainIn) ? chainIn : null;
  if (!hint && addressKind(input) === "evm") {
    const res = await resolveEvmChain(input.trim().toLowerCase()).catch(() => null);
    if (res && res.candidates.length > 1) return json({ error: 'This address is a token on more than one chain — pass "chain".', ambiguous: true, candidates: res.candidates }, 300);
    hint = res?.candidates[0]?.chain ?? null;
  }
  const chain = detectChain(input.trim(), hint);
  if (!chain) return json({ error: new InvalidAddressError(input).message, rejected: NOT_A_CA }, 400);
  const address = normalizeAddress(chain, input.trim());
  const refused = knownNonMeme(chain, address, chain === "robinhood" ? await stockRegistry() : undefined);
  if (refused) return json({ rejected: refused.rejected, reason: refused.reason, error: refused.rejected, meme: false }, 422);

  if (!fresh) {
    const hit = await kvGet<TierSummary>(summaryKey(chain, address));
    if (hit) return json({ ...hit, cached: true }, hit.meme ? 200 : 422, { "x-hoodtier-cache": "kv", "cache-control": `public, max-age=${TTL_S}` });
  }
  let remaining: number | null = null;
  if (fresh || !peekCached(address, { chain })) {
    const slot = await takeLiveSlot(clientId(req));
    remaining = slot.remaining;
    if (!slot.ok) {
      return json({ error: `Rate limit: too many live analyses from this client. Retry in ${slot.retryAfter}s (cached results are not limited).`, retryAfter: slot.retryAfter }, 429, { "retry-after": String(slot.retryAfter), "cache-control": "no-store" });
    }
  }
  try {
    const { report, cached } = await analyzeCached(address, { fresh, chain });
    const summary = summarize(report, new URL(req.url).origin);
    await kvSet(summaryKey(chain, address), summary, TTL_S);
    // A forced re-run must never be answered by the CDN; normal lookups may be (2 minutes).
    const cacheControl = fresh ? "no-store" : `public, max-age=${TTL_S}, s-maxage=${TTL_S}`;
    return json({ ...summary, cached }, summary.meme ? 200 : 422, { "x-hoodtier-cache": cached ? "memory" : "miss", "cache-control": cacheControl, ...(remaining != null ? { "x-ratelimit-remaining": String(remaining) } : {}) });
  } catch (err) {
    if (err instanceof NotAMemeError) return json({ rejected: err.message, reason: err.reason, error: err.message, meme: false }, 422);
    if (err instanceof InvalidAddressError) return json({ error: err.message }, 400);
    console.error("[tier] unexpected failure", err);
    return json({ error: "Analysis failed unexpectedly — retry in a moment." }, 500);
  }
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  return handle(req, u.searchParams.get("ca") ?? u.searchParams.get("address"), u.searchParams.has("fresh"), u.searchParams.get("chain"));
}

export async function POST(req: Request) {
  let body: { ca?: unknown; address?: unknown; fresh?: unknown; chain?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Body must be JSON: { "ca": "<address>" }' }, 400);
  }
  return handle(req, body.ca ?? body.address, body.fresh === true, body.chain);
}
