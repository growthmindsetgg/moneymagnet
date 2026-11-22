/**
 * Holder Strength (0–100): how the top-20 non-LP, non-infra holders have behaved, weighted by their share.
 * Pure — the collectors (lib/holderStrengthData.ts) gather each wallet's ledger; this file only scores it.
 *
 * Components (weight; each 0–1; the score is the weighted mean over the components with data):
 *   hold          20  supply-weighted median of (days held ÷ token age); full at ≥ 70% of token age
 *   drawdown      20  share of the supply held at the worst 7d drawdown's peak that never sold during it
 *   discipline    20  per wallet: 0 sells over ≥ 30d = 1 · 0 sells < 30d = 0.8 · < 25% of the position sold = 0.7 ·
 *                     25–50% = 0.35 · > 50% = 0
 *   maturity      15  per wallet: ≥ 90d old before its first buy and ≥ 5 tokens = 1 ("real wallet"); < 7d and ≤ 1 token = 0
 *   accumulation  15  share of top-20 supply held by wallets that bought ≥ 20% below the 7d high; full at ≥ 30%
 *   accumulators  10  0-sell accumulators' share of supply (the former accumulator factors, now an input here)
 * Identity: a founder / team wallet that never sold and vesting / locked supply count as strong (full marks on
 * the per-wallet components) and are named apart (key-person risk); labelled CEX wallets are excluded.
 */

export type StrengthLabel = "Diamond" | "Strong" | "Mixed" | "Weak" | "Paper";
export type LedgerClass = "wallet" | "founder" | "team" | "vesting" | "treasury" | "cex";

export interface LedgerEvent {
  /** Unix seconds. */
  t: number;
  kind: "buy" | "sell" | "in" | "out";
  /** Token units. */
  qty: number;
  /** USD per token when the source prices the trade (swap index), else null. */
  priceUsd: number | null;
}

export interface HolderLedger {
  address: string;
  /** Share of supply now (%). */
  pct: number;
  cls: LedgerClass;
  /** Founder / team wallet with 0 sells over its whole history (from the top-holder classification). */
  keyNeverSold?: boolean;
  /** Label shown in sentences ("founder wallet", "vesting contract (Hedgey)"). */
  label?: string;
  events: LedgerEvent[];
  /** Whole history read (else the wallet is left out of the per-wallet components). */
  complete: boolean;
  /** Unix seconds the wallet first held native coin / sent a tx; null with `walletAgeReason`. */
  walletFirstSeenT: number | null;
  walletAgeReason?: string;
  /** Distinct tokens the wallet holds; null with `tokensReason`. */
  tokensHeld: number | null;
  tokensReason?: string;
}

export interface DayCandle {
  /** Day start, unix seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface StrengthInput {
  ledgers: HolderLedger[];
  /** Token creation, unix seconds. */
  createdT: number | null;
  nowT: number;
  candles: DayCandle[] | null;
  candleReason?: string;
  accumulatorSupplyPct: number | null;
  accumulatorReason?: string;
  /** How the ledgers were read ("HoodScan swap index", "Transfer logs"), for the evidence lines. */
  method: string;
}

export interface StrengthComponent {
  id: "hold" | "drawdown" | "discipline" | "maturity" | "accumulation" | "accumulators";
  label: string;
  weight: number;
  /** 0–1, or null with `nullReason`. */
  score: number | null;
  evidence: string;
  nullReason?: string;
  /** Plain sentence for the top-3 list. */
  sentence: string | null;
  /** Nothing to measure (no drawdown deep enough, no dip): not missing data, left out of the weight. */
  na?: boolean;
}

export interface HolderStrength {
  score: number | null;
  label: StrengthLabel | null;
  components: StrengthComponent[];
  /** The three biggest contributors, as plain sentences. */
  sentences: string[];
  /** Founder / team / vesting holders named apart: "founder wallet 61.1%, never sold, 116d". */
  keyPerson: string[];
  wallets: number;
  excluded: { address: string; pct: number; why: string }[];
  nullReason?: string;
  method: string;
  /** Some ledgers are still being read (resumed in the background / on the next analysis): not missing data yet. */
  pending?: boolean;
}

