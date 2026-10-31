import { NextResponse } from "next/server";
import { kvSet } from "@/lib/kv";
import { LIBRARY_KEY, loadLibrary, reconstructToken } from "@/lib/timemachine";
import type { Archetype } from "@/lib/timemachine/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const WEEK_MS = 7 * 24 * 3_600_000;
const BUDGET_MS = 240_000;

/**
 * Weekly refresh (Vercel cron, see vercel.json): rebuilds archetypes older than 7 days, oldest
 * first, within the function's time budget, and stores the library in KV. Ranking new candidates
 * (new top graduations, new honeypots) is `pnpm timemachine:build`.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const t0 = Date.now();
  const lib = await loadLibrary();
  const stale = lib.archetypes.filter((a) => Date.now() - Date.parse(a.builtAt) > WEEK_MS).sort((a, b) => Date.parse(a.builtAt) - Date.parse(b.builtAt));
  const refreshed: string[] = [];
  const failed: string[] = [];
  for (const a of stale) {
    if (Date.now() - t0 > BUDGET_MS) break;
    try {
      const rec = await reconstructToken(a.chain, a.address, 72, { maxTx: 4000, maxLogs: 400_000 });
      const next: Archetype = { ...rec, kind: a.kind, source: a.source, peakMcapUsd: a.peakMcapUsd, symbol: rec.symbol ?? a.symbol };
      lib.archetypes = lib.archetypes.map((x) => (x.address === a.address && x.kind === a.kind ? next : x));
      refreshed.push(a.symbol ?? a.address);
    } catch (err) {
      failed.push(`${a.symbol ?? a.address}: ${(err as Error).message.slice(0, 80)}`);
    }
  }
  if (refreshed.length) await kvSet(LIBRARY_KEY, { ...lib, builtAt: new Date().toISOString() });
  return NextResponse.json({ stale: stale.length, refreshed, failed, ms: Date.now() - t0 });
}
