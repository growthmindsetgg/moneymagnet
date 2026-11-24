import type { ClusterGraph, ClusterNode } from "@/lib/cluster/graph";

/**
 * Wallet map (plan §3.9): linked groups as coloured cells — the shared funder as a small square in the middle, members
 * around it sized by the share of supply they hold — and the other sampled wallets in a grey band below. Plain inline
 * SVG, deterministic (no randomness: same input ⇒ same drawing), every wallet focusable with a title.
 */

const W = 640;
const H = 400;
const TOP_H = 290;
const MAX_CLUSTERS = 5;

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const pctText = (n: number | null) => (n == null ? "—" : `${(Math.round(n * 10) / 10).toFixed(1)}%`);
const radius = (pct: number | null, cap: number) => Math.min(cap, Math.max(4, 28 * Math.sqrt(Math.max(0, pct ?? 0) / 10)));

function nodeTitle(n: ClusterNode): string {
  const parts = [short(n.address), pctText(n.pct)];
  if (n.buyRank != null) parts.push(`buyer #${n.buyRank}`);
  if (n.clusterId) parts.push(`group ${n.clusterId}`);
  if (n.holderClass && n.holderClass !== "wallet") parts.push(n.holderClass);
  if (n.origin?.funder) parts.push(`first coin from ${short(n.origin.funder)}`);
  if (n.status === "excluded") parts.push(n.excludedReason ?? "funded by infrastructure");
  if (n.status === "unresolved") parts.push(`funding not read: ${n.origin?.reason ?? "pending"}`);
  return parts.join(" · ");
}

interface Placed {
  node: ClusterNode;
  x: number;
  y: number;
  r: number;
  color: string;
}

export function layout(graph: ClusterGraph): { placed: Placed[]; funders: { id: string; x: number; y: number; color: string; label: string; pct: number }[] } {
  const byAddr = new Map(graph.nodes.map((n) => [n.address, n]));
  const shown = graph.clusters.slice(0, MAX_CLUSTERS);
  const placed: Placed[] = [];
  const funders: { id: string; x: number; y: number; color: string; label: string; pct: number }[] = [];
  const cellW = W / Math.max(1, shown.length);
  shown.forEach((c, i) => {
    const cx = cellW * i + cellW / 2;
    const cy = TOP_H / 2 + 10;
    const color = `var(--cluster-${i + 1})`;
    funders.push({ id: c.id, x: cx, y: cy, color, label: c.id, pct: c.supplyPct });
    const members = c.members.map((m) => byAddr.get(m)!).filter(Boolean).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0) || (a.address < b.address ? -1 : 1));
    const cap = Math.max(6, Math.min(40, cellW / 6));
    const ring = Math.min(cellW / 2 - cap - 6, 40 + members.length * 4, TOP_H / 2 - cap - 14);
    members.forEach((n, j) => {
      let x: number;
      let y: number;
      if (members.length > 8) {
        // Phyllotaxis spiral for big groups (stable: index-based).
        const a = (j * 137.5 * Math.PI) / 180;
        const r = Math.min(ring, 9 * Math.sqrt(j + 1) + 14);
        x = cx + r * Math.cos(a);
        y = cy + r * Math.sin(a);
      } else {
        const a = (2 * Math.PI * j) / members.length - Math.PI / 2;
        x = cx + ring * Math.cos(a);
        y = cy + ring * Math.sin(a);
      }
      placed.push({ node: n, x, y, r: radius(n.pct, cap), color });
    });
  });
  // Everyone else (independent, other groups past the fifth, excluded, unresolved) in the grey band, largest first.
  const inShown = new Set(shown.flatMap((c) => c.members));
  const rest = graph.nodes.filter((n) => !inShown.has(n.address)).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0) || (a.address < b.address ? -1 : 1));
  const step = W / (rest.length + 1);
  rest.forEach((n, j) => placed.push({ node: n, x: step * (j + 1), y: TOP_H + 55, r: radius(n.pct, Math.max(4, Math.min(16, step / 2 - 2))), color: "var(--muted)" }));
  return { placed, funders };
}

