import type { TokenSnapshot } from "../types";

export interface PoolRow {
  id: string;
  name: string;
  liquidityUsd: number;
  volume24hUsd: number;
  createdAt: string | null;
}

/** pump.fun bonding-curve "markets" as GeckoTerminal / DexScreener list them. */
export const isCurveMarket = (dexId: string | null | undefined) => !!dexId && /^pump-?fun$/i.test(dexId);

/**
 * Solana pump.fun tokens: before graduation the only market is the curve (its liquidity is the
 * curve's real SOL reserve, read on-chain — indexer "liquidity" for it is not comparable); after
 * graduation the curve market is dead and the main market is the deepest AMM pool, which alone
 * supplies liquidity, volume and VOL/MC. Returns null for tokens without a curve market.
 */
export function pumpMarket(pools: (PoolRow & { dexId?: string | null })[]): { metrics: Partial<TokenSnapshot>; nullReasons: Record<string, string>; note: string } | null {
  const curve = pools.filter((p) => isCurveMarket(p.dexId));
  if (!curve.length) return null;
  const amm = pools.filter((p) => !isCurveMarket(p.dexId)).sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  if (!amm.length) {
    const reason = "pre-graduation: liquidity is the curve's real SOL reserve (Solana RPC), not an indexer figure";
    return {
      metrics: { poolCount: 1, volume24hUsd: curve.reduce((a, p) => a + p.volume24hUsd, 0), createdAt: curve[0].createdAt },
      nullReasons: { liquidityUsd: reason, mainPoolLiquidityUsd: reason },
      note: "pre-graduation (curve market only)",
    };
  }
  const main = amm[0];
  return {
    metrics: {
      poolCount: amm.filter((p) => p.liquidityUsd >= ACTIVE_MIN_LIQ).length || 1,
      liquidityUsd: main.liquidityUsd,
      mainPoolLiquidityUsd: main.liquidityUsd,
      mainPoolSharePct: 100,
      volume24hUsd: main.volume24hUsd,
      liquidityTotalUsd: main.liquidityUsd,
      createdAt: [...pools].map((p) => p.createdAt).filter(Boolean).sort()[0] ?? null,
    },
    nullReasons: {},
    note: `graduated — main market ${main.name} (${main.id.slice(0, 8)}…), curve market ignored`,
  };
}

/** A pool counts as "active" when it has real depth and was traded in the last 24h. */
export const ACTIVE_MIN_LIQ = 1000;
export const ACTIVE_MIN_VOL = 100;

/** Turns a pool list into liquidity / fragmentation / age metrics. */
export function poolMetrics(pools: PoolRow[]): Partial<TokenSnapshot> {
  if (!pools.length) return { poolCount: 0 };
  const active = pools.filter((p) => p.liquidityUsd >= ACTIVE_MIN_LIQ && p.volume24hUsd >= ACTIVE_MIN_VOL);
  const basis = active.length ? active : pools;
  const liquidityUsd = basis.reduce((a, p) => a + p.liquidityUsd, 0);
  const main = Math.max(...basis.map((p) => p.liquidityUsd));
  const created = pools
    .map((p) => (p.createdAt ? Date.parse(p.createdAt) : NaN))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  return {
    poolCount: active.length,
    liquidityUsd,
    mainPoolLiquidityUsd: main,
    mainPoolSharePct: liquidityUsd > 0 ? (main / liquidityUsd) * 100 : null,
    volume24hUsd: pools.reduce((a, p) => a + p.volume24hUsd, 0),
    liquidityTotalUsd: pools.reduce((a, p) => a + p.liquidityUsd, 0),
    createdAt: created ? new Date(created).toISOString() : null,
  };
}
