# nad.fun meme sweep: old vs new HoodTier scoring (2026-11-22)

**Verdict: the data layer got better, the tier output did not.**

**Data layer: clearly improved.**
- `volume24hUsd` now matches nad.fun's own 24h figure for 41 of 44 tokens that have real volume. On old code it matched for 0 of 44, about 75× low.
- Against DexScreener alone, which is independent of nad.fun, it matches 28 of 32 (old: 0 of 32).
- An indexer outage no longer zeroes FDV and liquidity on its own.

**Tier output: net flat, and not yet trustworthy.** 8 of 94 tokens changed tier:

| Count | Moves | Verdict |
|---|---|---|
| 3 | WRAITH, BUSY, GONE | Correct. They lose a false "Dead launch" F. |
| 1 | MONCAT | Correct but harsh. A pseudo value was removed, and this costs coverage. |
| 3 | 143, BC, MONCHEL | New wrong moves. Two follow a GeckoTerminal 429; one comes from a null total read as $0. |
| 1 | HOGDOG | Noise. |

The noise floor is 6 of 67 tier changes on identical code an hour apart, so 8 moves cannot be told apart from noise.

**Defects untouched by the deploy:**
- dust-pool override (MOE, GOCHI, PANAL);
- zero activity scored as missing;
- weeks-old candles scored as a live 7-day trend.

## Method
- **Token list (94):**
  - nad.fun's public `api.nad.fun/order/{market_cap,volume,latest_trade}`, top 50 each;
  - `order/creation_time`, the 20 newest;
  - 3 known-dead audit fixtures (NAD, Vibe, PERPL).
- **Composition:**
  - By nad.fun `market_type`: 54 graduated (DEX/V2_DEX), 37 on the curve, 3 unlisted.
  - By HoodTier mode: 83 established, 11 launch (< 72h).
- **Paired run (main comparison):** each token was scored with `POST /api/analyze {"address","fresh":true}` on the **old deployment** `hoodtier-8rgtxeyx4` and the **new deployment** `hoodtier-fu18m31dw`, back to back.
  - Both are direct deployment URLs, not the alias.
  - Old/new order alternated per token, and analyses started 36 s apart.
  - Window: 2026-11-21 20:35–22:30 UTC.
  - `kq7jc2axn` went live mid-run. The main session said it changes only Robinhood dead-token logic, so the run stayed on `fu18m31dw`.
  - Canary CHOG at start and end: old A 80.6 with volume $107 / $109; new A 82.7 / 82.1 with volume $8,051 / $8,226.
- **Shared state between deployments:** the two deployments share score history, so the paired runs are not fully independent.
  - No row ended with `binding.kind` "hysteresis" or a tier `hold`.
  - But MONCAT's new `tierReason` reads: "maps to S. Held at A: … previous analysis (1m ago) was A". That previous analysis was the old deployment's result. A coverage cap to B then overrode the hold.
- **Ground truth** was fetched by me during the run, in two passes. For each token I used the pass nearest in time. Where the 24h window moved between passes (MONIGGA), the pass matching the scoring time was used.
  - DexScreener `token-pairs/v1/monad/<ca>`, summed over pairs: volume, liquidity, txns.
  - nad.fun `agent/metrics/<ca>?timeframes=1D`: USD volume, makers, buyers. CHOG nad.fun $7,911 vs DexScreener $7,942.
  - Every token was fetched successfully on both passes.
- **Noise run:** an earlier old-code run through the alias (19:41–20:22 UTC). 67 rows were clean. 13 later rows were answered by the new code after the alias moved at about 20:23, so they are excluded.
- **Pacing:** a first attempt at concurrency 3 was aborted. Within 10 tokens, production hit:
  - nad.fun 429 (keyless, 10 req/min; about 5 nad.fun calls per analysis);
  - GeckoTerminal 429;
  - GoPlus 4029;
  - HoodTier's own per-client limit.
  
  At serial 36 s pacing there were no HoodTier 429s, no 5xx and no retries.
- **Raw data:** shared notes folder `…/side-session-notes/local_6e3bfa63-…/nadfun-sweep-data/`. It has full responses in `runs/paired_{old,new}/<ca>.json`, plus `log.jsonl`, `gt_*.json`, `compare_out.txt` and `table_new.txt`.
- **Review:** an independent Fable-model reviewer checked this report against the raw files. I re-verified its corrections (MONCHEL, MONCAT, MONIGGA, NAD trend, curve liquidity) before including them.

## Tier distribution (paired run, same moment)