export default function ClusterBubbles({ graph }: { graph: ClusterGraph }) {
  const { placed, funders } = layout(graph);
  const pos = new Map(placed.map((p) => [p.node.address, p]));
  const funderOf = new Map(funders.map((f) => [f.id, f]));
  const weak = graph.edges.filter((e) => e.strength === "weak" && pos.has(e.a) && pos.has(e.b));
  const composite = graph.edges.filter((e) => e.kind === "composite" && pos.has(e.a) && pos.has(e.b));
  return (
    <figure className="m-0 space-y-1" data-testid="cluster-bubbles">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="group" aria-label={`Wallet map: ${graph.clusters.length} linked group${graph.clusters.length === 1 ? "" : "s"} among ${graph.nodes.length} sampled wallets`} className="block h-auto max-w-full">
        <line x1={0} x2={W} y1={TOP_H + 20} y2={TOP_H + 20} stroke="var(--muted)" strokeDasharray="2 4" />
        <text x={8} y={TOP_H + 34} fontSize={11} fill="var(--muted)">
          other sampled wallets (independent, excluded or not read yet)
        </text>
        {funders.map((f) => (
          <text key={`l${f.id}`} x={f.x} y={18} textAnchor="middle" fontSize={13} fontWeight={700} fill={f.color}>
            {`group ${f.label} · ${pctText(f.pct)}`}
          </text>
        ))}
        {/* Funding lines: each member to its group's centre (the shared funder). */}
        {placed
          .filter((p) => p.node.clusterId && funderOf.has(p.node.clusterId))
          .map((p) => {
            const f = funderOf.get(p.node.clusterId!)!;
            return <line key={`f${p.node.address}`} x1={f.x} y1={f.y} x2={p.x} y2={p.y} stroke={p.color} strokeWidth={1.5} />;
          })}
        {weak.map((e, i) => {
          const a = pos.get(e.a)!;
          const b = pos.get(e.b)!;
          return <line key={`w${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--muted)" strokeWidth={1} strokeDasharray="4 3" />;
        })}
        {composite.map((e, i) => {
          const a = pos.get(e.a)!;
          const b = pos.get(e.b)!;
          return (
            <text key={`c${i}`} x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} fontSize={10} textAnchor="middle" fill="var(--ink)">
              2×
            </text>
          );
        })}
        {funders.map((f) => (
          <rect key={`s${f.id}`} x={f.x - 4} y={f.y - 4} width={8} height={8} fill={f.color} />
        ))}
        {placed.map((p) => {
          const n = p.node;
          const founder = n.holderClass === "founder" || n.holderClass === "team";
          const holdsNothing = (n.pct ?? 0) <= 0;
          const t = nodeTitle(n);
          return (
            <g key={n.address} tabIndex={0} role="img" aria-label={t} className="mm-node" data-status={n.status} data-cluster={n.clusterId ?? ""}>
              <title>{t}</title>
              <circle
                cx={p.x}
                cy={p.y}
                r={holdsNothing ? 4 : p.r}
                fill={holdsNothing || n.status !== "resolved" ? "none" : p.color}
                fillOpacity={n.clusterId ? 0.85 : 0.35}
                stroke={founder ? "var(--bad-text)" : n.status === "resolved" ? p.color : "var(--muted)"}
                strokeWidth={founder ? 3 : 1.5}
                strokeDasharray={n.status === "unresolved" ? "2 2" : n.status === "excluded" ? "5 2" : undefined}
              />
            </g>
          );
        })}
      </svg>
      <figcaption className="text-xs text-muted">
        Solid line: funded by the group&apos;s shared source (proven link). Dashed: a weak clue only (never merges on its own); &quot;2×&quot;: two different weak clues. Circle size: share of supply held now; hollow: holds nothing / not read; thick red ring: founder or team.
      </figcaption>
    </figure>
  );
}
