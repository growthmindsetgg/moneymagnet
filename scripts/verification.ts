// Prints the cross-source verification for tokens: counts, every disputed metric, flagged APIs.
//   pnpm verification [address…]   (defaults to the four fixtures)
import { analyzeAddress } from "@/lib/analyze";
import { formatProvenanceValue } from "@/lib/verify";
import { FIXTURES } from "../tests/fixtures/addresses";

const targets = process.argv.slice(2).length ? process.argv.slice(2).map((a) => ({ name: a.slice(0, 8), address: a })) : FIXTURES.map((f) => ({ name: f.name, address: f.address }));
for (const t of targets) {
  const r = await analyzeAddress(t.address, { fresh: true });
  const v = r.verification;
  console.log(`\n## ${t.name} — ${r.tier} ${r.score ?? "–"} · ${v.verified} verified (≥2 sources) · ${v.single} single-source · ${v.disputed} disputed`);
  for (const m of v.metrics) {
    const vals = m.values.map((x) => `${x.label}${x.onchain ? "⛓" : ""}=${formatProvenanceValue(x.value)}`).join(", ");
    console.log(`  ${m.status.padEnd(8)} ${m.metric.padEnd(20)} → ${formatProvenanceValue(m.chosen)}  [${vals}]${m.status === "disputed" ? `  · ${m.resolution}` : ""}`);
  }
  for (const s of r.sourceStatus) if (s.flags?.length) console.log(`  FLAG ${s.label}: ${s.flags.join("; ")}`);
}
