// v3 §1d production matrix for Base, Monad and Ethereum. BASE=https://moneymagnet.vercel.app node scripts/v3-matrix.mjs
// Established memes must be rated (not F / U) with ≥ 60% coverage; launches must answer with a tier and every
// source listed; rugs must be F; blue chips must be refused (422); a token on several chains must get the picker (300).
const BASE = process.env.BASE ?? "https://moneymagnet.vercel.app";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/api/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.status === 429 && attempt < 6) {
      await sleep((Number(res.headers.get("retry-after")) || 20) * 1000 + 500);
      continue;
    }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
}
const usd = (v) => (v == null ? "?" : `$${Math.round(v).toLocaleString("en-US")}`);
const line = (r) => `${r.tier} ${r.score ?? "–"} · raw ${r.rawScore} · cov ${r.coveragePct}% · ${r.modeLabel} · fdv ${usd(r.token?.fdvUsd)} liq ${usd(r.token?.liquidityUsd)} · ${r.binding?.text ?? ""}`;
const rated = (r) => !["F", "U"].includes(r.tier) && r.coveragePct >= 60;
const anyTier = (r) => /^[SABCDFU]$/.test(r.tier) && (r.sourceStatus ?? []).length > 0;
const isF = (r) => r.tier === "F";

const M = [
  ["base", "BRETT", "0x532f27101965dd16442e59d40670faf5ebb142e4", "established", rated],
  ["base", "TOSHI", "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4", "established", rated],
  ["base", "99", "0xd44bc820aba3a4965cf6082661bb9ec543524619", "launch", anyTier],
  ["base", "ADFO", "0xf57b2065428ab1c1afb8ba4c1ec933ff8c6f9a82", "launch", anyTier],
  ["base", "小小徐", "0x5ad1d043031659a562c34803eea3b51bb2156b07", "rug", isF],
  ["monad", "CHOG", "0x350035555e10d9afaf1566aaebfced5ba6c27777", "established", rated],
  ["monad", "JAMES", "0x43cf5407bda1400498b8064d50a7e17528d87777", "established", rated],
  ["monad", "Vibe", "0x4c995d07af7ee32a08fc7094f532a91a44567777", "launch", anyTier],
  ["monad", "PERPL", "0xb47ffe20d02a827efcc9647d7db9e1a1ef287777", "launch", anyTier],
  ["monad", "NAD", "0x47c6ac22d1fbb5747b711b7d6602090c8dd37777", "rug", isF],
  ["ethereum", "PEPE", "0x6982508145454ce325ddbe47a25d4ec3d2311933", "established", rated],
  ["ethereum", "Mog", "0xaaee1a9723aadb7afa2810263653a34ba2c21c7a", "established", rated],
  ["ethereum", "PIPI", "0x7bcefbb4ea938f71e4352057d9bf6cb2122d47b9", "launch", anyTier],
];
const REFUSED = [
  ["base", "USDC", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
  ["base", "WETH", "0x4200000000000000000000000000000000000006"],
  ["monad", "WMON", "0x3bd359c1119da7da1d913d1c4d2b7c461115433a"],
  ["monad", "USDC", "0x754704bc059f8c67012fed69bc8a327a5aafb603"],
  ["ethereum", "WETH", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"],
  ["ethereum", "USDC", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
];
let pass = 0;
let total = 0;
for (const [chain, name, address, kind, ok] of M) {
  total++;
  const { status, body } = await post({ address, chain, fresh: true });
  const good = status === 200 && ok(body);
  pass += good ? 1 : 0;
  console.log(`${good ? "✓" : "✗"} ${chain.padEnd(5)} ${name.padEnd(7)} ${kind.padEnd(11)} ${status === 200 ? line(body) : `HTTP ${status} ${JSON.stringify(body).slice(0, 120)}`}`);
  if (status === 200) for (const s of body.sourceStatus.filter((x) => x.state !== "ok")) console.log(`      ${s.id} ${s.state}: ${(s.message ?? "").slice(0, 110)}`);
  await sleep(8_000);
}
for (const [chain, name, address] of REFUSED) {
  total++;
  const { status, body } = await post({ address, chain });
  const good = status === 422;
  pass += good ? 1 : 0;
  console.log(`${good ? "✓" : "✗"} ${chain.padEnd(5)} ${name.padEnd(7)} blue-chip   HTTP ${status} ${body.rejected ?? body.error ?? ""}`);
}
total++;
const dual = await post({ address: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34" });
const dualOk = dual.status === 300 && (dual.body.candidates ?? []).length >= 2;
pass += dualOk ? 1 : 0;
console.log(`${dualOk ? "✓" : "✗"} dual  USDe    picker      HTTP ${dual.status} ${(dual.body.candidates ?? []).map((c) => `${c.chain} ${usd(c.fdvUsd)}`).join(" · ")}`);
console.log(`\n${pass}/${total} rows hold`);
process.exitCode = pass === total ? 0 : 1;
