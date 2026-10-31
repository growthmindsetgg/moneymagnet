// v2.3 production matrix (run after scripts/v22-matrix.mjs). BASE=https://hoodtier.vercel.app node scripts/v23-matrix.mjs
const BASE = process.env.BASE ?? "https://hoodtier.vercel.app";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function analyze(address) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/api/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, fresh: true }) });
    if (res.status === 429 && attempt < 6) {
      await sleep((Number(res.headers.get("retry-after")) || 20) * 1000 + 500);
      continue;
    }
    return { status: res.status, body: await res.json() };
  }
}
const rows = [];
const check = (name, ok, detail) => {
  rows.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(12)} ${detail}`);
};
const line = (r) => `${r.tier} ${r.score ?? "–"} · raw ${r.rawScore} · cov ${r.coveragePct}% · ${r.binding?.text ?? ""}`;
const sim = (r) => (r.sourceStatus ?? []).find((s) => s.id === "rh-sim")?.message ?? "";
const fired = (r) => (r.rules ?? []).filter((x) => x.state === "fired").map((x) => x.id);

const M = [
  ["ELON", "0xccfeac099c53b7820fca922d32c30bf135f8b63a", (r) => r.token.sellable === true, (r) => `${line(r)} · ${sim(r).slice(0, 220)}`],
  ...[
    ["NUZL", "0x92e4a26c08a91143588b2ef3200faebbdcf34db9"],
    ["YMB", "0x07ffff586c62915163517af9fece936b70456b70"],
    ["POD", "0x451f509516a6c742bbc7b4869ad8f8de33823929"],
  ].map(([n, a]) => [n, a, (r) => /Liquidity removed|Dead/.test(r.binding?.text ?? "") && !/Honeypot/.test(r.binding?.text ?? ""), (r) => `${line(r)} · last trade ${r.token.lastTradeHoursAgo?.toFixed?.(1)}h ago · ${sim(r).slice(0, 140)}`]),
  ["PEEK", "A7Hm1SaHZZz8ZKFqZpsnZoGhri9f1iHEzYBPQGiPpump", (r) => r.tier === "F" && typeof r.score === "number" && r.coveragePct >= 90, line],
  ["cell", "HTLSJSroPYreXR6xQXL9MEcjSs9jLaRrS5pAeUCzpump", (r) => r.coveragePct >= 90, line],
  ["NETANYAHU", "59QQe9CpYc3ysgpKUrpc4C2LgcVZPoB3ycBUyKBnpump", (r) => r.coveragePct >= 90 && ["S", "A"].includes(r.tier), (r) => `${line(r)} · dev sold ${r.token.deployerSoldPct}% (distributed ${r.token.deployerDistributedPct}%)`],
  ["Pairless", "4RERijtnnUKnSLtGZEgmAEpCJCWJP86pTGKf1c9Kpump", (r) => r.coveragePct >= 90, line],
  ["Fartcoin", "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump", (r) => r.coveragePct >= 90, (r) => `${line(r)} · dev sold ${r.token.deployerSoldPct}% (distributed ${r.token.deployerDistributedPct}%)`],
  ["PONS", "0x39dbed3a2bd333467115de45665cc57f813c4571", (r) => !fired(r).includes("dev_sold"), (r) => `${line(r)} · dev sold ${r.token.deployerSoldPct}%, distributed ${r.token.deployerDistributedPct}%`],
];
for (const [name, address, ok, detail] of M) {
  const { status, body } = await analyze(address);
  check(name, status === 200 && ok(body), status === 200 ? detail(body) : `HTTP ${status} ${JSON.stringify(body).slice(0, 100)}`);
  await sleep(5_200);
}

// 10 parallel analyses of GIGATENEV / PONS / microduck: no RPC 429 in the sell sim or holder reads, no stale fields.
await sleep(61_000);
const P = ["0xc9675fe679c7d4e1b94416f66d61c96127eb964a", "0x39dbed3a2bd333467115de45665cc57f813c4571", "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725"];
const jobs = Array.from({ length: 10 }, (_, i) => P[i % 3]);
const res = await Promise.all(jobs.map((a) => analyze(a)));
const rpc429 = res.filter((x) => (x.body.sourceStatus ?? []).some((s) => ["rh-sim", "rpc"].includes(s.id) && /\b429\b/.test(s.message ?? ""))).length;
const stale = res.filter((x) => Object.keys(x.body.token?.staleFields ?? {}).length > 0).length;
check("parallel RH", res.every((x) => x.status === 200) && rpc429 === 0 && stale === 0, `${res.filter((x) => x.status === 200).length}/10 OK · RPC 429 in ${rpc429} · stale fields in ${stale} · tiers ${res.map((x) => x.body.tier).join(" ")}`);

const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} v2.3 rows hold`);
if (failed.length) process.exit(1);
