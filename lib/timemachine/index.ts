import bundled from "@/data/archetypes/library.json";
import type { Chain } from "../types";
import { kvGet, kvSet } from "../kv";
import { nearest, type Match } from "./similarity";
import { heliusClient, reconstructSolana } from "./solana";
import { reconstructRobinhood } from "./robinhood";
import { BUCKETS, type ArchetypeLibrary, type Bucket, type BucketSnapshot, type Reconstruction } from "./types";

export * from "./types";

export const LIBRARY_KEY = "tm:library:v1";
const tokenKey = (chain: Chain, address: string) => `tm:token:v1:${chain}:${address}`;

/** The archetype library: the KV copy (refreshed weekly by cron) if present, else the bundled build. */
export async function loadLibrary(): Promise<ArchetypeLibrary> {
  const kv = await kvGet<ArchetypeLibrary>(LIBRARY_KEY);
  if (kv?.archetypes?.length) return kv;
  return bundled as unknown as ArchetypeLibrary;
}

/** Round the token's age down to a bucket (null under 1h). */
export function bucketFor(ageHours: number | null): Bucket | null {
  if (ageHours == null) return null;
  const fit = BUCKETS.filter((b) => b <= ageHours);
  return fit.length ? fit[fit.length - 1] : null;
}

export interface TimeMachineResult {
  status: "ok" | "unavailable";
  /** Why it is unavailable, or a note about the comparison (e.g. a fallback bucket). */
  reason: string | null;
  /** Age bucket the token is compared at. */
  bucket: Bucket | null;
  /** Bucket the token's age rounds down to (may differ when history beyond it exceeded the budget). */
  ageBucket: Bucket | null;
  token: BucketSnapshot | null;
  methods: Reconstruction["methods"];
  winners: Match[];
  rugs: Match[];
  /** Best similarity to the winner set / the rug set (0–100). */
  winnerPct: number | null;
  rugPct: number | null;
  verdict: "closer to winners" | "closer to rugs" | "no clear lean" | null;
  library: { winners: number; rugs: number; builtAt: string };
}

export const unavailable = (reason: string, lib: Pick<ArchetypeLibrary, "archetypes" | "builtAt"> = { archetypes: [], builtAt: "" }, ageBucket: Bucket | null = null): TimeMachineResult => ({
  status: "unavailable",
  reason,
  bucket: null,
  ageBucket,
  token: null,
  methods: {},
  winners: [],
  rugs: [],
  winnerPct: null,
  rugPct: null,
  verdict: null,
  library: { winners: lib.archetypes.filter((a) => a.kind === "winner").length, rugs: lib.archetypes.filter((a) => a.kind === "rug").length, builtAt: lib.builtAt },
});

/** Per-request budgets (the library build uses larger ones). A bucket past them is null, never sampled. */
const REQUEST_MAX_TX = Number(process.env.TM_REQUEST_MAX_TX || 2000);
const REQUEST_MAX_LOGS = Number(process.env.TM_REQUEST_MAX_LOGS || 60_000);

export async function reconstructToken(chain: Chain, address: string, maxBucket: number, budget: { maxTx?: number; maxLogs?: number } = {}): Promise<Reconstruction> {
  if (chain === "solana") {
    const key = process.env.HELIUS_API_KEY;
    if (!key) throw new Error("Helius key not set");
    return reconstructSolana(address, heliusClient(key), { maxBucket, maxTx: budget.maxTx ?? REQUEST_MAX_TX });
  }
  return reconstructRobinhood(address, { maxBucket, maxLogs: budget.maxLogs ?? REQUEST_MAX_LOGS });
}

/** Stores a reconstruction for a token (used by the pre-warm script with larger budgets). */
export const saveTokenReconstruction = (rec: Reconstruction) => kvSet(tokenKey(rec.chain, rec.address), rec);

/** A completed bucket is history; it never changes, so the reconstruction is cached for good. */
async function tokenReconstruction(chain: Chain, address: string, bucket: Bucket): Promise<Reconstruction> {
  const cached = await kvGet<Reconstruction>(tokenKey(chain, address));
  if (cached?.buckets.some((b) => b.bucket === bucket)) return cached;
  const rec = await reconstructToken(chain, address, bucket);
  await kvSet(tokenKey(chain, address), rec);
  return rec;
}

const usable = (b: BucketSnapshot) => Object.values(b.fields).filter((v) => v != null).length >= 4;

/**
 * Time Machine for a pasted token: rebuild it at its age bucket, then find the nearest winner and
 * rug archetypes at the same age. Information only — the score effect lives in factors.json rules.
 */
export async function timeMachine(chain: Chain, address: string, ageHours: number | null, opts: { library?: ArchetypeLibrary; reconstruct?: typeof tokenReconstruction } = {}): Promise<TimeMachineResult> {
  const lib = opts.library ?? (await loadLibrary());
  const ageBucket = bucketFor(ageHours);
  if (ageBucket == null) return unavailable(ageHours == null ? "token age unknown" : "token is younger than 1h — the first bucket is +1h", lib);
  if (!lib.archetypes.length) return unavailable("archetype library not built yet", lib, ageBucket);
  let rec: Reconstruction;
  try {
    rec = await (opts.reconstruct ?? tokenReconstruction)(chain, address, ageBucket);
  } catch (err) {
    return unavailable(`could not rebuild this token's history: ${(err as Error).message.slice(0, 120)}`, lib, ageBucket);
  }
  // Use the age bucket; when its history exceeded the budget, fall back to the latest complete one.
  const snaps = rec.buckets.filter((b) => b.bucket <= ageBucket && usable(b)).sort((a, b) => b.bucket - a.bucket);
  const snap = snaps[0];
  if (!snap) return unavailable(rec.buckets.find((b) => b.bucket === ageBucket)?.nulls.holders ?? "no reconstructable bucket", lib, ageBucket);
  const pool = lib.archetypes.filter((a) => a.address !== rec.address);
  const winners = nearest(snap.fields, snap.bucket, pool, "winner", 5);
  const rugs = nearest(snap.fields, snap.bucket, pool, "rug", 3);
  const winnerPct = winners[0]?.pct ?? null;
  const rugPct = rugs[0]?.pct ?? null;
  const verdict = winnerPct == null || rugPct == null ? null : Math.abs(winnerPct - rugPct) < 3 ? "no clear lean" : winnerPct > rugPct ? "closer to winners" : "closer to rugs";
  return {
    status: "ok",
    reason: snap.bucket !== ageBucket ? `compared at +${snap.bucket}h: the history to +${ageBucket}h exceeds the reconstruction budget` : null,
    bucket: snap.bucket,
    ageBucket,
    token: snap,
    methods: rec.methods,
    winners,
    rugs,
    winnerPct,
    rugPct,
    verdict,
    library: { winners: lib.archetypes.filter((a) => a.kind === "winner").length, rugs: lib.archetypes.filter((a) => a.kind === "rug").length, builtAt: lib.builtAt },
  };
}
