// v2.4 distribution check: score a live sample of 100 tokens and assert the tier spread.
//   pnpm distribution collect [out.json]           — sample HoodScan discover + pump.fun new, collect snapshots
//   pnpm distribution score <in.json> [factors.json] — rescore the saved snapshots (deterministic, for tuning)
//   pnpm distribution collect-list <list.json> <out.json> — collect a fixed list ([{from, address, rank?}]), e.g. the known-good set
//   pnpm distribution score-good <in.json> [factors.json] — known-good check: first 20 eligible per group (by rank) + named extras
// Junk pass: ≤ 10% of rated tokens land A/S, and no token with FDV < $10k scores above D.
// Known-good pass: ≥ 30% of rated tokens land A/S, and every F names the gate that forced it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { collect } from "@/lib/analyze";
import { detectChain, normalizeAddress } from "@/lib/chain";
import { mcpCall } from "@/lib/sources/http";
import { DEFAULT_FEED_URL } from "@/lib/sources/pumpfeed";
import { loadConfig } from "@/lib/scoring/config";
import { scoreSnapshot } from "@/lib/scoring/engine";
import { deriveMetrics } from "@/lib/snapshot";
import { eligibility, knownNonMeme, stockRegistry } from "@/lib/memeFilter";
import type { SourceStatus, TokenSnapshot } from "@/lib/types";

interface Saved {
  from: string;
  rank?: number;
  address: string;
  snapshot?: TokenSnapshot;
  sources?: SourceStatus[];
  rejected?: string;
}

const pick = (x: unknown): Record<string, unknown>[] => {
  const o = x as Record<string, unknown>;
  for (const k of ["tokens", "rows", "items", "results", "data"]) if (Array.isArray(o?.[k])) return o[k] as Record<string, unknown>[];
  return Array.isArray(x) ? (x as Record<string, unknown>[]) : [];
};
const addrOf = (t: Record<string, unknown>): string => {
  const inner = t.token && typeof t.token === "object" ? (t.token as Record<string, unknown>) : null;
  return inner ? addrOf(inner) : String(t.address ?? t.mint ?? t.token_address ?? t.contract ?? t.ca ?? "");
};

async function sample(): Promise<{ from: string; address: string }[]> {
  const out = new Map<string, string>();
  const hs = await mcpCall("https://hoodscan.co/mcp", "discover_tokens", { view: "ranked", signal: "all", window_minutes: 1440, limit: 50, min_buyers: 1, include_suspicious: true }, 30_000);
  for (const t of pick(hs)) if (addrOf(t)) out.set(addrOf(t).toLowerCase(), "hoodscan discover");
  if (process.env.DIST_SOURCES === "hoodscan") return [...out].map(([address, from]) => ({ address, from }));
  const pf = await mcpCall(DEFAULT_FEED_URL, "get_new_tokens", { limit: 50 }, 30_000);
  for (const t of pick(pf)) if (addrOf(t)) out.set(addrOf(t), "pump.fun new");
  return [...out].map(([address, from]) => ({ address, from }));
}

