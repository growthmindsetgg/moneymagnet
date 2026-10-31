import { NextResponse } from "next/server";
import { peekReport } from "@/lib/analyze";
import { isChain } from "@/lib/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The research view's "Raw data" (snapshot + every source's raw payload), loaded on demand from the
 * 2-minute result cache — kept out of the page HTML so the result page stays light. Never runs an analysis.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const chain = u.searchParams.get("chain");
  const address = u.searchParams.get("address");
  if (!isChain(chain) || !address) return NextResponse.json({ error: "chain and address required" }, { status: 400 });
  const simulate = u.searchParams.get("simulate") === "hoodscan-down" ? ("hoodscan-down" as const) : undefined;
  const hit = await peekReport(address, { chain, simulate });
  if (!hit) return NextResponse.json({ error: "This result is no longer cached (2 minutes) — use Retry sources to re-run it." }, { status: 404 });
  return NextResponse.json({ generatedAt: hit.report.generatedAt, snapshot: hit.report.token, raw: hit.report.raw ?? null }, { headers: { "cache-control": "no-store" } });
}
