// LOOP steps 3 + 4: re-run microduck several times (bypassing the result cache) and assert the
// Holder conviction group always has data (live or stale) and the tier never flips because of a
// source outage. With SIMULATE=1 it also injects a HoodScan 503 (server needs HOODTIER_ALLOW_SIMULATE=1).
//   BASE=https://hoodtier.vercel.app node scripts/stability.mjs
//   node scripts/stability.mjs            (starts a local production server on :3100)
import { spawn, execSync } from "node:child_process";

const MICRODUCK = process.env.TOKEN ?? "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725";
const MIN_COVERAGE = Number(process.env.MIN_COVERAGE ?? 0);
const RUNS = Number(process.env.RUNS ?? 3);
const GAP_MS = Number(process.env.GAP_MS ?? 30_000);
let BASE = process.env.BASE;
let server;

if (!BASE) {
  BASE = "http://localhost:3100";
  server = spawn("npx next start -p 3100", { shell: true, stdio: "ignore", env: { ...process.env, HOODTIER_ALLOW_SIMULATE: "1" } });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const stop = () => {
  if (!server) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
    } catch {}
  } else server.kill();
};

async function analyze(extra = {}) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: MICRODUCK, fresh: true, ...extra }),
  });
  const r = await res.json();
  const holders = r.groups?.find((g) => g.id === "holders");
  const hs = r.sourceStatus?.find((s) => s.id === "hoodscan");
  const rpc = r.sourceStatus?.find((s) => s.id === "rpc");
  const staleCount = Object.keys(r.token?.staleFields ?? {}).length;
  console.log(
    `HTTP ${res.status} tier=${r.tier} score=${r.score} holders=${holders?.hasData ? "data" : "NONE"} hoodscan=${hs?.state} stale=${staleCount} rpc=${rpc?.state} ${Date.now() - t0}ms`,
  );
  if (rpc?.message) console.log(`   rpc: ${rpc.message.slice(0, 160)}`);
  if (hs?.state !== "ok") console.log(`   hoodscan: ${hs?.message?.slice(0, 160)}`);
  console.log(`   coverage ${r.coveragePct}% · mode ${r.modeLabel}`);
  return { status: res.status, tier: r.tier, holdersData: !!holders?.hasData, hsState: hs?.state, staleCount, coverage: r.coveragePct };
}

const failures = [];
const runs = [];
try {
  for (let i = 0; i < RUNS; i++) {
    if (i) await new Promise((r) => setTimeout(r, GAP_MS));
    const r = await analyze();
    runs.push(r);
    if (r.status !== 200) failures.push(`run ${i + 1}: HTTP ${r.status}`);
    if (!r.holdersData) failures.push(`run ${i + 1}: Holder conviction group has no data`);
    if (r.coverage < MIN_COVERAGE) failures.push(`run ${i + 1}: coverage ${r.coverage}% < ${MIN_COVERAGE}%`);
  }
  const tiers = new Set(runs.map((r) => r.tier));
  if (tiers.size > 1) {
    const outage = runs.some((r) => r.hsState !== "ok");
    failures.push(`tier flipped across runs: ${[...tiers].join(" → ")}${outage ? " (during a HoodScan outage)" : ""}`);
  }
  if ((process.env.SIMULATE === "1" || !process.env.BASE) && MICRODUCK.startsWith("0x")) {
    console.log("-- simulated HoodScan 503 --");
    const sim = await analyze({ simulate: "hoodscan-down" });
    if (!sim.holdersData) failures.push("simulated outage: holder group lost its data");
    if (sim.hsState !== "stale" || sim.staleCount === 0) failures.push(`simulated outage: expected stale HoodScan data, got ${sim.hsState} (${sim.staleCount} stale fields)`);
    if (runs.length && sim.tier !== runs[runs.length - 1].tier) failures.push(`simulated outage flipped tier ${runs[runs.length - 1].tier} → ${sim.tier}`);
  }
} catch (e) {
  failures.push(String(e));
} finally {
  stop();
}
if (failures.length) {
  console.error("\nSTABILITY FAILED:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("\nSTABILITY OK");
