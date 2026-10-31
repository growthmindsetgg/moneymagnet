// v2.4 production fixture matrix. BASE=https://hoodtier.vercel.app node scripts/v24-matrix.mjs
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
const usd = (v) => (v == null ? "?" : `$${Math.round(v).toLocaleString("en-US")}`);
const line = (r) => `${r.tier} ${r.score ?? "–"} · raw ${r.rawScore} · cov ${r.coveragePct}% · fdv ${usd(r.token?.fdvUsd)} liq ${usd(r.token?.liquidityUsd)} · ${r.binding?.text ?? ""}`;
const is = (...tiers) => (r) => tiers.includes(r.tier);

const M = [
  ["cell", "HTLSJSroPYreXR6xQXL9MEcjSs9jLaRrS5pAeUCzpump", is("D", "F")],
  ["UHI", "0xd16e3d92c7401a2659d054b48081c4db2d0bc92a", is("D")],
  ["microduck", "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725", is("A")],
  ["GIGATENEV", "0xc9675fe679c7d4e1b94416f66d61c96127eb964a", is("A", "B")],
  ["Kolshi", "0x774b0e022477e83108530a975e9edf26cc4301bf", is("A", "B")],
  ["PONS", "0x39dbed3a2bd333467115de45665cc57f813c4571", is("A", "B")],
  ["ELON", "0xccfeac099c53b7820fca922d32c30bf135f8b63a", is("B", "C", "D", "F")],
  ["NETANYAHU", "59QQe9CpYc3ysgpKUrpc4C2LgcVZPoB3ycBUyKBnpump", is("C")],
  ["PEEK", "A7Hm1SaHZZz8ZKFqZpsnZoGhri9f1iHEzYBPQGiPpump", is("F")],
  ["Pairless", "4RERijtnnUKnSLtGZEgmAEpCJCWJP86pTGKf1c9Kpump", is("F")],
  ["offline", "4Kz2m4F347YzLyvgHDjqD1pS8p4NGV64Mucaj7LXpump", is("F")],
  ["Tolybot", "GG9V99Qe21knHbRLT7VRfTqZf2x6FMhkWMuAFUDtpump", is("F")],
  ["NUZL", "0x92e4a26c08a91143588b2ef3200faebbdcf34db9", is("F")],
  ["YMB", "0x07ffff586c62915163517af9fece936b70456b70", is("F")],
  ["POD", "0x451f509516a6c742bbc7b4869ad8f8de33823929", is("F")],
];
let pass = 0;
for (const [name, address, ok] of M) {
  const { status, body } = await analyze(address);
  const good = status === 200 && ok(body);
  pass += good ? 1 : 0;
  console.log(`${good ? "✓" : "✗"} ${name.padEnd(10)} ${status === 200 ? line(body) : `HTTP ${status} ${JSON.stringify(body).slice(0, 100)}`}`);
  await sleep(5_200);
}
console.log(`\n${pass}/${M.length} rows hold`);
