# HoodTier: team review, final plan (2026-11-23, repo main @ 1625b4f)

**Status:** final. The Senior Manager draft was merged with the Expert Advisor critique: all 13 blocking issues are resolved (§5 maps each one) and all 27 corrections are applied or explicitly deferred. This was a read-only planning run: this file is the only change. Nothing was edited, installed, committed or deployed.

**Builds on, does not repeat:** docs/research/2026-11-23-improvements-and-skills.md.

**Re-checked by the Senior Manager while finalising:**
- `lib/scoring/engine.ts:198-213`: `chains` → n/a, then `value === null` → `whenMissing` (`mode: "na" | "score" | null`), then `minSample` at :215-225. So a null meter never reaches `minSample`; that is blocker B1.
- `lib/scoring/conditions.ts:29-45`: a missing metric makes a rule "unknown" unless it has `orMissing`; the OPS are eq/ne/gt/gte/lt/lte/missing, and there is no `in` (B4, correction 2).
- The zero-activity path is opt-in per metric through `zeroMetrics` (engine.ts:184).
- `lib/kv.ts` exports get/set/incr only, with no MGET (correction 22).
- vercel.json has two crons, weekly and daily (B13).
- Holder weights per set, read from `factors.json.sets` (correction 1, table in §3.8).
- Rules with an `ageHours` condition: `vol_mc_bundle`, `bot_inflated`, `supply_controlled`, `micro_cap`, `dead_no_trades`, `lp_unlocked_unproven`, plus the two track-record bonuses (R10).

Everything else is cited from the four reviews, the expert guidance and the advisor critique, whose authors checked it.

---

## 1. Executive summary

1. **The main gap is the one the owner named.** Nothing in HoodTier tells a trader "one person holds many of these wallets", except on Solana for launches under 72h.
   - Even there the check counts wallets, has no CEX filter and picks the wrong cluster.
   - It also writes `clusterSupplyPct = 0` when it could not read a funder (lib/sources/helius.ts:301-317). That is a past integrity bug, which PR R1(a) fixes and REPORT.md must log.
   - In the reviewers' fixtures, a ring of 8 wallets holding 49.9% leaves fartcoin at B 68.6. A JAMES-style founder with 61% who sent tokens to wallets 153 times shows as "Top-10 10.1%".
2. **We will build one cross-chain Wallet-Cluster Meter.**
   - It reads 0–100 and its headline is "one linked group holds X% of supply (N wallets)".
   - It runs on Solana, Base, Monad and Ethereum, and on Robinhood in a labelled partial mode.
   - It uses only on-chain links we can prove (same-time funding within 30s, shared funders, multi-sends, token hand-offs, shared cash-out addresses and more).
   - It comes with a "Wallet map" bubble graph in which every line names its clue.
   - Caps mirror the single-holder caps (> 20% → C, ≥ 35% → D), because a hidden ring is at least as bad as an open whale.
3. **Honesty rules built into the meter:**
   - An unread wallet is never counted as independent. That covers age-screened wallets.
   - A gate never shows "passed" on a partial read.
   - "Pending" ends: after 3 attempts or 30 min it becomes null with named reasons.
   - Caps fire only on a proven lower bound of at least 10%.
4. **It answers inside 10–30s.**
   - Origins (who first funded a wallet) never change, so final ones are cached with no expiry. A warm run takes under 1s.
   - On a cold run the origin read starts when the holder list arrives, not after classification. Only the top-10 holders and first-10 buyers are read inline, ahead of other Helius work in a new priority lane. The rest finish in a rate-limited background route.
   - On Solana this replaces today's top-20 origin loop and halves its Helius calls.
5. **Next:** founder "never sold" through funded wallets (R3), trader-first UI honesty (R4), rug and dump gates (R5), anti-farming (R6), speed (R2, R7) and fail-closed supply accounting (R8). Bubblemaps stays deferred: it is paid, needs a partnerId, and its terms are unknown (R9).

---

## 2. Ranked roadmap

**Decision key:**
- **ACCEPT:** this cycle.
- **ACCEPT-LATER:** planned, after its dependency.
- **DEFER:** blocked on the owner or a third party.
- **REJECT:** see §4.

