import { kvGet, kvSet } from "../kv";
import { BudgetExceeded, fetchX402 } from "./x402";

/**
 * RobinX (api.robinx.io): measured X / Telegram social data for Robinhood Chain tokens only.
 * - GET /report/:token?tier=free — free, 25/day per IP: mentions total + 24h, first mention, the earliest
 *   10 callers (handle, followers, measured caller record, coordinated-cluster flag).
 * - GET /mentions/:token — $0.02: the latest 200 mentions with each caller's record (no tweet text).
 * - GET /tg/first-call/:token — $0.03: Telegram vs X first sighting (k-anonymous: null below 3 rooms).
 * - GET /report/:token (paid) — $0.05, when the free quota is spent.
 * Paid calls need ROBINX_WALLET_KEY (x402, USDC on Base) or ROBINX_API_KEY (x-robinx-key). Spend per
 * analysis is capped at ROBINX_MAX_USD (default 0.05); results are cached for 10 minutes.
 */
export const ROBINX_API = "https://api.robinx.io";
export const ROBINX_CACHE_S = 600;
const atomicCap = () => BigInt(Math.round(Number(process.env.ROBINX_MAX_USD || 0.05) * 1e6));

export interface RobinxCaller {
  account: string;
  when: string | null;
  followers: number | null;
  verified?: boolean | null;
  coordinated: boolean | null;
  clusterId?: string | null;
  measured: boolean;
}

export interface RobinxSocial {
  mentionsTotal: number | null;
  mentions24h: number | null;
  uniquePosters24h: number | null;
  /** Follower sum over the unique 24h posters RobinX listed (null when the mention tape was not fetched). */
  reach24h: number | null;
  firstMention: { account: string; when: string; followers: number | null } | null;
  /** Earliest callers (report) — or the 24h posters (mention tape) when that was fetched. */
  posters: RobinxCaller[];
  /** Coordinated-cluster callers among the listed ones. */
  coordinatedShare: number | null;
  tg: { telegramFirst: string | null; xFirst: string | null; leadMinutes: number | null; rooms: number | null; reportable: boolean } | null;
  calls: { endpoint: string; tier: "free" | "paid" | "key"; usd: number; status: number | string }[];
  spentUsd: number;
  nullReasons: Record<string, string>;
  fetchedAt: string;
}

type Json = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

function callerOf(c: Json): RobinxCaller | null {
  const account = str(c.account) ?? str(c.handle) ?? str(c.author);
  if (!account) return null;
  const m = (c.measured ?? c.caller ?? null) as Json | null;
  return {
    account,
    when: str(c.when) ?? str(c.tweeted_at) ?? str(c.at) ?? str(c.ts),
    followers: num(c.followers),
    verified: typeof c.verified === "boolean" ? c.verified : null,
    coordinated: m && typeof m.coordinated === "boolean" ? m.coordinated : typeof c.coordinated === "boolean" ? c.coordinated : null,
    clusterId: m ? (str(m.cluster_id) ?? null) : null,
    measured: !!m,
  };
}

/** Parses /report's `social` block. Absent fields stay null. */
export function parseReportSocial(body: unknown): Pick<RobinxSocial, "mentionsTotal" | "mentions24h" | "firstMention" | "posters"> {
  const social = ((body as Json)?.data as Json | undefined)?.social as Json | undefined;
  const fm = social?.first_mention as Json | undefined;
  return {
    mentionsTotal: num(social?.mentions_total),
    mentions24h: num(social?.mentions_24h),
    firstMention: fm && str(fm.account) && str(fm.when) ? { account: str(fm.account)!, when: str(fm.when)!, followers: num(fm.followers) } : null,
    posters: ((social?.earliest_callers as Json[] | undefined) ?? []).map(callerOf).filter((c): c is RobinxCaller => !!c),
  };
}

/**
 * Parses /mentions (documented: latest 200 mentions with caller records, a full 24h count, the first-ever
 * mention, clustered vs independent voices; the response was not observed live — no paid call was made
 * while building this). Only fields that are present are used.
 */
