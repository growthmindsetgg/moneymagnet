import { NextResponse } from "next/server";
import { detectChain, normalizeAddress } from "@/lib/chain";
import { kvGet, kvSet } from "@/lib/kv";
import { defaultConfig } from "@/lib/scoring/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const key = (chain: string, address: string) => `checks:${chain}:${address.toLowerCase()}`;
const VALID = new Set(defaultConfig.manualChecks.map((c) => c.id));

function target(chainParam: unknown, addressParam: unknown) {
  if (typeof addressParam !== "string") return null;
  const chain = detectChain(addressParam, typeof chainParam === "string" ? chainParam : null);
  if (!chain || (chainParam && chainParam !== chain)) return null;
  return { chain, address: normalizeAddress(chain, addressParam) };
}

/** Manual-check ticks for a token, shared by everyone who views it. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const t = target(u.searchParams.get("chain"), u.searchParams.get("address"));
  if (!t) return NextResponse.json({ error: "invalid chain/address" }, { status: 400 });
  const stored = await kvGet<{ ticks: Record<string, boolean>; updatedAt: string }>(key(t.chain, t.address));
  return NextResponse.json({ ticks: stored?.ticks ?? {}, updatedAt: stored?.updatedAt ?? null }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  let body: { chain?: unknown; address?: unknown; ticks?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const t = target(body.chain, body.address);
  if (!t || !body.ticks || typeof body.ticks !== "object") return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const ticks = Object.fromEntries(Object.entries(body.ticks as Record<string, unknown>).filter(([id, v]) => VALID.has(id) && typeof v === "boolean")) as Record<string, boolean>;
  const value = { ticks, updatedAt: new Date().toISOString() };
  await kvSet(key(t.chain, t.address), value, 90 * 24 * 3600);
  return NextResponse.json(value);
}