| | S | A | B | C | D | F | U |
|---|---|---|---|---|---|---|---|
| **Old**, all 94 | 0 | 9 | 2 | 6 | 26 | 51 | 0 |
| **New**, all 94 | 0 | 8 | 2 | 5 | 30 | 49 | 0 |
| Old: graduated, established (54) | 0 | 9 | 2 | 6 | 26 | 11 | 0 |
| New: graduated, established (54) | 0 | 8 | 2 | 5 | 30 | 9 | 0 |
| Curve, established (26): old = new | | | | | | 26 | |
| Curve, launch (11): old = new | | | | | | 11 | |
| Unlisted fixtures (3): old = new | | | | | | 3 | |

- **Curve tokens:** 36 of the 37 have ≤ 19 holders or ≤ $76 of 24h volume (nad.fun), so F is right for them. The exception is PANAL: 780 holders, $198 volume.
- **What binds the new tiers:**

  | Binding | Tokens |
  |---|---|
  | Dead launch | 22 |
  | Micro-cap D | 22 |
  | Dust F | 16 |
  | Top holder ≥ 35% | 5 |
  | Honeypot | 5 |
  | Other | 24 |

  These liquidity caps and gates do not use volume. That is why the volume fix barely moves tiers.
- **Consistency checks:** displayed scores are monotone with tier, and there are no U tiers. No penalty is age-based; the only penalties are `dev_sold`, `vol_mc_bundle`, `broke_hl` and `top_holder_bundle`.

## Every tier move, and why

| Token | Old → New | Rule / factor (new response) | Real state (ground truth) | Verdict |
|---|---|---|---|---|
| WRAITH `0x7e8b…7777` | F 0 → **B 69.9** | `dead_launch` no longer fires. `buyer_seller_ratio` 0 → 3.0× (8 pts), `liq_fdv` 0 → 29.1% (12 pts). Coverage 78% caps it at B. | nad.fun 1D $337, DexScreener $338, liquidity $8,701, 147 holders | **Correct**: it was falsely "dead". |
| BUSY `0xb0a7…7777` | F 0 → **D 39.9** | `dead_launch` gone (volume $0 → $356). Capped by `top_holder_35`. | nad.fun $356, 10 makers, 1,399 holders | **Correct** |
| GONE `0x0b7a…7777` | F 0 → **D 39.9** | Same: volume $0 → $60. Capped by `top_holder_35`. | nad.fun $60, 5 makers, 69 holders | **Correct** |
| MONCAT `0x0158…1a70` | A 76.8 → **B 69.9** | Raw score rose 73.8 → 83.7. `liq_change_24h/7d` are now null: "nearest older one is 297h old (a gap in the history)". Coverage 78% → B. | nad.fun $349, DexScreener $352, liquidity $7,853 | **Correct but harsh.** See below. |
| MONCHEL `0xb684…7777` | D 39.9 → **F 0** | `dead_launch` fires on "$0.00 liquidity". | Same response: `nullReasons.liquidityTotalUsd` = "5 known pools sum to $10,304", and `monad-sim` sells at 1.99%. 0 nad.fun makers in 1D. DexScreener: no pairs listed. | **Wrong: new regression.** See below. |
| 143 `0x3842…7777` | C 49.6 → **D 39.9** | New `sell_tax_25` cap. `round_trip_loss` 2.0% → **48.3%**. | GoPlus sell tax 0%. Main v3 pool round-trip 1.99% (liquidity $6,986, listed in the same message). | **Wrong: new regression.** |
| BC `0x228c…7777` | B 67.7 → **D 39.9** | `sell_tax_25`. `round_trip_loss` 2.0% → **46.8%**, from a v4 pool with a 20% fee. | GoPlus 0% tax, 2,470 holders, liquidity $5,865 | **Wrong: new regression.** |
| HOGDOG `0xc911…7777` | B 65 → **D 39.9** | Plain `top_holder_35` instead of `top_holder_35_founder`. New response: "top-holder classification timed out (12s)". | Old code was already D 39.9 in the baseline an hour earlier, when the founder sell-history lookup failed. | **Noise.** An unknown founder status falls through to the harsher cap. |

### MONCAT: correct but harsh
- Old code showed the 297h-old reading as "−33.7% over 24h" *and* "−33.7% over 7d", which is pseudo data.
- On old code, 9 of the 18 tokens with a liquidity-change value have identical 24h and 7d figures.
- New code correctly refuses it.
- The A→B drop will last until 24h/7d history accumulates. I did not verify how long that takes.

### MONCHEL: a null total read as $0
- Seven tokens in the same state (0 buyers, no DexScreener pairs) stay D: Mongo, LISA, Anago `0x5df1…`, GIGA, Motion, sbgood, NEURON.