export function parseMentions(body: unknown, now = Date.now()): { count24h: number | null; posters24h: RobinxCaller[]; total: number | null } {
  const d = ((body as Json)?.data ?? body) as Json;
  const list = ((d?.mentions ?? d?.tape ?? d?.items) as Json[] | undefined) ?? [];
  const callers = list.map(callerOf).filter((c): c is RobinxCaller => !!c);
  const recent = callers.filter((c) => c.when && now - Date.parse(c.when) <= 24 * 3_600_000);
  const unique = new Map<string, RobinxCaller>();
  for (const c of recent) if (!unique.has(c.account.toLowerCase())) unique.set(c.account.toLowerCase(), c);
  const count24h = num(d?.count_24h) ?? num(d?.mentions_24h) ?? num((d?.velocity as Json | undefined)?.count_24h) ?? null;
  return { count24h, posters24h: [...unique.values()], total: num(d?.total) ?? num(d?.mentions_total) };
}

export function parseTgFirstCall(body: unknown): RobinxSocial["tg"] {
  const d = ((body as Json)?.data ?? body) as Json;
  if (!d || typeof d !== "object") return null;
  const tgAt = str(d.telegram_first) ?? str(d.telegram_first_at) ?? str((d.telegram as Json | undefined)?.first_at);
  const xAt = str(d.x_first) ?? str(d.x_first_at) ?? str((d.x as Json | undefined)?.first_at);
  const lead = num(d.lead_minutes) ?? num(d.lead_min);
  const rooms = num(d.rooms) ?? num(d.room_count) ?? num((d.telegram as Json | undefined)?.rooms);
  return { telegramFirst: tgAt, xFirst: xAt, leadMinutes: lead, rooms, reportable: tgAt != null || lead != null };
}

interface Paid {
  get: (path: string) => Promise<{ status: number; body: unknown; usd: number; tier: "paid" | "key" } | { skipped: string }>;
}

/** Paid access: API key (no per-call payment) or x402 wallet, never above the remaining cap. */
function paidAccess(spent: { atomic: bigint }, fetchImpl: typeof fetch, maxUsd?: number): Paid {
  const cap = maxUsd != null ? BigInt(Math.round(maxUsd * 1e6)) : atomicCap();
  const apiKey = process.env.ROBINX_API_KEY;
  const wallet = process.env.ROBINX_WALLET_KEY;
  return {
    async get(path) {
      if (apiKey) {
        const res = await fetchImpl(`${ROBINX_API}${path}`, { headers: { "x-robinx-key": apiKey }, signal: AbortSignal.timeout(15_000), cache: "no-store" });
        return { status: res.status, body: await res.json().catch(() => null), usd: 0, tier: "key" };
      }
      if (!wallet) return { skipped: "ROBINX_WALLET_KEY not set (paid RobinX calls disabled)" };
      try {
        const { res, paidAtomic } = await fetchX402(`${ROBINX_API}${path}`, { privateKey: wallet, maxAtomic: cap - spent.atomic, fetchImpl });
        spent.atomic += paidAtomic;
        return { status: res.status, body: await res.json().catch(() => null), usd: Number(paidAtomic) / 1e6, tier: "paid" };
      } catch (err) {
        if (err instanceof BudgetExceeded) return { skipped: `${err.message} (cap ${Number(cap) / 1e6})` };
        throw err;
      }
    },
  };
}

/**
 * `paid`: "all" (an analysis: report + mention tape + Telegram first call, ≤ the per-analysis cap) or
 * "mentions" (the cron: the free report, and only the $0.02 mention tape when the free quota is spent).
 */
