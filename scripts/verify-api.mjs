// LOOP step 2: start the production server, hit /api/analyze for each fixture address,
// and fail on non-200s, missing tiers, thin reports or uncaught errors in the server log.
// Requires `pnpm build` first.
import { spawn, execSync } from "node:child_process";

const PORT = Number(process.env.VERIFY_PORT ?? 3100);
const BASE = `http://localhost:${PORT}`;
const ADDRESSES = [
  "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725",
  "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
  "4Kz2m4F347YzLyvgHDjqD1pS8p4NGV64Mucaj7LXpump",
  "0x30de7ae4c9578d110a97367ede9f7765cdce06ea",
  // v3: a Base and a Monad token (0x, no chain given — resolved across the EVM chains).
  "0x532f27101965dd16442e59d40670faf5ebb142e4",
  "0x350035555e10d9afaf1566aaebfced5ba6c27777",
];

const server = spawn("npx", ["next", "start", "-p", String(PORT)], { shell: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

function stop() {
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
    } catch {}
  } else server.kill("SIGTERM");
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("server did not start within 60s");
}

const failures = [];
try {
  await waitReady();
  for (const address of ADDRESSES) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const body = await res.json().catch(() => ({}));
    const groupsWithData = (body.groups ?? []).filter((g) => g.hasData).length;
    const line = `${address.slice(0, 10)}… HTTP ${res.status} tier=${body.tier} score=${body.score} groups=${groupsWithData}/4 ${Date.now() - t0}ms`;
    console.log(line);
    if (res.status !== 200) failures.push(`${address}: HTTP ${res.status}`);
    if (!body.tier) failures.push(`${address}: no tier`);
    if (groupsWithData < 3) failures.push(`${address}: only ${groupsWithData}/4 groups have data`);
    for (const s of body.sourceStatus ?? []) console.log(`   ${s.id.padEnd(14)} ${s.state.padEnd(8)} ${s.message ?? ""}`);
  }
  // Page render check for the shareable URL. Replaced (v3 §2): a cold page fetches the analysis from the
  // browser (LiveReport), so the server HTML is the loader; a warm page (result < 2 min old) renders the
  // tier server-side. Both are asserted — re-warm microduck first (the loop above can take > 2 min).
  await fetch(`${BASE}/api/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: ADDRESSES[0] }) });
  const page = await fetch(`${BASE}/t/robinhood/${ADDRESSES[0]}`);
  const html = await page.text();
  if (page.status !== 200 || !html.includes('data-testid="tier-letter"')) failures.push(`warm /t page did not render a tier server-side (HTTP ${page.status})`);
  else console.log("/t/robinhood/<microduck> warm page renders tier server-side ✓");
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const coldMint = "So1Verify" + Array.from({ length: 35 }, () => B58[Math.floor(Math.random() * 58)]).join("");
  const cold = await fetch(`${BASE}/t/solana/${coldMint}`);
  const coldHtml = await cold.text();
  if (cold.status !== 200 || !coldHtml.includes('data-testid="loading"')) failures.push(`cold /t page did not render the live loader (HTTP ${cold.status})`);
  else console.log("cold /t page renders the live loader (data call from the browser) ✓");
} catch (e) {
  failures.push(String(e));
} finally {
  stop();
}

const uncaught = log.split("\n").filter((l) => /uncaught|unhandled|⨯|TypeError|ReferenceError/i.test(l));
if (uncaught.length) failures.push(`uncaught errors in server log:\n  ${uncaught.join("\n  ")}`);

if (failures.length) {
  console.error("\nVERIFY FAILED:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("\nVERIFY OK");
process.exit(0);
