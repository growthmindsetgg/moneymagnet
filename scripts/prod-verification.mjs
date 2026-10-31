// Production check for the cross-source verification layer: analyze the four fixtures on BASE and
// print verified / single / disputed counts, every disputed metric, and APIs flagged stale/wrong.
//   BASE=https://hoodtier.vercel.app node scripts/prod-verification.mjs
const BASE = process.env.BASE ?? "https://hoodtier.vercel.app";
const TOKENS = {
  microduck: "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725",
  offline: "4Kz2m4F347YzLyvgHDjqD1pS8p4NGV64Mucaj7LXpump",
  PANGEA: "0x30de7ae4c9578d110a97367ede9f7765cdce06ea",
  Fartcoin: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
};
const fmt = (v) => (typeof v === "number" ? (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 1000) / 1000)) : String(v));
let bad = 0;
for (const [name, address] of Object.entries(TOKENS)) {
  const res = await fetch(`${BASE}/api/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, fresh: true }) });
  if (!res.ok) {
    console.log(`✗ ${name}: HTTP ${res.status}`);
    bad++;
    continue;
  }
  const r = await res.json();
  const v = r.verification;
  if (!v) {
    console.log(`✗ ${name}: no verification in the report`);
    bad++;
    continue;
  }
  console.log(`\n${name} — ${r.tier} ${r.score ?? "–"} · ${v.verified} verified · ${v.single} single · ${v.disputed} disputed`);
  for (const m of v.metrics.filter((x) => x.status === "disputed")) {
    console.log(`  disputed ${m.metric}: ${m.values.map((x) => `${x.label}${x.onchain ? " (chain)" : ""}=${fmt(x.value)}`).join(", ")} → ${fmt(m.chosen)} · ${m.resolution}`);
  }
  for (const s of r.sourceStatus) for (const f of s.flags ?? []) console.log(`  flag ${s.label}: ${f}`);
}
if (bad) process.exit(1);
console.log("\nPROD VERIFICATION OK");
