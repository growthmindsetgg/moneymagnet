import { NextResponse } from "next/server";
import { resampleSocial } from "@/lib/social/cron";
import { buildSocialLibrary } from "@/lib/social";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Social re-sample (social §1). Vercel Hobby runs crons once a day (vercel.json); the spec's 30-minute
 * cadence needs an external scheduler (or Vercel Pro) calling this with `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await resampleSocial();
  const library = await buildSocialLibrary().catch((e: Error) => ({ error: e.message }));
  console.log(`[cron/social] due ${result.due} · stored ${result.stored} · spent $${result.spentUsd} · ${result.ms}ms${result.stoppedEarly ? ` · stopped: ${result.stoppedEarly}` : ""}`);
  return NextResponse.json({ ...result, library });
}
