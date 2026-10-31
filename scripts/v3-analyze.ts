// pnpm tsx scripts/v3-analyze.ts <chain> <address…> — one live analysis per token: tier, sources, factors, nulls.
import { analyzeAddress } from "@/lib/analyze";
import type { Chain } from "@/lib/types";

const [chain, ...addrs] = process.argv.slice(2);
for (const a of addrs) {
  const t0 = Date.now();
  try {
    const r = await analyzeAddress(a, { chain: chain as Chain });
    console.log(`\n${a} ${r.token.symbol} → ${r.tier} ${r.score ?? "—"} (raw ${r.rawScore}, cov ${r.coveragePct}%, ${r.modeLabel}) in ${Date.now() - t0}ms`);
    console.log("  why:", r.binding?.text);
    for (const s of r.sourceStatus) console.log(`  [${s.state}] ${s.label}: ${(s.message ?? "").slice(0, 220)}`);
    for (const g of r.groups) for (const f of g.factors) console.log(`   ${f.status.padEnd(5)} ${f.id.padEnd(20)} ${String(f.display).padEnd(14)} ${f.points}/${f.max} ${f.status === "null" ? "— " + f.nullReason : ""}`);
    console.log("  fired:", r.rules.filter((x) => x.state === "fired").map((x) => x.id).join(", "));
    if (r.eligibility && !r.eligibility.meme) console.log("  REJECTED:", r.eligibility.rejected, r.eligibility.reason);
  } catch (e) {
    console.log(`\n${a} → ${(e as Error).name}: ${(e as Error).message}`);
  }
}