async function runCollect(file: string, fixed?: { from: string; address: string; rank?: number }[]) {
  // Re-running tops the file up: addresses already collected are kept, not re-fetched.
  const saved: Saved[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const have = new Set(saved.map((x) => x.address.toLowerCase()));
  const list = (fixed ?? (await sample())).filter((x) => !have.has(x.address.toLowerCase()));
  console.log(`sample: ${list.length} (${list.filter((x) => x.from === "pump.fun new").length} pump.fun new, ${list.filter((x) => x.from !== "pump.fun new").length} HoodScan)`);
  const stocks = await stockRegistry();
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const item = list[i++];
      const chain = detectChain(item.address);
      if (!chain) continue;
      const address = normalizeAddress(chain, item.address);
      const refused = knownNonMeme(chain, address, chain === "robinhood" ? stocks : undefined);
      if (refused) {
        saved.push({ ...item, address, rejected: refused.rejected ?? "not a meme" });
        continue;
      }
      try {
        const { snapshot, sources } = await collect(chain, address, { fresh: true });
        const meme = eligibility(snapshot, chain === "robinhood" ? stocks : undefined);
        saved.push(meme.meme ? { ...item, address, snapshot, sources } : { ...item, address, rejected: meme.rejected ?? "not a meme" });
        console.log(`${saved.length}/${list.length} ${snapshot.symbol ?? address.slice(0, 8)}`);
      } catch (e) {
        saved.push({ ...item, address, rejected: `error: ${(e as Error).message.slice(0, 100)}` });
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  writeFileSync(file, JSON.stringify(saved));
  console.log(`saved ${saved.length} → ${file}`);
}

/** Known-good selection: the first 20 eligible tokens of each ranked group, plus every unranked (named) extra. */
function knownGood(saved: Saved[]): Saved[] {
  const out: Saved[] = [];
  const groups = new Map<string, Saved[]>();
  for (const x of saved.filter((y) => y.snapshot)) {
    if (x.rank == null) out.push(x);
    else groups.set(x.from, [...(groups.get(x.from) ?? []), x]);
  }
  for (const g of groups.values()) out.push(...g.sort((a, b) => a.rank! - b.rank!).slice(0, 20));
  return out;
}

function runScore(file: string, factors?: string, good = false) {
  const cfg = factors ? loadConfig(JSON.parse(readFileSync(factors, "utf8"))) : undefined;
  const all = JSON.parse(readFileSync(file, "utf8")) as Saved[];
  const saved = good ? knownGood(all) : all;
  if (good) for (const x of all.filter((y) => !y.snapshot)) console.log(`excluded: ${x.from} ${x.address} — ${x.rejected}`);
  // Re-run the wash heuristic with the current code, so snapshots collected earlier are judged by today's rule.
  for (const x of saved) {
    const s = x.snapshot;
    if (!s) continue;
    const heuristic = s.fakeSignals.filter((f) => f.kind === "wash" && f.source === "HoodTier heuristic");
    if (s.washFlag && heuristic.length && !heuristic.some((f) => f.level !== "danger" && f.level !== "warn")) {
      s.fakeSignals = s.fakeSignals.filter((f) => !heuristic.includes(f));
      s.washFlag = null;
      x.snapshot = deriveMetrics(s);
    }
  }
  const rows = saved.filter((x) => x.snapshot).map((x) => {
    const r = scoreSnapshot(x.snapshot!, x.sources ?? [], cfg);
    return { sym: x.snapshot!.symbol ?? x.address.slice(0, 8), from: x.from, chain: x.snapshot!.chain, tier: r.tier, score: r.score, raw: r.rawScore, fdv: x.snapshot!.fdvUsd, liq: x.snapshot!.liquidityUsd, age: x.snapshot!.ageHours, binding: r.binding?.text ?? "", gates: [...r.gates, ...r.rules].filter((g) => g.state === "fired" && ("gate" in g ? g.gate : true)).map((g) => g.label) };
  });
  const by: Record<string, number> = {};
  for (const r of rows) by[r.tier] = (by[r.tier] ?? 0) + 1;
  const rated = rows.filter((r) => r.tier !== "U");
  const top = rated.filter((r) => r.tier === "A" || r.tier === "S");
  const tinyAboveD = rows.filter((r) => r.fdv != null && r.fdv < 10_000 && ["S", "A", "B", "C"].includes(r.tier));
  for (const r of rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))) {
    const usd = (v: number | null) => (v == null ? "?" : `$${Math.round(v).toLocaleString("en-US")}`);
    console.log(`${r.tier} ${String(r.score ?? "–").padStart(5)} (raw ${String(r.raw).padStart(5)})  ${r.sym.slice(0, 14).padEnd(14)} ${r.chain.padEnd(9)} fdv ${usd(r.fdv).padStart(12)} liq ${usd(r.liq).padStart(10)} age ${r.age == null ? "?" : r.age.toFixed(1) + "h"}  ${r.binding.slice(0, 70)}`);
  }
  const share = rated.length ? (top.length / rated.length) * 100 : 0;
  if (good) {
    const fs = rows.filter((r) => r.tier === "F");
    const ungated = fs.filter((r) => !r.gates.length && !/^(gate|cap): /.test(r.binding));
    console.log(`\nknown-good · scored ${rows.length} · tiers ${["S", "A", "B", "C", "D", "F", "U"].map((t) => `${t} ${by[t] ?? 0}`).join(" · ")}`);
    console.log(`A/S share of rated: ${top.length}/${rated.length} = ${share.toFixed(1)}% (needs ≥ 30%) ${share >= 30 ? "✓" : "✗"}`);
    for (const r of fs) console.log(`  F ${r.sym}: ${r.binding} · gates fired: ${r.gates.join("; ") || "none"}`);
    console.log(`F without a named gate: ${ungated.length} ${ungated.length ? "✗ " + ungated.map((r) => r.sym).join(", ") : "✓"}`);
    process.exitCode = share >= 30 && !ungated.length ? 0 : 1;
    return;
  }
  console.log(`\nscored ${rows.length} (rejected ${saved.length - rows.length}) · tiers ${["S", "A", "B", "C", "D", "F", "U"].map((t) => `${t} ${by[t] ?? 0}`).join(" · ")}`);
  console.log(`A/S share of rated: ${top.length}/${rated.length} = ${share.toFixed(1)}% (limit 10%) ${share <= 10 ? "✓" : "✗"}`);
  console.log(`FDV < $10k above D: ${tinyAboveD.length} ${tinyAboveD.length ? "✗ " + tinyAboveD.map((r) => r.sym).join(", ") : "✓"}`);
  process.exitCode = share <= 10 && !tinyAboveD.length ? 0 : 1;
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "collect") await runCollect(a ?? "distribution.json");
else if (cmd === "collect-list") await runCollect(b, JSON.parse(readFileSync(a, "utf8")));
else if (cmd === "score") runScore(a ?? "distribution.json", b);
else if (cmd === "score-good") runScore(a, b, true);
else console.log("usage: distribution collect [out.json] | collect-list <list.json> <out.json> | score <in.json> [factors.json] | score-good <in.json> [factors.json]");