| # | Item | Effort | Decision | Depends on |
|---|---|---|---|---|
| R0 | Pre-flight probes (Helius method, Vercel plan, Upstash quota) | XS (½ day) | ACCEPT, first | none |
| R1 | Wallet-Cluster Meter (owner's ask) | L (8–10 days, 3 PRs) | ACCEPT | R0; R2 for background |
| R2 | Timings, deadline, safe background work route | M (3 days) | ACCEPT, in parallel with R1(a) | R0 |
| R3 | Founder and dev selling through funded wallets | M (2–3 days) | ACCEPT (owner decision logged) | R1(a) edge reader |
| R4 | Honest trader read (UI) | M (3 days) | ACCEPT; the U1 founder % ships first | R1(c) for the linked-wallets row |
| R5 | Rug and dump gates (config) | S (1 day) | ACCEPT | none |
| R6 | Stop farming and misstatement | M (2–3 days) | ACCEPT, after R1(b) | R1(b) |
| R7 | Speed remainder (D1, D4, D6–D11) | L (6 days) | ACCEPT-LATER | R2 timings |
| R8 | Fail-closed supply accounting | M (3 days) | ACCEPT-LATER (owner decision on LP) | none |
| R9 | Bubblemaps cross-check | S | DEFER (owner key and terms) | owner |
| R10 | Age-rule compliance cleanup | S (½ day) | ACCEPT (CLAUDE.md rule; logged) | none |

### R0. Pre-flight probes: ACCEPT, first
These answer the facts the R1 design rests on (B11, B13, correction 22). They are read-only checks with no code shipped.
1. **Helius `getTransactionsForAddress`.** Call it once with the owner's HELIUS_API_KEY.
   - If it works, the Solana origin design stands. The cost is about 10 credits per call, so about 200 credits per cold token for 20 inline wallets and 400 with background (helius.dev/docs/rpc/gettransactionsforaddress).
   - If it fails, R1 uses the §3.4 fallback, and the coverage expectations in §3.7 drop.
2. **Vercel plan.** Read the plan tier. It decides the `*/5` cron versus self-chained `after()` → signed `fetch`, and maxDuration 300 versus 60 for `/api/work`.
3. **Upstash.** Read the free-tier command quota against about 40 MGET keys plus about 20 SETs per cold run, on top of the `kvIncr` that already runs on every Helius call (heliusQueue.ts:22).
4. **Robinhood.** Two checks:
   - does a non-archive `eth_getBlockByNumber(n, true)` at an old block still return the block body (correction 8)?
   - does HoodScan `get_address` or `get_trader` expose first funding?
5. **Monad.** Check the public archive depth (REPORT.md:131 notes "Block requested not found").

Write the results in REPORT.md.

### R1. Wallet-Cluster Meter: ACCEPT
- **Goal:**
  - a 0–100 meter, plus "one linked group holds X% of supply (N wallets)";
  - the owner's literal "same-time funded" count (`sameTimeFundedMax`) and same-time buys (`sameTimeBuyMax`);
  - scored, with caps and a Wallet-map SVG;
  - live on Solana, Base, Monad and Ethereum, and partial on Robinhood.
- **Why:** bundles, sybil holder bases and funder sprays are the most common meme rug, and today they pass at A or B (fartcoin with a 49.9% ring stays B 68.6; microduck with a randomised ring stays A 73.5).
- **PRs:**
  - **(a)** lib/onchain/origin.ts, the Solana fix (replaces helius.ts:296-317), the `heliusQueue` priority lane, KV `mget`, and the per-request lookup memo;
  - **(b)** lib/cluster/{graph,collect,meter}.ts, the EVM and Robinhood readers, the factors.json changes, and the infra registries;
  - **(c)** ClusterMeter, ClusterBubbles, the Quick read row and the pending poll.
- **Files:**
  - **New:** lib/onchain/origin.ts, lib/cluster/graph.ts, lib/cluster/collect.ts, lib/cluster/meter.ts, data/solana-infra.json, data/bot-infra.json, data/disperse-contracts.json, data/aa-entrypoints.json, components/ClusterMeter.tsx, components/ClusterBubbles.tsx.
  - **Changed:** lib/analyze.ts, lib/snapshot.ts, lib/types.ts, lib/kv.ts, lib/sources/helius.ts, lib/sources/heliusQueue.ts, lib/topHolders.ts, lib/holderStrengthData.ts, lib/timemachine/core.ts (:93 `max : 1` → null with reason), data/{base,monad,robinhood}-infra.json (`cexWallets`), lib/scoring/factors.json, components/Report.tsx.
- **Keys:**
  - only existing ones: HELIUS_API_KEY, plus optional private archive RPCs and ETHERSCAN_API_KEY;
  - no new required paid key.
- **Risks and their guards:**

| Risk | Guard |
|---|---|
| False clusters from CEX, bridge, relayer, 4337 or bot infrastructure | §3.5 exclusions, registered-disperse-only multisend, signer rules, consecutive-spray hub rule |
| Pending stuck forever | end state, §3.6 |
| Credit burn by third parties | §3.7 locks and caps |
| Robinhood has no funding edges | partial label; S blocked by default |

- **Tests:** §3.11.
- **Decision:** ACCEPT. The estimate rose from 6–8 to 8–10 days, because of the B6–B9 rules and the registries.

### R2. Measure and background enablers: ACCEPT
- **Why:**
  - after() work dies at the 60s maxDuration (app/api/analyze/route.ts:13);
  - the deadline starts after up to 32s of unbudgeted pre-work (lib/analyze.ts:387, lib/memeFilter.ts:57-61);
  - there are no per-phase timings.
- **Changes:**
  1. `report.timings` per phase (lib/analyze.ts, lib/types.ts), and `sources` plus `totalMs` on ScoreEntry (lib/scoreHistory.ts).
  2. scripts/latency.mjs plus a README LOOP step. Gates:
     - p95 total ≤ 30s;
     - cluster inline ≤ `CLUSTER_BUDGET_MS`;
     - the U rate is not above baseline;
     - the share of cold runs ending `pending` is reported per chain.
  3. A Deadline created at request arrival in app/api/analyze/route.ts and app/api/tier/route.ts, then passed down.
  4. **`/api/work` (B13).** HMAC with CRON_SECRET; kinds `cluster | ledger | outflow | replay | tm`; and:
     - a KV lock per `(kind, chain, token)` (SET NX, 5 min);
     - at most 3 attempts per token per 6h;
     - a global cap of `WORK_JOBS_PER_HOUR` (env, default 120);
     - an enqueue that is allowed only when the triggering analyze request passed `takeLiveSlot`.
  5. Scheduler, chosen by R0:
     - Pro: a `*/5` cron over tokens analysed in the last 24h with unresolved progress;
     - Hobby: no frequent cron. `after()` → a signed `fetch('/api/work')`, and each hop re-enqueues itself until it finishes or runs out of attempts.
  6. stockRegistry: 3s live cap, 60s negative cache, 7d roster.
  7. The Helius curve replay uses getTransactionsForAddress if R0 confirms it (helius.ts:177-246).
- **Tests:**
  - HMAC verify;
  - lock exclusivity;
  - attempts and hourly cap enforced;
  - progress resume from KV;
  - a latency script run in the LOOP.
- **Decision:** ACCEPT.

### R3. Founder and dev selling routed through transfers: ACCEPT (owner decision logged)
- **Why:**
  - `sells = toPools + swapSells` (lib/topHolders.ts:411, :447);
  - `founderNeverSold` ignores transfers to wallets (:471-475);
  - that keeps the A softening and removes the founder from top1 and top10 (lib/snapshot.ts:553-566).
- **Changes:**
  - Follow one hop for each deployer, founder or team recipient of more than `handoffMinPct` (0.05%) of supply. Recipient sells add to the founder's sold figure, with the evidence "sold X% through N wallets it funded".
  - `founderNeverSold` requires that no recipient sold and that recipients hold under 1% in total. Otherwise the founder and its recipients form a team cluster under the R1 caps.
  - The airdrop exception (≥ 50 recipients, each under 0.1%) is labelled "airdrop distribution" and not linked.
  - Add `founderTransfersOut` to HolderClassRow.
  - Solana creator history reads `limit:100` only (helius.ts:332). Label it "last 100 txs only, incomplete"; the full read goes to `/api/work`.
- **Data source (B12):** Holder Strength runs only for established tokens (lib/analyze.ts:539), so do not rely on its ledgers.
  - EVM: one `eth_getLogs` for Transfer with `topic1 = [founder, team]` (an OR filter, as the cohort code does, REPORT.md:1085), then a second `eth_getLogs` with `topic1 = [recipients]` for their sells to pools.
  - Solana: the curve replay's per-wallet sells (helius.ts:233+) before graduation, and the recipients' `getTransactionsForAddress` pages after it.
- **Owner decision #2:** a founder who funds market-maker or listing wallets loses the A softening. This changes the 2026-11-23 founder rule.
- **Tests:**
  - founder → 3 wallets → pool sells: `founderNeverSold` false, normal cap;
  - an airdrop to 60 small wallets keeps the founder path;
  - the founder-cap tests are replaced, not deleted, and listed in REPORT.md.

### R4. Honest trader read (UI): ACCEPT
- **Why:**
  - "Top-10 10.1%" printed beside a 61.1% founder (components/prosCons.ts:33);
  - trap pools (65–75% fee, 88–94% round-trip loss) are hidden in a clamped Sources row (app/globals.css:556);
  - on a 375px phone the verdict sits at 847px and Gates at 3037px.
- **Changes:**
  - The founder % goes beside every ex-founder figure (prosCons.ts, present.ts, displayTemplate variant). This is **U1**, the first PR.
  - A **Quick read** card under the tier: Verdict, Main risk, Who holds, Can I sell, and **Linked wallets** (from R1).
  - A **Sell check** from `raw[<chain>-sim].pools`, with a red "avoid" line for trap pools.
  - Why lists risks first and stops saying "no cap binds" when a cap equals the tier (components/verdict.ts, engine.ts:534).
  - The sticky bar shows the main-risk sentence (Report.tsx:952).
  - The Social panel collapses to one line when null and moves below the factor groups.
  - One holders table with a cluster column.
  - A client poll every 15s for up to 2 min while `holderStrengthPending` or `walletClusterPending` is true.
  - Format fixes: priceUsd → formatPrice, the age unit, and "Clear." → a filled template.
  - "raw N" only when the score is clamped.
- **Tests:**
  - prosCons: a founder-excluded pro contains the founder %;
  - Sell check rendering with the monad-sim fixture;
  - whyLines ordering;
  - Playwright at 375px: Quick read above the fold, trap-pool line visible.
- Snapshot churn is expected. Replace the snapshots and note it in REPORT.md.

### R5. Rug and dump gates, config only: ACCEPT
- **Solana `liquidityPulled`.** True when every market is under $100 (RugCheck markets plus DexScreener and GeckoTerminal), corroborated by Jupiter "no route" where a route existed earlier. RugCheck `rugged` is corroboration only (lib/sources/rugcheck.ts:111, jupiter.ts:42). Add solana to `liquidity_pulled.chains` (factors.json:7248).
- **`dump_24h`:** priceChange24hPct ≤ −40 and netFlowRatio24h ≤ −0.2 → cap B.
  - It is `orMissing` on net flow (correction 7), so the template must say "net flow unknown, treated as selling" when it is missing.
  - Apply the same template fix to `price_collapse` (:7453-7472).
- **`slow_rug_7d`:** priceChange7dPct ≤ −70, netFlowRatio7d < 0 and trendScore = 0 → cap C, with `chains: ["robinhood"]` (correction 6).
  - `netFlowRatio7d` is filled only by HoodScan (hoodscan.ts:109, :219); GeckoTerminal parses only `transactions.h24` (geckoterminal.ts:20, :70).
  - Widen it to other chains only after an engineer confirms that GeckoTerminal daily candles carry buy and sell volume. Never treat a missing 7d flow as selling.
- **`cluster_dumping`:** from R1 (§3.8).
- **Tests:**
  - rugged-Solana-pool fixture → F;
  - CHOG −85% 7d with net selling (Robinhood) → C;
  - −70% with net buying → no cap;
  - microduck −55% 24h with sellers 3:1 → B;
  - missing net flow → the template says "treated as selling".

### R6. Stop farming and misstatement: ACCEPT, after R1(b)
- **Wash evidence** comes from the inputs actually read (lib/snapshot.ts:431-437), e.g. "turnover 0.11× liquidity; swap patterns not measured on Solana".
- **VOL/MC:**
  - no credit above 5× the bar;
  - VOL/MC > 5× with volume per trader > 3× the chain median → wash flag;
  - `vol_mc_bundle` becomes cap-only with 0 points.
- **`accumulatorCountIndependent`** counts accumulators outside strong clusters, not deployer-funded and not fresh. `s_accumulators` reads it (:8341).
- **`uniqueBuyers` is NOT reduced by cluster members** (correction 5, one mechanism per signal). Its evidence adds "of which N linked (among M sampled)". Dust holders under $1 are still excluded from holder counts, and the evidence says so.
- **RugCheck `insiderNetworks === null`** stays null with a reason (rugcheck.ts:130). Relabel it "supply moved through insider networks".
- **`bundler_majority`:**
  - fed from R1, counting only clusters still holding ≥ 1% (correction 4);
  - its label "majority of holders" (:7807) becomes "first buyers".
- **`fees_low`** is deleted and logged in REPORT.md: no input exists.
- **One mechanism per signal:** `liq_change_7d` vs `liq_drain`, the fresh_wallets factor vs its rule, and Robinhood `bundle_share` relabelled "recent same-block share".
- **The thin-trading relative floor is DEFERRED** (owner decision #5; CHOG would move).
- Fixture score changes are replaced and noted in REPORT.md.

### R7. Speed, remainder: ACCEPT-LATER (after R2 timings exist)
- **Order:** D7 ScanHood 8–10s cap → D4 replay meta key → D8 single GeckoTerminal wait budget → D10 rpcBatch and getCode memo (the cluster checks use `codeKind`) → D9 AbortController → D1 four-lane task graph (market, chain, holder, cluster) → D11 KV lock plus stale-while-revalidate.
- **D11:** stale-while-revalidate is at most 60s for launch-set tokens and 10 min for established. This is cache policy, not scoring.
- **D6 Upstash** is an owner env task.

### R8. Fail-closed supply accounting: ACCEPT-LATER
- An unclassified contract counts in concentration, or concentration becomes null with the reason (lib/snapshot.ts:280, lib/analyze.ts:582-585).
- Lockers and vesting come from a per-chain registry, not selectors alone (holderClass.ts:26-35). An expired `unlocksAt` counts as liquid.
- Copy back `equalSplitPct` / `equalSplitCount` (lib/analyze.ts:578).
- The LP check is keyed on who owns the LP, with a locker registry (lib/analyze.ts:432-437, factors.json:7359, :8409).
- Removing the age condition from it is owner decision #4.

### R9. Bubblemaps cross-check: DEFER
- **Why:** the Data API is paid (Pro credits, prices not published). The iframe needs a Bubblemaps-issued partnerId and domain whitelisting. No data-use terms were found (docs.bubblemaps.io/data/api/authentication, /iframe/pricing; bubblemaps.io/terms).
- **If the owner gets a key and confirms the terms:**
  - lib/sources/bubblemaps.ts makes one `/v0/tokens/metrics` call (6s cap, in parallel);
  - it appears in Sources only, as ok / failed / skipped ("BUBBLEMAPS_API_KEY not set");
  - it is **never scored**;
  - the iframe only with BUBBLEMAPS_PARTNER_ID.

### R10. Age-rule compliance: ACCEPT (CLAUDE.md is already the decision; logged in REPORT.md)
CLAUDE.md says age never gates or penalises. These rules carry an `ageHours` condition:

| Rule | Current | Fix |
|---|---|---|
| `bot_inflated` | ageHours < 24 inside a −10 penalty | `sets: ["launch*"]`, ageHours removed (the set already carries the age selection) |
| `supply_controlled` | ageHours < 24 inside a −10 penalty | same treatment |
| `vol_mc_bundle` | repeats ageHours < 72 in a launch-set rule (:7728) | drop the redundant age term; launch sets select it |
| `micro_cap` | ageHours ≥ 1 or missing (first-hour exemption) | review; it exempts, not penalises. Note it in REPORT.md |
| `dead_no_trades` | ageHours ≥ 12 (exemption) | review; same as above |

The track-record bonuses (+1.5 / +3) are allowed: age only adds.

Tests: each changed rule fires on a token that matches every condition except age. The replaced assertions are listed in REPORT.md.

---

## 3. WALLET-CLUSTER METER: implementation spec

### 3.0 The owner's request, read two ways (both are covered)
- **(a) Funding window.** Wallets funded by the same non-excluded source **within 30s**, or in the same slot, block or registered multi-send tx, are "same-time funded". That count is `sameTimeFundedMax`.
  - Wallets that also **bought within 30s** of each other are counted in `sameTimeBuyMax`, the classic bundle signature, at no extra cost.
  - Wider windows are graded: a shared funder within 30 min is strong, and 30 min–2h is weak.
- **(b) Latency.** The check answers inside the 10–30s analysis. Warm runs take under 1s. Cold runs resolve the priority wallets inline (budget 8s, started early), and the rest complete in the background, shown as "reading N of M" until then.
- **Owner question 1:** is the window 30s or 10s? It is `walletClusters.sameTimeSec` in factors.json, with no code change.

### 3.1 Types (lib/types.ts)
```ts
type FunderKind = "eoa"|"contract"|"multisend"|"cex"|"bridge"|"launchpad"|"router"|"hub"|"bot_infra"
                | "relayer"|"aa_bundler"|"program"|"deployer"|"unknown";

interface Origin {
  wallet: string;
  fundT: number|null;            // unix s of first native-coin receipt
  fundRef: string|null;          // block number or slot
  funder: string|null;
  funderKind: FunderKind;
  funderNonce?: number;          // EVM: funder's nonce on the funding tx (consecutive-spray test)
  via: string|null;              // registered disperse/multisend contract only
  viaRecipients?: number;        // recipients credited in the funding tx (batch-withdrawal test)
  fundTx: string|null;
  method: "helius-gtfa"|"helius-sigs"|"etherscan"|"archive-2stage"|"unreadable";
  final: boolean;                // true ⇒ cacheable with no TTL (B9)
  proof?: "balance0+nonce0"|"first-tx"|"not-proven-7702";
  freshness?: { agedBeforeSec: number };   // age screen only: freshness, NOT clustering (B5)
  reason?: string;               // whenever funder is null or not final
}

type EdgeKind =
  | "same_time_funder"   // shared non-excluded funder, |Δt| ≤ sameTimeSec or same slot/block        [strong]
  | "shared_funder"      // shared non-excluded funder, |Δt| ≤ strongWindowSec                       [strong]
  | "direct_fund"        // A (or deployer) funded B                                                [strong]
  | "multisend"          // credited in one tx by a REGISTERED disperse contract, not a batch withdrawal [strong]
  | "peel"               // funder → fresh intermediate (≤ peelWindowSec, forwarded > peelForwardPct) → wallet [strong]
  | "token_handoff"      // plain token transfer A→B (> handoffMinPct of supply)                     [strong]
  | "paid_buy"           // buy signer ≠ recipient AND signer is in the sample or a non-hub code-less EOA [strong]
  | "common_sink"        // sell proceeds / swap recipient to the same non-infra address              [strong]
  | "create_slot_buy"    // Solana: buy in create slot/tx, funded ≤ 1h before; EVM: pool-creation block AND a funding edge [strong]
  | "deployed_by"        // holder contract whose creation sender is a cluster member               [strong]
  | "hub_spray"          // unlabelled hub → ≥ 2 sample wallets by consecutive nonces / one tx / adjacent slots, no foreign recipient between [strong]
  | "same_block_buy"     // first buys in the same block/slot                                       [weak]
  | "funder_2h"          // shared funder, strongWindowSec < |Δt| ≤ weakWindowSec                   [weak]
  | "hub_funder"         // shared unlabelled hub, not a consecutive spray                          [weak]
  | "batch_withdrawal"   // one tx crediting > 20 recipients with sample < 25% of them              [weak]
  | "cex_batch";         // same labelled CEX hot wallet within cexBatchSec, amounts within ±cexBatchAmountPct [weak]

interface ClusterEdge { a: string; b: string; kind: EdgeKind | "composite"; strength: "strong"|"weak";
  parts?: EdgeKind[]; tx?: string; gapSec?: number; detail: string }
interface ClusterNode { address: string; role: "holder"|"buyer"|"both"; pct: number|null; buyRank: number|null;
  buyT: number|null; holderClass: string|null; clusterId: string|null; origin: Origin|null;
  status: "resolved"|"freshness-only"|"unresolved"|"excluded"; excludedReason?: string }
interface Cluster { id: string; members: string[]; supplyPct: number; buyers: number; funder: string|null;
  includesFounder: boolean; founderOnly: boolean; edgeKinds: string[]; netSell24hPct: number|null; evidence: string }
interface ClusterGraph {
  chain: Chain; token: string; computedAt: number;
  nodes: ClusterNode[]; edges: ClusterEdge[]; clusters: Cluster[];
  exclusions: { address: string; kind: FunderKind; label: string; source: string; wallets: number }[];
  edgeKindsReadable: EdgeKind[];
  sources: { id: string; status: "ok"|"partial"|"failed"|"skipped"; reason?: string; ms: number; calls: number }[];
}
```

### 3.2 Snapshot fields (lib/snapshot.ts)
Every field that can be null gets a `nullReasons` entry when it is null.

| Field | Type | Meaning / publication rule |
|---|---|---|
| `walletClusterMeter` | number \| null | 0–100. Published only when the coverage bar (§3.6) is met. Otherwise null, and the reason says why. |
| `walletClusterState` | "live" \| "partial" \| "pending" \| "stale" \| "null" \| "n/a" | `partial` = Robinhood without funding edges. |
| `walletClusterPending` | boolean | Background work in flight **and** within the end-state limits (§3.6). |
| `walletClusterAttempts` | number | Background attempts in the current 6h window. |
| `clusterSupplyMinPct` | number \| null | **Caps read this.** The proven lower bound: the largest strong cluster's share of **total** supply, with **this run's** balances. Same basis as `top1SharePct`: pools, curves, burns and registry-verified locked contracts are excluded; members that left the list count 0. **Published only when ≥ 10 or when coverage is complete**; otherwise null with "no linked group ≥ 10% proven yet (N of M read)". |
| `clusterSupplyPct` | number \| null | Same number, published only when the state is live, partial or stale. Used in factor evidence. |
| `clusterSupplyText` | string \| null | Pre-rendered "22.4%" or "at least 22.4%" for templates; `fill()` has no conditionals. |
| `clusterSupplyIsLowerBound` | boolean | true while unresolved wallets remain. |
| `clusterHoldShare` / `clusterBuyShare` | number \| null | 0–1 parts of the meter. |
| `fundingClusterMax` | number \| null | Wallet count of the largest strong cluster (kept for compatibility). |
| `sameTimeFundedMax` | number \| null | Largest group funded by one non-excluded source within `sameTimeSec` or the same slot/block. A lower bound while unresolved; null when fewer than 2 funders are resolved, never 0 by default. |
| `sameTimeBuyMax` | number \| null | Largest group sharing a funder whose first buys fall within `sameTimeSec`. |
| `clusterCount` | number \| null | Clusters of size ≥ 2. |
| `clusterResolvedWallets` / `clusterSampleWallets` | number \| null | Coverage. Resolved = funder found or proven excluded (not age-screened). |
| `clusterHolderSupplyResolvedPct` | number \| null | Share of sampled holder supply whose wallets are resolved. |
| `clusterFreshnessOnlyWallets` | number \| null | Wallets funded > 7d before, whose funder read is pending. |
| `clusterIncludesFounder` / `founderClusterOnly` | boolean \| null | `founderClusterOnly` = the largest cluster is the founder alone, or the founder plus recipients that all hold and never sold (R3's strict definition). |
| `clusterNetSell24hPct` | number \| null | Share of strong-cluster holdings sold in 24h. Fed in **both** modes (§3.4c). |
| `clusterEdgeSummary` | string \| null | e.g. "funded by one wallet within 36s; 2 token hand-offs". |
| `bundlerMajority` | boolean \| null | > 50% of resolved first-20 buyers sit in strong clusters **still holding ≥ 1%**. |
| `bundlerShare` | string \| null | Pre-rendered "14 of 20". |
| `accumulatorCountIndependent` | number \| null | Used by R6. |

`report.clusterGraph: ClusterGraph | null` goes in the report for the UI. It is not in the snapshot.

### 3.3 Sample (lib/cluster/collect.ts)
The sample is built as soon as the holder list arrives. It does **not** wait for holderClassification (B10d).

Exclusions are applied when the graph is built, from the infra registries, `codeKind` (rpc.ts:273, chainInfra.ts:50-51) and the curve and pool addresses the adapters already know. Classification results join later, only for labels and the team tag.

- **H (holders), up to 20.** Take the top-20 counted holders, then:
  - drop pools, curves, migration accounts, registry lockers and vesting while locked, infra, Solana program or off-curve owners, labelled CEX wallets, and dust under `dustPct` (0.05%);
  - de-duplicate by owner;
  - keep the founder and team, tagged;
  - run the **exchange-like holder test** (correction 16): nonce > `hubNonce` or ≥ `hubSigs` signatures, and no edge to the deployer → out of the cluster sample with the label "exchange-like custody wallet". It stays counted in concentration, per data/ethereum-infra.json:2.
- **B (first buyers), up to 20 distinct, in buy order:**
  - **EVM, Robinhood included:**
    - token Transfer logs out of the main pool or router from the pool-creation / addLiquidity block (1–3 `eth_getLogs`);
    - batched `eth_getTransactionByHash` for `tx.from`;
    - **Uniswap v4:** take the EOA recipient within the same tx, never the PoolManager or router (correction 20).
  - **Solana, in order of preference:**
    1. `raw.pumpfeed.top_wallets` (pumpfeed.ts:37, :114);
    2. Helius curve-replay buyers and firstBuyTime (helius.ts:60, :106);
    3. the mint's first history page, ascending (1–2 calls).
  - Record the slot or block, the signer or fee payer, the recipient owner and the buy time.
  - Cache at `early-buyers:v1:{chain}:{token}`: no TTL once 20 are found or the launch window has closed; otherwise 10 min.
- **Inline priority:** top-10 holders, then first-10 buyers (B10b). The rest of H and B, up to 40 wallets, go to the background.
- **Zero activity:** no wallets to sample → whenMissing n/a with "no wallets to sample (no trading activity)". This is not a number: a meter of 0 would read "independent", the opposite of what is known. The metric is not added to `zeroActivity`. Decision logged in REPORT.md.

### 3.4 Origins (lib/onchain/origin.ts), one helper for every reader
`originOf(chain, wallet, { buyRef?, deadline, priority })` → `Origin`.

- **In-request memo:** one in-flight promise map per request, shared by the cluster step, Holder Strength (holderStrengthData.ts:289), topHolders (topHolders.ts:29-32), founderLink and the time machine (correction 23).
- **Readers that switch to it:** Holder Strength wallet age, founder-link, the time machine and Helius freshWallets, which fixes the four readers that disagree. In the time machine, core.ts:93 `max : 1` becomes null with a reason.

**Caching (B9):**
- `origin:v2:{chain}:{wallet}` has **no TTL only when `final`**: the funder is found with proof, or excluded with proof, **and** the funding is past finality (Solana `finalized`; EVM more than 64 blocks deep).
- `unknown`, `unreadable`, read errors and non-final results get a TTL of at most 3600s and keep their reason.
- Legacy `helius:origin:v1` entries with `funder: null` are ignored. v1 funders are used only as hints to re-verify. `first-native:v1` and `wallet-first-seen:v1` are hints only.

**(a) Solana**
- **Primary (if R0 confirms):** one `getTransactionsForAddress(wallet, { sortOrder: "asc", limit: 5, transactionDetails: "full" })`.
  - Find the first tx where the wallet's lamports rise. The funder is the **non-program** account with the largest lamport drop (balance deltas cover inner instructions and disperse programs).
  - **There is no fee-payer fallback.** No rise in the first 5 txs → `unknown`, "first 5 txs carry no SOL receipt (token-first wallet)", not final.
  - It is a multisend when one source credits ≥ 3 accounts in that tx; `via` is set only if the program is in data/disperse-contracts.json, and `viaRecipients` is recorded.
- **Fallback (method unavailable):** `getSignaturesForAddress(limit 1000)`, then `getTransaction(oldest)` with the same balance-delta parsing.
  - A full page of 1000 → `unknown`, "active wallet: first funding not reachable inline; read in background". Never a guessed funder.
  - This also fixes helius.ts:301-305: a non-transfer first instruction no longer becomes "no funder".

**(b) Base, Monad, Ethereum**
1. **ETHERSCAN_API_KEY set and the chain covered:** `txlist` + `txlistinternal` with sort=asc and offset=1 (2 calls).
   - Ethereum is free.
   - Base needs a paid plan (.env.example:40).
   - Monad on Etherscan v2 is not verified (R0).
2. **Otherwise the archive, in two stages:**
   - **Age screen (freshness only, B5):** 3 parallel `eth_getBalance` calls at the reference block minus 1h, 24h and 7d.
     - A balance > 0 seven days earlier → `freshness.agedBeforeSec = 604800`, node status `freshness-only`.
     - That wallet is **not resolved** for clustering, not counted as independent, and not in the coverage bar. Its funder is read in the background.
   - **Narrowed kSearch** (holderClass.ts:97-110) inside the zero-balance window: about 48 calls when narrowed to under 7d, about 100 over the full range (correction 12). Inline it runs for **top-10 priority wallets only**.
   - **Proof (correction 11):** `balance(found−1) == 0 && nonce(found−1) == 0` → `proof: "balance0+nonce0"`.
     - A no-code EOA cannot lose coin without a nonce increase, so funded → drained → refunded is rejected.
     - On failure: widen and retry once, then `unknown` with the reason.
     - A 7702-delegated wallet (from `codeKind`) gets `proof: "not-proven-7702"`, "first funding not proven (7702 wallet)", and is not final.
   - **Multi-send (B6):** if no tx in the funding block has `to === wallet`, scan the block's tx inputs (already fetched) for the wallet's 20-byte address.
     - Attribute to `tx.from` **only** if `tx.to` is in data/disperse-contracts.json, or its bytecode matches a disperse selector via `matchSignature` (holderClass.ts:41-44), e.g. `disperseEther(address[],uint256[])`.
     - Then `funder = tx.from`, `via = tx.to`, `funderKind = "multisend"`.
     - Any other contract (Across SpokePool, Relay or solver fills, router unwraps, ERC-4337 `handleOps`) → `funder = tx.to`, kind `contract` / `relayer` / `aa_bundler`, **excluded**.
3. Contract detection always uses `codeKind`, so 7702 and minimal-proxy wallets stay wallets (correction 15).

**(c) 24h cluster selling, both modes (B12)**
- **EVM:** one `eth_getLogs` over the last 24h for Transfer with `topic1 = [cluster members]` (OR filter, chunked to the endpoint's span) → transfers into pools and routers = sells.
- **Solana:**
  - before graduation: the curve replay's per-wallet sells (helius.ts:233+);
  - after it: token-balance deltas in each member's latest `getTransactionsForAddress` page (desc, limit 20, background if not inline).
- `clusterNetSell24hPct` = sold ÷ (sold + held now), across strong-cluster members. Null with the reason when the read failed.

**(d) Robinhood**
- With public infrastructure, native funding is `unreadable`: "Robinhood RPC keeps no historical state; native funding not readable". There is no trace API and Blockscout returns 403 (live probes, 2026-11-23). Not final; TTL 1h.
- If ROBINHOOD_RPC_URL is an archive, path (b) is used.
- If R0 finds that old block bodies are served, a **background** bounded scan of `[buy − 10 min, buy]` block bodies can find EOA→EOA funding for launch buyers. That would lift Robinhood from partial for launch tokens.

### 3.5 Exclusions and edges (lib/cluster/graph.ts stays generic; every number comes from factors.json `walletClusters`)

**Classifying a funder.** Each distinct funder is classified once and cached at `funder-kind:v1:{chain}:{addr}` for 7 days.
1. **Labelled infrastructure → excluded, never a funding edge, never a sink.** It applies to the funder **and** to a multisend signer (correction 17). Sources:
   - data/{chain}-infra.json (routers, pools, launchpads, bridges, lockers);
   - `cexWallets` (new in base, monad and robinhood; new data/solana-infra.json);
   - data/bot-infra.json (Jito tip accounts; Trojan, BonkBot, Photon, Maestro and Banana Gun fee collectors);
   - data/aa-entrypoints.json (ERC-4337 EntryPoints per chain);
   - known settlement and filler contracts.

   Every entry carries a `source` and a `verifiedAt` date, and is checked on chain before commit, as data/ethereum-infra.json does. Prefer behavioural evidence over imported name tags (correction 26).
2. **Contract by `codeKind`, not a registered disperse contract** → excluded (kind `contract` or `relayer`).
3. **Unlabelled hub test** (nonce > `hubNonce` 5000, or ≥ `hubSigs` 1000 signatures in one page). Run only for funders shared by ≥ 2 sample wallets (B8):
   - **consecutive spray:** EVM funding txs to ≥ 2 sample wallets have consecutive `funderNonce` values, or Solana credits sit in one tx or adjacent slots with no non-sample recipient between them → strong `hub_spray`;
   - otherwise → weak `hub_funder`.

   No extra calls: the funding txs are already fetched (and for Solana adjacent slots, the hub's signature page from the test).
4. **Batch withdrawal** (correction 17): a funding tx with `viaRecipients > 20` where sample wallets are under 25% of the recipients → weak `batch_withdrawal`, never strong.
5. **The deployer as funder** → kind `deployer`, which creates `direct_fund` edges to the team cluster.

**Edges.** Strong edges merge through union-find; weak edges are drawn but never merge on their own.
- Funding windows: `sameTimeSec` 30, `strongWindowSec` 1800, `weakWindowSec` 7200.
- `create_slot_buy`:
  - Solana: a buy in the create slot or create tx by a wallet funded ≤ `createSlotFundedWithinSec` (3600) earlier → strong;
  - EVM: the pool-creation block is strong **only with** a funding edge or deployer funding; otherwise it is `same_block_buy` (weak).
- `peel`: inline only when the intermediate was funded ≤ 1800s before it sent and forwarded more than 80%. The general second hop runs in the background.
- `token_handoff`:
  - EVM: from the 24h and launch Transfer reads (§3.4c, R3), plus the Holder Strength ledgers when present (holderStrengthData.ts:254, :323);
  - Solana: the top holders' token-account history, in the background unless already cached;
  - **airdrop exception:** a sender with ≥ 50 recipients each under 0.1% → "airdrop distribution: N recipients", with no edges to those small recipients unless they also share a sink or same-block sells. Recipients above 0.1% still link.
- `common_sink`:
  - EVM v2 `Swap(…, to)` and v3 `Swap(…, recipient)` where the recipient ≠ the wallet and is not infra: inline;
  - v4 (no recipient in `Swap`) from the following transfers: background;
  - Solana SOL swept to one address after sells: background.
- `paid_buy` (B7): buy `tx.from` or the fee payer ≠ the recipient, **and** the signer is in the sample (it holds or bought this token), **or** the signer is a non-hub EOA with no code by `codeKind`. EntryPoint, settlement, filler and relayer signers, and fee payers that pass the hub test, give **no edge**.
- `deployed_by` (correction 19): a holder contract whose `creationSender` (already imported, topHolders.ts:6) is a cluster member joins that cluster.
- **Two-kinds rule:** two weak edges of **different** kinds on the same pair merge, recorded as a `composite` strong edge with both clues listed. One weak edge never merges, and two weak edges of the same kind never merge.
- **Team cluster:** deployer + team EOAs + recipients linked by `token_handoff`, `direct_fund` or `deployed_by`.
  - A lone founder wallet is size 1, never counts as a cluster, and stays on the founder cap path.
  - Safe treasuries join only when an edge ties them to the deployer.
  - Vesting beneficiaries join once `unlocksAt ≤ now`.
- Edges from `clusters:v1` progress are permanent facts. Holdings are always recomputed from **this run's** balances (correction 18).

### 3.6 Formula, bands, states (lib/cluster/meter.ts; constants in `walletClusters`)

**Resolved wallet.** The funder is found with proof, or proven excluded. On Robinhood, every edge kind readable on that chain has been read for the wallet. **Age-screen alone is not resolved** (B5).

**Formula:**
- `holdShare` = Σ pct of resolved holder wallets in strong clusters of size ≥ 2 ÷ Σ pct of resolved holder wallets.
- `buyShare` = resolved first buyers in strong clusters **still holding ≥ `buyerClusterMinHoldPct` (1%)** ÷ resolved first buyers. Fully exited bundles are the existing positive `bundlersFlushed` (snapshot.ts:353-354), not counted twice.
- Blend by mode. Age only selects the set and never penalises.
  - launch: `meter = round(100 × (0.6·buyShare + 0.4·holdShare))`;
  - established: `meter = round(100 × (0.2·buyShare + 0.8·holdShare))`.
- If one part is n/a with a reason (e.g. "first buyers not reconstructable: launch predates the log window"), the meter uses the other part alone, and the evidence says so.
- **Floor:** the largest strong cluster holds ≥ 50% of resolved sampled holder supply → `meter = max(meter, 80)`.

**Coverage bar** (needed for `walletClusterMeter` to be non-null):
- `clusterResolvedWallets` ≥ 12;
- **and** `clusterHolderSupplyResolvedPct` ≥ 70;
- **and** (resolved first buyers ≥ 10, **or** the buyer part n/a with a reason).

Supply percentages always use **total** supply as the denominator, never the resolved subset.

**Bands.** Labels claim only what an edge proves (correction 3).

| Meter | Label | Colour token |
|---|---|---|
| 0–19 | Independent wallets | `--ok` |
| 20–39 | Some linked wallets | `--info` |
| 40–59 | Coordinated group | `--warn` |
| 60–79 | Heavily linked | `--danger` |
| 80–100 | Linked wallets dominate buying and holding | `--rug` |

**States.**

| State | When | Factor result | Caps |
|---|---|---|---|
| **live** | Bar met; this run's holder list is live. Cached final origins are facts, not stale. | scored | read `clusterSupplyMinPct` |
| **partial** | Robinhood without archive or old-block funding. Computed from `token_handoff`, `paid_buy`, `common_sink`, `deployed_by`, `same_block_buy`, `create_slot_buy` (weak only) and the HoodScan first-swap time. Evidence: "partial: native funding not readable (no archive state)". | scored when the bar is met on the readable kinds; **S blocked by default** (owner decision #3); never U from this factor | yes |
| **pending** | Bar not met **and** background work in flight **and** `walletClusterAttempts < 3` **and** progress started under 30 min ago | **n/a** through `whenMissing {if walletClusterPending eq true, mode na}` (B1). Evidence: "funding origin read for 9 of 31 wallets; the rest load in the background". | only if `clusterSupplyMinPct` ≥ 10 is already proven |
| **end of pending** (B2) | Attempts ≥ 3 or more than 30 min | Wallets still unreadable become `excluded: "unreadable: <reason>"` and the bar is re-tested on the rest. If it passes → live. If not → **null** with the reason (e.g. "funding not readable for 14 of 31 wallets: Monad archive 'Block requested not found'"), counted as missing. | as above |
| **stale** | This run's holder list came from last-good | inherits "stale Xm" through `staleFields`; expires after 6h; last complete graph at `cluster-result:v1` | yes, with the stale label |
| **null** | A source failed or a key is missing ("Helius key not set", "archive RPC unreachable", "Helius rate-limited") | null, counted toward the ≥ 40%-missing U rule with the source named | rules "unknown" |
| **n/a** | By-design chain gap via `chains`, or zero activity (§3.3) | n/a | none |

**No unread gate is shown as passed (B3).** Caps read `clusterSupplyMinPct`, which is null until a link of at least 10% is proven or coverage is complete. A null makes the rules "unknown", and rules carry no weight in coverage. A gate is never shown as passed on a partial read.

### 3.7 Budget, background, cache

**Where the step runs (B10).** `walletClusterStep` starts **as soon as the holder list is known**:
- on Solana, inside the Helius adapter in place of the top-20 origin loop (helius.ts:296-306), which already makes about 40 calls (getSignaturesForAddress plus getTransaction per wallet) and is now about 20;
- on EVM, right after the holder adapter returns, in parallel with the remaining adapters.

Edges and the meter are finalised after the market and holder data join. The step does not wait for holderClassification or Holder Strength.

**Budget:**
- inline cap `CLUSTER_BUDGET_MS` (env, default 8000), never past the request deadline (created at arrival, R2);
- work order: one KV `mget` for cached origins → early-buyers cache → missing priority origins → edges → meter.

**`heliusQueue` priority lane.** It is limited to 2 in flight per instance with 100ms spacing (heliusQueue.ts:9-10) and 9/s across all instances (:14-16), and has no priority lane today. Add `priority: "high" | "normal"`: cluster and origin jobs dequeue before curve-replay batches. A batch counts as N slots (:20).

**Expected cold cost** (verified by R2 latency runs, not assumed):

| Chain | Inline cold work | Expected inline |
|---|---|---|
| Solana | ≈ 20 `getTransactionsForAddress` (priority wallets) + ≤ 5 hub checks + 1–2 early-buyer pages, high priority | 3–10s, depending on contention (20 ÷ 9/s ≈ 2.2s best case; 2-in-flight at ~0.5s RTT ≈ 5s; more under shared traffic). Started early, so it overlaps the other adapters. |
| Base / Monad / Ethereum (archive) | early-buyer getLogs (1–3) + ≤ 20 batched getTransactionByHash + age screen 3 × 20 (batched) + kSearch for **fresh top-10** only (≈ 48 each when narrowed) | top-10 resolved in ~6–8s; the rest in the background |
| Ethereum (Etherscan key) | 2 calls per wallet, rate-limited | top-20 inline |
| Robinhood | early-buyer getLogs (1–3) + ≤ 20 tx lookups + Transfer reads + HoodScan first swaps (cached 1d) | ~2–4s, partial |
| Warm (any chain) | KV `mget` only | < 1s |

**Background (with R2's safeguards):**
- progress at `clusters:v1:{chain}:{token}` = `{ sample, resolvedSet, cursor, edgesSoFar, attempts, startedAt }`, TTL 6h;
- when anything is unresolved and the end state is not reached: `walletClusterPending = true`, then enqueue `/api/work { kind: "cluster" }`;
- the per-token lock, 3 attempts per 6h and the global hourly cap apply;
- **before R2 ships:** `after(() => run(Date.now() + 35_000))`, bounded by the same attempt counter;
- the R4 client poll (15s, up to 2 min) or the next analysis picks up the finished graph.

**KV (correction 22).** Add `mget(keys)` to the KV interface (lib/kv.ts): Upstash MGET, Postgres `WHERE key = ANY($1)`, and loops for File and Memory.

| Key | TTL |
|---|---|
| `origin:v2:{chain}:{wallet}` | none if `final`; ≤ 3600s otherwise |
| `funder-kind:v1:{chain}:{addr}` | 7d |
| `hub:v1:{chain}:{addr}` | 7d |
| `early-buyers:v1:{chain}:{token}` | none once final; 10 min otherwise |
| `clusters:v1:{chain}:{token}` | 6h (progress and attempts) |
| `cluster-result:v1:{chain}:{token}` | 6h (last complete graph, for stale) |
| `work-lock:v1:{kind}:{chain}:{token}` | 5 min (SET NX) |
| `work-count:v1:{yyyymmddhh}` | 2h (global hourly cap) |

### 3.8 factors.json (engine.ts unchanged and generic)

**New top-level block `walletClusters`:**
```json
"walletClusters": {
  "sameTimeSec": 30, "strongWindowSec": 1800, "weakWindowSec": 7200,
  "createSlotFundedWithinSec": 3600, "peelWindowSec": 1800, "peelForwardPct": 80,
  "handoffMinPct": 0.05, "airdropMinRecipients": 50, "airdropMaxPct": 0.1, "dustPct": 0.05,
  "cexBatchSec": 120, "cexBatchAmountPct": 2, "hubNonce": 5000, "hubSigs": 1000,
  "batchWithdrawalMinRecipients": 20, "batchWithdrawalMaxSampleShare": 0.25,
  "blend": { "launch": { "buy": 0.6, "hold": 0.4 }, "established": { "buy": 0.2, "hold": 0.8 } },
  "buyerClusterMinHoldPct": 1, "floorClusterPct": 50, "floorMeter": 80,
  "minProvenPct": 10,
  "coverage": { "minResolved": 12, "minHolderSupplyPct": 70, "minBuyers": 10 },
  "pending": { "maxAttempts": 3, "maxAgeSec": 1800 },
  "inline": { "holders": 10, "buyers": 10 }, "sample": { "holders": 20, "buyers": 20 },
  "bands": [19, 39, 59, 79]
}
```

**New factor `wallet_clusters`** (in every set's holders group):
```json
{ "id": "wallet_clusters", "label": "Linked wallets (on-chain ties)", "metric": "walletClusterMeter",
  "direction": "lower_better", "format": "int",
  "data": ["helius", "rpc", "hoodscan"],
  "minSample": { "metric": "clusterResolvedWallets", "gte": 12, "label": "resolved wallets" },
  "whenMissing": [
    { "if": { "walletClusterPending": { "eq": true } }, "mode": "na",
      "evidence": "Bundle check reading: funding origin read for {clusterResolvedWallets} of {clusterSampleWallets} wallets; the rest load in the background." },
    { "if": { "clusterSampleWallets": { "eq": 0 } }, "mode": "na",
      "evidence": "No wallets to sample (no trading activity)." }
  ],
  "thresholds": [
    { "lte": 19, "points": 1 },
    { "lte": 39, "points": 0.7, "flag": "info" },
    { "lte": 59, "points": 0.35, "flag": "warn" },
    { "points": 0, "flag": "danger" }
  ],
  "evidenceTemplate": "Meter {value}/100: largest linked group holds {clusterSupplyText} of supply ({fundingClusterMax} wallets; {clusterEdgeSummary}); {sameTimeFundedMax} funded by one source within 30s, {sameTimeBuyMax} also bought within 30s; {clusterResolvedWallets} of {clusterSampleWallets} wallets resolved." }
```
A null meter that is not pending falls through to the engine's null path, with `nullReasons.walletClusterMeter`, and counts as missing.

**Weights.** Each set states where its weight comes from (correction 1). Group totals are unchanged.

| Set | Today (holders-related) | Change | `wallet_clusters` |
|---|---|---|---|
| `launch` (Solana) | funding_cluster 5, fresh_wallets 7 | remove funding_cluster; fresh_wallets 7 → 6 | 6 |
| `launch_robinhood` | bundle_share 6, top10_share 8 | bundle_share 6 → 3 ("recent same-block share"), top10_share 8 → 5 | 6 (partial) |
| `launch_base` | top_holder 16, top10_share 14 | 16 → 13, 14 → 11 (split; owner may prefer top_holder only) | 6 |
| `launch_ethereum` | top_holder 16, top10_share 14 | 16 → 13, 14 → 11 | 6 |
| `launch_monad` | top_holder 10, top10_share 8 | 10 → 7, 8 → 5 | 6 |
| `established` (Solana / Robinhood) | top10_share 8 | 8 → 3 | 5 |
| `established_base` | top10_share 11 | 11 → 6 | 5 |
| `established_ethereum` | top10_share 11 | 11 → 6 | 5 |
| `established_monad` | top10_share 10 | 10 → 5 | 5 |

**Rules.** All are caps only with 0 points. Weak edges never cap. No age condition anywhere.

| id | when | cap | evidence template |
|---|---|---|---|
| `cluster_10` | `clusterSupplyMinPct {gt:10}`, `founderClusterOnly {ne:true, orMissing:true}` | A | "A linked group of {fundingClusterMax} wallets holds {clusterSupplyText} of supply ({clusterEdgeSummary}): capped at A." |
| `cluster_20` | `clusterSupplyMinPct {gt:20}`, same founder condition | C | "A linked group holds {clusterSupplyText} of supply ({clusterEdgeSummary}), treated as one holder > 20%: capped at C." (mirrors `top_holder_20`, :7490) |
| `cluster_35` | `clusterSupplyMinPct {gte:35}`, same founder condition | D | "A linked group holds {clusterSupplyText}, treated as one holder ≥ 35%: capped at D." (mirrors `top_holder_35`, :7515) |
| `cluster_20_founder` (new, B4) | `founderClusterOnly {eq:true}`, `clusterSupplyMinPct {gt:20}` | A | "Founder and the wallets it funded hold {clusterSupplyText} and never sold: capped at A." (mirrors :7540) |
| `cluster_35_founder` (new, B4) | `founderClusterOnly {eq:true}`, `clusterSupplyMinPct {gte:35}` | A | as above (mirrors :7556) |
| `full_bundle` (existing, :7869) | `clusterSupplyMinPct {gte:50}` | D | "A linked group (on-chain ties) holds {clusterSupplyText} of supply: capped at D." Fed on every chain. |
| `cluster_overhang` | `walletClusterMeter {gte:60}`, `clusterSupplyMinPct {gte:10}` | B | "Buying was coordinated (meter {walletClusterMeter}) and the group still holds {clusterSupplyText}: capped at B." `cluster_10` already caps at A, so B is the effective addition. |
| `cluster_dumping` | `clusterNetSell24hPct {gte:20}` | C | "Linked wallets sold {clusterNetSell24hPct} of their holdings in 24h: capped at C." Fed in both modes (§3.4c). |
| `bundler_majority` (existing, :7797) | `bundlerMajority {eq:true}` | C | "{bundlerShare} of the first 20 buyers sit in linked groups that still hold supply: capped at C." Label: "first buyers". |

Changes from the draft:
- `cluster_overhang` reads `clusterSupplyMinPct ≥ 10`, not 5, because the proven-bound field is null below 10.
- The overhang therefore applies only together with a proven link of at least 10%.

**Requirement:**
```json
{ "id": "s_clusters", "tiers": ["S"], "when": { "walletClusterState": { "eq": "live" }, "walletClusterMeter": { "lt": 20 } },
  "label": "Bundle check complete and clean", "failText": "Never S with bundling unknown or linked wallets present." }
```
- Robinhood partial fails it by default (owner decision #3).
- A remains reachable while the check is pending, with the pending label shown.
- `s_accumulators` (:8341) reads `accumulatorCountIndependent` (R6).

**Removed:** the `funding_cluster` factor (:1830) and rule (:7760). Their tests are replaced with `wallet_clusters` and `cluster_*` assertions and listed in REPORT.md.

**Monotonicity:** caps clamp the displayed score with "raw N" beside it (existing clamp). A property test (§3.11) checks that adding a strong edge never raises the tier or the displayed score.

### 3.9 UI

**Quick read row (R4):**
- "**Linked wallets:** one group holds **X% of supply** (N wallets) · meter M/100 · *band label*" with a state badge: live / partial / stale Xm / reading N of M / the null reason.
- While pending: "Bundle check: reading (N of M wallets)". It is above the fold on launch tokens and never shows an inferred number.
- The sticky mobile bar shows the main risk, which can be this line.

**Meter (components/ClusterMeter.tsx):**
- reuses the Holder-strength meter shell (Report.tsx:293-305): a 0–100 bar with 5 band segments, a needle, a big number and the band label;
- the subline reads "27 of 31 wallets resolved · 19 holders, 12 first buyers · 4 funded > 7d before (links reading) · live";
- when a cap binds, it links to the cap line.

**Wallet map (components/ClusterBubbles.tsx).** It is not called "Bubblemaps" (correction 27). Plain inline SVG, no library, deterministic (no randomness, stable sort by supplyPct then address), at most 40 nodes.
- **Size:** `viewBox="0 0 640 400"`, `width:100%`, height auto. Under 480px a single-column layout with `viewBox="0 0 360 560"`. No horizontal scroll.
- **Layout:**
  - clusters packed into grid cells (at most 5 coloured clusters, the rest grey);
  - the funder is an 8px square at the cell centre;
  - members sit on a ring of radius 40–70px, or a phyllotaxis spiral above 8 members (angle i·137.5°, r = 9·√i);
  - independent wallets sit in a grey band at the bottom, sorted by pct;
  - freshness-only wallets get a dotted outline.
- **Circles:**
  - `r = min(40, max(4, 28·√(pct/10)))`, so 10% → 28px, clamped at 40px;
  - a buyer with no holding is hollow (r = 4);
  - the founder or team gets a thicker `--danger` stroke.
- **Colours:** `--cluster-1..5`, `--muted` and `--danger`, defined on `:root` with dark-mode overrides under `prefers-color-scheme` and `[data-theme="dark"]`.
- **Lines:**
  - strong edges solid at 1.5px;
  - weak edges dashed (`stroke-dasharray: 4 3`);
  - composite edges solid with a "2×" marker.
- **Labels:** the cluster letter and % on each cell.
- **Interaction:**
  - each node is a `<g tabindex="0" role="img">` with a `<title>`, e.g. "0xab12…cd34 · 4.1% · buyer #3 · cluster A · funded by 0x77…e1 within 12s (tx)";
  - hover or focus highlights its edges.
- **List view:** a `<details>` table with columns wallet, % held, buyer rank, cluster, class, funder, gap, clue and tx link (lib/holderLine.ts explorer links).
- **Legend:**
  - solid = proven link (funding, registered multi-send, hand-off, paid buy, sink, create-slot, deployed-by, hub spray);
  - dashed = weak (same block, 30 min–2h, hub funder, batch withdrawal, CEX batch);
  - "2×" = two different weak clues.
- **Empty, pending and null:**
  - empty: "No linked groups among N resolved wallets";
  - pending: a skeleton with "reading N of M";
  - null: the reason text.

**Evidence block:**
- one line per cluster, e.g. "Cluster A, 6 wallets, 18.4% of supply: first SOL from 7xKp…Q2 between 12:01:05 and 12:01:41 UTC (36s), txs …; 2 also got tokens from 0xcd34… by plain transfer";
- an exclusions line, e.g. "4 wallets funded by Binance hot wallet (source, date) / high-volume senders, not linked";
- source statuses with call counts: Helius / archive / Etherscan / HoodScan as ok / partial / failed / skipped, with reasons.

**Holders table:** a cluster column with the letter and the main clue.

### 3.10 Per-chain readable edges

| Edge | Solana | Base / Monad / Ethereum | Robinhood (public RPC) |
|---|---|---|---|
| same_time_funder / shared_funder / funder_2h / hub_* | yes (Helius) | yes (archive or Etherscan) | no (old block bodies: background, if R0 confirms) |
| direct_fund, multisend, peel | yes | yes (registered disperse only) | no |
| token_handoff | yes (background unless cached) | yes (Transfer logs) | yes (Transfer logs) |
| paid_buy | yes (fee payer, B7 rules) | yes (tx.from, B7 rules) | yes |
| common_sink | swept SOL (background) | v2/v3 inline; v4 background | v2/v3-style pools (layouts to be confirmed) |
| create_slot_buy | yes | only with a funding edge | weak only |
| deployed_by | n/a (programs) | yes (`creationSender`) | yes |
| same_block_buy, cex_batch, batch_withdrawal | yes | yes | same_block only |

### 3.11 Tests

**Unit, pure (lib/cluster):**
- union-find merges on strong edges only;
- one weak edge never merges; two weak edges of the same kind never merge; two of different kinds do (composite);
- excluded CEX, bridge, AA or bot-infra funders create no edge, and nothing chains through them;
- window boundaries at 30, 1800 and 7200s;
- airdrop exception: 60 recipients under 0.1% stay unlinked; a 0.3% recipient links;
- the peel inline condition;
- team cluster includes recipients; a lone founder is size 1;
- `meterOf` bands and blend per mode;
- buyShare drops exited clusters;
- floor of 80;
- coverage bar → null meter with the reason;
- the supply denominator is total supply (12 resolved wallets never read 100%);
- **B5:** age-screened wallets are not in holdShare and not in the coverage bar;
- **B8:** a high-nonce funder with consecutive nonces to 4 sample wallets → strong `hub_spray`; interleaved recipients → weak `hub_funder`;
- **correction 17:** a tx crediting 100 recipients with 3 in the sample → weak `batch_withdrawal`;
- **correction 18:** a member that left the holder list counts 0 in `clusterSupplyMinPct`;
- **correction 19:** a holder contract created by a member joins the cluster.

**Origin parsers:**
- Solana: a balance-delta fixture with an inner-instruction disperse (funder found; registered program → multisend);
- Solana: a token-first wallet → `unknown`, not final, **no fee-payer fallback**;
- Solana: the signatures fallback with a full page → `unknown` "active wallet";
- EVM fake RPC: the two-stage search finds the block;
- EVM: funded → drained (nonce 1) → refunded is rejected by `nonce(found−1)==0` (correction 11);
- EVM: a 7702 wallet → "not proven";
- **B6:** Across or Relay fill calldata → funder = the contract, excluded; a Disperse.app tx → funder = tx.from;
- Robinhood → `unreadable` with the exact reason.
- **B9 cache:**
  - a read error is stored with TTL ≤ 3600;
  - a v1 `funder: null` entry is ignored;
  - a non-final (under 64 blocks) result is not stored with no TTL.

**Scoring (fixtures re-scored):**
- fartcoin plus a strong 8-wallet cluster at 49.9% → D (`cluster_35` / `full_bundle`), previously B 68.6;
- microduck with a randomised ring at 22% → C;
- a cluster at 12% → A, no S;
- meter 65 with a cluster at 12% → A (`cluster_10` binds before `cluster_overhang` B);
- meter 65 with only an 8% proven cluster → the meter factor is scored low, `clusterSupplyMinPct` null, no supply cap. Expected and documented.
- `clusterNetSell24hPct` 25 on a **launch** token → C (B12);
- **B4:** `founderClusterOnly` missing → `cluster_20` still fires;
- **B4:** a never-sold founder group of 10% + 15% → `cluster_20_founder` → A;
- **B1:** pending + `whenMissing na` → factor n/a, `missing: false`, coverage unchanged, `s_clusters` blocks S, A still reachable;
- **B1:** meter null without pending → null, counted missing;
- **B2:** pending past 3 attempts or 30 min → null with the unreadable-wallet reasons;
- **B3:** below threshold and incomplete → `clusterSupplyMinPct` null → cluster gates show "unknown", never passed;
- Helius key missing → null "Helius key not set";
- `bundler_majority` fires only for clusters still holding ≥ 1%;
- **B7:** an EntryPoint `handleOps` bundler signer and a shared Solana gasless fee payer → no `paid_buy` edge;
- **correction 16:** an exchange-like holder pair with `direct_fund` between them is left out of the cluster sample and still counted in `top1SharePct`;
- zero activity → n/a "no wallets to sample";
- **property:** adding a strong edge never raises the tier or the displayed score.
- The replaced `funding_cluster` tests are listed in REPORT.md.

**Budget and route:**
- **B10:** with a slow fake RPC and Helius, inline cluster work never passes `CLUSTER_BUDGET_MS` or the request deadline;
- **B10:** the priority lane runs origin jobs before queued curve-replay batches;
- **B13:** one lock per token; the 3-attempt and hourly caps are enforced; an unsigned request is rejected.

**Recorded fixtures (sanity notes, not assertions):**
- one bundled pump.fun launch;
- one organic Solana token;
- one Base sybil token;
- one Robinhood partial-mode token.

Cross-check by hand against RugCheck insiders and, if a key exists, Bubblemaps.

**Playwright (375px and desktop, light and dark):**
- the Quick read linked-wallets row is above the fold;
- meter, SVG and list view render;
- pending shows "reading N of M" and the poll updates it;
- null shows the reason;
- no horizontal scroll;
- every SVG node is focusable with a title;
- **two renders of the same input give identical SVG** (no randomness).

**Latency (scripts/latency.mjs):**
- cluster phase p50/p95, warm and cold, per chain;
- archive and Helius call counts;
- share of cold runs ending pending.

Gates: cluster inline ≤ 8s and total p95 ≤ 30s.

---

## 4. Not doing, and why

- **Embed, scrape or score Bubblemaps.** It is paid, the iframe needs a partnerId, no data-use terms were found, and a third-party index breaks the per-factor evidence rule. At most it becomes an unscored cross-check (R9).
- **Softer cluster caps (≥ 20% → B, ≥ 35% → C).** A proven ring is treated as one holder (C / D).
- **Funding amounts within ±5% as a strong edge.** Amount similarity appears only inside weak `cex_batch` (±2%, ≤ 120s).
- **Same block or slot alone as proof.** Sniper and copy-trade bots co-locate; it stays weak.
- **Attribute multisend to `tx.from` for any contract.** Only registered disperse contracts; relayers, bridges and 4337 bundlers are excluded (B6).
- **Exclude every high-volume funder outright.** Professional bundlers would escape; a consecutive spray stays strong (B8).
- **The general second hop inline.** Only peel chains are inline; the rest runs in the background.
- **A resolved-only denominator for supply share.** It inflates thin samples.
- **Treat age-screened wallets as checked.** Freshness only, until the funder is read (B5).
- **Default a pending, unreadable or zero-activity meter to a number, or show a cluster gate as passed without proof.** Pending is n/a with an end state, failures are null, and only a proven ≥ 10% lower bound caps (B1–B3).
- **Cache failures permanently.** Final results only, after finality (B9).
- **Subtract cluster members from `uniqueBuyers`.** That would penalise one signal twice (correction 5).
- **Delete `vol_mc_bundle` or `bundler_majority`.** Cap-only and fed respectively. `fees_low` is removed and logged.
- **Any age gate in the meter.** Age selects the set and blend weights only. R10 cleans up existing age penalties.
- **Treat RugCheck `insiderSupplyPct` as held concentration.** It stays informational.
- **Change the thin-trading floor or VOL/MC curve without the owner.**
- **Stale-while-revalidate beyond 60s on launch tokens.**
- **Require a paid explorer key or private archive.** Public archive endpoints are wired (rpc.ts:85-113); private ones are optional.
- **A `*/5` cron on a plan that does not allow it.** Self-chained signed `after()` on Hobby (R0 decides).

---

## 5. Blocking issues: how each is resolved

| # | Issue | Resolution | Where |
|---|---|---|---|
| B1 | Pending counted as missing | `whenMissing {if walletClusterPending eq true, mode na}` | §3.8 factor, §3.6 |
| B2 | Pending forever | End state: 3 attempts or 30 min → exclude unreadable, re-test, else null | §3.6, `walletClusters.pending` |
| B3 | Unread gates shown as passed | `clusterSupplyMinPct` published only at ≥ 10 or full coverage; `clusterSupplyText` pre-rendered | §3.2, §3.8 |
| B4 | Caps disabled when there is no founder; founder-group gap | `orMissing: true`; new `cluster_20_founder` / `cluster_35_founder` → A | §3.8 |
| B5 | Age screen counted as resolved | `freshness-only` status; excluded from the bar and holdShare | §3.4b, §3.6 |
| B6 | Bridge, relayer and 4337 multisend false edges | Registered disperse contracts only; other contracts excluded | §3.4b, data/disperse-contracts.json |
| B7 | paid_buy false positives | Signer in the sample, or a non-hub code-less EOA; AA, filler and relayer excluded | §3.5 |
| B8 | Hub test drops real bundlers | Labelled → excluded; unlabelled → strong only via consecutive spray, else weak | §3.5 |
| B9 | Failures cached permanently | Final-only, post-finality no-TTL; others ≤ 1h; v1 nulls ignored | §3.4 |
| B10 | 10–30s not achievable | Start at holder list arrival; top-10 + first-10 inline; priority lane; no classification dependency | §3.3, §3.7 |
| B11 | Helius method unconfirmed | R0 probe; signatures fallback with "active wallet" unknown | R0, §3.4a |
| B12 | Holder Strength is established-only | Direct Transfer-log and curve-replay reads in both modes | §3.4c, R3 |
| B13 | Credit burn; cron plan | Lock, 3 attempts per 6h, hourly cap, `takeLiveSlot`; Hobby self-chain | R2, §3.7 |

Corrections 1–27 are applied in place (weights table, OPS, labels, bundler filter, uniqueBuyers, slow_rug chains, dump_24h template, Robinhood S default, zero activity, age rules → R10, archive proof, kSearch cost, optional archive keys, Etherscan coverage, codeKind, exchange-like holders, batch withdrawals, this-run balances, deployed_by, v4 buyers, sameTimeBuyMax, KV mget and quota, shared lookups, time machine null, Solana integrity bug, label provenance, Wallet map radius and naming).

**Explicitly deferred:**
- extending `slow_rug_7d` beyond Robinhood (needs GeckoTerminal candle verification);
- Robinhood funding through old block bodies (needs the R0 probe).

---

## 6. Open questions for the owner (log the answers in REPORT.md)

1. **"Same time" window:** 30s (proposed) or 10s? (`walletClusters.sameTimeSec`)
2. **Founder "never sold" through funded wallets (R3):** it changes the 2026-11-23 founder rule. Approve?
3. **Robinhood partial meter:** scored (proposed), but **S blocked** until funding is readable (proposed conservative default)? Effect: no Robinhood token reaches S under public RPC unless a private archive (ROBINHOOD_RPC_URL) is set or the R0 old-block probe succeeds.
4. **LP-lock check:** remove its age condition (R8)?
5. **Relative thin-trading floor (R6):** CHOG would move. Proceed?
6. **Bubblemaps:** obtain a key and partnerId and confirm the data-use terms (R9)?
7. **Base and Ethereum launch weights:** split 3/3 from top_holder and top10_share (proposed), or all 6 from top_holder?
8. **Plan facts (R0):**
   - the Vercel plan (cron frequency, maxDuration 300 for `/api/work`);
   - whether `getTransactionsForAddress` is available on the Helius plan;
   - the Upstash command quota.

**Env vars for the owner** (document all in .env.example):
- **Required for full coverage:** HELIUS_API_KEY; CRON_SECRET (work route HMAC; confirm it is set).
- **Optional:**
  - BASE_RPC_URL, MONAD_RPC_URL, ETHEREUM_RPC_URL (private archive with higher limits; public archive endpoints are already wired);
  - ROBINHOOD_RPC_URL (an archive enables funding edges);
  - ETHERSCAN_API_KEY (free for Ethereum; Base needs a paid plan);
  - CLUSTER_BUDGET_MS (default 8000);
  - WORK_JOBS_PER_HOUR (default 120);
  - KV_REST_API_URL / KV_REST_API_TOKEN (Upstash);
  - BUBBLEMAPS_API_KEY / BUBBLEMAPS_PARTNER_ID (deferred).

**Open verification items:**
- the Helius method and credit cost;
- Etherscan v2 Monad coverage;
- HoodScan first-funding fields;
- Robinhood DEX Swap layouts (for sinks) and old-block bodies;
- GeckoTerminal daily buy/sell volume (for `slow_rug_7d`);
- Monad archive depth;
- Vercel plan limits;
- the Upstash quota;
- the disperse-contract registry per chain;
- ERC-4337 EntryPoint addresses per chain, each checked on chain;
- each CEX and bot-infra address checked on chain, with source and date;
- Bubblemaps terms and pricing.
