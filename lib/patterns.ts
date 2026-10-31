import type { PatternDetection } from "./types";

/** One OHLCV candle; `t` is the open time in unix seconds. Volume is in USD. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const iso = (t: number | undefined) => (t == null ? null : new Date(t * 1000).toISOString());
const windowLabel = (tf: string, cs: Candle[]) =>
  cs.length ? `${cs.length} × ${tf} candles, ${iso(cs[0].t)!.slice(0, 16)}Z → ${iso(cs[cs.length - 1].t)!.slice(0, 16)}Z` : `no ${tf} candles`;
const detection = (id: string, result: PatternDetection["result"], detail: string, tf: string, cs: Candle[]): PatternDetection => ({
  id,
  result,
  detail,
  timeframe: tf,
  from: iso(cs[0]?.t),
  to: iso(cs[cs.length - 1]?.t),
  candles: cs.length,
});

export function sortCandles(raw: number[][]): Candle[] {
  return raw
    .map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }))
    .filter((x) => [x.o, x.h, x.l, x.c].every((n) => Number.isFinite(n) && n > 0))
    .sort((a, b) => a.t - b.t);
}

/**
 * Guide p.27: a straight-up launch that never retraces ≥ 30% from the first 15-minute high
 * means supply is controlled. Needs 1m candles that start at launch.
 */
export function launchRetrace(candles1m: Candle[], launchTs: number) {
  const first = candles1m.filter((c) => c.t < launchTs + 15 * 60);
  const after = candles1m.filter((c) => c.t >= launchTs + 15 * 60);
  if (!first.length || !after.length) {
    return { value: null, window: windowLabel("1m", candles1m), detection: detection("launch_retrace", null, "Needs candles from the first 15 minutes and after.", "1m", candles1m) };
  }
  const high = Math.max(...first.map((c) => c.h));
  const low = Math.min(...after.map((c) => c.l));
  const drop = (1 - low / high) * 100;
  const value = drop >= 30;
  return {
    value,
    window: windowLabel("1m", candles1m),
    detection: detection("launch_retrace", value, `First-15m high ${high.toPrecision(4)}, lowest low afterwards ${low.toPrecision(4)} (−${drop.toFixed(1)}%).`, "1m", candles1m),
  };
}

/**
 * Guide p.24: identical candles are bots. Share of the last 30 candles whose body is within ±10% of
 * the most common body size. Doji candles (body < 0.1% of price) carry no information and are skipped.
 */
export function identicalCandles(candles: Candle[], n = 30) {
  const last = candles.slice(-n);
  const bodies = last.map((c) => Math.abs(c.c - c.o) / c.o).filter((b) => b >= 0.001);
  if (bodies.length < 10) {
    return { value: null, window: windowLabel("1m", last), detection: detection("identical_candles", null, `Only ${bodies.length} non-doji candles in the last ${n} (need 10).`, "1m", last) };
  }
  let best = 0;
  for (const b of bodies) best = Math.max(best, bodies.filter((x) => x >= b * 0.9 && x <= b * 1.1).length);
  const value = (best / bodies.length) * 100;
  return {
    value,
    window: windowLabel("1m", last),
    detection: detection("identical_candles", value, `${best} of ${bodies.length} non-doji candle bodies within ±10% of one size.`, "1m", last),
  };
}

/**
 * Guide p.24 staircase: ≥ 5 consecutive up-steps with flat plateaus and near-zero sells.
 * Step = green candle up ≥ 2%; plateau = candle whose body is < 0.5% and range < 1.5%; any red
 * candle (body down > 0.5%) breaks the staircase. The run must alternate steps and plateaus —
 * an ordinary rally without plateaus is not a staircase.
 */
