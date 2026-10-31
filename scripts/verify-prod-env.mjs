// Production checks that need the durable env vars (Upstash, Helius) — spec v2.1 item 4.
//   BASE=https://hoodtier.vercel.app SIMULATE_TOKEN=<HOODTIER_SIMULATE_TOKEN> node scripts/verify-prod-env.mjs
// 1. Stale fallback engages when HoodScan is mocked down (needs HOODTIER_SIMULATE_TOKEN in Vercel).
// 2. microduck holder replay is complete (pre-warm first: `pnpm replay 0xd5f1…` with the same Upstash env).
// 3. Liquidity history has ≥ 2 points after two analyses ≥ 60s apart.
// 4. Helius is configured (Solana Helius source is not "skipped").
const BASE = process.env.BASE ?? "https://hoodtier.vercel.app";
const MICRODUCK = "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725";
const OFFLINE = "4Kz2m4F347YzLyvgHDjqD1pS8p4NGV64Mucaj7LXpump";

async function analyze(address, extra = {}, headers = {}) {
  const res = await fetch(`${BASE}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ address, fresh: true, ...extra }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const src = (r, id) => r.sourceStatus.find((s) => s.id === id);
const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${label} — ${detail}`);
  if (!ok) failures.push(label);
};

const first = await analyze(MICRODUCK);
const rpc = src(first, "rpc");
check(/replay at block/.test(rpc.message ?? ""), "holder replay complete", rpc.message);
check(first.token.holderSource === "onchain", "holders from the on-chain replay", `holderSource=${first.token.holderSource}`);

if (process.env.SIMULATE_TOKEN) {
  const sim = await analyze(MICRODUCK, { simulate: "hoodscan-down" }, { "x-hoodtier-simulate-token": process.env.SIMULATE_TOKEN });
  const hs = src(sim, "hoodscan");
  const holders = sim.groups.find((g) => g.id === "holders");
  check(hs.state === "stale", "stale fallback when HoodScan is down", hs.message);
  check(holders.hasData && sim.tier === first.tier, "holder group scored, tier unchanged", `${first.tier} → ${sim.tier}`);
} else {
  check(false, "stale fallback when HoodScan is down", "SIMULATE_TOKEN not given (set HOODTIER_SIMULATE_TOKEN in Vercel and pass it here)");
}

console.log("   waiting 65s for a second liquidity observation…");
await new Promise((r) => setTimeout(r, 65_000));
const second = await analyze(MICRODUCK);
check(second.token.liqHistoryPoints >= 2, "liquidity history ≥ 2 points", `${second.token.liqHistoryPoints} points, 24h window: ${second.token.liqChange24hWindow}`);

const sol = await analyze(OFFLINE);
const hel = src(sol, "helius");
check(hel.state !== "skipped", "Helius configured", `${hel.state} — ${hel.message}`);

if (failures.length) {
  console.error(`\nPROD ENV CHECK FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nPROD ENV CHECK OK");
