// Lighthouse (mobile, default throttling) on the MoneyMagnet pages; writes reports to docs/lighthouse/.
//   BASE=http://localhost:3300 CHROME_PATH=<chrome> node scripts/lighthouse.mjs
// Pass: performance, accessibility and best-practices ≥ 95 on every page.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3300";
const PAGES = {
  home: "/",
  "result-microduck": "/t/robinhood/0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725",
  "result-peek": "/t/solana/A7Hm1SaHZZz8ZKFqZpsnZoGhri9f1iHEzYBPQGiPpump",
  "rejected-nvda": "/t/robinhood/0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
  "result-base-brett": "/t/base/0x532f27101965dd16442e59d40670faf5ebb142e4",
  "result-monad-chog": "/t/monad/0x350035555e10d9afaf1566aaebfced5ba6c27777",
};
mkdirSync("docs/lighthouse", { recursive: true });
let ok = true;
for (const [name, path] of Object.entries(PAGES)) {
  // Warm the 2-minute result cache first, so Lighthouse measures the page, not the data sources. The page
  // streams, so fetch() resolves at the first byte: read the whole body or the report is still being built.
  // A cold render can take a minute when sources are slow; it counts as warm once a re-fetch is fast.
  // v3 §2: a cold page fetches the analysis from the browser; warm the shared result cache through the API
  // first so the page renders server-side (what a returning visitor and a shared link within 2 min get).
  // fresh: a cache hit would keep an older entry, which can expire (2 min) before Lighthouse loads the page.
  const [, chain, ca] = path.match(/^\/t\/([^/]+)\/([^/?]+)/) ?? [];
  if (ca) {
    // Retried once: after a (blocking) Lighthouse run the pooled keep-alive socket is dead ("fetch failed").
    const warm = () => fetch(`${BASE}/api/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: ca, chain, fresh: true }), signal: AbortSignal.timeout(180_000) });
    const w = await warm().catch(() => warm()).catch((e) => ({ status: String(e) }));
    const html = await fetch(BASE + path).then((r) => r.text(), () => "");
    console.log(`  ${name}: warm-up API ${w.status} · page server-rendered: ${html.includes('data-testid="tier-letter"') || html.includes('data-testid="not-a-meme"') ? "yes" : "NO (cold loader)"}`);
  }
  let warmMs = null;
  for (let i = 0; i < 4 && (warmMs == null || warmMs > 5_000); i++) {
    const t0 = Date.now();
    const ok = await fetch(BASE + path, { signal: AbortSignal.timeout(180_000) }).then((r) => r.text()).then(() => true, () => false);
    warmMs = ok ? Date.now() - t0 : null;
  }
  if (warmMs == null || warmMs > 5_000) console.log(`  ! ${name}: result cache not warm (last fetch ${warmMs ?? "failed"}ms): Lighthouse will include data-source latency`);
  const out = `docs/lighthouse/${name}.json`;
  execFileSync(
    process.execPath,
    [
      "node_modules/lighthouse/cli/index.js",
      BASE + path,
      "--quiet",
      "--output=json",
      `--output-path=${out}`,
      "--only-categories=performance,accessibility,best-practices,seo",
      "--chrome-flags=--headless=new --no-sandbox",
    ],
    { stdio: "inherit" },
  );
  const r = JSON.parse(readFileSync(out, "utf8"));
  const s = Object.fromEntries(Object.entries(r.categories).map(([k, v]) => [k, Math.round(v.score * 100)]));
  const pass = s.performance >= 95 && s.accessibility >= 95 && s["best-practices"] >= 95;
  ok &&= pass;
  const a = r.audits;
  console.log(`${pass ? "✓" : "✗"} ${name.padEnd(17)} perf ${s.performance} · a11y ${s.accessibility} · best ${s["best-practices"]} · seo ${s.seo}  (LCP ${a["largest-contentful-paint"].displayValue}, CLS ${a["cumulative-layout-shift"].displayValue}, TBT ${a["total-blocking-time"].displayValue})`);
  if (!pass)
    for (const [id, au] of Object.entries(a))
      if (au.score != null && au.score < 0.9 && au.scoreDisplayMode !== "informative" && au.scoreDisplayMode !== "notApplicable") console.log(`    ${id}: ${au.title}${au.displayValue ? ` (${au.displayValue})` : ""}`);
}
process.exitCode = ok ? 0 : 1;