const DAY = 86_400;
export const STRENGTH_WEIGHTS = { hold: 20, drawdown: 20, discipline: 20, maturity: 15, accumulation: 15, accumulators: 10 } as const;
/** Fewer components than this, or less weight than this share, and there is no score. */
const MIN_COMPONENTS = 3;
const MIN_WEIGHT_SHARE = 0.5;
/** The worst 7d drawdown must be at least this deep to be something to survive. */
const MIN_DRAWDOWN = 0.2;
const DIP = 0.2;
/** Launch-phase price discovery (the first 72h) is not a drawdown to survive. */
const LAUNCH_S = 72 * 3600;

export function strengthLabel(score: number): StrengthLabel {
  return score >= 80 ? "Diamond" : score >= 60 ? "Strong" : score >= 40 ? "Mixed" : score >= 20 ? "Weak" : "Paper";
}

const pctText = (x: number) => `${(x * 100).toFixed(0)}%`;
const days = (s: number) => Math.floor(s / DAY);

/** The worst peak→trough fall inside any 7-day stretch of daily candles: depth (0–1), peak day start, trough day end (latest on ties). */
export function worstDrawdown7d(c: DayCandle[]): { depth: number; peakT: number; troughEndT: number } | null {
  let best: { depth: number; peakT: number; troughEndT: number } | null = null;
  for (let i = 0; i < c.length; i++) {
    for (let j = i; j < c.length && c[j].t - c[i].t < 7 * DAY; j++) {
      const depth = c[i].h > 0 ? 1 - c[j].l / c[i].h : 0;
      // Ties go to the later peak / trough: the window hugs the actual fall.
      if (!best || depth >= best.depth - 1e-9) best = { depth, peakT: c[i].t, troughEndT: c[j].t + DAY };
    }
  }
  return best;
}

/** Highest high of the 7 daily candles before the day starting at `dayStart`. */
function high7dBefore(c: DayCandle[], dayStart: number): number | null {
  const w = c.filter((x) => x.t < dayStart && x.t >= dayStart - 7 * DAY);
  return w.length ? Math.max(...w.map((x) => x.h)) : null;
}

/** A day whose whole range (its high) sat ≥ 20% under the previous 7 days' high. */
const dipDay = (c: DayCandle[], d: DayCandle) => {
  const hi = high7dBefore(c, d.t);
  return hi != null && d.h <= hi * (1 - DIP);
};

/**
 * A buy at least 20% below the 7d high. With a priced trade the trade price decides; otherwise only a day whose
 * HIGH was already ≥ 20% under the 7d high proves it (the buy cannot have been above that day's high).
 */
export function isDipBuy(c: DayCandle[], e: LedgerEvent): boolean {
  const day = c.find((x) => x.t <= e.t && e.t < x.t + DAY);
  const dayStart = Math.floor(e.t / DAY) * DAY;
  const hi = high7dBefore(c, day?.t ?? dayStart);
  if (hi == null) return false;
  if (e.priceUsd != null) return e.priceUsd <= hi * (1 - DIP);
  return !!day && dipDay(c, day);
}

function weightedMedian(xs: { v: number; w: number }[]): number {
  const s = [...xs].sort((a, b) => a.v - b.v);
  const total = s.reduce((a, x) => a + x.w, 0);
  let acc = 0;
  for (const x of s) {
    acc += x.w;
    if (acc >= total / 2) return x.v;
  }
  return s[s.length - 1]?.v ?? 0;
}

const isKey = (h: HolderLedger) => (h.cls === "founder" || h.cls === "team") && h.keyNeverSold === true;
const isLocked = (h: HolderLedger) => h.cls === "vesting";
const strong = (h: HolderLedger) => isKey(h) || isLocked(h);

interface WalletFacts {
  h: HolderLedger;
  firstInT: number | null;
  buys: number;
  sells: number;
  soldFrac: number;
  sellTs: number[];
}

function factsOf(h: HolderLedger): WalletFacts {
  const ins = h.events.filter((e) => e.kind === "buy" || e.kind === "in");
  const outs = h.events.filter((e) => e.kind === "sell" || e.kind === "out");
  const sold = h.events.filter((e) => e.kind === "sell").reduce((a, e) => a + e.qty, 0);
  const gross = ins.reduce((a, e) => a + e.qty, 0);
  const position = Math.max(gross, sold + outs.filter((e) => e.kind === "out").reduce((a, e) => a + e.qty, 0));
  return {
    h,
    firstInT: ins.length ? Math.min(...ins.map((e) => e.t)) : null,
    buys: h.events.filter((e) => e.kind === "buy").length,
    sells: h.events.filter((e) => e.kind === "sell").length,
    soldFrac: position > 0 ? sold / position : 0,
    sellTs: h.events.filter((e) => e.kind === "sell").map((e) => e.t),
  };
}