export function staircase(candles: Candle[], minSteps = 5) {
  if (candles.length < 10) {
    return { value: null, window: windowLabel("5m", candles), detection: detection("staircase", null, "Needs ≥ 10 candles.", "5m", candles) };
  }
  let steps = 0;
  let best = 0;
  let sawPlateauSinceStep = true;
  for (const c of candles) {
    const body = (c.c - c.o) / c.o;
    const range = (c.h - c.l) / c.o;
    const isStep = body >= 0.02;
    const isPlateau = Math.abs(body) < 0.005 && range < 0.015;
    const isRed = body < -0.005;
    if (isRed) {
      steps = 0;
      sawPlateauSinceStep = true;
    } else if (isStep) {
      steps = sawPlateauSinceStep ? steps + 1 : 1;
      sawPlateauSinceStep = false;
    } else if (isPlateau) {
      sawPlateauSinceStep = true;
    } else {
      steps = 0;
      sawPlateauSinceStep = true;
    }
    best = Math.max(best, steps);
  }
  const value = best >= minSteps;
  return {
    value,
    window: windowLabel("5m", candles),
    detection: detection("staircase", value, `Longest step–plateau run with no red candle: ${best} steps (flag at ${minSteps}).`, "5m", candles),
  };
}

interface Pivot {
  i: number;
  p: number;
}

/**
 * Guide p.61-71 trend structure from swing pivots (a high/low above/below both neighbours ±2).
 * 1 = higher highs and higher lows, 0 = lower lows and lower highs, 0.5 = mixed.
 */
function pivots(candles: Candle[], span: number) {
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];
  for (let i = span; i < candles.length - span; i++) {
    const n: Candle[] = [];
    for (let k = 1; k <= span; k++) n.push(candles[i - k], candles[i + k]);
    if (n.every((x) => candles[i].h > x.h)) highs.push({ i, p: candles[i].h });
    if (n.every((x) => candles[i].l < x.l)) lows.push({ i, p: candles[i].l });
  }
  return { highs, lows };
}

export function trend(candles: Candle[], tf = "5m") {
  // 2-candle pivots; a short history (young or freshly graduated pool) falls back to 1-candle pivots.
  let { highs, lows } = pivots(candles, 2);
  let pivotNote = "";
  if (highs.length < 2 || lows.length < 2) {
    const short = pivots(candles, 1);
    if (short.highs.length >= 2 && short.lows.length >= 2) {
      ({ highs, lows } = short);
      pivotNote = " (1-candle pivots — short history)";
    }
  }
  if (highs.length < 2 || lows.length < 2) {
    return {
      value: null,
      brokeHigherLow: null,
      window: windowLabel(tf, candles),
      detection: detection("trend", null, `Only ${highs.length} swing highs / ${lows.length} swing lows (need 2 each).`, tf, candles),
    };
  }
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  const hh = h2.p > h1.p;
  const hl = l2.p > l1.p;
  const value = hh && hl ? 1 : !hh && !hl ? 0 : 0.5;
  const last = candles[candles.length - 1];
  const brokeHigherLow = hl && last.c < l2.p && last.t > candles[l2.i].t;
  return {
    value,
    brokeHigherLow,
    window: windowLabel(tf, candles),
    detection: detection(
      "trend",
      value,
      `Swing highs ${h1.p.toPrecision(4)} → ${h2.p.toPrecision(4)} (${hh ? "HH" : "LH"}), lows ${l1.p.toPrecision(4)} → ${l2.p.toPrecision(4)} (${hl ? "HL" : "LL"}); last close ${last.c.toPrecision(4)}${brokeHigherLow ? " broke the last higher low" : ""}${pivotNote}.`,
      tf,
      candles,
    ),
  };
}

/** Up-only chart (guide p.19 honeypot triad): never more than a 10% drawdown from the running peak. */
export function upOnly(candles: Candle[]) {
  if (candles.length < 12) {
    return { value: null, detection: detection("up_only", null, "Needs ≥ 12 candles.", "5m", candles) };
  }
  let peak = 0;
  let maxDd = 0;
  for (const c of candles) {
    peak = Math.max(peak, c.h);
    maxDd = Math.max(maxDd, 1 - c.l / peak);
  }
  const value = maxDd < 0.1 && candles[candles.length - 1].c > candles[0].o;
  return { value, detection: detection("up_only", value, `Max drawdown from running peak ${(maxDd * 100).toFixed(1)}%.`, "5m", candles) };
}
