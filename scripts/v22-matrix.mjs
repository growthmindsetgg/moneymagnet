// v2.2 fixture matrix on production (spec LOOP step 2) + parallel-vs-sequential consistency (step 3).
//   BASE=https://hoodtier.vercel.app node scripts/v22-matrix.mjs [--parallel-only]
const BASE = process.env.BASE ?? "https://hoodtier.vercel.app";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parallelOnly = process.argv.includes("--parallel-only");

async function analyze(address, { fresh = true } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/api/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, fresh }) });
    if (res.status === 429 && attempt < 6) {
      await sleep((Number(res.headers.get("retry-after")) || 20) * 1000 + 500);
      continue;
    }
    return { status: res.status, body: await res.json() };
  }
}
const fired = (r) => (r.rules ?? []).filter((x) => x.state === "fired").map((x) => x.id);
const ammLiquidity = async (mint) => {
  const j = await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)).json();
  return Math.max(0, ...(j.pairs ?? []).filter((p) => !/^pump-?fun$/i.test(p.dexId)).map((p) => p.liquidity?.usd ?? 0));
};
async function newestPumpMint() {
  const res = await fetch("https://three.ws/api/pump-fun-mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_new_tokens", arguments: { limit: 3 } } }),
  });
  const t = (await res.text()).replace(/^data: /m, "");
  return JSON.parse(JSON.parse(t).result.content[0].text).tokens[0].mint;
}