export async function robinx(address: string, opts: { fetchImpl?: typeof fetch; now?: number; cache?: boolean; paid?: "all" | "mentions"; maxUsd?: number } = {}): Promise<RobinxSocial> {
  const a = address.toLowerCase();
  const key = `social:robinx:v1:${a}`;
  const useCache = opts.cache ?? !opts.fetchImpl;
  if (useCache) {
    const hit = await kvGet<RobinxSocial>(key);
    if (hit) return hit;
  }
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();
  const spent = { atomic: 0n };
  const paid = paidAccess(spent, f, opts.maxUsd);
  const mode = opts.paid ?? "all";
  const calls: RobinxSocial["calls"] = [];
  const nullReasons: Record<string, string> = {};

  // 1. The free report.
  let report: ReturnType<typeof parseReportSocial> | null = null;
  try {
    const res = await f(`${ROBINX_API}/report/${a}?tier=free`, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
    calls.push({ endpoint: "/report?tier=free", tier: "free", usd: 0, status: res.status });
    if (res.ok) report = parseReportSocial(await res.json());
  } catch (err) {
    calls.push({ endpoint: "/report?tier=free", tier: "free", usd: 0, status: (err as Error).name === "TimeoutError" ? "timeout" : "error" });
  }
  // 2. Free quota spent (or failed): the paid report, if it fits the cap (analyses only).
  if (!report && mode === "all") {
    const r = await paid.get(`/report/${a}`).catch((e: Error) => ({ skipped: `paid report failed: ${e.message.slice(0, 80)}` }));
    if ("skipped" in r) nullReasons.report = `free tier unavailable (${calls[0]?.status}); ${r.skipped}`;
    else {
      calls.push({ endpoint: "/report", tier: r.tier, usd: r.usd, status: r.status });
      if (r.status === 200) report = parseReportSocial(r.body);
      else nullReasons.report = `paid /report answered HTTP ${r.status}`;
    }
  }
  // 3. The 24h mention tape (unique posters, reach) and 4. the Telegram first sighting — paid, within the cap.
  let mentions: ReturnType<typeof parseMentions> | null = null;
  const m = mode === "mentions" && report ? { skipped: "cron: the free report answered" } : await paid.get(`/mentions/${a}`).catch((e: Error) => ({ skipped: `failed: ${e.message.slice(0, 80)}` }));
  if ("skipped" in m) nullReasons.uniquePosters24h = nullReasons.reach24h = `RobinX /mentions ($0.02) not called: ${m.skipped}`;
  else {
    calls.push({ endpoint: "/mentions", tier: m.tier, usd: m.usd, status: m.status });
    if (m.status === 200) mentions = parseMentions(m.body, now);
    else nullReasons.uniquePosters24h = nullReasons.reach24h = `RobinX /mentions answered HTTP ${m.status}`;
  }
  let tg: RobinxSocial["tg"] = null;
  const t = mode === "mentions" ? { skipped: "cron samples post counts only" } : await paid.get(`/tg/first-call/${a}`).catch((e: Error) => ({ skipped: `failed: ${e.message.slice(0, 80)}` }));
  if ("skipped" in t) nullReasons.tg = `RobinX /tg/first-call ($0.03) not called: ${t.skipped}`;
  else {
    calls.push({ endpoint: "/tg/first-call", tier: t.tier, usd: t.usd, status: t.status });
    if (t.status === 200) tg = parseTgFirstCall(t.body);
    else nullReasons.tg = `RobinX /tg/first-call answered HTTP ${t.status}`;
  }
  if (tg && !tg.reportable) nullReasons.tg = "RobinX: fewer than 3 monitored Telegram rooms carried it (k-anonymous — not evidence it was never discussed)";

  const posters = mentions?.posters24h.length ? mentions.posters24h : (report?.posters ?? []);
  const flagged = posters.filter((p) => p.coordinated != null);
  const out: RobinxSocial = {
    mentionsTotal: mentions?.total ?? report?.mentionsTotal ?? null,
    mentions24h: mentions?.count24h ?? report?.mentions24h ?? null,
    uniquePosters24h: mentions ? mentions.posters24h.length : null,
    reach24h: mentions && mentions.posters24h.every((p) => p.followers != null) ? mentions.posters24h.reduce((s, p) => s + (p.followers ?? 0), 0) : null,
    firstMention: report?.firstMention ?? null,
    posters,
    coordinatedShare: flagged.length ? flagged.filter((p) => p.coordinated).length / flagged.length : null,
    tg,
    calls,
    spentUsd: Number(spent.atomic) / 1e6,
    nullReasons,
    fetchedAt: new Date(now).toISOString(),
  };
  if (!report && !mentions) nullReasons.mentions24h = nullReasons.report ?? "RobinX did not answer";
  if (mentions && out.reach24h == null && !nullReasons.reach24h) nullReasons.reach24h = "RobinX's mention tape omitted follower counts for some posters";
  if (useCache && (report || mentions)) await kvSet(key, out, ROBINX_CACHE_S);
  return out;
}