### 143 / BC / CATLABS: junk-pool sell tax, conditional on an outage
- The junk-pool choice happened only where GeckoTerminal was `failed` (429).
- In those cases the v4 pools carry `liquidityUsd: null` in `raw.monad-sim`, and the most liquid pool is passed over.
- Of 10 tokens that list high-fee v4 pools while GeckoTerminal failed, 3 were hit. Of 41 with GeckoTerminal not failed, 0 were hit.
- This is a correlation; I did not trace the selection rule.

### Score-only changes (no tier change)
8 tokens changed score without changing tier:

| Token | Old → New | Cause |
|---|---|---|
| CATLABS | 39.9 → 39.2 | junk-v4 `round_trip_loss` 36.9% |
| MAXI | 18.5 → 24.9 | |
| BOB | 72.7 → 76 | |
| EGG | 77.6 → 79.1 | |
| CHOG | 80.6 → 82.7 | |
| emo | 78.6 → 76.3 | |
| moncock | 81.5 → 79.8 | |
| MOLANDAK | 75.3 → 75.7 | |

### Noise floor
Old code, baseline vs paired-old, about 1h apart: 6 of 67 tiers differ.

| Token | Baseline → paired-old | Cause |
|---|---|---|
| MOLANDAK | B → A | GeckoTerminal partial vs ok |
| 143 | B → C | nad.fun 429 in the baseline (coverage 69%) |
| HOGDOG | D → B | founder sell-history lookup |
| Mongo | F → D | old code + GeckoTerminal 429 → liquidity and FDV read as 0 → `dead_launch` |
| LISA | F → D | same as Mongo |
| KINU | D → F | FDV $2,002 vs $1,996 at the dust line |

## Data that still looks wrong (new deployment)

### 1. Dust-pool / active-pool selection
This predates the deploy and was not fixed. The figures are present in the response but are not used:

| Token | Used for scoring | Present in the same response, or ground truth | Result |
|---|---|---|---|
| **MOE** `0xd8e0…7777` | buyers24h **1**, liquidity **$4.41**, volume $0.07 | `liquidityTotalUsd` $12,962; `nadfun` "400 buyers / 358 sellers"; nad.fun and DexScreener 1D $1,428 | F "dead launch — 1 buyers, $4.41 liquidity at 59d" |
| **GOCHI** `0x527d…7777` | liquidity $0.045, volume 0 | nad.fun "17 buyers / 18 sellers"; DexScreener liquidity $15,037 | F dead launch |
| **PANAL** `0x2e2e…7777` (curve) | volume 0, liquidity $0.77 (a GeckoTerminal pool) | nad.fun 1D $198, 4 buyers, 780 holders | F dead launch |

- MOE has the most makers in the set (762). By volume it is 4th, at about $1.9 per maker, which looks botted. Its creator sold 100% of what they bought, so C (`dev_sold` cap) or D is defensible. "Dead" is not.
- This is the Monad counterpart of what commit 6a1df47 fixed for Solana.

### 2. Junk-v4 round-trip loss after a GeckoTerminal 429
Affects 143, BC and CATLABS (see above). This contradicts the idea that GeckoTerminal outages are now harmless. Liquidity *does* now fall back to DexScreener (for example emo, BOB and IWRU keep their tiers through a 429), but sell-pool selection does not.

### 3. Null read as zero
- MONCHEL: see above.
- Curve tokens: 20 of 37 have `liquidityUsd` **0 with no reason**, while 15 have null with "curve liquidity not stated". These are the same kind of token treated two ways.

### 4. "Always score" not applied to zero activity
- The 7 zero-activity D tokens above have `buyer_seller_ratio` and `net_flow_24h` **missing** ("not provided by nad.fun"), although nad.fun reports "0 buyers / 0 sellers".
- The 25 zero-activity F tokens instead get "0 — no activity".
- Treating zero as missing inflates raw scores (Mongo raw 95.7).
- Old code behaves the same.

### 5. Stale candles scored as a live 7-day trend
- 16 tokens score `trend` from candles 9–208 days old. Examples:
  - NAD (a dead fixture): 7/7, "higher highs and higher lows (1 × 1h candles, 2026-10-28)";
  - Mongo: 7/7 from 2 candles dated 2026-10-03 → 10-10.
- 10 of 11 tokens whose trend source failed with "OHLCV failed 429" still have `trend` scored.

### 6. Value present and a null reason present at once
This is a class, not one token:

| Field | Tokens |
|---|---|
| `deployerAddress` | 94 of 94 |
| `volume24hUsd` | 7 |
| `liquidityUsd` | 4 |
| `buyers24h` | 12 |

Example: BUSY `liquidityUsd` $37,121 while its null reason says it cannot be stated, and DexScreener has no liquidity figure.

### 7. Honeypot verdicts from probe artefacts
- 5 tokens are bound by "Honeypot — cannot sell": MB, mshroom, chogjak, JACKET, AC.
- JACKET and AC: "transfer amount exceeds balance", meaning the probe wallet had no tokens. MB: "nad.fun sell returned no amount".
- All are dead (`dead_launch` also fires), so the tier is right, but the stated reason is not proven. Old code is identical.

### 8. Caps do all the work
- TYR, POSEIDON, PTAH and IDUNN (curve) score raw 90.6 with 1–2 holders and about $3 of volume. Only the Dust cap holds them at F, and they sit at exactly 60% coverage.
- 5 of the 8 A's have ≤ 13 makers in 24h:
  - EGG A 79.1: $4 volume, 6 makers.
  - MONIGGA A 84.9: $26 volume, $5.1k liquidity.
  
  Vetted public memecoin checklists treat liquidity under about $5–10k as manipulable and want multi-signal evidence for top tiers.
- On Monad these rules are always "unknown": `all_buyers_exited`, `bundler_majority`, `full_bundle`, `huge_candles`, `liq_drain` (94 of 94), and `dead_no_trades` (92 of 94).

### 9. Liquidity-change nulls
- New code: 164 `liq_change` nulls, all with reasons. 110 are history-type and 54 are "no pool liquidity".
- Old code: 131, of which 75 were history-type.
- Most are first-sighting artefacts of a sweep this broad, not caused by the deploy.

### 10. Nulls without a reason
None. Every `missing` factor in the 94 new responses carries a `nullReason`.

### 11. Age conditions in `factors.json`
`micro_cap` requires `ageHours ≥ 1` and `dead_no_trades` requires `≥ 12`. No output here was affected, but the owner may want to check these against the rule "age never gates".

## Remaining volume misses
On new code there are 3 of 44: MOE, GOCHI and PANAL, all from the dust-pool issue. MONIGGA ($25.9) matches nad.fun at its scoring time.

## Sources (new deployment, 94 analyses)

| Source | Status | Count | Reason |
|---|---|---|---|
| dexscreener | partial | 49 | "No pairs listed" |
| geckoterminal | partial | 36 | "No pools" |
| geckoterminal | partial / failed / stale | 26 | HTTP 429. Old run: 16. |
| nadfun-chart | failed | 4 | 429 |
| nadfun | failed | 0 | In the noise run at the same pacing, 3 of 67 failed with 429. |

**`NAD_API_KEY` appears not to be in effect in production.** nad.fun's `x-ratelimit-limit` of 10 is the keyless limit, and 429s appear at under 2 analyses per minute. A key (100/min) would remove most nad.fun partials.

## Speed (HTTP 200, `fresh: true`, serial)

| | median | p90 | max |
|---|---|---|---|
| Old | 11.7 s | 14.4 s | 20.2 s |
| New | 12.4 s | 16.3 s | 23.5 s |

New code is about 6% slower at the median. There were no timeouts or 5xx on either deployment.

## Has the model improved for Monad memes?

**Measurement: yes.**
- Volume is right for 41 of 44 active tokens, up from 0 of 44.
- An indexer outage no longer turns liquidity and FDV into zeros.
- Three live tokens are no longer called dead.

**Tiers: no measurable improvement yet.**
- 3 right moves are balanced by 3 new wrong ones: 143, BC and MONCHEL.
- Overall, the moves are within the noise floor.

**Suggested fixes, in priority order:**
1. **Round-trip loss:** take Monad round-trip loss from the most liquid or best route. Don't pick a pool whose liquidity is unknown, especially when GeckoTerminal is down. (143, BC, CATLABS)
2. **Active-pool selection:** never let a dust pool supply buyers, volume or liquidity when the response already has the total and nad.fun's counts. (MOE, GOCHI, PANAL)
3. **Null totals:** a null liquidity total must stay null, not become $0 for gates. (MONCHEL; 20 curve tokens)
4. **Zero activity:** nad.fun "0 buyers / 0 sellers" is a value. Score it as no activity, not missing.
5. **Stale candles:** don't score a 7-day trend from candles weeks old, or when the OHLCV fetch failed.
6. **Production key:** set `NAD_API_KEY` in production.
7. **Honeypot verdicts:** report probe-balance sell reverts as unverified, not honeypot.