const rows = [];
const check = (name, address, ok, detail) => {
  rows.push({ name, address, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(11)} ${detail}`);
};
const line = (r) => `${r.tier} ${r.score ?? "–"} · cov ${r.coveragePct}% · ${r.binding?.text ?? ""}`;

if (!parallelOnly) {
  const M = [
    ["microduck", "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725", (r) => ["A", "S"].includes(r.tier) && (r.token.deployerSoldPct ?? 0) < 5 && !fired(r).includes("top_holder_bundle"), (r) => `${line(r)} · dev sold ${r.token.deployerSoldPct}%`],
    ["GIGATENEV", "0xc9675fe679c7d4e1b94416f66d61c96127eb964a", (r) => !fired(r).includes("dev_sold") && (["S", "A", "B"].includes(r.tier) || r.binding?.kind === "gate"), (r) => `${line(r)} · dev sold ${r.token.deployerSoldPct}%`],
    ["Kolshi", "0x774b0e022477e83108530a975e9edf26cc4301bf", (r) => !fired(r).includes("top_holder_bundle"), (r) => `${line(r)} · top1 ${r.token.top1SharePct?.toFixed(2)}%`],
    ...[
      ["NUZL", "0x92e4a26c08a91143588b2ef3200faebbdcf34db9"],
      ["YMB", "0x07ffff586c62915163517af9fece936b70456b70"],
      ["ELON", "0xccfeac099c53b7820fca922d32c30bf135f8b63a"],
    ].map(([n, a]) => [n, a, (r) => r.token.sellable != null && r.coveragePct >= 80 && (r.token.top1SharePct ?? 0) < 50, (r) => `${line(r)} · sellable ${r.token.sellable} · top1 ${r.token.top1SharePct?.toFixed(1)}% · ${r.sourceStatus.find((s) => s.id === "rh-sim")?.message?.slice(0, 90)}`]),
    ["Jinifer", "0xbe0372a2f56d09329bc22e7256f294543689f885", (r) => r.tier === "F", line],
    ["Conductor", "0x2da3e1690b131d4a935d51b9f9fa68b064a34cc1", (r) => r.tier === "F", line],
    ["PANGEA", "0x30de7ae4c9578d110a97367ede9f7765cdce06ea", (r) => r.tier === "F", line],
    ["Pairless", "4RERijtnnUKnSLtGZEgmAEpCJCWJP86pTGKf1c9Kpump", (r) => r.tier === "F", line],
    ["offline", "4Kz2m4F347YzLyvgHDjqD1pS8p4NGV64Mucaj7LXpump", (r) => r.tier === "F", line],
    ["Tolybot", "GG9V99Qe21knHbRLT7VRfTqZf2x6FMhkWMuAFUDtpump", (r) => r.tier === "F", line],
    ["Pepechi", "BRQvgCheuPEi2Z65q94VBQ6zD6naVnsbtSzJgod5pump", (r) => ["C", "D", "F"].includes(r.tier), (r) => `${line(r)} · bundle ${r.token.bundleScore} · snipe ${r.token.snipeRatioPct}`],
  ];
  for (const [name, address, ok, detail] of M) {
    const { status, body } = await analyze(address);
    if (status !== 200) check(name, address, false, `HTTP ${status} ${JSON.stringify(body).slice(0, 120)}`);
    else check(name, address, ok(body), detail(body));
    await sleep(5_200);
  }
  // Stock token is rejected.
  const nvda = await analyze("0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec");
  check("NVDA", "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", nvda.status === 422 && nvda.body.rejected === "stock token — HoodTier scores memecoins only", `HTTP ${nvda.status} · ${nvda.body.rejected ?? nvda.body.tier}`);
  // Graduated pump.fun tokens: liquidity is the graduated (AMM) pool's.
  for (const [name, mint] of [
    ["cell", "HTLSJSroPYreXR6xQXL9MEcjSs9jLaRrS5pAeUCzpump"],
    ["NETANYAHU", "59QQe9CpYc3ysgpKUrpc4C2LgcVZPoB3ycBUyKBnpump"],
  ]) {
    await sleep(5_200);
    const [{ status, body }, amm] = await Promise.all([analyze(mint), ammLiquidity(mint)]);
    const liq = body.token?.liquidityUsd;
    const fromAmm = status === 200 && liq != null && amm > 0 && Math.abs(liq - amm) / amm < 0.25;
    check(name, mint, fromAmm, `${status === 200 ? line(body) : `HTTP ${status}`} · liquidity $${liq?.toFixed?.(0)} vs AMM pool $${amm.toFixed(0)} · wash ${body.token?.washFlag} (vol/liq ${body.token?.volLiqRatio?.toFixed?.(1)})`);
  }
  // A pump.fun mint minutes old is U "too early".
  await sleep(5_200);
  const fresh = await newestPumpMint();
  const f = await analyze(fresh);
  // §7a: U "too early" only while < 5 min AND < 10 buyers; otherwise a numeric score.
  const early = (f.body.token?.ageMinutes ?? 99) < 5 && (f.body.token?.uniqueBuyers ?? 99) < 10;
  check("new mint", fresh, f.status === 200 && (early ? f.body.tier === "U" && /too early/.test(f.body.binding?.text ?? "") : typeof f.body.score === "number"), `${f.status === 200 ? line(f.body) : `HTTP ${f.status}`} · age ${f.body.token?.ageMinutes} min · buyers ${f.body.token?.uniqueBuyers}`);
  // §7c fixture: PEEK is F (dead launch) with coverage ≥ 90% and a numeric score.
  await sleep(5_200);
  const peek = await analyze("A7Hm1SaHZZz8ZKFqZpsnZoGhri9f1iHEzYBPQGiPpump");
  check("PEEK", "A7Hm1SaHZZz8ZKFqZpsnZoGhri9f1iHEzYBPQGiPpump", peek.status === 200 && peek.body.tier === "F" && peek.body.coveragePct >= 90 && typeof peek.body.score === "number", peek.status === 200 ? line(peek.body) : `HTTP ${peek.status}`);
}

// Step 3: 10 analyses in parallel; Helius must not 429; tiers equal a sequential run.
const P = [
  "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725",
  "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
  "4Kz2m4F347YzLyvgHDjqD1pS8p4NGV64Mucaj7LXpump",
  "HTLSJSroPYreXR6xQXL9MEcjSs9jLaRrS5pAeUCzpump",
  "59QQe9CpYc3ysgpKUrpc4C2LgcVZPoB3ycBUyKBnpump",
  "4RERijtnnUKnSLtGZEgmAEpCJCWJP86pTGKf1c9Kpump",
  "GG9V99Qe21knHbRLT7VRfTqZf2x6FMhkWMuAFUDtpump",
  "BRQvgCheuPEi2Z65q94VBQ6zD6naVnsbtSzJgod5pump",
  "0x774b0e022477e83108530a975e9edf26cc4301bf",
  "0xc9675fe679c7d4e1b94416f66d61c96127eb964a",
];
if (!parallelOnly) await sleep(61_000);
console.log("\n10 analyses in parallel…");
const par = await Promise.all(P.map((a) => analyze(a)));
const helius429 = par.filter((p) => (p.body.sourceStatus ?? []).some((s) => s.id === "helius" && /429|too many/i.test(s.message ?? ""))).length;
check("parallel", "-", helius429 === 0, `${par.filter((p) => p.status === 200).length}/10 OK · Helius 429 in ${helius429} reports`);
await sleep(61_000);
console.log("…and the same 10 sequentially (cache bypassed)");
const seq = [];
for (const a of P) {
  seq.push(await analyze(a));
  await sleep(5_200);
}
const diffs = P.filter((a, i) => par[i].body.tier !== seq[i].body.tier).map((a, i) => `${a.slice(0, 8)} ${par[P.indexOf(a)].body.tier}≠${seq[P.indexOf(a)].body.tier}`);
check("consistent", "-", diffs.length === 0, diffs.length ? `tiers differ: ${diffs.join(", ")}` : `same tiers: ${P.map((a, i) => seq[i].body.tier).join(" ")}`);

const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} rows hold`);
if (failed.length) process.exit(1);
