// Production fixture matrix (the owner's brief): every fixture scored on the new deployment and, side by side,
// on the previous one. Fixtures that move with the market assert "same tier as the previous deployment", not a
// fixed letter; structural fixtures (rugs, dead, rejected) keep their fixed expectation.
//   NEW=https://moneymagnet.vercel.app PREV=https://hoodtier-xxxx.vercel.app node scripts/fixture-matrix.mjs
const NEW = process.env.NEW ?? "https://moneymagnet.vercel.app";
const PREV = process.env.PREV ?? null;

/** [name, address, expectation]. expectation: "same" (= previous deployment), a set of letters, or "rejected". */
export const FIXTURES = [
  ["microduck", "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725", "same"],
  ["GIGATENEV", "0xc9675fe679c7d4e1b94416f66d61c96127eb964a", "same"],
  ["Kolshi", "0x774b0e022477e83108530a975e9edf26cc4301bf", "same"],
  ["PONS", "0x39dbed3a2bd333467115de45665cc57f813c4571", "same"],
  ["ELON", "0xccfeac099c53b7820fca922d32c30bf135f8b63a", "same"],
  ["UHI", "0xe01ada02fb4d1951cdb8cbb761d509db2ff02c94", "same"],
  ["JAMES", "0x43cf5407bda1400498b8064d50a7e17528d87777", "same"],
  ["cell", "HTLSJSroPYreXR6xQXL9MEcjSs9jLaRrS5pAeUCzpump", "same"],
  ["NETANYAHU", "59QQe9CpYc3ysgpKUrpc4C2LgcVZPoB3ycBUyKBnpump", "same"],
  ["PEEK", "A7Hm1SaHZZz8ZKFqZpsnZoGhri9f1iHEzYBPQGiPpump", "F"],
  ["Pairless", "4RERijtnnUKnSLtGZEgmAEpCJCWJP86pTGKf1c9Kpump", "F"],
  ["offline", "4Kz2m4F347YzLyvgHDjqD1pS8p4NGV64Mucaj7LXpump", "F"],
  ["Tolybot", "GG9V99Qe21knHbRLT7VRfTqZf2x6FMhkWMuAFUDtpump", "F"],
  ["NUZL", "0x92e4a26c08a91143588b2ef3200faebbdcf34db9", "F"],
  ["YMB", "0x07ffff586c62915163517af9fece936b70456b70", "F"],
  ["POD", "0x34f125328f1bb97c865680a12cfb1766f88dafb6", "F"],
  ["NVDA", "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", "rejected"],
  // Ethereum (added with chain id 1): the previous deployment has no Ethereum, so these carry fixed letters, not "same".
  // PEPE is on Ethereum only, so the no-chain request resolves to Ethereum.
  ["PEPE (ETH)", "0x6982508145454ce325ddbe47a25d4ec3d2311933", "ABC"],
  ["WETH (ETH)", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "rejected"],
];

async function analyze(base, address) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${base}/api/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, fresh: true }), signal: AbortSignal.timeout(90_000) });
      const body = await res.json().catch(() => ({}));
      if (res.status >= 500 && attempt === 0) continue;
      const r = body.report ?? body;
      return { status: res.status, tier: r.tier ?? null, score: r.score ?? null, reason: (r.tierReason ?? body.error ?? body.message ?? "").slice(0, 150), failed: (r.sourceStatus ?? []).filter((s) => s.state === "failed").map((s) => s.id) };
    } catch (e) {
      if (attempt === 1) return { status: 0, tier: null, score: null, reason: String(e.message ?? e).slice(0, 120), failed: [] };
    }
  }
}

const rejected = (r) => r.status >= 400 && r.status < 500 && !r.tier;
let fails = 0;
for (const [name, address, want] of FIXTURES) {
  const [n, p] = await Promise.all([analyze(NEW, address), PREV ? analyze(PREV, address) : Promise.resolve(null)]);
  let ok;
  if (want === "rejected") ok = rejected(n);
  else if (want === "same") ok = p ? n.tier === p.tier : !!n.tier;
  else ok = want.includes(n.tier);
  if (!ok) fails++;
  const prev = p ? ` | prev ${p.tier ?? `HTTP ${p.status}`} ${p.score ?? ""}` : "";
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(10)} want ${want.padEnd(8)} new ${n.tier ?? `HTTP ${n.status}`} ${n.score ?? ""}${prev}${n.failed.length ? ` | failed: ${n.failed.join(",")}` : ""}\n      ${n.reason}`);
}
console.log(fails ? `\n${fails} of ${FIXTURES.length} differ` : `\nALL ${FIXTURES.length} OK`);
process.exit(fails ? 1 : 0);