export function computeHolderStrength(inp: StrengthInput): HolderStrength {
  const excluded = inp.ledgers.filter((h) => h.cls === "cex").map((h) => ({ address: h.address, pct: h.pct, why: "labelled CEX wallet" }));
  const all = inp.ledgers.filter((h) => h.cls !== "cex");
  const facts = all.filter((h) => h.complete || strong(h)).map(factsOf);
  const supply = (xs: WalletFacts[]) => xs.reduce((a, f) => a + f.h.pct, 0);
  const total = supply(facts);
  const ageS = inp.createdT != null ? inp.nowT - inp.createdT : null;
  const comps: StrengthComponent[] = [];
  const nul = (id: StrengthComponent["id"], label: string, reason: string): StrengthComponent => ({ id, label, weight: STRENGTH_WEIGHTS[id], score: null, evidence: `no data — ${reason}`, nullReason: reason, sentence: null });
  // Coverage counts only the wallets whose behaviour is measured: a key-person or locked holder (strong by identity)
  // must not stand in for the rest of the top 20.
  const plain = all.filter((h) => !strong(h));
  const plainRead = facts.filter((f) => !strong(f.h));
  const covered = plain.length ? supply(plainRead) / plain.reduce((a, h) => a + h.pct, 0) : all.length ? 1 : 0;
  const incomplete = all.filter((h) => !h.complete && !strong(h)).length;

  // 1. Hold duration.
  if (ageS == null || ageS <= 0) comps.push(nul("hold", "Hold duration", "token age unknown"));
  else {
    const xs = facts.flatMap((f) => (strong(f.h) ? [{ v: 1, w: f.h.pct }] : f.firstInT != null ? [{ v: Math.min(1, (inp.nowT - f.firstInT) / ageS), w: f.h.pct }] : []));
    if (!xs.length) comps.push(nul("hold", "Hold duration", "no first-buy time for any top-20 wallet"));
    else {
      const med = weightedMedian(xs);
      comps.push({
        id: "hold",
        label: "Hold duration",
        weight: STRENGTH_WEIGHTS.hold,
        score: Math.min(1, med / 0.7),
        evidence: `supply-weighted median hold = ${pctText(med)} of token age (${days(ageS)}d; full points at ≥ 70%), ${xs.length} wallets`,
        sentence: `top holders have held a median ${pctText(med)} of the token's ${days(ageS)}-day life`,
      });
    }
  }

  // 2. Drawdown survival — over the Established life only: the first 72h (launch price discovery) is left out.
  const life = (inp.candles ?? []).filter((c) => inp.createdT == null || c.t >= inp.createdT + LAUNCH_S);
  const dd = life.length ? worstDrawdown7d(life) : null;
  if (!inp.candles?.length) comps.push(nul("drawdown", "Drawdown survival", inp.candleReason ?? "no daily candles"));
  else if (!life.length) comps.push(nul("drawdown", "Drawdown survival", "no daily candle after the first 72h"));
  else if (!dd || dd.depth < MIN_DRAWDOWN) {
    comps.push({ ...nul("drawdown", "Drawdown survival", `worst 7d drawdown only −${pctText(dd?.depth ?? 0)} — nothing to survive (< ${pctText(MIN_DRAWDOWN)})`), evidence: `worst 7d drawdown −${pctText(dd?.depth ?? 0)}: below the ${pctText(MIN_DRAWDOWN)} that counts as a drawdown — not scored`, na: true });
  } else {
    const there = facts.filter((f) => strong(f.h) || (f.firstInT != null && f.firstInT < dd.peakT));
    const held = there.filter((f) => strong(f.h) || !f.sellTs.some((t) => t >= dd.peakT && t < dd.troughEndT));
    if (!there.length) comps.push(nul("drawdown", "Drawdown survival", `no current top-20 wallet held before the −${pctText(dd.depth)} drawdown began`));
    else {
      const share = supply(held) / supply(there);
      const when = new Date(dd.peakT * 1000).toISOString().slice(0, 10);
      comps.push({
        id: "drawdown",
        label: "Drawdown survival",
        weight: STRENGTH_WEIGHTS.drawdown,
        score: share,
        evidence: `worst 7d drawdown −${pctText(dd.depth)} from ${when}: ${held.length} of ${there.length} wallets holding then never sold during it (${pctText(share)} of their supply)`,
        sentence: `${held.length} of ${there.length} top-20 wallets held through the −${pctText(dd.depth)} drawdown`,
      });
    }
  }

  // 3. Sell discipline.
  if (!facts.length) comps.push(nul("discipline", "Sell discipline", "no top-20 wallet history read"));
  else {
    const per = facts.map((f) => {
      if (strong(f.h)) return 1;
      const held = f.firstInT != null ? inp.nowT - f.firstInT : 0;
      if (f.sells === 0) return held >= 30 * DAY ? 1 : 0.8;
      if (f.soldFrac < 0.25) return 0.7;
      if (f.soldFrac <= 0.5) return 0.35;
      return 0;
    });
    const score = total > 0 ? facts.reduce((a, f, i) => a + per[i] * f.h.pct, 0) / total : 0;
    const zero = facts.filter((f) => f.sells === 0).length;
    const dumped = facts.filter((f) => !strong(f.h) && f.soldFrac > 0.5).length;
    comps.push({
      id: "discipline",
      label: "Sell discipline",
      weight: STRENGTH_WEIGHTS.discipline,
      score,
      evidence: `${zero} of ${facts.length} wallets never sold; ${dumped} sold > 50% of their position; supply-weighted ${pctText(score)}`,
      sentence: dumped > zero ? `${dumped} of ${facts.length} top wallets have sold more than half their position` : `${zero} of ${facts.length} top wallets have never sold`,
    });
  }

  // 4. Wallet maturity.
  {
    // Wallets only: a multisig treasury is a contract, its "age" says nothing about a holder.
    const people = facts.filter((f) => !strong(f.h) && f.h.cls !== "treasury");
    const rows = people.filter((f) => f.h.walletFirstSeenT != null && f.firstInT != null);
    const why = people.find((f) => f.h.walletAgeReason)?.h.walletAgeReason;
    if (!rows.length) comps.push(nul("maturity", "Wallet maturity", why ?? "no wallet age for any top-20 wallet"));
    else if (supply(rows) < 0.3 * supply(people)) comps.push(nul("maturity", "Wallet maturity", `wallet age read for ${rows.length} of ${people.length} wallets (< 30% of their supply)${why ? ` — ${why}` : ""}`));
    else {
      const tokensKnown = rows.filter((f) => f.h.tokensHeld != null).length;
      const per = rows.map((f) => {
        const age = Math.max(0, f.firstInT! - f.h.walletFirstSeenT!) / DAY;
        const tk = f.h.tokensHeld;
        if (tk == null) return age < 7 ? 0 : Math.min(1, age / 90);
        if (age >= 90 && tk >= 5) return 1;
        if (age < 7 && tk <= 1) return 0;
        return 0.5 * Math.min(1, age / 90) + 0.5 * Math.min(1, tk / 5);
      });
      const score = rows.reduce((a, f, i) => a + per[i] * f.h.pct, 0) / supply(rows);
      const real = per.filter((p) => p === 1).length;
      const fresh = per.filter((p) => p === 0).length;
      const tokNote = tokensKnown < rows.length ? `; token count known for ${tokensKnown} of ${rows.length} (${rows.find((f) => f.h.tokensHeld == null)?.h.tokensReason ?? "unavailable"}) — the others are scored on age alone` : "";
      comps.push({
        id: "maturity",
        label: "Wallet maturity",
        weight: STRENGTH_WEIGHTS.maturity,
        score,
        evidence: `${real} real wallets (≥ 90d old before buying, ≥ 5 tokens), ${fresh} fresh (< 7d)${tokNote}; supply-weighted ${pctText(score)}`,
        sentence: fresh > real ? `${fresh} of ${rows.length} top wallets were less than a week old when they bought` : `${real} of ${rows.length} top wallets are seasoned (90d+ before buying)`,
      });
    }
  }

  // 5. Accumulation on dips.
  if (!inp.candles?.length) comps.push(nul("accumulation", "Dip accumulation", inp.candleReason ?? "no daily candles"));
  else {
    const after72h = (t: number) => inp.createdT == null || t >= inp.createdT + LAUNCH_S;
    const dipDays = inp.candles.filter((c) => after72h(c.t) && dipDay(inp.candles!, c)).length;
    const buyers = facts.filter((f) => !strong(f.h) && f.h.events.some((e) => e.kind === "buy" && after72h(e.t) && isDipBuy(inp.candles!, e)));
    if (!total) comps.push(nul("accumulation", "Dip accumulation", "no top-20 wallet history read"));
    else if (!dipDays && !buyers.length) comps.push({ ...nul("accumulation", "Dip accumulation", "price never traded a full day 20% below its 7d high"), evidence: "no dip to buy: price never traded a full day ≥ 20% below its 7d high — not scored", na: true });
    else {
      const share = supply(buyers) / total;
      comps.push({
        id: "accumulation",
        label: "Dip accumulation",
        weight: STRENGTH_WEIGHTS.accumulation,
        score: Math.min(1, share / 0.3),
        evidence: `${buyers.length} wallets bought ≥ 20% below the 7d high, holding ${pctText(share)} of top-20 supply (full points at ≥ 30%)`,
        sentence: `${buyers.length} top wallets bought the dips (${pctText(share)} of top-20 supply)`,
      });
    }
  }

  // 6. 0-sell accumulators (supply share), the former separate factors.
  if (inp.accumulatorSupplyPct == null) comps.push(nul("accumulators", "0-sell accumulators", inp.accumulatorReason ?? "no per-wallet buy / sell counts"));
  else {
    const v = inp.accumulatorSupplyPct;
    comps.push({
      id: "accumulators",
      label: "0-sell accumulators",
      weight: STRENGTH_WEIGHTS.accumulators,
      score: v >= 5 ? 1 : v >= 2 ? 0.75 : v >= 0.5 ? 0.45 : 0.15,
      evidence: `multi-buy, zero-sell wallets hold ${v.toFixed(2)}% of supply`,
      sentence: `multi-buy wallets that never sold hold ${v.toFixed(1)}% of supply`,
    });
  }

  const keyPerson = all
    .filter(strong)
    .map((h) => (isKey(h) ? `${h.label ?? `${h.cls} wallet`} ${h.pct.toFixed(1)}%, never sold${inp.createdT != null ? `, ${days(inp.nowT - (factsOf(h).firstInT ?? inp.createdT))}d` : ""}` : `${h.label ?? "vesting contract"} ${h.pct.toFixed(1)}%, locked`));

  const scored = comps.filter((c) => c.score != null);
  const weight = scored.reduce((a, c) => a + c.weight, 0);
  const missing = comps.filter((c) => c.score == null && !c.na);
  const measurable = comps.filter((c) => !c.na).reduce((a, c) => a + c.weight, 0);
  const base = { components: comps, keyPerson, wallets: facts.length, excluded, method: inp.method };
  if (covered < 0.6) {
    return { ...base, score: null, label: null, sentences: [], nullReason: `histories read for wallets holding ${pctText(covered)} of the top-20 supply outside key-person / locked holders (${incomplete} still incomplete; needs ≥ 60%)` };
  }
  if (scored.length < MIN_COMPONENTS || weight < MIN_WEIGHT_SHARE * measurable) {
    return { ...base, score: null, label: null, sentences: [], nullReason: `only ${scored.length} of 6 components measurable — ${missing.map((c) => `${c.label.toLowerCase()}: ${c.nullReason}`).join("; ")}` };
  }
  const score = Math.round((scored.reduce((a, c) => a + c.weight * c.score!, 0) / weight) * 1000) / 10;
  // Biggest contributors: the components furthest from neutral, by weight; a key-person holder ranks by its share.
  const ranked = [
    ...scored.filter((c) => c.sentence).map((c) => ({ s: c.sentence!, r: c.weight * Math.abs(c.score! - 0.5) })),
    ...keyPerson.map((s, i) => ({ s, r: (all.filter(strong)[i].pct / Math.max(1, total)) * 20 })),
  ].sort((a, b) => b.r - a.r);
  return { ...base, score, label: strengthLabel(score), sentences: ranked.slice(0, 3).map((x) => x.s.charAt(0).toUpperCase() + x.s.slice(1)) };
}
