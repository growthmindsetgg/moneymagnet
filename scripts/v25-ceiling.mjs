// v2.4 ceiling check on production: score the known-good set (first 20 eligible per ranked group + named extras).
//   BASE=https://hoodtier.vercel.app node scripts/v25-ceiling.mjs <list.json> [out.json]
// list.json: [{ from, address, rank? }]. out.json keeps each production snapshot, so `pnpm distribution score-good out.json
// [factors.json]` can rescore exactly what production saw. Pass: ≥ 30% of rated land A/S, and every F names the gate that forced it.
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE ?? "https://hoodtier.vercel.app";
const [listFile, outFile] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function analyze(address) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}/api/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, fresh: true }) });
    } catch (e) {
      // A dropped connection is the network, not the token: retry, then report it.
      if (attempt < 3) {
        await sleep(10_000);
        continue;
      }
      return { status: 0, body: { error: String(e.cause?.code ?? e.message) } };
    }
    if (res.status === 429 && attempt < 6) {
      await sleep((Number(res.headers.get("retry-after")) || 20) * 1000 + 500);
      continue;
    }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
}
const usd = (v) => (v == null ? "?" : `$${Math.round(v).toLocaleString("en-US")}`);

const list = JSON.parse(readFileSync(listFile, "utf8"));
const taken = new Map();
const rows = [];
for (const item of list) {
  if (item.rank != null && (taken.get(item.from) ?? 0) >= 20) continue;
  const { status, body } = await analyze(item.address);
  await sleep(5_200);
  if (status !== 200 && !(status >= 400 && status < 500)) {
    // A network / server failure is not a refusal: report it, never replace the token with the next rank.
    if (item.rank != null) taken.set(item.from, (taken.get(item.from) ?? 0) + 1);
    console.log(`  FAILED ${item.from} #${item.rank ?? "-"} ${item.address} — HTTP ${status} ${body.error ?? ""} (counted in the 20, not scored)`.slice(0, 200));
    continue;
  }
  if (status !== 200) {
    console.log(`  skip ${item.from} #${item.rank ?? "-"} ${item.address} — HTTP ${status} ${body.rejected ?? body.error ?? ""}`.slice(0, 200));
    continue;
  }
  if (item.rank != null) taken.set(item.from, (taken.get(item.from) ?? 0) + 1);
  const t = body.token ?? {};
  const fired = (body.rules ?? []).filter((r) => r.state === "fired").map((r) => r.id);
  const gates = [...(body.gates ?? []), ...(body.rules ?? []).filter((r) => r.gate)].filter((r) => r.state === "fired").map((r) => r.label);
  const row = { from: item.from, rank: item.rank, address: item.address, sym: t.symbol, tier: body.tier, score: body.score, raw: body.rawScore, fdv: t.fdvUsd, liq: t.liquidityUsd, vol: t.volume24hUsd, age: t.ageHours, binding: body.binding?.text ?? "", fired, gates, snapshot: t, sources: body.sourceStatus };
  rows.push(row);
  console.log(`${row.tier} ${String(row.score ?? "–").padStart(5)} raw ${String(row.raw).padStart(5)}  ${String(row.sym).slice(0, 12).padEnd(12)} ${row.from.padEnd(20)} fdv ${usd(row.fdv).padStart(14)} liq ${usd(row.liq).padStart(11)} age ${row.age == null ? "?" : (row.age / 24).toFixed(1) + "d"}  ${row.binding.slice(0, 60)} [${fired.join(",")}]`);
}
if (outFile) writeFileSync(outFile, JSON.stringify(rows, null, 1));
const by = {};
for (const r of rows) by[r.tier] = (by[r.tier] ?? 0) + 1;
const rated = rows.filter((r) => r.tier !== "U");
const top = rated.filter((r) => r.tier === "A" || r.tier === "S");
const share = rated.length ? (top.length / rated.length) * 100 : 0;
const fs = rows.filter((r) => r.tier === "F");
const ungated = fs.filter((r) => !r.gates.length && !/^(gate|cap): /.test(r.binding));
console.log(`\nknown-good · scored ${rows.length} · tiers ${["S", "A", "B", "C", "D", "F", "U"].map((t) => `${t} ${by[t] ?? 0}`).join(" · ")}`);
console.log(`A/S share of rated: ${top.length}/${rated.length} = ${share.toFixed(1)}% (needs ≥ 30%) ${share >= 30 ? "✓" : "✗"}`);
for (const r of fs) console.log(`  F ${r.sym}: ${r.binding} · gates fired: ${r.gates.join("; ") || "none"}`);
console.log(`F without a named gate: ${ungated.length} ${ungated.length ? "✗ " + ungated.map((r) => r.sym).join(", ") : "✓"}`);
const washD = rows.filter((r) => r.fired.includes("wash") && (r.fdv ?? 0) >= 1e6 && (r.age ?? 0) >= 168);
console.log(`wash-capped, ≥ $1M FDV, ≥ 7d: ${washD.length ? washD.map((r) => `${r.sym} (vol/liq ${r.liq ? (r.vol / r.liq).toFixed(1) : "?"}×, liq ${usd(r.liq)})`).join("; ") : "none"}`);
