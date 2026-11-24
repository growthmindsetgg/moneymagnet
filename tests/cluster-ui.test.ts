import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ClusterBubbles, { layout } from "@/components/ClusterBubbles";
import ClusterMeter from "@/components/ClusterMeter";
import Report from "@/components/Report";
import { buildGraph, type SampleWallet, type WalletClustersCfg } from "@/lib/cluster/graph";
import { meterFields } from "@/lib/cluster/meter";
import type { Origin } from "@/lib/onchain/origin";
import { defaultConfig } from "@/lib/scoring/config";
import { scoreSnapshot } from "@/lib/scoring/engine";
import type { TokenSnapshot } from "@/lib/types";
import { perfectSnapshot } from "./helpers";

const cfg = defaultConfig.walletClusters as WalletClustersCfg;
const T = 1_760_000_000;
const holder = (i: number, pct: number): SampleWallet => ({ address: `Wallet${String(i).padStart(2, "0")}xxxxxxxxxxxx`, role: "holder", pct, buyRank: null, buyT: null, buyRef: null, holderClass: i === 0 ? "founder" : null });
const origin = (wallet: string, funder: string, fundT: number): Origin => ({ wallet, fundT, fundRef: fundT, funder, funderKind: "eoa", via: null, fundTx: `tx${wallet}`, method: "helius-gtfa", final: true });

function ringGraph() {
  const wallets = Array.from({ length: 14 }, (_, i) => holder(i, i < 6 ? 4 : 4));
  const origins = wallets.map((w, i) => (i < 6 ? origin(w.address, "SprayerWalletxxxxxxxxx", T + i * 5) : origin(w.address, `Solo${i}xxxxxxxxxxxxxxx`, T + i * 9000)));
  return buildGraph({ chain: "solana", token: "TOKEN", wallets, origins: new Map(origins.map((o) => [o.wallet, o])), funders: new Map(), deployers: new Set(), cfg, computedAt: 0 });
}

function reportWith(graph: ReturnType<typeof ringGraph>, extra: Partial<TokenSnapshot> = {}) {
  const fields = meterFields({ graph, cfg, mode: "established", pending: false, attempts: 1 });
  const { nullReasons, ...values } = fields;
  const s = perfectSnapshot("solana", { ...values, walletClusterGraph: graph, ...extra, nullReasons: { ...nullReasons, ...(extra.nullReasons ?? {}) } });
  return scoreSnapshot(s);
}

describe("wallet map (SVG)", () => {
  it("is deterministic: two renders of the same graph are byte-identical", () => {
    const g = ringGraph();
    const a = renderToStaticMarkup(createElement(ClusterBubbles, { graph: g }));
    const b = renderToStaticMarkup(createElement(ClusterBubbles, { graph: ringGraph() }));
    expect(a).toBe(b);
  });
  it("places every sampled wallet once, inside the canvas, with no NaN", () => {
    const g = ringGraph();
    const { placed } = layout(g);
    expect(placed).toHaveLength(g.nodes.length);
    for (const p of placed) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.r)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(640);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(layout(g).height);
    }
  });
  it("every wallet is focusable with a title naming its group and funder", () => {
    const html = renderToStaticMarkup(createElement(ClusterBubbles, { graph: ringGraph() }));
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(14);
    expect(html).toMatch(/<title>Wallet…xxxx · 4\.0% · group A · founder · first coin from Spraye…xxxx<\/title>/);
    expect(html).toMatch(/group A · 24\.0%/);
    // The HTML legend repeats each group readably (phones scale the SVG down).
    expect(html).toMatch(/data-testid="cluster-legend"/);
    expect(html).toMatch(/Group A<\/span> · 6 wallets · 24\.0%/);
  });
});

describe("Linked wallets section", () => {
  it("live: meter, band label, the largest group and same-time lines", () => {
    const html = renderToStaticMarkup(createElement(ClusterMeter, { report: reportWith(ringGraph()) }));
    expect(html).toMatch(/data-state="live"/);
    expect(html).toMatch(/data-testid="wallet-clusters-meter">43/);
    expect(html).toMatch(/Coordinated group/);
    expect(html).toMatch(/Largest linked group: 6 wallets holding 24\.0% of supply/);
    expect(html).toMatch(/6 wallets funded by one source within 30s/);
    expect(html).toMatch(/A linked group holds 24\.0% of supply, treated as one holder &gt; 20% — capped at C\./);
    expect(html).toMatch(/role="meter"/);
  });
  it("pending and null show the reason, never a number", () => {
    const pending = reportWith(ringGraph(), { walletClusterState: "pending", walletClusterPending: true, walletClusterMeter: null, clusterResolvedWallets: 6, clusterSampleWallets: 14, nullReasons: { walletClusterMeter: "bundle check incomplete: 6 of 14 wallets resolved (needs 12)" } });
    const h1 = renderToStaticMarkup(createElement(ClusterMeter, { report: pending }));
    expect(h1).toMatch(/Reading funding origins \(6 of 14 wallets\)…/);
    expect(h1).not.toMatch(/wallet-clusters-meter/);
    const nul = reportWith(ringGraph(), { walletClusterState: "null", walletClusterMeter: null, nullReasons: { walletClusterMeter: "Helius key not set" } });
    const h2 = renderToStaticMarkup(createElement(ClusterMeter, { report: nul }));
    expect(h2).toMatch(/No meter<\/span> — Helius key not set/);
  });
  it("absent on reports made before the meter existed", () => {
    const r = scoreSnapshot(perfectSnapshot("solana", { walletClusterState: undefined }));
    expect(renderToStaticMarkup(createElement(ClusterMeter, { report: r }))).toBe("");
  });
  it("the full report renders with the section", () => {
    const html = renderToStaticMarkup(createElement(Report, { report: reportWith(ringGraph()) }));
    expect(html).toMatch(/data-testid="wallet-clusters"/);
    expect(html).toMatch(/data-testid="cluster-bubbles"/);
  });
});
