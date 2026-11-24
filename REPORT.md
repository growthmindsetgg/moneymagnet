# Fixes after the cluster deploys: background episodes, WIF dead launch, group wording, source line (2026-11-24)

- **Background reads stopped for good after 30 minutes (a regression in stage B).**
  - **Cause:** the progress record's `startedAt` never reset, so once 30 minutes had passed no new background read was scheduled until its 6h TTL ran out. Brett went from live 9/9 to null 7/9 after the `origin:v3` bump.
  - **Fix:** `episodeStep()` (lib/cluster/collect.ts, pure and tested) starts a new episode once the last one has expired and some wallets were never read. The progress key is versioned with the origin key (`clusters:v3`).
  - **The spec's B2 end state is now applied:** when an episode is spent, wallets unreadable through an outage or budget leave the sample (listed on the page) and the bar is re-tested.
  - **Token-first wallets are deliberately NOT dropped:** tokens handed to fresh wallets with no coin is a bundle pattern, so they keep blocking the number with their reason.
- **WIF was forced to F ("dead launch") with $3.75M liquidity and 9,230 buyers in 24h.** This predates the cluster work.
  - **Source:** the Helius adapter derives a pump.fun bonding-curve address for every mint and replayed whatever touched it (84 unrelated txs on WIF ⇒ "0 buyers"). It now replays only when that account is owned by the pump.fun program, and otherwise says "not a pump.fun launch". A failed account read (null) keeps the replay, because an error is not proof.
  - **Guard:** `deadLaunchOf`'s buyers leg can no longer fire when live unique-wallet `buyers24h` > 2 contradicts it. Tx counts don't count as wallets.
  - **Unchanged:** a real never-traded pump launch (genuine curve account) and PEEK stay dead.
  - **Fixture snapshots:** no tier moved.
- **The group wording claimed the whole group was funded "within 27s" when only 2 of 4 were.** The evidence now describes the group: "all 4 first funded by X within 12 min (2 of them within 30s)".
- **Visual check (live, 375px dark and 1024px light):** no horizontal scroll, dark tokens apply. On phones the SVG scales to about 0.5×, so its group labels were around 6px.
  - Added an HTML legend above the map (colour chip · Group A · N wallets · %), readable at any width.
  - Under 480px the in-map group label grows and the band caption is hidden (the figure caption repeats it).
  - The map height now follows its content.
  - **Not deployed yet:** this legend change passed typecheck, lint, unit tests (786/787; the one failure is the live microduck comparison that has flaked all day), build, verify:api and stability. Playwright could not run: the machine was at 100% CPU with 1.6 GB RAM free (another project's dev servers), its server did not start within 60s, and an earlier attempt had 11 timeouts. Deploy after a clean Playwright run. Production stays on 7ba9a02, which passed the full LOOP.
- **Source line:** "Wallet funding (cluster check)" now appears in Sources.
  - **States:** ok when live; partial when pending or null, with the reason; skipped for n/a and Robinhood partial.
  - **Never "failed",** so it cannot feed the adapter outage / U logic (no factor lists it in `data`).
- **Tests:**
  - `tests/dead-launch-guard.test.ts` (5);
  - the episode tests (4), the custody picker, group wording, and a no-curve-account Helius test;
  - `audit-solana`'s Helius mock now returns a pump.fun-owned curve account for the replay tests (they simulate a pump token);
  - section7's first gate case states "≤ 2 buyers and none live", since its inputs had contradicted each other.

# Wallet-cluster meter, stage C: the Linked wallets section and the wallet map (2026-11-24)

## What it shows
- **`components/ClusterMeter.tsx` (Linked wallets, default view, under Largest holder):**
  - the 0–100 bar with band edges, the number and the band label;
  - the largest linked group and same-time funding as sentences;
  - any binding cluster cap in red;
  - coverage ("N of M wallets resolved · top holders, first buyers · % of their supply resolved") and the points the factor gave;
  - a wallet table, the infrastructure exclusions, and a method line.
- **States:** pending, null, n/a and partial show their reason; a number never appears without the coverage bar. The section is absent on reports made before the meter existed.
- **`components/ClusterBubbles.tsx` (wallet map):** deterministic inline SVG (viewBox 640×400, width 100%, no library, no randomness).
  - Up to 5 linked groups as coloured cells, the shared funder as a square in the middle, members on a ring (a spiral above 8) sized by the share of supply held now.
  - Every other sampled wallet sits in a grey band: dotted when not read, dashed when funded by infrastructure.
  - Founder and team wallets get a thick red ring; weak clues are dashed lines; composite pairs are marked "2×".
  - Every wallet is a focusable `<g role="img">` with a title (address, % held, buyer rank, group, funder).
  - Colours are `--cluster-1..5`, defined for light mode and both dark-mode selectors.
- **The research view's holder table and cluster read-out** now use the same groups as the meter ("group A ×6"). Before, they used the old Helius top-20 grouping, which could disagree on the same page.

## Fixes found on the first production run (stage B deploy)
- **Solana wallets that got tokens before SOL** showed no SOL receipt in their first 5 transactions (9 of 19 fartcoin holders). The window is now 25 transactions in the same single call.
- **Origin cache key bumped to `origin:v3`,** so the new window applies at once. `originKey()` is now shared by origin.ts and collect.ts: collect.ts had rebuilt the key by hand, and a version bump would have silently broken its in-request lookups.
- **Monad:** the public archive answers "Block requested not found" (shallow history), so funding is not readable there. After 3 background attempts this ends as null, or n/a when the source lists fewer than 8 wallets. A deeper archive (`MONAD_RPC_URL`) would fix it.
- **Base:** live, meter 0, 9 of 9 top holders resolved, no linked group (brett). That was before the origin:v3 bump; the episode bug above then left it null 7/9 until fixed.
- **WIF read meter 32 with "2 wallets holding 16.4% (1 direct funding)", capped at A.** Those are exchange custody wallets: one exchange wallet funding another is not one person.
  - Added the spec's exchange-like holder test (correction 16), which first-cut stage B had skipped. A group member over the hub bar (≥ 1000 signatures in one page on Solana; nonce > 5000 on EVM) that is not founder / team and not deployer-funded leaves the cluster sample and stays counted in concentration. The graph is re-linked without it, and the section names it.
  - Cost: only group members are tested (usually a handful), cached 7 days at `hub:v1`. The funder hub test now uses the same helper.

## Tests
`tests/cluster-ui.test.ts` (7):
- two renders of the map are byte-identical;
- every wallet is placed once, inside the canvas, with no NaN;
- every wallet is focusable with a title;
- the live section (meter 43 "Coordinated group", lines, the binding C cap);
- pending and null show reasons with no number;
- the section is absent on old reports;
- the full report renders it.

# Wallet-cluster meter, stages A + B: origins, graph, meter, scoring (2026-11-24)

Owner request: rate how much of a meme's buying and holding is one person, using unique vs same-time-funded wallets, as a 0–100 meter used in scoring (bubble-map style).
- **Spec:** docs/research/2026-11-23-team-review-plan.md §3, from the 8-agent team review.
- **Owner defaults (2026-11-24):**
  - same-time window 30s;
  - Robinhood partial with S blocked;
  - the founder-rule change through funded wallets (R3) deferred.

## Built
- **`lib/onchain/origin.ts`.** A wallet's first native-coin funding.
  - **Solana:** `getTransactionsForAddress` (asc, 5). The plan already uses it in production, at helius.ts:217 and :332. The funder is the non-program account with the largest lamport drop. There is no fee-payer fallback, and it falls back to the signatures path if the method is ever unavailable.
  - **Base / Monad / Ethereum:** archive two-stage search with proof (balance 0 and nonce 0 just before the funding block).
    - When the wallet has sent transactions, the balance is searched only below its first outgoing tx, where an EOA's balance can only rise.
    - A multi-send counts only when the contract is registered or matches the verified Disperse selectors (keccak checked); any other carrier contract (bridge, relayer, 4337) is itself the funder and is excluded.
  - **Robinhood:** unreadable, with the reason.
  - **Caching:** final results are kept forever; anything not final keeps its reason for at most 1h.
- **`lib/kv.ts` `mget`.** Upstash MGET, Postgres `key = ANY(...)`, and loops for File and Memory. A warm run reads every origin in one round trip.
- **`lib/cluster/graph.ts`.** Pure.
  - **Strong edges merge** (union-find): same funder ≤ 30s or same block/slot, shared funder ≤ 30 min, direct funding, and a high-volume sender spraying back to back.
  - **Weak edges never merge alone:** funder 30 min–2h, high-volume sender not consecutive, batch payout (> 20 recipients, sample < 25%), same-block buys.
  - **Two weak clues of different kinds merge** as a composite.
  - **Excluded funders** (exchange, bridge, router, launchpad, program, contract, relayer, 4337, bot infra) create no edge.
  - **Founder group:** a cluster made only of founder or team wallets.
- **`lib/cluster/meter.ts`.**
  - **Formula:** launch 0.6·buyShare + 0.4·holdShare; established 0.2/0.8; with a floor of 80 when one group holds ≥ 50% of the resolved holder supply.
  - **Supply:** always measured against TOTAL supply.
  - **Coverage bar:** ≥ 12 resolved and ≥ 70% of the sampled holder supply, plus ≥ 10 first buyers when buyers are sampled.
  - **States:** live / pending (background, ≤ 3 attempts in 30 min) / null with named reasons / n/a / partial.
  - **Caps read `clusterSupplyMinPct`,** which stays null below 10% until coverage is complete, so no unread gate ever shows as passed.
- **`lib/cluster/collect.ts`.**
  - **Timing:** starts as soon as the holder list is merged, in parallel with classification and Holder Strength; the priority wallets (top-10 holders and first-10 buyers) are resolved within `CLUSTER_BUDGET_MS` (8s); the rest is read in the background via `after()`.
  - **Sample:** the top-20 counted holders, minus dust, programs, infrastructure, exchanges and non-counted classes.
  - **First buyers:** Solana's first curve buyers, from the existing replay with slot and time.
- **factors.json:**
  - the `walletClusters` constants;
  - the `wallet_clusters` factor (a guide factor, p.25 / p.21-22) in launch, established_solana, launch/established for base, monad and ethereum;
  - group totals unchanged: launch funding_cluster 5 → removed, fresh_wallets 7 → 6, meter 6; base/eth launch top_holder 16 → 13, top10_share 14 → 11, meter 6; monad launch 10 → 7, 8 → 5, meter 6; established top10_share → −5, meter 5;
  - caps `cluster_10` → A, `cluster_20` → C, `cluster_35` → D, `cluster_20/35_founder` → A, `cluster_overhang` → B;
  - `full_bundle` now reads the proven bound;
  - the S requirement `s_clusters`: a complete, clean check.
- **Robinhood stays on the shared `established` set, unchanged.** Solana established tokens get `established_solana`, the same set plus the meter.

## Deviations from the spec, and why
- **Small samples.** Base / Monad / Ethereum holder sources list only about 10 wallets and EVM first buyers are not built, so the 12-wallet bar was unreachable.
  - Added `coverage.minSampleAll` (8): a smaller sample passes only when every wallet is resolved.
  - Below 8 wallets the factor is **n/a**, "only N holder wallets to sample", not missing, so a source limit cannot cut coverage.
- **Robinhood partial is shown but not scored.** The partial-mode edges (hand-off, paid buy, common sink, deployed-by) are not built yet, so a partial number would be guesswork. S is blocked by `s_clusters`.
- **A dead launch ⇒ n/a** ("no wallets to sample").
- **Not built yet** (later stages; the factor reads holders only where buyers are missing, and says so):
  - EVM first-buyer reconstruction, so the buyer share is n/a on EVM;
  - token hand-off, paid-buy, common-sink, peel and deployed-by edges;
  - cluster 24h selling (`cluster_dumping`) and the `bundler_majority` feed;
  - the `/api/work` route (R2);
  - registries beyond the existing infrastructure and exchange files (bot-infra, 4337 EntryPoints).

## Live probes (local, public archive RPC)
- **Base brett:**
  - first run: 13s for the whole analysis, pending, 3 of 9 resolved inline;
  - the cache filled over three runs; in production the background run does this in one;
  - then **live, meter 0, 9 of 9 resolved, no linked group**.
- **Monad $JAMES:** the source lists 4 holder wallets ⇒ n/a with that reason.
- **Solana:** needs `HELIUS_API_KEY`, which is not available locally; checked on production after deploy.

## Tests
- **New:** `tests/wallet-clusters.test.ts` (33): the graph (windows, exclusions, hub spray vs hub funder, batch payout, composite, direct funding, founder group, determinism), the meter (blend per mode, floor, coverage bar, small sample, lower bound, total-supply denominator, n/a, partial, bands), the Solana parser (fee excluded, no fee-payer fallback, failed tx), scoring (caps, founder cap, missing founder flag, pending n/a, null missing, monotone, sets, dead launch, small source).
- **Replaced** (the spec changed):
  - guide-rules #7: `funding_cluster` → `cluster_20` and the meter factor;
  - guide-rules #12: `full_bundle` now on `clusterSupplyMinPct`;
  - v21 drops `funding_cluster` from its launch-only rule list.
- **Harness updates (no assertion removed):**
  - the "perfect" and "clean" test tokens carry a clean, complete cluster check;
  - the weak v24 token carries the bad cluster signal it used to carry as `fundingClusterMax`;
  - the Robinhood A/S flap fixtures in stability and audit-scoring get a clean cluster check stubbed in, because Robinhood S is now blocked and those tests are about the hold;
  - the config pick-up test adds its factor to the set the token resolves to.
- **Fixture snapshots regenerated: no tier changed.** Scores moved ≤ 1.1 within their band. Coverage fell 5–6 points on chains with the meter, because the recordings predate it (missing until re-recorded). Robinhood fixtures are unchanged.

## Env vars
- `CLUSTER_BUDGET_MS`: optional, default 8000.
- No new keys. Solana uses the existing `HELIUS_API_KEY`.

# GeckoTerminal rate limits: one shared client, budget, cool-down, candle reuse (2026-11-23)

**Problem.** Production GeckoTerminal calls were often rate-limited (HTTP 429).
- **Baseline before this change, measured on production:** 12 fresh analyses in two parallel bursts. **4 of 12 were rate-limited, all in the second burst**; they fell back to stale data on 8–26 fields.
- **Causes:**
  - one analysis fires the pool list plus up to 5 candle series in parallel;
  - each 429 was retried twice inside the request, which multiplied the burst;
  - the peer cohort, social links and time machine drew on the same per-minute quota with no coordination.

## Decisions
- **New `lib/sources/gtClient.ts`** is the only GeckoTerminal caller. The adapter, cohort, social links and Robinhood time machine all go through it.
  - **A 429 is never retried in-request.** It sets a shared cool-down in KV: Retry-After, else until the next minute window opens (the quota is per minute; min 5s, max 5 min). Background callers then skip at once. A scoring (core) call waits out a cool-down that ends within 8s.
  - **Skips surface as HTTP 429 errors**, so the existing outage path (last good ≤ 6h, labelled "stale Xm") applies unchanged and nothing is invented.
  - **A shared per-minute call budget** (KV counter): defaults are no key 30, Demo 90, Pro 280 per minute, or `GECKO_RPM`. When the budget is used and the next minute window opens within 8s, a core call waits for it (a burst is smoothed, not failed); otherwise it skips.
    - **First deploy used 20/min with a flat 60s cool-down. That was too strict.** Production had served a ~24-call burst without a 429, and the stress test got worse: 10 of 12 analyses rate-limited, 5 of them by our own budget. Hence 30/min, a cool-down only to the next minute, and core waits.
    - "Core" calls for the token being scored may use the whole budget. "Background" calls (cohort, social links, time machine) get at most half, so they never starve scoring.
    - If the KV is down the client fails open, and the provider's own 429 still triggers the cool-down.
  - **Timeouts and 5xx get one retry**, counted against the budget. Nothing else is retried.
  - **A keyed plan that runs out of monthly credits** (CoinGecko 402/403 with a credits message) counts as a rate limit, with a 1h pause.
- **Candle reuse** (`CANDLE_CACHE_S` in `lib/sources/geckoterminal.ts`): the 5m series 120s, the hourly 600s, the daily 1800s.
  - The 1m launch candles and launch-mode 5m series (sized by age) are never reused.
  - The pool list is reused only within 45s.
  - **Labelling:** reuse under a minute counts as this run's reading (GeckoTerminal's own refresh step). Older reuse is labelled "stale Xm" **on exactly the fields that series fed**:
    - 5m → staircase / up-only, plus trend in launch mode;
    - 1h → trend;
    - 1d → 7d change / launch price.
  - Only fields that hold a value are labelled; a null keeps its reason.
  - Known gap: the daily candles passed to Holder Strength (`raw.dayCandles`) can be up to 30 min old. Holder Strength reads drawdowns and dips over days, so this is not labelled separately.
- **Optional CoinGecko key:**
  - `GECKO_API_KEY` + `GECKO_API_PLAN` (demo | pro) switch to `api.coingecko.com/api/v3/onchain` (header `x-cg-demo-api-key`) or `pro-api.coingecko.com/api/v3/onchain` (`x-cg-pro-api-key`). The paths are the same.
  - With a key the footer shows "Data provided by CoinGecko" with a link, as CoinGecko's terms require.
  - Demo is 100 calls/min but only 10k calls/month, so it is a stopgap, not a fix for heavy traffic.
- **DexPaprika not integrated.** Its API terms (§3.6) allow commercial use only on paid plans (Dev $30/mo and up) and require "Powered by DexPaprika" (§3.10). That is an owner decision, so it was left out.

## Tests
- **New:**
  - `tests/gt-client.test.ts` (10): plan roots and headers; cache with age; no retry on 429 plus a shared cool-down; Retry-After parsing; budget priorities; the single 5xx retry; credits exhaustion.
  - `tests/gt-candle-reuse.test.ts` (2): reused series are labelled stale on exactly their fields, and refetched past their window.
- **Test harness fixes. No assertion was changed or removed:**
  - `stability.test.ts`: the "10 minutes later" run now sets the clock to that time, because the adapter reads the clock for the cache.
  - `audit-indexers.test.ts`: `withFetch` also stubs `fetch`, because GeckoTerminal now goes through the client rather than `fetchJson`; without this the test reached the real network. M5 also gets a fresh store per test.
  - `v21.test.ts`: a fresh store per test.

## Sources / null factors / env vars
- **Env vars (optional):** `GECKO_API_KEY` (secret), `GECKO_API_PLAN`, `GECKO_RPM`, documented in `.env.example`.
- When GeckoTerminal is skipped (budget or cool-down), the source line says why. For example: "rate limited — GeckoTerminal answered 429 recently; cooling down 30s before calling again".

# A proven never-sold founder's stake is left out of the concentration factors (2026-11-23)

**Owner decision.** When the largest counted holder is the founder (the deployer, or a wallet founder-link due diligence ties to it) and that wallet is proven never to have sold, the founder cap (A) already covers the stake. It is no longer also counted in the top-holder and top-10 share factors.

## How it works
- **Engine (generic):** a factor may declare `override: { when, metric, evidenceTemplate }`.
  - When the boolean snapshot field `when` is true, the factor reads the substitute metric with its own evidence line.
  - The original metric's cross-source verification is not attached, because the sources' 61% reading doesn't verify the derived value.
  - Nothing in it is founder-specific.
- **Snapshot:** `applyFounderExclusion` (lib/snapshot.ts) sets three fields:
  - `founderExcluded`;
  - `top1ExFounderPct` (the largest holder other than the founder);
  - `top10ExFounderPct` (the top 10 other than the founder).

  It runs in `deriveMetrics` and again after top-holder classification (`lib/analyze.ts`), once the founder fields are known. The stale age is inherited from `top1SharePct` / `top10SharePct`.
- **factors.json:** all 17 `top_holder` / `top10_share` factors across the sets carry the override. Their evidence says the founder's share and hold days were left out and that the value is derived.
- **The rules keep reading `top1SharePct`**, so the founder cap A still binds while the founder holds, and the tier is never S.
  - Burn or lock ⇒ the founder is no longer a counted holder ⇒ no cap.
  - Any sell ⇒ `founderNeverSold` false ⇒ no exclusion, and the normal caps apply.
- **Never excluded:** team wallets (one clue), founders that sold, and founders whose sell history is unproven.
- **The S/A requirement `basic_top10` ("Top-10 holders < 60%")** also passes when `founderExcluded` and `top10ExFounderPct` < 60.
  - Its founder branch uses `missing: false`, so it can only add a pass.
  - It never turns a measured fail into "not held against the token". The existing test "top-10 ≥ 60% fails the requirement" still passes unchanged.
- **Live, before the requirement change:** $JAMES top-holder factor 9/9 (2.0% other than the founder), top-10 factor 10/10 (10.1%), but B 69.9: "A requirement not met: Top-10 holders < 60%".

## Tests
New in `holder-class.test.ts`:
- the JAMES-shaped founder snapshot scores the factors on the other holders, with evidence that says so, no borrowed verification, and the founder cap still firing;
- no exclusion for a team wallet, a founder that sold, or an unproven founder.

No existing test was changed.

## Sources / null factors / env vars
No change.

# Founder-link due diligence + founder cap A at any size (2026-11-23)

Owner request, after $JAMES (Monad) showed C. Its 61.1% holder is the founder's second wallet, but it was classed as a "team wallet (deployer-funded)", and ≥ 35% team never-sold caps at C.

## Decisions
- **Founder cap** (owner decision): a founder that never sold now caps at **A at any size**. `top_holder_35_founder` moved from B to A; `top_holder_20_founder` was already A.
  - **Never S** while the founder still holds the stake.
  - **Burning the stake or locking it in a vesting / lock contract lifts the cap.** A burn address or lock contract is not a counted holder, so S becomes reachable.
  - **Any sell (a swap, or a transfer into a pool / router) reverts to the normal caps (C / D)** and adds the red "founder started selling" con. A founder dumping never earns a higher tier.
- **Founder-link due diligence:** new `lib/onchain/founderLink.ts`, used in `lib/topHolders.ts`. For a large non-deployer EOA it reads five on-chain clues; each is live, false, or null with the exact reason, never assumed:
  - **tokens_from_deployer** (direct): its first tokens came from the deployer by plain transfer (no Swap event in that tx).
  - **gas_from_deployer** (direct): the first native coin it ever received came from the deployer.
  - **stake_from_deployer:** that deployer transfer is ≥ 80% of its current balance, so the stake was handed over, not bought.
  - **deployer_emptied:** the deployer kept ≤ 1% of what it sent, so it moved its stake rather than splitting it.
  - **shared_funder:** the wallet and the deployer got their first native coin from the same EOA. A contract funder (bridge / router) or a labelled exchange wallet doesn't count.
- **Verdict:**
  - no direct clue ⇒ an ordinary wallet;
  - 1 clue ⇒ team wallet (team caps B / C as before);
  - **≥ 2 clues with at least one direct ⇒ "founder wallet (linked to the deployer)"**, scored as the founder.
  - The evidence line lists every clue and its reading.
- **Coverage:**
  - Base / Monad / Ethereum read all five clues from archive state.
  - Robinhood reads the three token clues. Native-coin funding is null there, with the reason "no archive RPC".
  - Solana is unchanged (team detection only); founder linking there is a follow-up.

## $JAMES, read live 2026-11-23 (local, no production KV)
- **Founder link 3/5:**
  - tokens from deployer: yes (creation-tx sender `0x8258…`, plain transfer in tx `0x5c96c6…ebeb`);
  - stake handed over: yes (that transfer is 109.7% of its current balance);
  - deployer emptied: yes (the sender kept 0%);
  - gas from deployer: no;
  - shared funder: no (different first funders).
- ⇒ classed **founder wallet (linked to the deployer)**. nad.fun shows it as "james.nad" with 3 buys and 0 sells.
- **Locally the sell-history scan reached only 23% in one run** (no saved scan state), so founderNeverSold was null there. Production keeps the scan state in KV.
- **With the history complete and 0 sells, the binding cap is A.** The tier then comes from its factor score: about 61, i.e. B. The cap no longer holds it at C, but the factors alone don't reach A.

## Tests
- **Replaced** (the spec changed; each replacement asserts the new rule):
  - `holder-class.test.ts` "≥ 35% held by a founder … capped at B" → "… capped at A, never S".
  - JAMES "were that wallet the deployer … B" → "classed as the founder (linked wallet) … founder cap A, team / normal caps don't fire".
- **Added:**
  - "burning / locking lifts the founder cap";
  - `tests/founder-link.test.ts`: 9 tests (the pure verdict, plus JAMES-shaped fake-RPC cases: founder 3/5, gift-then-buy ⇒ team, swap ⇒ no link, shared-funder exclusions).
- The recorded JAMES fixture (2026-10-30, class team) is kept as recorded. Its "team ⇒ C" test still holds for a team-classed snapshot.

## Stability fixes found on the live $JAMES checks
The tier flipped B ↔ D whenever one read of the founder sell history failed.
- **nad.fun swap-history read fails:** the last good reading (≤ 6h, labelled "stale Xm") stands in.
- **Sell-history read fails or doesn't finish:** e.g. the Monad archive RPC returning "Block requested not found". If no sell was seen in what was read, the last complete 0-sell proof (≤ 6h, labelled stale) stands in.
- A sell found in the live read always wins.
- **Live result:** $JAMES reads **B ~61**, founder cap A (not binding), "0 sells in 140d". The tier is B because its factor score is ~58 raw + 3 track-record bonus; the founder cap no longer holds it down.

## Sources / null factors / env vars
- No new source and no new env var.
- Founder-link clues that can't be read are null with their reason, shown on the largest-holder evidence line.

# Session summary: sync + Sparsity-inspired improvements (2026-11-22)

**Status:** merged on `main`, pushed to GitHub (`growthmindsetgg/moneymagnet`) and **deployed to production** on 2026-11-22: `hoodtier-bsumxih0u`, aliased to moneymagnet.vercel.app.

## Deploy LOOP results (2026-11-22)
- **lint / typecheck / test / build:** ok. Lint has 0 errors; tests 709/709.
- **verify:api:** 6 of 7 tokens passed. `0x30de7ae4…` (Robinhood) had only 2/4 groups with data because GeckoTerminal returned HTTP 429 for every call. The **old production build failed the same check for the same token at the same time**, so this is a source outage, not a regression.
- **verify:stability:**
  - local: OK, including the simulated HoodScan 503;
  - production after deploy (`BASE=https://moneymagnet.vercel.app RUNS=3`): OK, with no tier flips.
- **Playwright:** 56 passed, 4 flaky (passed on retry), 1 skipped.
  - `hero.spec.ts` light and dark: the snapshots were regenerated, because the only change is microduck's score line (80.4 / raw 77.4 / 100% → 81.0 / raw 78 / 98%) from banded `liq_fdv` and the new `rel_strength_7d` factor, which is null in the fixture.
  - `clarity.spec.ts:24` Kolshi still fails locally: its holder severity reads "none" because there is no fresh Robinhood holder replay or production KV on this machine. It fails on the pre-change front end too.
- **GeckoTerminal is rate-limiting production heavily (HTTP 429).** The cohort makes extra GeckoTerminal calls; they are capped by the hourly cache, the 5-minute failure backoff and single-flight. A GeckoTerminal API key is now the most valuable env var to add.

## Tasks done and decisions made
- **Sync.** Restored the source of the live deploy `dpl_4KFeqYXL` (2026-11-22) from Vercel into the repo. The other machine's commits made after that deploy (including the `pnpm sync` script) are not here yet; that machine was offline.
- **Sparsity Data's Holder Strength** (sparsitydata.com/holderstrength) was used only for its published method ideas. Its terms forbid scraping, or building a product from its data, without written permission, so nothing is fetched from it.
- **Merged four branches.** Each has its own dated section below.
  - Holder Strength areas (Conviction / Demand), whale net accumulation and dip absorption.
  - The `thin_trading` cap: tier capped at C when 24h volume is under $100.
  - Liquidity for its size (banded `liq_fdv`) and `rel_strength_7d`.
  - Front-end accessibility / metadata pass.
- **Merge conflicts.** Both were resolved by keeping both sides:
  - `REPORT.md`: kept every section.
  - `lib/scoring/engine.ts` `metricFormats`: kept the `volume24hUsd` entry and the config-driven `metricFormats` loop.
- **Checks after merging:**
  - typecheck: ok.
  - lint: 0 errors, 2 old warnings.
  - unit tests: 709/709.
  - build: ok.

# Front end: accessibility, 360px mobile, metadata, first-time-user copy (2026-11-22)

No scoring or data change, and the Holder Strength panel is untouched.

## Changes
- **Colour key at 360px:** no longer clipped.
- **Loading status:** announced once to screen readers; the source-name cycling is visual only.
- **Icon labels:** `role="img"` added so screen readers read them.
- **Address input:**
  - `aria-invalid` and `aria-describedby`;
  - no autocapitalise or autocorrect;
  - 16px on phones, so iOS doesn't zoom on focus.
- **Copy controls:** the copy confirmation is announced, and the copy-address target is 32px.
- **External links:** say they open in a new tab.
- **New `components/TierKey.tsx`:**
  - "What do the tiers mean?" on home, and "How to read this page" on results.
  - Tier bands and coverage limits are read from `factors.json`, never restated in the UI.
- **Metadata:**
  - title template "%s · MoneyMagnet";
  - full OG and Twitter tags on token pages, which previously lost og:title and og:description;
  - a static share image (`app/opengraph-image.tsx`) with no tier or score;
  - `noindex` on the not-found page.
- **Copy:** the not-found page and the footer now name every supported chain and source.
- **CSS:** `--bad-text` is now defined; it was undefined before.
- **axe (WCAG 2.1 A/AA):** 0 violations on home, microduck and peek at 360px, light and dark.

## Found, not fixed
- **Gate pill evidence:** in the default view it is in a hover tooltip only. It is reachable in Research view.
- **Cold-load result:** not announced when it replaces the loading skeleton.
- **Chain `<select>`:** still 12px, so iOS may zoom on it.

## Playwright
- **`hero.spec.ts` screenshots fail.** The stored images show microduck at 80.4 (raw 77.4). Scoring has since moved it: 80.9 on the synced deploy, and about 81 with the banded `liq_fdv`.
  - It failed on the base front end too.
  - The snapshots were not updated. The owner should regenerate them once the new scoring is accepted.
- **`clarity:24` and `severity:34/89`:** live-data or source-outage failures. They pass on rerun or fail on base too.

## Sources / null factors / env vars
- **Sources:** no change in this part.
- **Env vars:** see the relative-strength section for optional `COHORT_BUDGET_MS` and `COHORT_REFRESH_MIN`. For production, set `HOODTIER_CANONICAL_HOST=moneymagnet.vercel.app`.
- **Still worth setting on Vercel** (from the earlier run): `NAD_API_KEY`, a GeckoTerminal key and `ETHERSCAN_API_KEY`.

# Holder Strength: Conviction / Demand areas (2026-11-22)

**Status:** committed on worktree branch `worktree-agent-a6a7e4ddf69f4fd66`. Not pushed, not deployed. Only `lib/holderStrength.ts`, `lib/holderStrengthData.ts`, `tests/holder-strength.test.ts` and this report changed. `lib/scoring/factors.json`, `components/` and `app/` were not touched.

**Method source.** The area idea comes from Sparsity's public Holder Strength methodology: Conviction, Demand, fixed reference per metric, and "too new to measure" for young coins. Only the idea is borrowed. Nothing was fetched from sparsitydata.com, and none of their data is used. Every input is something we already collect: top-20 holder ledgers (EVM Transfer logs / Helius history), GeckoTerminal day candles, the accumulator supply share and wallet tokens-held counts.

## What changed
- **Areas.** Every component now carries `area` (`conviction` / `demand`), and the components are listed Conviction first. `HolderStrength.areas[]` gives each area's weight, its 0–100 score (the weighted mean of its scored components) and a null reason when nothing in it was measurable. The overall score is still the weighted mean over all scored components. Areas are display only and do not re-weight the score.
- **The public shape is unchanged** (`score`, `label`, `components`, `sentences`, `keyPerson`, `wallets`, `excluded`, `nullReason`, `method`, `pending`). The new fields are additive and optional, because details recorded before today do not have them: `areas`, and on each component `area`, `tooNew` and `unavailable`. Labels and bands are the same (Diamond ≥ 80 · Strong 60–79 · Mixed 40–59 · Weak 20–39 · Paper < 20).
- **New Demand components**, computed from the ledgers we already read:
  - `whaleNet`: the top-20 buy share of their own swap volume over the last 7d, as buys ÷ (buys + sells) by token quantity. Trades are unpriced, and transfers are not trades. No swaps in 7d scores 0 with the evidence "no activity". This follows CLAUDE.md: zero activity is a value, not missing.
  - `dipAbsorption`: the same buy share on days that closed red (close < open) in the last 30d, after the 72h launch phase. If no day closed red, the component is n/a (nothing to absorb). Red days with no top-20 swap score 0 ("no activity").
  - `holderGrowth`: the scorer supports a real holder-count series (7d change: −10% or worse scores 0, +20% or better scores 1). **No source we read keeps one.** GoPlus, RugCheck, nad.fun and the RPC holder index all give only today's count, and our own history stores liquidity and score points. So the collector passes `null`, and the component is null with that reason and marked `unavailable`.
- **New Conviction component `fullported`.** It measures the share of the top-20 supply held by wallets with ≥ 50% of their portfolio **value** in this token (full points at ≥ 50%). **There is no portfolio-value input, so it is always null for now.** `tokensHeld` is a count of distinct tokens, not a value. HoodScan gives an open-position count only, Helius gives balances without prices and we do not read the SOL balance, and Base / Monad / Ethereum have no keyless token list. The exact reason for each chain is in `portfolioReason(chain)`. A token count is not used as a stand-in for value.
- **Too new to measure.** Time-based components are null with "too new to measure — token is Nd old; needs ≥ Md" and are never guessed:
  - `hold` needs 14d of token age;
  - `drawdown`, `accumulation`, `whaleNet`, `dipAbsorption` and `holderGrowth` need 10d (a full 7d window after the 72h launch phase).
  - Discipline, maturity and accumulators do not depend on token age and are unchanged.
- **Weight handling.** Too-new, n/a and source-unavailable components are all left out of the weight. They neither add nor take away points. Because age never penalises, each too-new component lowers the minimum component count by one, from 3 down to a floor of 2. Without this, a 3–10d Solana token would turn into "no score", which is counted as missing in the main score's coverage. The weight rule (≥ 50% of the weight that could be measured) is unchanged. The "only N of M components measurable" reason now counts all 10 components and says how many are too new.

## New weights (sum 100, documented in the `lib/holderStrength.ts` header)
| Area | Component | Old | New |
|---|---|---|---|
| Conviction (67) | hold | 20 | 14 |
| | drawdown | 20 | 14 |
| | discipline | 20 | 14 |
| | maturity | 15 | 10 |
| | accumulators | 10 | 8 |
| | fullported | — | 7 (null: no portfolio value) |
| Demand (33) | accumulation (dip buys) | 15 | 9 |
| | whaleNet (7d) | — | 9 |
| | dipAbsorption (red days) | — | 9 |
| | holderGrowth (7d) | — | 6 (null: no series) |

Fullported and holder growth are always null today, so the effective split is 60 / 27 (69% / 31%).

## Effect on the synthetic label sets (`tests/holder-strength.test.ts`, unchanged assertions)
All five sets keep their label:

| Set | Old score | New score | Conviction | Demand |
|---|---|---|---|---|
| Diamond | 100 | 88.5 | 100 | 50 |
| Strong | 73.4 | 65.4 | 88.1 | 0 |
| Mixed | 49.9 | 44.7 | 60.1 | 0 |
| Weak | 26.2 | 23.4 | 31.5 | 0 |
| Paper | 17 | 15.4 | 20 | 0 |

These sets stop trading after day ~90, so whale net accumulation over the last 7d reads "no activity" (0). That is intended: holders who are not buying show no demand. The cost to a quiet Diamond-hand token is at most 9 of 100 weight.

## Tests
- No existing test was deleted, weakened or changed. 23 tests were added, covering:
  - areas and weights;
  - whale net (buy share, net sellers, no activity = 0, too new, no history);
  - dip absorption (share, no red day = n/a, no activity = 0, red days older than 30d or inside the launch window, no candles, too new);
  - holder growth (unavailable without a series, scored from a series, series too short = missing, too new);
  - fullported (unavailable with each chain's reason, scored from values, coverage < 30% = missing);
  - too-new states (which components, the 14d vs 10d thresholds, left out of the weight, the minimum of 2 when young vs 3 otherwise, the null reason counting too-new components).
- **Snapshots:** no change. `tests/__snapshots__/*.snap` do not contain Holder Strength. The fixture files keep the Holder Strength values recorded live on 2026-10-30, because they are replayed and not recomputed. They will show the new fields after the next `scripts/record-holder-strength.ts` run, which needs the live network.
- LOOP subset run here: `pnpm typecheck` clean, `pnpm lint` with 0 errors (the 2 warnings are in untouched `scripts/`), `pnpm test` 41 files / 660 tests passed (was 637). That includes the live-network `api.integration` tests; GeckoTerminal answered HTTP 429 during the run, which those tests tolerate. Build, API verify, stability and Playwright were not run: there is no deploy in this task.

## Sources
- No new source and no new fetch. The collectors read the same ledgers, candles and wallet facts as before.
- Sparsity: method idea only. Not fetched, no data used.

## Factors / components still null, and why
- `fullported`: no source gives a wallet's portfolio value. The reasons for each chain are above.
- `holderGrowth`: no source keeps a holder-count series. The pieces needed to supply one are already in place: our own analyses could append `holderCount` points the way `lib/history.ts` does for liquidity, and pass them as `holderSeries`.
- Time-based components on tokens younger than 14d / 10d: "too new to measure".

## Env vars the owner must set
None new.

# Thin-trading cap: no top tier on holder structure alone (2026-11-22)

**Status:** committed on the worktree branch `worktree-agent-a2f5ee2889a7717cb`. Not pushed, not deployed. The README LOOP was not run past lint / typecheck / test: build, verify:api, stability and Playwright still need to run before any deploy.

**Bug.** This was an open item from the nad.fun sweep (`docs/nadfun-sweep-2026-11-22.md` §8, "Caps do all the work"). GOCHI (`0x527d…7777`) scored A with $14 of 24h volume. EGG scored A 79.1 with $4 and 6 makers, and MONIGGA scored A 84.9 with $25.9. No rule looked at volume, so a clean holder list was enough for a top tier.

**Rule** (`lib/scoring/factors.json`, rule `thin_trading`, one self-contained entry placed before `micro_cap`):
- **Condition:** `volume24hUsd < 100`.
- **Effect:** caps the tier at **C**. It has no points, no gate chip and no age condition, and applies to every factor set and chain.
- **Evidence line:** "24h trading: $14 volume, 17 buyers / 18 sellers (measured) — below the $100 24h volume a tier above C needs. Holder structure alone does not earn a top tier: capped at C."
- **Zero activity:** $0 is a measured value. The rule fires and the token is still scored S–F with a number, never U.
- **Unknown volume:** null volume makes the rule "not evaluable", so no cap is invented from missing data.
- **Displayed score:** the existing generic clamp applies. A capped token shows 54.9 (top of C) with "raw N" beside it.

**Decisions.**
- **Why cap at C.** C is "mixed signals": the holder list may be sound, but no market confirms it, and $100 a day is not enough to exit a position. The other "unproven" caps (`sellable_unknown`, `top_holder_20`, `price_collapse`) also cap at C. B would still read as a tradeable market.
- **Why $100.** The lowest-volume fixture legitimately rated above C is CHOG (`monad-chog`), recorded at $131.54 and rated A 76.3. That figure is an old-code reading about 75× too low; the sweep measured about $8k on new code. The examples sit far below the line ($4 / $14 / $25.9). A higher floor such as $1,000 would cap CHOG's recorded snapshot to C. That can be revisited once the Monad fixtures are re-recorded on the fixed volume path.
- **Buyer/seller-count floor tried, then dropped.** A first version also capped at fewer than 5 buyers and fewer than 5 sellers. The live `api.integration` microduck run then read **0 buyers / 0 sellers beside $52k of DexScreener volume**: the swap-index counts were stale again, see the stalled-index section below. That clause capped a live, busy token at C. The counts are now only printed on the evidence line, never used as a floor.
- **`engine.ts`:** one entry added to the generic metric-format table (`volume24hUsd: "usdAbs"`) so the evidence line reads "$14" rather than "14". There is no factor-specific logic.

**Fixtures whose tier changed: none.** All 18 recorded fixtures (5 Robinhood/Solana, 13 v3) were scored before and after.
- The rule fires on 4 fixtures that were already lower than C: `peek` ($0, F), `monad-james` ($25.32, D), `monad-perpl` ($0.62, F) and `monad-nad` ($66.33, F). Their `fired` lists in `tests/__snapshots__/fixtures.test.ts.snap` (peek) and `v3-fixtures.test.ts.snap` (3) gained `"thin_trading"`. Tier, score, raw score and factors are unchanged.
- No other snapshot line changed.

**Tests:** new file `tests/thin-trading.test.ts`, 13 tests. None deleted or weakened.
- **GOCHI-like, EGG-like and MONIGGA-like.** A synthetic Monad token with the sweep's recorded activity figures, built from `perfectSnapshot`. Fields the sweep did not record are marked "synthetic" in the test. Each scores S/A with the rule removed from the config. With the rule each scores C, bound by the cap, displayed at 54.9 with raw beside it, and the measured volume appears on the evidence line.
- **Not capped:** a healthy $1.2M token stays S, and a healthy Monad token stays S/A. The recorded microduck and CHOG fixtures stay A. $100 is clear and $99.99 fires. A stalled index (0/0 counts beside $52k) does not fire. Unknown volume is "unknown", not a cap.
- **Zero activity** is rated with a number, never U, and capped.
- **Age:** the same thin market is capped at 30h (launch set) and at 40d (established set).
- **Monotonicity:** a sweep of 360 reports over volume, counts, top-10 share and Holder Strength. A higher displayed score never means a lower tier, and every capped report sits at or below 54.9 with raw ≥ displayed.

**LOOP (partial):**

| Check | Result |
|---|---|
| lint | ok (the same 2 old warnings) |
| typecheck | ok |
| Tests | 650/650, including the live `api.integration` microduck test (local B = production B) |

**Sources:** no adapter was changed. Live microduck during this run: HoodScan's 24h buyer/seller counts read 0/0 while DexScreener read $52k volume. This looks like the stalled-index symptom on the count fields, which that fix did not cover. Not investigated here.

**Factors still null:** none changed by this run.

**Env vars:** none new. `NAD_API_KEY` in production is still recommended (sweep §Sources).

**Open:** once Monad volume is trusted (fixtures re-recorded on new code), consider raising the floor or scaling it with FDV. That is an owner decision.

# Liquidity for its size + relative strength 7d (2026-11-22)

**Status:** committed on branch `worktree-agent-a64850f3e67982bc3`. Not pushed, not deployed. The method ideas come from Sparsity's public Holder Strength write-up; none of their data is used and sparsitydata.com is never fetched.

## What changed
**1. `liq_fdv` is now "Liquidity for its size".** An existing factor already measured liquidity against market cap: `liq_fdv`, active-pool liquidity ÷ FDV, with flat bars. It was improved in place, not duplicated.
- The share is scored against a **fixed reference ratio for the token's market-cap band**. The bands live in `factors.json` (`reference` on the factor):

  | FDV band | Reference liquidity / FDV |
  |---|---|
  | < $100k | 20% |
  | $100k–1M | 15% |
  | $1M–10M | 10% (identical to the old flat bars) |
  | > $10M | 5% |

- Thresholds read the share ÷ reference: ≥ 1× scores full, ≥ 0.5× scores 0.75, ≥ 0.2× scores 0.45 (info), ≥ 0.1× scores 0.2 (warn), anything lower scores 0 (danger). The score never depends on other coins.
- **Evidence:** "Active-pool liquidity is 4.3% of FDV ($45M); the fixed reference for the > $10M band is 5%, so it holds 0.85× of the reference — at least half the band reference."
- **Unknown FDV:** null, with "market cap (FDV) unknown (…) — needed to pick the reference band". No default band is used.
- **Staleness:** a stale FDV makes the reading stale.
- **Engine:** `engine.ts` gained a generic `reference` feature: any factor can be scored against a band reference picked by another metric. No code in it is specific to this factor. The new `factors.json` key `metricFormats` holds evidence display formats.
- **Weight:** `liq_fdv` gave 2 points to the new factor, as follows. Group weights are unchanged.

  | Set | Before | After |
  |---|---|---|
  | Established | 9 | 7 |
  | Base | 13 | 11 |
  | Monad | 12 | 10 |
  | Ethereum | 13 | 11 |

**2. New factor `rel_strength_7d`, "Relative strength 7d".** Weight 2 in every Established set's liquidity group. It is absent from Launch sets.
- **Metric:** `relStrength7dPp = min(7d change, 7d change − cohort median)`, derived in `deriveMetrics`. It is above 0 only when the token **rose AND beat** its cohort's median.
- **Thresholds:** ≥ +10 pp scores 1, > 0 scores 0.75, ≥ −15 pp scores 0.4 (info), anything lower scores 0 (info).
- **Token's 7d change (`priceChange7dPct`):** read from GeckoTerminal daily candles that are already fetched (no new call). The rule is the latest close vs the close at or before the start of the day 7 days back. A day with no candle means no trade, so the last close stands. The window string names both dates.
- **Cohort (`lib/cohort.ts`):** tokens on the same GeckoTerminal venue as the token's main pool, on the same chain.
  - GeckoTerminal lists Robinhood launchpads as DEXes (pons-dot-family, hoodit, clanker-robinhood, frontier-fun…). pump.fun graduates trade on `pumpswap`.
  - It reads up to 3 pages of the venue's volume-ranked pools.
  - It keeps pools with ≥ $10k reserve and ≥ 7d of history, skips majors (stables, wrapped ETH/SOL/BTC, LSTs, the registered non-memes), and keeps one pool per token.
  - It reads each peer's daily candles (≤ 8 peers) and applies the same 7d rule.
  - It needs ≥ 5 peers. If the venue has fewer, it falls back to the chain's top pools, and the label says so.
  - The token itself never counts in its own median.
- **Caching:** the cohort is cached in KV (`cohort7d:v1:<chain>:<dex>`).
  - It is refreshed at most every 60 minutes (`COHORT_REFRESH_MIN`) and never used past 6h.
  - A cached cohort is always labelled "stale Xm", on the factor and on the "Peer cohort (GeckoTerminal)" source line.
  - One refresh runs at a time per cohort (60s KV lock).
  - A read that failed with nothing cached is not retried for 5 minutes.
- **Budget:** at most `COHORT_BUDGET_MS` (default 10s), capped by what is left of the analysis budget (`lib/budget.ts`). The step runs beside the liquidity-history step.
  - With < 1.5s left, it does not fetch: it uses the cache if there is one, otherwise the factor is null with the reason.
  - A read cut off by the budget keeps running and stores its result for the next analysis.
- **Age never penalises.** Under 7 days old (`ageHours < 168`) with no reading, the factor is **n/a**, not null, so coverage does not drop. In Launch mode the cohort is not read, and the source line says why.
- **Evidence (format example with test values):** "7d price change +25% (daily close 2026-11-15 → latest 2026-11-22) against a median of +5% across 8 pons-dot-family peers on Robinhood Chain; strength = the lesser of the change and its excess over the median = +20 pp (derived) — rose and beat the peer median by ≥ 10 pp."

## Cohort failure modes (each is null with the exact reason, or stale-labelled)
| Situation | Result |
|---|---|
| GeckoTerminal listing 429 / 5xx / timeout, no cache ≤ 6h | null: "peer cohort unreadable: GeckoTerminal pool listing failed: rate limited (HTTP 429)". Retried after 5 min. |
| Same, cache ≤ 6h | Cached median, stale Xm, "refresh failed: …" on the source line |
| < 5 qualifying pools on the venue and on the chain | null: "only N qualifying peer pools (≥ $10k reserve, ≥ 7d old, not a major) in … — needs ≥ 5" |
| < 5 peers' candles readable | null: "only N of M peers' 7d changes could be read (…) — needs ≥ 5" |
| Only < 5 peers besides the token itself | null: "…: only 4 peers besides this token (needs ≥ 5)" |
| Token's own 7d change unknown | Cohort not read; null: "the token's own 7d price change is unknown (GeckoTerminal daily candles start … )" |
| Budget used up | null: "peer cohort timed out after Ns" or "no analysis time left to read the peer cohort" (or the cache, stale) |

The `OUTAGE` pattern in `lib/hold.ts` matches the failure reasons above, so a cohort outage cannot flip a tier: the tier hold applies.

**Known limit.** Volume-ranked GeckoTerminal listings lead with fresh launches and wash-traded dust. This was checked live on 2026-11-22:
- `solana/dexes/pumpswap` volume pages 1–3 had 0 qualifying pools, and Solana's chain-wide top pools are SOL/USDC plus newborn dust.
- So **most pump.fun graduates will read null** ("only 0 qualifying peer pools…") until a better cohort source exists.
- Robinhood launchpad venues work well: `pons-dot-family` gave 8 peers on page 1, median −5.4%, recorded as a fixture.
- GeckoTerminal's category endpoints (which would give launchpad cohorts directly) return 401 on the public API.
- Follow-up options: a paid GeckoTerminal key with categories, or a KV-observed cohort built from HoodTier's own recent analyses.

## Tier changes on recorded fixtures (justification)
The old and new `factors.json` were compared on every recorded fixture: 19 fixtures, 10 of them Established.

| Fixture | Before | After | Why |
|---|---|---|---|
| base-brett ($46M FDV, liquidity 4.3%) | B 68 | **A 71.8** | > $10M reference 5% ⇒ 0.85× ⇒ 0.75 (was 0.45 on the flat 5% bar) |
| base-toshi ($45M FDV, liquidity 2.9%) | B 68.7 | **A 72.6** | 0.59× ⇒ 0.75 (was 0.45 on the flat 2% bar) |
| ethereum-pepe ($1.5B, 1.8%) | B 64.6 | B 69.7 | 0.35× ⇒ 0.45 (was 0.2) |
| fartcoin ($147M, 6.3%) | B 66.5 | B 68.6 | 1.27× ⇒ full (was 0.75) |
| microduck ($4.3M, 7.6%) | A 80.9 | A 81 | $1M–10M band = old bars; the 2 points moved to rel strength |
| monad-chog / monad-james / holders-james / ethereum-mog / monad-nad | same tier | same tier | Raw score moves ≤ 2; caps or gates still bind |

- **Both moves (B → A) come from the liquidity-for-size change**, which is the intended effect. A $45M Base meme holding 3–4% of its value in pool liquidity (about $1.3–2M) is deep for its size. The old flat 10% bar scored it like a $2M coin with the same share. Both stay inside their fixture's expected tiers (A/B/C).
- The recorded fixtures predate relative strength, so it is null there (coverage −2 points: 100 → 98, 87 → 85). That is honest: the input was not recorded.
- Rel strength was funded from `liq_fdv`, not from `trend`. Funding it from `trend` would have lifted weak-trend tokens whenever the cohort is null (microduck went A 84.3 → S 85.0), so it was rejected.

## Tests (no test deleted or weakened)
- **New:** `tests/liquidity-relative-strength.test.ts` (36 tests).
  - Bands and edges; the $1M–10M band equals the old bars; monotone in size and depth; evidence text; FDV null; stale FDV; BRETT and TOSHI fixtures.
  - The derived metric (strong iff rose AND beat), its null reasons and its stale inheritance.
  - Factor points, evidence and n/a under 7d; the token's own 7d rule.
  - `pickPeers` filters; `fetchCohort` replayed from **recorded** GeckoTerminal responses (`tests/fixtures/cohort/robinhood-pons-dot-family.json`, made by `scripts/record-cohort-fixture.ts`); the fallback label; listing and candle failures.
  - `readCohort`: cache within the refresh window shown stale, refresh failure falls back to the cache, never used past 6h, 5-minute failure memo, budget timeout, no time left, subject excluded, too few peers.
  - `relativeStrengthStep` wiring and the source line.
- **Updated for the new spec:**
  - `tests/helpers.ts`: `perfectSnapshot` ("clears every factor") now carries a relative-strength reading.
  - `tests/scoring.test.ts`: "a group with no data…" also strips the liquidity group's new metric.
  - `tests/stability.test.ts`: the microduck flap numbers moved A 84.3 / S 87.7 → A 84.5 / S 88. The flap and the hold are asserted exactly as before.
  - Fixture snapshots: `fixtures.test.ts.snap` and `v3-fixtures.test.ts.snap` were regenerated. Changes are listed in the table above.

## LOOP (partial: typecheck, lint, test only; no deploy)
| Check | Result |
|---|---|
| typecheck | ok |
| lint | ok (the same 2 old warnings in `scripts/`) |
| Tests | 672/673 on the full run, then the 1 failure passed on rerun |

**The failure was network-flaky.** The live `api.integration` "analyzes offline" test read U while GeckoTerminal answered HTTP 429, and passed on rerun. GeckoTerminal's public quota was contested throughout this session. In the live runs, the cohort source itself read "failed: rate limited (HTTP 429)" on microduck and offline, and was reported as a null with that reason.

**Not run:** build, verify:api, stability and Playwright.

## Sources, nulls, env
- **New source line:** "Peer cohort (GeckoTerminal)": ok / partial / stale / failed / skipped, with the reason.
- **Factors still null:**
  - `rel_strength_7d` where the cohort cannot be read: mostly Solana pump.fun graduates (see the known limit).
  - `rel_strength_7d` on tokens whose main pool has < 7 days of daily candles (n/a when the token is < 7 days old).
- **Env vars (optional, not secret, documented in `.env.example`):**
  - `COHORT_BUDGET_MS` (default 10000).
  - `COHORT_REFRESH_MIN` (default 60).
  - Nothing the owner must set.

# Ethereum + data-audit merge, stalled-index fix (2026-11-22)

**Status:** deployed as `hoodtier-fu18m31dw` (`dpl_BffyCLA7u9uD1k6ZyZhdaefBgnts`), then `hoodtier-kq7jc2axn` (`dpl_E1zyaAaz8ayA8UzMQXH5b8ieRCQt`) with the stale-bound fix. `moneymagnet.vercel.app` points to the latter. The rollback target is `hoodtier-8rgtxeyx4`.

Commits on main:
- `fc768df`: merge of `claude/ethereum-and-audit-576c16`. Ethereum mainnet plus the data-audit fixes; see the next section, now deployed.
- `34855b3`: stalled trade index.

## Stalled HoodScan trade index (found while checking the merge)
**Symptom.** On production, microduck, GIGATENEV, Kolshi, PONS and UHI read **F 0**, "dead — no trades for 16.9h+". The previous deployment gave the same.

**Cause.** HoodScan's newest indexed microduck swap was 16.9h old. DexScreener meanwhile counted trades on 5 pools in the last hour (about $96k/24h). The adapter assumed the index "trails the chain by seconds".

**Fix.**
- DexScreener now states `lastTradeWithinHours`: the shortest window (1h / 6h / 24h) with at least one trade, given only when every base pair reports that window.
- When the index's last-trade age is older than that bound, `lastTradeHoursAgo` becomes null, with both readings in the reason.
- A token with no DexScreener trade in 24h still fires `dead_no_trades`.
- Tests: `tests/stalled-index.test.ts` (4).

**Limit.** UHI has no DexScreener pair, so nothing contradicts HoodScan and it stays F. If HoodScan's index is stalled, a live token without a DexScreener listing can still read as dead. HoodScan's other swap-derived fields (net flow, swap holders) may also be stale while its index lags; this was not measured.

## Merge checks
**Review before merging.**
- No test was deleted or skipped.
- The e2e changes accept the Ethereum label and the "(age unknown)" suffix.
- No existing factor weight changed; only the Ethereum sets were added.
- No factor-specific code was added to `engine.ts`.
- 12 locally regenerated `docs/screens/*.png` files were backed up to the scratchpad and replaced by the branch's versions.

**LOOP on the final tree** (`34855b3` plus the stale-bound aging fix):

| Check | Result |
|---|---|
| lint | ok (2 old warnings) |
| typecheck | ok |
| Tests | 625/626 |
| build | clean (`.next` removed) |
| verify:api | OK |
| stability | OK |
| Playwright | 64 passed, 1 skipped (data-conditional: "three.ws returned no new tokens" / "no gate fired") |
| Lighthouse (merged build) | home 99, microduck 96, PEEK 97, NVDA 98, BRETT 97, CHOG 96; a11y, best practices and SEO all 100 |

**The one failure** is the live `api.integration` microduck test ("same tier as the previous deployment"). It failed twice: first A locally against production's stalled-index F, then A against B while microduck sat on the 70 line. A direct side-by-side straight after read B 69.3 on production and B 69.9 locally. It was not changed.

**Fixture matrix**, new production vs `hoodtier-8rgtxeyx4`: 15/19 same.
- All fixed-F fixtures stay F.
- NVDA and WETH are rejected (422).
- PEPE (Ethereum) is B 69.9.
- The 4 that differ read F 0 on the previous deployment at the same moment because of the stalled index:

| Fixture | New | Two days ago |
|---|---|---|
| microduck | B 69.9 | B 64.8 |
| GIGATENEV | A 79.4 | B 61 |
| Kolshi | D 39.9 | D 37 |
| PONS | B 69.9 | C 51.9 |

  GIGATENEV and PONS moving up a tier from two days ago is attributed to the audit fixes (zero-default nulls, hold freshness) plus the market. This was not isolated factor by factor.

**Production checks:**
- PEPE resolves to Ethereum and scores B 69.9 in 13.3s.
- microduck: 9.1s. The fan-out to four EVM chains caused no slowdown.

## Follow-up checks (advisor review)
- **Why GIGATENEV and PONS rose (B 61 → A 79, C 52 → B 70).** Both had `liq_change_7d` at about −70%, which fired `liq_drain` (−15). The audit fix nulls it: "no liquidity observation between 7d and 252h ago — the nearest older one is 554h old". The old −70% was a 23-day change labelled 7d. The null is correct, but a real long-term liquidity drain no longer counts. **Owner decision:** add a factor for the change over the available history, labelled with its span?
- **UHI F is correct.** GeckoTerminal shows 0 trades in 24h on all 19 pools, and the last swap was 32h ago.
- **Stale upper bound.** `lastTradeWithinHours` now ages on stale refill (added to `TIME_RELATIVE`), so a stale "traded within 1h" cannot suppress a genuine dead F for 6h. There is a test for it.
- **Engine.** The merge added only generic reads (`nullReasons`, `staleFields`) to `engine.ts`; no factor-specific code.
- **v3 matrix on the new deployment:** all rows pass (Base, Monad, Ethereum, blue-chip 422s).
- **Distribution:** partial and **inconclusive**. The run was cut at 10 minutes, while the nad.fun sweep was also hitting nad.fun and GeckoTerminal.
  - Base junk: 9 rated, 0 A/S.
  - Base known-good: 0 of 7 A/S. 6 are capped at B by coverage below 60%: GeckoTerminal and GoPlus failed (429), and missing pool figures are now null instead of 0, so they lower coverage.
  - Monad junk and the summary were not reached.
  - Rerun when rate limits are quiet. A GeckoTerminal API key would remove most of these coverage caps.
- **Production deployer reads** sometimes fail with "block range extends beyond current head block" (a lagging RPC endpoint), which nulls `deployer_holding` and `deployer_sold`. Not fixed.

## Env vars (owner)
- `ETHERSCAN_API_KEY` is not set on Vercel, so the `etherscan` source is skipped on Ethereum (and Base deployer lookups fall back). Set it in the Vercel project env to fill those fields.
- `ETHEREUM_RPC_URL` is optional. The keyless pool is used without it.

## In progress
- `nadfun-sweep` session: 94 nad.fun memes. The baseline on the old deployment is done or running; the rerun on this deployment follows. The report goes to `docs/nadfun-sweep-2026-11-22.md`.

# Data audit + Ethereum mainnet (2026-11-20, branch `claude/ethereum-and-audit-576c16`)

**Status:** merged into main (`fc768df`) and deployed as `hoodtier-fu18m31dw` on 2026-11-22; see the section above. The LOOP is green locally (table below).

## How it was run
- A lead session handed work to subagents and reviewed each result before accepting it.
- Audit, read-only:
  - an Opus code audit of every data path: 6 critical, 14 high, 15 medium and 8 low findings;
  - a Sonnet live audit of 25 production tokens: 7 Robinhood, 8 Solana, 5 Base, 5 Monad.
- Writers, each on its own set of files:
  - an Opus agent for Ethereum;
  - four Opus fix agents: EVM on-chain errors, indexer zero-defaults, Solana sources, and scoring/presentation.
- Coordinated with the main session:
  - H1 ("no cap binds" while penalties decide the tier), NIKO (graduated curve pool) and SHEEP (dust AMM pool) were fixed on main and are not redone here.
  - NIKO's volume showing 0 was the curve-pool bug fixed on main.
- Full notes, outside the repo, in the shared notes folder: `code-audit.md`, `live-audit.md`, `ethereum-evidence.md`.

## Ethereum mainnet (chain id 1)
- **Chain setup.** Built on the Base/Monad template:
  - chain type, labels, and the header "Robinhood Chain · Base · Monad · Ethereum · Solana";
  - RPC pool `data/ethereum-rpc-endpoints.json` (11 probed keyless endpoints; `ETHEREUM_RPC_URL` is tried first);
  - registry `data/ethereum-infra.json` (48 contracts checked on-chain);
  - GoPlus chain 1, DexScreener `ethereum`, GeckoTerminal `eth`;
  - sell simulation (v2/v3/v4), Etherscan v2 (`chainid=1`), resolver, picker, meme filter, verify metrics, and `docs/chains/ethereum.md`.
- **Exchange wallets.** `cexWallets` holds 9 exchange wallets that only label holder rows; they stay in the concentration figures. Their names are Etherscan name tags and cannot be proven on-chain; the file says so. GoPlus's own tag, when present, takes priority.
- **Factor sets.** `launch_ethereum` and `established_ethereum` are the Base sets on Ethereum sources, without `launchpad`: no Ethereum launchpad is registered, so that factor would always be null. The chain-restricted EVM rules now include Ethereum: owner cap, owner mint, proxy cap, liquidity pulled, too early.
- **Auto-detection.**
  - An 0x address is checked on all four EVM chains in parallel, each with its own 12 s deadline, so a slow Ethereum RPC can't delay the others. The cache key is now `resolve:v2:`.
  - When the same address is a token on several chains, the user gets the picker, highest FDV first. Nothing is auto-picked: a CREATE2 twin is a different token.
  - With no chain hint, the default is still Robinhood Chain.
  - Live checks: PEPE resolves to Ethereum only; BRETT stays Base only.
- **Blue-chip rule.** "> $1B FDV and no launchpad ⇒ blue chip" is not applied on Ethereum, because it would refuse PEPE. Ethereum non-memes are refused through the registry instead.
- **Fixes that apply to every chain, found while adding Ethereum:**
  - native-ETH v4 pools (`currency0 = 0x0`) were never sell-simulated;
  - a GoPlus holder list whose shares add up to more than 100% of supply is now refused, with the reason, instead of scored.
- **Tests.**
  - `tests/v3-ethereum.test.ts`: 20 tests.
  - Fixtures PEPE, Mog and PIPI added as new snapshot entries.
  - `fixture-matrix.mjs` and `v3-matrix.mjs` entries.
  - `verify:api` now includes PEPE.
- **Live evidence**, final branch code, local, `fresh`, no Etherscan key:

| Token | Tier | Score (raw) | Coverage | Why / notes |
|---|---|---|---|---|
| PEPE `0x6982…1933` | B | 64.4 (61.4 + 3 track record) | 80% | No cap. Sellable through v2, v3 and v4, round trip 0.6–2.3%. Owner renounced. GoPlus: 578,855 holders. GeckoTerminal OHLCV 429, so `trend` is null with that reason. |
| Mog `0xaaee…1c7a` | C | 54.9 (55.7) | 52% | Capped by "top holder > 20%". GeckoTerminal failed (429). 3 of 12 DexScreener pools have no liquidity figure, so pool totals are null with the partial sum named (see open item 3). |
| PIPI `0x7bce…47b9` (3h old, native-ETH v4) | D | 39.9 (71.4) | 33% | Capped by "LP unlocked, launchpad not proven". Sellable with 0.19% loss, but only since the v4 fix. GoPlus holder list adds up to 138.6%, so concentration is null with the reason. |

## Audit findings: fixed
Critical:
- **C1. Missing indexer figures stored as $0 or 0** (DexScreener, GeckoTerminal, pool sums).
  - Before: a zero then won the verifier's "min" rule and could force `dead_launch` F, `micro_cap` and `vol_mc_bundle`.
  - Now the figure is null, and totals name the partial sum.
  - DexScreener's "last trade ≥ 24h" bound applies only when every pair reports its trade counts.
  - The verifier ignores null readings and prefers live readings over stale ones (M2).
- **C2. An RPC timeout on `owner()` read as "owner renounced"** (which cleared the owner cap and the owner-mint F). A timeout on `totalSupply()` read as "not a token".
  - New `isRevert` / `callOrRevert` in `lib/onchain/rpc.ts`: only a real revert means "function absent".
  - A transport error now gives null with "owner() read failed: …" and status partial.
- **C3. Sell-simulation transport errors became revert, blocked, dry or "liquidity removed"**, leading to honeypot verdicts and forced F.
  - Now they give a new `error` result, which is excluded from the verdict.
  - If only errors remain, sellable is null with the reason.
- **C4. Failed LP-lock reads became 0% locked** (forced F through `lp_unlocked`), and a failed `ownerOf` was treated as burned. Now `lockedPct` is null with "LP lock read failed (k of n calls)".
- **C5. RugCheck missing fields read as passes.** Mint/freeze authority counted as revoked, sellable as true, and the fee ×2 was shown as a "simulated" round trip.
  - Now each value is set only when its field is present.
  - The fee becomes a signal labelled "derived, not a simulation".
  - `round_trip_loss` no longer lists `rugcheck` as a source.
- **C6 + M1. The tier hold saved stale values as a fresh "complete run".**
  - Each value now keeps its own fetch time, and values older than 6h are dropped.
  - The previous tier is held only when the re-score gives the same tier; otherwise the re-score is shown, labelled.

High:
- **H2. An "insufficient sample" scored 0 points but counted as covered.** It is now n/a, or null when the sample size itself is unknown.
- **H3/H4. Helius failures were silent.** Batch items that failed were dropped silently and their misses cached; errors that weren't outages were never recorded. A partial curve history now nulls the curve fields with the count of unreadable transactions.
- **H5. pump.fun creators showed "0 prior mints, 0% rugged" from DAS.** This is now null, because DAS doesn't index those mints under the creator. The KV key moved to `helius:creator:v2:`.
- **H6. pump.fun feed.** The dev-buy share was 0% when the creator wasn't in the feed's top wallets. "Dev not sold during the observation window" was turned into a lifetime 0% sold.
- **H7/H12. Zero activity or "dead" from indexer silence alone.** This now needs a source that reads trades to have answered: Helius or the curve on Solana, HoodScan on Robinhood, nad.fun on Monad.
- **H10. ScanHood's `lp.safe` flag became 100% or 0% locked, and Jupiter's "no sell route" became a 100% loss.** Both are now booleans or null.
- **H11. Liquidity history recorded stale or partial totals as fresh points.**
- **H13. DexScreener transaction counts became `uniqueBuyers`.**

Medium and low:
- M3 (stale label on every scoring path), M5, M7, M8, M10, M13, M14.
- M10: RugCheck's first-detection time is no longer used as the creation time, and stale refills add their age to time-based fields.
- L1, L2, L3, L5, L7.

From the live audit:
- **Monad volume was about 75× too low.** nad.fun's `volume` is already in USD, but the code multiplied it by the MON price.
- **`liq_change_24h` equalled `liq_change_7d` on 18 of 25 tokens.** Both used the same old reference point. Now a reference must be at most 1.5× the window old. 7d is null until a real 7-day point exists, and the two changes can no longer share a reference.
- **Robinhood stock token ANT was scored B.** `/api/analyze` now answers 422 whenever `eligibility.meme === false`.
- **"Main risk: track record ≥ 30 days" named a bonus.** The main risk is now the binding cap, then the largest penalty; bonuses are never picked. Evidence text keeps its capitals and timestamps.
- **Cached responses looked identical to fresh ones.** The JSON now carries `cache {cached, generatedAt, ageSeconds}`. On a cached answer, stale ages include the time since generation, and the page shows "cached · generated HH:MM UTC (Nm ago)".
- **The reason text netted penalties against bonuses.** PONS showed "raw 67 − 12": the `liq_drain` penalty of 15 minus the track-record bonus of 3. The reason now lists penalties and bonuses separately.

Last-good snapshots:
- `STALE_VERSION` was bumped for every adapter whose stored values these fixes change: GeckoTerminal and DexScreener to v3; nad.fun, RugCheck, ScanHood, Helius, GoPlus, rpc, base-rpc and monad-rpc to v2.
- So values saved before the fixes are never served as stale.

## Audit findings: rejected
- **M4** proposed counting a factor toward U only when *every* listed source failed. I rejected it. A factor whose providing source failed is missing because of that failure, even if another listed source answered. Under M4, section7 §7e would go from U to B at 22% coverage.
- The U accounting is unchanged. Skipped sources are now named "not configured" in the reason, separately from failed ones.

## Open (ranked)
1. **M9: age-conditioned rules. Owner decision.**
   - The `vol_mc` bar depends on age (`snapshot.ts:299`: 1.5× under 6h, 1.2× under 24h). This is the closest thing to an age penalty.
   - `lp_unlocked_unproven` applies only under 14 days.
   - `bot_inflated` and `supply_controlled` apply only under 24h.
   - `vol_mc_bundle` repeats the launch-set age check.
   - `micro_cap`, `dead_no_trades` and `too_early` only exempt the youngest tokens, so they never penalise age.
2. **H8: GoPlus and other short holder lists.** `deriveMetrics` recomputes top-10 from any list, even one with fewer than 10 wallets. Fixing it means a generic "complete list only" rule, which conflicts with `tests/scoring.test.ts:509/523`. Owner decision.
3. **Pools without a liquidity figure.**
   - Pool totals are now null instead of a silent partial sum.
   - On Mog, 3 of 12 DexScreener pools have no figure, which nulls `liq_fdv`, `pool_count`, `main_pool_share` and `liq_change`. Coverage fell from 80% to 52%.
   - A follow-up could treat a pool with no liquidity *and* no volume as immaterial, with the evidence saying so.
4. **Robinhood holder shares from the swap index look too low on large tokens** (live: PONS top-10 at 0.4% on a $69M FDV).
5. **GeckoTerminal 429s.** In the live audit it was ok on only 5 of 25 tokens. A GeckoTerminal API key or a shared rate budget would recover `trend` and the chart factors.
6. **Smaller items:**
   - H14: the `all_buyers_exited` evidence basis.
   - `lib/types.ts`: `rawScore` and `coveragePct` are still typed `number` (a cast covers the nulls).
   - The LP-lock "first 40 of N" note doesn't reach the evidence when a value was measured.
   - Liquidity history points recorded before this fix stay in KV until they age out after 30 days.

## Tests replaced (CLAUDE.md: replaced, not weakened)
- `tests/v24.test.ts`: "insufficient sample is live, 0 points" now asserts n/a (H2).
- `tests/fixtures.test.ts`: "offline `bundle_score` is live" now asserts n/a on fewer than 50 buyers (H2). The `offline` snapshot: coverage 65 → 63, raw 53.4 → 54.4, bundle and organic score n/a. The tier is unchanged.
- `tests/dust-pool.test.ts`: the last-good key assertions now expect the bumped versions. The rule is the same: pre-fix keys are never read.
- `e2e/smoke.spec.ts`: the launch badge may carry the engine's existing "(age unknown)" label. That happens when only RugCheck's detection time exists (M10).
- `tests/audit-scoring.test.ts`: the M4 cases assert the rule that was kept.
- New tests:
  - `tests/audit-evm-errors.test.ts` (19)
  - `tests/audit-indexers.test.ts` (24)
  - `tests/audit-solana.test.ts` (26)
  - `tests/audit-scoring.test.ts` (24)
  - `tests/v3-ethereum.test.ts` (20)

## LOOP (local, final tree)
| Check | Result |
|---|---|
| lint | 0 errors, the 2 old warnings in `scripts/` |
| typecheck | ok |
| test | 621/621 (39 files, including the live `api.integration`) |
| build | ok |
| verify:api | OK: 7 addresses including PEPE (B 66.2) |
| stability | OK: microduck B ×3, plus a simulated HoodScan 503 |
| Playwright | 64 passed, 1 skipped |

The run against production (`BASE=… stability`) and the fixture matrix against production were not run, because nothing was deployed.

## Sources
- **Live audit:**
  - GeckoTerminal: ok 5, partial 10, stale 8, failed 2. Almost every non-ok result was HTTP 429.
  - ScanHood failed on 3 of 7 Robinhood tokens (timeouts).
  - `rh-sim` failed on 2 of 7.
  - Robinhood RPC: "block range beyond head" errors recur.
  - Helius failed once (35s timeout).
  - basescan was skipped on all Base tokens (no key).
- **Ethereum:** RPC, simulation, DexScreener and GoPlus ok. GeckoTerminal was rate-limited. Etherscan was skipped (`ETHERSCAN_API_KEY` not set; the adapter is unit-tested against a mocked API only).

## Factors still null, and why
- **Ethereum:**
  - `liq_change_*` until history accrues;
  - GeckoTerminal-fed factors on 429;
  - concentration when GoPlus's list is inconsistent;
  - `lp_lock` n/a at 14 days or older;
  - Time Machine and social have no Ethereum source.
- **Everywhere:** values that used to be defaulted, now null with their reasons:
  - pool totals with figure-less pools;
  - owner/supply reads that failed in transport;
  - an incomplete curve history;
  - creator history for pump.fun creators;
  - round trip when no route or simulation exists.

## Env vars the owner must set
- `ETHERSCAN_API_KEY` (recommended; the free Etherscan v2 plan covers chainid 1): Ethereum creation time, creator and verified source. Base falls back to it when `BASESCAN_API_KEY` is unset, and Ethereum falls back to `BASESCAN_API_KEY`.
- `ETHEREUM_RPC_URL` (optional): a private RPC tried before the public list.
- Optional, from the live audit: `BASESCAN_API_KEY` (Base is skipped without it), and a paid GeckoTerminal/CoinGecko plan for the 429s.

# NIKO + SHEEP pool fixes (2026-11-20)

**Status:** deployed as `hoodtier-8rgtxeyx4` (`dpl_7GHMRk8fqBvLUtN7oAkJWABPAiuL`). `moneymagnet.vercel.app` is re-pointed to it.

Commits:
- `4a488c6`: NIKO, from the side session; merged in `9973349`.
- `6a1df47`: SHEEP.
- the stale-key version follow-up.

## NIKO (A2MgdY1o…pump): B 66 → D 29.3 → now C 42.7
**Cause.** NIKO has graduated from its pump.fun curve to a PumpSwap pool. GeckoTerminal listed only the dead curve pool: $0 volume, 0 trades, price frozen at graduation. Those zeros beat DexScreener's live PumpSwap data and fired the VOL/MC bundle penalty (−20).

**Fix.**
- When Solana RPC says the curve is complete, a source that sees only the curve pool no longer supplies market fields (`dropGraduatedCurveMarket`). The reason is stated, and the source is marked partial.
- "Why this tier" now names penalties: "score X (raw Y − Z penalties)". Before, it said only "no cap binds" while raw ≠ shown.

**Now.** Volume reads $73k. The remaining −20 VOL/MC is genuine: 0.78 is below the 1.0 bar for a 24–72h token. That bar is the age-scaled one listed as an open item.

## SHEEP (6ppvYhoj…pump, still on the curve): F 23.5 → D 39.9
**Cause.**
- Someone opened a $0.65 Meteora pool next to SHEEP's live curve ($57k/24h). `pumpMarket()` treated any AMM pool as graduation, so it read volume 0.23 and liquidity 0.64 from the dust pool. That fired the −20 bundle penalty.
- The price change came from the dust pool too (−81% instead of −3%), which could have falsely fired the new price-collapse cap.

**Fix.**
- An AMM pool under $1,000 liquidity that trades less than the live curve is ignored and named in the note. A drained AMM pool next to a dead curve still reads as graduated, so a pulled pool is not hidden.
- Price change now comes from the most-traded pair, on both DexScreener and GeckoTerminal.

**Follow-up.** After the first deploy, GeckoTerminal returned 429 and the pre-fix $0.23 came back as "stale" (the verifier picks the lowest volume). The GeckoTerminal and DexScreener last-good keys now carry a derivation version (`STALE_VERSION` in `lib/stale.ts`), so snapshots computed by the old logic are never served.

**Now.** Volume reads $58.6k. D is set by the wash heuristic ($58k volume against about $500 of curve SOL reserve) and the micro-cap cap ($3.1K FDV). Both come from measured values.

## Tests and LOOP
**New tests:**
- `tests/graduated-curve-pool.test.ts`
- `tests/dust-pool.test.ts` (5 tests, SHEEP's real pool data)

**LOOP results:**

| Check | Result |
|---|---|
| Tests | 505/505 |
| build | ok |
| verify:api | OK |
| stability | OK |
| Playwright | 65/65 (1 flaky on retry: "recent searches chips", unrelated) |
| Fixture matrix vs `1d24y7x4o` | 17/17, same tier |

One earlier full run failed the live microduck check: A locally against B on production. It passed on two reruns, so it was the A/B line moving with the market.

**Build cache.** A corrupt webpack build cache crashed the build both locally and on Vercel (`WasmHash … reading 'length'`). It was fixed by deleting `.next` locally and deploying once with `--force` (no Vercel build cache).

## Side sessions
- The NIKO investigation is done and its worktree removed. An empty folder `.claude/worktrees/graduated-curve-pool` remains, held open by the idle session.
- The Fable advisor (branch `claude/ethereum-and-audit-576c16`) has rebased onto main. It is working on Ethereum mainnet and audit fixes:
  - Monad volume about 75× undercounted;
  - zero-defaults;
  - EVM owner/sim/LP-lock error handling.

  Not merged and not deployed.

# Price-collapse cap (2026-11-20)

**Status:** deployed as `hoodtier-mgjkbxpql` (`dpl_9bgRNTraPZ9R3wKzz28mDa1RWRp9`). `moneymagnet.vercel.app` is re-pointed to it.

## What it does
New gate rule `price_collapse` in `factors.json` caps the tier at **C** when all of these hold:
- the 24h price change is −60% or worse;
- net 24h flow is negative (selling). If net flow is unknown, the rule still applies: a 60% fall is not passed on missing data;
- the pool was not pulled (a pulled pool is already F).

This closes REPORT open item 1. The blind test had GATO (−74%) and WASTED (−62%) at A, where the 4-point trend factor was the only signal. A fall that net buyers are absorbing (a dip) is not capped. Age does not gate the rule. For a pair younger than 24h the window is "since launch (Xh)", and the evidence line says so.

## Data
- New snapshot fields: `priceChange24hPct` and `priceChangeWindow`.
- Sources: DexScreener `priceChange.h24` and GeckoTerminal `price_change_percentage.h24`, both from the main pair, and only when the token is that pair's base.
- Cross-checked in `lib/verify/metrics.ts`. If the two disagree by more than 15% (and more than 5 points), the steepest fall is used.
- If the price change is unknown, the rule shows "not evaluable". It is neither passed nor applied.

## Tests
- New: `tests/price-collapse.test.ts` (8 tests).
- `verify.test.ts`: added a covered conservative-direction case for `priceChange24hPct`. Nothing was weakened.
- Fixture snapshots: only the new rule row was added (pass/unknown). No tier changed.
- **Replaced** (brief item 4): the live `api.integration` microduck test asserted a fixed S/A. microduck's live tier moves with the market and reads B on both the old and new code. It now asserts the same tier as the previous deployment (`PREV_DEPLOYMENT`, default production), queried in parallel. The recorded fixture still asserts S/A.

## LOOP
| Check | Result |
|---|---|
| lint | 0 errors, 2 old warnings in `scripts/` |
| typecheck | ok |
| Tests | 493/493 |
| build | ok |
| verify:api | OK |
| Local stability | OK (B ×3, plus a simulated HoodScan 503) |
| Playwright | 65/65 |
| Production stability | OK |
| Fixture matrix vs `2qvecb2y0` | 17/17, same tier |

Lighthouse was not rerun because no UI changed.

## Sources, nulls, env
- No new sources and no new env vars.
- `priceChange24hPct` is null when neither DexScreener nor GeckoTerminal lists a pair with this token as base. GeckoTerminal returned 429 on some runs today; DexScreener covers those runs.

## Open
- Age-gated penalties (`supply_controlled`, `bot_inflated`, the VOL/MC bar).
- The backtest.
- Two side sessions started at the owner's request:
  - NIKO score-drop investigation (read-only);
  - a Fable-led data audit plus Ethereum mainnet, on its own branch, not deployed.

# Tier hysteresis (2026-11-20)

**Status:** deployed. Commit `3bcbf6d`, deployment `hoodtier-2qvecb2y0` (`dpl_2Szmu96bUoGLFRg1x6StEi6DYaHC`). `moneymagnet.vercel.app` is re-pointed to it.

## What it does
A Schmitt trigger on the score → band step. The previous analysis's tier is kept while the new score sits within **±2** of the line between the two tiers. Config is in `factors.json` → `hysteresis` (`margin` 2, `maxAgeHours` 6); the engine stays generic (`hysteresisHold`).

The hold only applies when **all** of these hold:
- the previous analysis (latest `score_history` entry) was **placed by the score bands**: binding `score` or `hysteresis`. A previous gate, cap, requirement, coverage limit or outage hold never carries over;
- it was in the **same mode** (launch / established);
- it is **≤ 6h old** (the stale limit);
- the two tiers are **adjacent**;
- the new score is within the margin of their shared line.

**Order of operations.** The hold sits before every gate, cap, coverage rule and S/A requirement, so all of them still apply: a held A with a top holder over 20% is still C. If a later rule moves the tier, the hold is dropped from the report.

**Monotone display.**
- Held **up**: the number shows the bottom of the held band (e.g. 70.0), with "raw 69.0" and the reason.
- Held **down**: the number is clamped to the top of the held band (e.g. 69.9), as caps already are.
- A higher displayed score therefore never means a lower tier.

**Shown on the page.** A muted chip under the score: "held near the 70 line · from 20m ago · alone B". "Why this tier" reads "held A: score 69.0 within ±2 of the 70 line; 20m ago it was A".

**Data.**
- `score_history` entries now store the binding kind.
- Entries written before this change have none, so the first analysis after the deploy never holds.

## Why
- microduck flapped A ↔ B on live net flow during yesterday's stability check (score ~70).
- The red team found S ↔ C flips in 18–27% of ±2% noise draws next to the 20% top-holder, $10k FDV and 0.8 VOL/MC lines.
- Hysteresis covers the band lines only. A cap threshold (e.g. 20.00% vs 20.01% top holder) is a rule boundary, which hysteresis deliberately does not override.

## Tests
- +11 in `tests/hysteresis.test.ts`:
  - band math (inside / at / beyond the margin);
  - no hold across two bands, across modes, after 6h, or after a cap / gate / requirement / outage / coverage binding, or to or from U;
  - held up and held down;
  - caps and gates after a hold;
  - monotone display;
  - a 6-step flap damped to one tier;
  - `score_history` round trip.
- No test changed or removed.

## LOOP
| Step | Result |
|---|---|
| lint / typecheck / build | 0 errors (2 old warnings) / ok / ok |
| unit + integration | **484/484** |
| `verify:api` / `verify:stability` (local) | OK / OK (B ×3 + simulated outage) |
| Playwright + axe | **65/65** |
| production stability (`RUNS=3`) | **OK**, B ×3, 6–13s per analysis |
| fixture matrix (production vs `ormpuwloh`) | **17/17** same tier (Kolshi reads D on both deployments today, F yesterday: market) |
| v3 matrix (production) | **15/15** |

## Not covered
- **Playwright and the chip:** no Playwright test renders the hysteresis chip. Fixture pages score without a previous analysis, and adding a test-only path for one muted chip was not worth it. The engine tests cover the logic.

## Env vars
None new. Still missing (names only): `NAD_API_KEY`, `ROBINX_WALLET_KEY` (or `ROBINX_API_KEY`); optional `BASE_RPC_URL`, `MONAD_RPC_URL`, `ROBINHOOD_RPC_URL`.

## Next (from the previous section, still open)
1. A price-collapse / slow-rug cap.
2. Remove the age-gated penalties under 24h (CLAUDE.md "age never penalises").
3. The backtest, once `score_history` has ~30 live tokens per tier.

---

# Logic review + six fixes (2026-11-19)

**Status:** deployed. Commit `ca508ce`, deployment `hoodtier-ormpuwloh` (`dpl_6hSBZ57NTefZn9BtZqvDcJ7xdfCy`). `moneymagnet.vercel.app` is re-pointed to it. This also ships the previous run's team-wallet class and Holder Strength (`568f69e`, which had been committed but not deployed).

## 0. State at the start of the run
- Production was `hoodtier-lkwktssm1` (`dpl_BqbcLRYqvAf1oSXShEPcsJCiuJ9W`, 2026-10-30).
- **(a)** Top-holder classification was deployed.
- **(b)** The team-wallet class and **(c)** Holder Strength were committed but **not** deployed.
- Before deploying, the owner asked to test how good the scoring logic is, using several agents.
- The backtest (task 3) was **held**. `score_history` holds **58 tokens**, all since 2026-10-29, not 3+ weeks. 5–10 live tokens per tier is too few to read win or rug rates (see §1).

## 1. The four-agent review (read-only)
| Agent | What it did | Headline |
|---|---|---|
| Rule audit | Read `factors.json` + the engine against CLAUDE.md, using a scratch simulator | The engine is generic, monotone, weights sum to 100. But safety and concentration inputs **fail open**: concentration could be hidden in contracts or split wallets; Robinhood had no mint check; an unknown LP lock cost nothing. One hard-rule breach: penalties that apply only under 24h. |
| Red team | Built 25+ synthetic tokens and probed sensitivity | 0 monotonicity breaks in 3,668 reports. Eight scam patterns reached **A/S**, including a 99% sell tax, an unlocked LP with launchpad unknown, a 3-minute Robinhood token, a slow rug, unflagged wash trading, a micro-cap of unknown age, and sybil holders. Cliffs: 20.00% → 20.01% top holder goes S → C. |
| Outcome check | Read `score_history` (SELECT only) and took GeckoTerminal/DexScreener outcomes at 24h/72h/now | Dead-at-entry tokens were always F/U. 0 of 8 A tokens rugged. Among *live* tokens, tiers did not separate later rugs (0/2 at 72h, 4/7 by now) or 2× moves. n is 5–10 per tier, and A is confounded with one Monad cohort. |
| Live blind test | Judged 25 real tokens from outside evidence first, then scored them on production (old build) | 13/25 agree. Every rug and dead token got D/F. Misses: ANT (Robinhood) was rated F as a honeypot on ScanHood alone, while our own simulator said sellable. The Robinhood RPC timed out on every call. Crashing tokens were rated A. Some impossible values were shown as live (snipe ratio 100.4%; a "7d" change from 9 minutes of history). |

The agents' scripts and raw output are in the session scratchpad, not the repo.

## 2. The six fixes (owner: "Fix the top 6 first")
1. **Sell tax is a gate** (`sell_tax_50` / `_25` / `_10`):
   - a round trip ≥ 50% forces F, whatever `sellable` says;
   - ≥ 25% caps at D;
   - > 10% caps at B;
   - ≤ 10% is unchanged (the factor already gave full points there).
2. **Unlocked LP with no launchpad proof** (`lp_unlocked_unproven`). LP measured < 50% locked and `isLaunchpad` unknown caps at D.
   - The Base, Monad and Solana adapters never assert `isLaunchpad = false`, so the old `lp_unlocked` gate could not fire there.
   - It uses the same young-only window (< 14 days) that analyze.ts already applies to the Base/Monad LP reading.
   - New S requirement `s_lp`: the LP lock or the launchpad must be proven for tokens < 14 days.
   - Also: `micro_cap` now applies when age is unknown (`orMissing`). It used to fail open.
3. **Robinhood:**
   - `too_early` (U) now covers Robinhood. A 3-minute token with 5 buyers is U, not S.
   - `evm_owner_mint` now covers Robinhood, using a bytecode selector scan (`mint(address,uint256)`, `mint(uint256)`, `mintTo`) plus a live `owner()` (`lib/onchain/mintScan.ts`). A proxy reads null, with the reason.
4. **Hidden concentration:**
   - An unclassified contract in the top 5 now **counts** like a wallet. Only proven pools, vesting, lockers and staking leave the count.
   - Unlisted pools are recognised by `token0()`/`token1()` (new class `pool`).
   - New `top10_50`: the 10 largest counted wallets holding ≥ 50% caps at C. The founder/team/vesting softening the owner chose earlier still applies.
   - New `equal_split`: ≥ 5 of the top-20 wallets within 10% of each other, holding ≥ 15% together, caps at C. It is derived from the holder list, and the evidence line says so.
5. **Robinhood sellability and RPC:**
   - **Our own sell simulations** (`rh-sim`, `base-sim`, `monad-sim`) are on-chain truth for `sellable`, `honeypot` and round-trip loss. A scanner that disagrees is flagged (grey ≠), not obeyed.
   - ScanHood's self-contradicting `sellable=false` (a completed round trip under 50% with no honeypot flag) is **null** with the reason.
   - **Why the Robinhood RPC "timed out" on every call:**
     - Half of all `eth_getLogs` calls went to `rpc-robinhood.globalstake.io`, which takes about 21s per 100k-block range (under 1s on the official RPC). It is now a fallback (`"logs": "fallback"` in `data/rpc-endpoints.json`), and the endpoint pool orders by measured latency.
     - Replay calls are bounded by the time left.
     - The replay gets 8s inside the request plus 20s after the response, and its 1.2 MB state is saved after the response.
     - **microduck's on-chain holder list had been stuck since about 2026-10-23** (20 days, 16M blocks behind) and was served as current. A replay behind the head is now labelled stale (≤ 6h) or not used.
     - Result: a Robinhood analysis takes **14–25s on production**, down from 36–50s.
6. **Unmeasured values → null with the reason:**
   - a liquidity change needs history covering ≥ half its window, or half the token's life for a token younger than the window;
   - a snipe ratio over 100% is null;
   - snipe ratio and dev-buy share from < 10 readable curve buyers are null.

Also fixed: the social cron's `due()` ignored the injected clock, which made `social.test.ts` fail by date.

### Tests replaced (none deleted or weakened)
| Test | Old assertion | New assertion |
|---|---|---|
| `holder-class.test.ts` holder math | unclassified contracts leave the count | they join it; a proven pool leaves |
| `scoring.test.ts` "drops A to B when top-10 ≥ 60%" | B | C via `top10_50`, with the basic requirement still failing beside it |
| `resilience.test.ts` "labels short histories honestly" | 3h of history scored as the 7d change | null with the reason; 96h is labelled; a young token's whole life counts |
| `rpc-pool.test.ts` "at least two with full eth_getLogs" | two full-log endpoints | the official RPC is full; a second log endpoint is a fallback |

New tests:
- **+13** in `tests/logic-fixes.test.ts` (one per hole, reproduced and asserted closed);
- **+2** in `rpc-pool.test.ts` (fallback only while primaries cool down; a slow endpoint goes behind fast ones).

## 3. LOOP
| Step | Result |
|---|---|
| lint / typecheck / build | 0 errors (2 old warnings in untouched scripts) / ok / ok |
| unit + integration | **473/473** |
| scoring snapshots | `fixtures.test.ts.snap`: + the `sell_tax_50` gate row only (tiers and scores unchanged). `v3-fixtures.test.ts.snap`: + `top10_50` in base-rug (F) and the recorded monad-james (D) only. |
| `verify:api` (local prod server) | OK |
| `verify:stability` (local) | first two runs **failed**: microduck sat on the A/B line (net flow moved −4.6% → −8.8% between runs; the old production build read A 70.2 at the same moment). Third run OK (B ×3 plus the simulated outage). |
| Playwright + axe | **65/65** |
| Lighthouse (production) | home 100 · microduck 96 · PEEK 97 · NVDA 100 · BRETT 99 · CHOG 97 |
| production stability (`RUNS=3`) | **OK**, B 64.7 ×3, 14–25s per analysis |
| v3 matrix (production) | **15/15** |
| fixture matrix (production, new vs previous deployment) | 13/17 same tier; the 4 that moved are explained below |
| distributions | **Junk (Robinhood / Solana, `pnpm distribution`, fresh sample):** 0/48 rated A/S (bar ≤ 10%) ✓. But the second clause fails: **3 tokens with FDV < $10k sit above D** (Bao $5.8k B, PIPI $2.3k C, YESNO $2.4k C). All three are 0.2–0.3h old, and CLAUDE.md applies the size floor only to tokens ≥ 1h, so the rule and this check disagree for sub-1h tokens. Not changed: owner decision. 52 of 100 were U (launch tokens whose public sources were rate-limited; no Helius key locally). **Junk (Base / Monad, `v3-distribution.ts`):** 0/18 A/S ✓. **Known-good (`v3-known-good.ts`):** 9/15 A/S = 60% (bar ≥ 30%) ✓. (The GeckoTerminal top-pools 'good' sample in `v3-distribution.ts` reads 0/12 A/S, mostly LP-removed / single-holder pools; that bar is not part of the brief, as in previous runs.) |

### Fixture matrix: new (`ormpuwloh`) vs previous (`lkwktssm1`), scored side by side
| Fixture | Previous | New | Why it moved |
|---|---|---|---|
| microduck | A 70.2 | **B 64.7** | Two changes. The holder list is current again: the old build served a 20-day-old replay. And the largest holder is now a counted **unclassified contract** holding 8.2% (`0x267444d0…`, 1,969 B, Ownable2Step, `onERC721Received`, `factory()`; no lock/vesting/pool signature; HoodScan did not answer). Holder Strength 86 Diamond replaces the accumulator factors. |
| GIGATENEV | C 53.1 | **B 58.2** | Holder Strength 88 (10/10) replaces the accumulators (5.8/8) — the previous run's change, now deployed |
| PONS | C 53.4 | **B 62.2** | Holder Strength is still reading histories (n/a, not counted). The weak accumulator points are gone, so raw rose 66.6 → 72.2 — the previous run's change |
| JAMES | D 39.9 | **C 54.9** | Team wallet (deployer-funded) ≥ 35%, never sold ⇒ C, as the brief expected |
| Kolshi, ELON, UHI, cell, NETANYAHU, PEEK, Pairless, offline, Tolybot, NUZL, YMB, POD | | same | NUZL now also fires `sell_tax_50` beside the honeypot gate |
| NVDA | 422 | 422 | stock token, rejected |

- **Task 4 (fixtures that move with the market):** `scripts/fixture-matrix.mjs` scores every fixture on the new and the previous deployment.
  - Market-moving fixtures assert **same tier as the previous deployment**: microduck, GIGATENEV, Kolshi, PONS, ELON, UHI, JAMES, cell, NETANYAHU.
  - Structural fixtures keep fixed expectations: the F set, and NVDA rejected.

## 4. Sources (this run)
- **ok:** RPC (all chains), DexScreener, GoPlus, nad.fun, HoodScan, Helius (production), the sell simulators.
- **Partial or failing:**
  - GeckoTerminal: 429s on most bursts, served stale where a last-good snapshot exists;
  - ScanHood: intermittent failures (PONS, UHI, YMB);
  - `rh-sim`: ELON (dead pools).
- **HoodScan `get_address`:** did not answer for `0x267444d0…`.

## 5. Still null (new or changed)
- **Robinhood holders:** while a replay is > 6h behind the head (PONS: 10.7% replayed, ~10M logs), holders come from the swap index. On-chain holders are null with the reason.
- **Liquidity change:** null until history covers half its window (or half the token's life).
- **Snipe ratio / dev-buy share:** null when the readable curve history has < 10 buyers.
- **Robinhood `mintAuthority`:** null on upgradeable proxies, with the reason.
- **Unchanged:** fees vs mcap, only-huge-candles, Robinhood wallet age before first buy, Robinhood transfer taxes, contract verified; Solana/Base/Monad social mention counts.

## 6. Env vars
- **New, optional:** `REPLAY_AFTER_MS` (default 20000). `REPLAY_BUDGET_MS` now defaults to 8000.
- **Still missing (names only):**
  - `NAD_API_KEY`;
  - `ROBINX_WALLET_KEY` (or `ROBINX_API_KEY`);
  - optional `BASE_RPC_URL`, `MONAD_RPC_URL`, `ROBINHOOD_RPC_URL` (a private endpoint would remove the last log-endpoint bottleneck).

## 7. Recommended next (not done in this run)
1. **Hysteresis at tier boundaries.** Hold the previous tier unless the score leaves the band by about 2 points, with the displayed score clamped so it stays monotone. Evidence: microduck flapped A↔B on live net flow during the stability check, and the red team found S↔C flips in 18–27% of ±2% noise draws next to the 20% top-holder, $10k FDV and 0.8 VOL/MC lines. This is an owner decision, since a held tier is a display rule.
2. **Price collapse and slow rugs need real weight.** The blind test had GATO (−74%/24h) and WASTED (−62%) at A; the red team had dev-sold 49.9% with liquidity −39% at A. "trend" is worth 4 points. Proposal: a cap at C for a 24h drawdown ≥ 60% with net selling, and a deployer-cluster check on every chain (the team-wallet funding trace already exists).
3. **Remove the age-gated penalties** (`supply_controlled`, `bot_inflated` under 24h; the age-scaled VOL/MC bar). They break CLAUDE.md's "age never penalises" (the same token scores A 74.8 at 23.9h, S 94.8 at 24.1h). Then **run the backtest** once `score_history` has ~30 live tokens per tier. Today's 58 tokens cannot support weight changes.

---

# Team wallets + Holder Strength (2026-10-30)

**Status:** the previous build (top-holder classification, `6fccb4b`) was **deployed**: `vercel --prod --yes` produced `hoodtier-lkwktssm1`, and `moneymagnet.vercel.app` now points to it. The v3 matrix re-run against production reads **15/15**. This run (team wallets + Holder Strength) is committed below and **not deployed yet**. The owner's approval covered the previous build only.

## 1. Team wallet (deployer-funded)

### What changed
- **New holder class `team`** (`lib/topHolders.ts`). A top holder over 20% that is not the deployer becomes a "team wallet (deployer-funded)" when an EOA deployer funded it in either way:
  - **its first tokens came by plain transfer from the deployer.** Checked with the first receipt (archive bisection on Base/Monad, or Transfer logs on Robinhood), and the receipt's tx has no Swap event;
  - **or its first native coin came from the deployer.** Found by archive bisection on `eth_getBalance`, then the plain transfer in that block. An internal call cannot be attributed and is said so.
  - **Solana:** the creator sent its first SOL, or its first tokens by plain transfer, in the wallet's first 100 transactions (Helius).
  - A deployer that is a contract (launchpad / factory) never counts: it funds everyone.
- **Labelling:** each team wallet carries its funding tx. The page line reads "Largest holder: team wallet (deployer-funded), 61.1%, 0 sells in 116d, funded in tx 0x5c96c6…ebeb". The expanded box links the tx on the chain's explorer.
- **Scoring** (`factors.json`), one notch weaker than the deployer's own wallet:
  - `top_holder_35_team` caps at **C** (≥ 35% held, the normal cap is D);
  - `top_holder_20_team` caps at **B** (> 20% held, the normal cap is C).
  - Both need the team wallet to have 0 swap-sells and 0 transfers into a pool / router / contract over its whole history, with the token ≥ 30 days old.
  - Any sell sets `teamSold`. The normal caps then stand, and `team_selling` fires a red con: "Team wallet started selling — red flag".
- **Whole-history reads, resumable:**
  - The founder and team histories now take the cheap archive proofs first (nonce 0, or a nonce unchanged since the first receipt).
  - If those don't settle it, every outbound Transfer log of the wallet is read window by window (`outflowScan`). Stretches where the wallet's nonce did not change are skipped (on JAMES, 87% of the blocks).
  - Progress is saved in KV and continues after the response (`after`) and on the next analysis. Until the read is complete the value is null with the % read, and the normal caps stand.
  - **Limitation:** a sell that a relayer executes for the wallet (its nonce unchanged) inside a skipped stretch is not seen. This is the same assumption as the nonce-unchanged proof from the previous run.
- **Fixed on the way:**
  - `logsRpc`: Monad / Base log endpoints with failover. It reports the primary endpoint's error.
  - RPC timeouts are rounded to whole ms. A fractional timeout made `AbortSignal.timeout` throw "delay out of range", which read as a range error.
  - Cached RPC promises can no longer cause unhandled rejections.

### JAMES `0x43cf…7777`: class and tier
- **61.1% holder `0xf8baf254…3432`:**
  - no code (EOA), nonce 1174;
  - not the deployer (the creation tx was sent by `0x8258cf2e…a10e`; nad.fun's creator is `0xaba951…1544e`).
- **Class: `team` — "team wallet (deployer-funded)".**
  - **Funding:** its first tokens came by plain transfer from `0x8258cf…`, 670M tokens in tx `0x5c96c6a1de542fce420aab5f3955abde5d042ec254f39129d6442b7dc456ebeb` (block 85,821,687).
- **Whole history:**
  - **0** transfers into pools / routers / contracts;
  - **153** transfers to wallets;
  - nad.fun: 3 buys, **0 sells**;
  - 116 days held.
- **Tier: D 39.9 → C 54.9** (binding: "Team wallet holds ≥ 35%, never sold ⇒ C"). The fixture `tests/fixtures/holders/monad-james.json` was re-recorded.
- **Obsolete test, replaced:** `holder-class.test.ts` "the 61.1% holder is an EOA funded by the creation-tx sender, not the deployer: normal caps, D" now asserts the team class, the funding tx and cap C. The e2e JAMES test changed the same way: tier C, `data-class="team"`, and the funding-tx link.
- **Distribution check after this change** (`v3-distribution.ts`): **junk 0% A/S of 26 rated** (bar ≤ 10%). The top-volume sample reads 15% A/S of 13; that bar was not part of the brief.

## 2. Holder Strength

### What it is
A 0–100 score for the top-20 non-LP, non-infrastructure holders, weighted by share (`lib/holderStrength.ts` scores; `lib/holderStrengthData.ts` collects). It gets a label (**Diamond ≥ 80 · Strong 60–79 · Mixed 40–59 · Weak 20–39 · Paper < 20**) and the three biggest contributors as sentences.

| Component | Weight | Measure |
|---|---|---|
| Hold duration | 20 | supply-weighted median of (days since first buy / receipt ÷ token age); full points at ≥ 70% |
| Drawdown survival | 20 | the worst 7-day drawdown from daily candles (the first 72h of launch price discovery is left out): share of the supply held at its peak that never sold during it. A drawdown under 20% is n/a ("nothing to survive"), not missing. |
| Sell discipline | 20 | per wallet: 0 sells over ≥ 30d = 1, under 30d = 0.8; < 25% of the position sold = 0.7; 25–50% = 0.35; > 50% = 0 |
| Wallet maturity | 15 | wallet age before its first buy, plus distinct tokens held. ≥ 90d and ≥ 5 tokens = 1; < 7d and ≤ 1 token = 0. Where the token count is unavailable, age alone counts, and the evidence says so. |
| Dip accumulation | 15 | share of top-20 supply held by wallets that bought ≥ 20% under the prior 7-day high; full at ≥ 30%. A priced trade decides by its price. An unpriced one counts only on a day whose **high** was already ≥ 20% under (provable, never estimated). |
| 0-sell accumulators | 10 | the former `accumulator_count` / `accumulator_supply` factors, now an input here (HoodScan swap index; Robinhood only) |

- **Identity:**
  - a founder or team wallet that never sold, and vesting / locked supply, count as strong (full marks on the per-wallet components). They are named apart as key-person risk ("team wallet (deployer-funded) 61.1%, never sold, 116d").
  - Wallets labelled CEX by the source (GoPlus tag, RugCheck known account) are excluded.
  - A key-person or locked holder can never stand in for the rest. At least 60% of the *other* top-20 supply must have complete histories, or the score is null.
- **Never estimated:**
  - fewer than 3 measurable components, or under half the measurable weight, gives null with every missing component's reason;
  - a still-reading ledger is **pending** (shown "reading holder histories…") and is not counted. It is n/a, so it never lowers coverage.

### Data per chain
| Chain | Holder ledgers | Wallet age / tokens held | Candles |
|---|---|---|---|
| Robinhood | Transfer logs of each wallet, 10M-block windows on the official RPC (one address per query: its OR-filter limit is 100k blocks; 429s back off) | HoodScan `get_trader`: first indexed swap / open positions, labelled as such (no historical RPC state) | GeckoTerminal daily |
| Base / Monad | Transfer logs, OR-filtered by cohort; span adapts to each endpoint's range cap | archive: first block holding native coin. Token count is null: no keyless token-list API (Blockscout sits behind a browser challenge). | GeckoTerminal daily |
| Solana | Helius history of each holder's token account for this mint | Helius first tx; token accounts of both token programs | GeckoTerminal daily |

- Ledgers are saved in KV:
  - EVM: 7 days, resumed;
  - Solana: complete wallets for 2 hours.
- Unfinished reads continue after the response. Inside a request, Holder Strength uses only the request budget actually left (52s minus what `collect` and the classification used). With under 1.5s left, the whole read moves after the response.

### Scoring
- **Established, Robinhood / Solana** (the sets with a holder-conviction group): `holder_strength` is worth **10 points**:
  - `accumulator_count` (4) and `accumulator_supply` (4) are removed, since they are inputs now;
  - `early_retention` drops 4 → 2.
  - The holders group stays at 38.
  - Thresholds: ≥ 80 → 100%, ≥ 60 → 75%, ≥ 40 → 50%, ≥ 20 → 25%, else 0.
- **Base / Monad Established:** information only. Their sets have no conviction group to take points from, so the v3 matrices and fixtures are unchanged.
- **Launch mode (< 72h):** no factor. The tile says "too young to measure".
- **Caps:** when the largest classified top-5 holder is a vesting / locked contract and Holder Strength ≥ 80, `top_holder_35` / `top_holder_20` soften one tier (`*_vesting`: D → C, C → B).
  - **Decision:** the founder / team softening (already specified) is not stacked further by Holder Strength; the "soften by one tier" reading applies to vesting.
  - **Never** when the top holder is an unlabelled wallet (unit-tested at Holder Strength 95 ⇒ still D).

### UI
- A **HOLDER STRENGTH** tile sits beside Age / Price / FDV / Liquidity. It shows the number, the label chip and a 0–100 bar in the severity colours (Diamond / Strong green, Mixed neutral, Weak orange, Paper red). It is an ARIA `meter`.
- **Research view:** the three sentences, key-person holders, every component's evidence and the method.

### Results
- **microduck** (Robinhood, 64d): **81.2 Diamond**. The spec expected Strong/Diamond.
  - median hold 91% of token age;
  - 17 of the top wallets bought the dips (84% of top-20 supply);
  - 11 of 20 never sold;
  - 5 of 10 holders held through the worst 7d drawdown, which reads −88% from daily candle lows, not the −37% in the spec;
  - 0-sell accumulators hold 11.6%;
  - wallet maturity null: HoodScan `get_trader` timed out or failed (it errors on wallets with very many trades).
- **JAMES** (Monad, 116d), recomputed after classification: **66.6 Strong**, information only.
  - key person: "team wallet (deployer-funded) 61.1%, never sold, 116d";
  - the 6 counted wallets all held through the −70% drawdown;
  - 5 of 6 never sold;
  - wallet maturity 0: 3 of them were < 7 days old when they bought;
  - no dip buyers.
  - **Tier stays C 54.9.**
- **Fixtures, before → after** (vitest snapshots re-recorded; the Holder Strength fields were added to the recorded snapshots live on 2026-10-30, the rest stays as recorded, and each file carries `holderStrengthRecordedAt`):

| Fixture | Before | After | Why |
|---|---|---|---|
| microduck (Robinhood, Established) | A 80.4 · raw 77.4 · coverage 100% | **A 80.9** · raw 77.9 · coverage 100% | the accumulator factors (4+4, both full) are replaced by Holder Strength 81 (10/10); early retention 4 → 2 |
| fartcoin (Solana, Established) | B 66.5 · raw 63.5 · coverage 85% | **B 66.5** · raw 63.5 · coverage **74%** | Holder Strength null: "Helius key not set — Solana holder histories need it". The fixture was recorded without Helius; production has the key. |
| offline, peek, pangea-honeypot | F / F / F | unchanged | Launch mode, or gated |
| v3 Base / Monad fixtures | — | unchanged | information only there |

- **Tests replaced or re-baselined** (none deleted or weakened):
  - `stability.test.ts`: the production-flap reproduction keeps its shape (A clean, S with OHLCV down, hold to A). Its numbers move 83.9 / 87.2 → 84.3 / 87.7 with the factor change.
  - `resilience.test.ts`: "stale accumulators" now asserts the stale `accumulatorCount` metric and that the old factor is gone (it is an input to Holder Strength).
  - `v24.test.ts`: the "basics only" weak token now carries a weak Holder Strength (5), alongside its zero accumulators.
  - `helpers.ts`: the perfect snapshot carries Holder Strength 88.
  - +22 new tests in `tests/holder-strength.test.ts`: one synthetic top-20 set per label, drawdown and dip rules, the launch window, n/a vs null, identity / CEX, the key-person coverage guard, scoring, caps, and holder selection.
- **Distribution re-runs:**
  - Robinhood / Solana (`pnpm distribution`): **0% A/S of 65 rated** (bar ≤ 10%); no sub-$10k FDV token above D. 35 U rows were launch tokens whose public sources were rate-limited (and no Helius key locally).
  - Base / Monad (`v3-distribution.ts`, after the team class): **0% A/S of 26 rated**.

### Checks (LOOP)
| Step | Result |
|---|---|
| lint / typecheck / build | 0 errors (2 old warnings in untouched scripts) / ok / ok |
| unit + integration tests | **458/458** (+6 team-wallet / outflow-scan tests in `holder-class.test.ts`; +22 in `holder-strength.test.ts`). `fixtures.test.ts.snap` re-recorded (microduck, fartcoin; table above). `v3-fixtures.test.ts.snap` unchanged. |
| `verify:api` / `verify:stability` | OK / OK (A, incl. simulated HoodScan 503) |
| Playwright | **65/65** (+2: HOLDER STRENGTH tile, label, bar severity, ARIA meter, Research-view sentences, axe AA; Launch-mode "too young to measure") |
| v3 matrix on production (previous build, after deploy) | **15/15** |
| distributions | Robinhood / Solana junk 0% A/S of 65; Base / Monad junk 0% A/S of 26 |

### Still null (new)
- **Wallet maturity — distinct tokens held on Base / Monad:** no keyless token-list API (Blockscout sits behind a browser challenge). Age is scored alone and the evidence says so.
- **Wallet age on Robinhood:** HoodScan's first indexed swap stands in, labelled. It is null when `get_trader` fails (very active wallets).
- **0-sell accumulators outside Robinhood:** needs HoodScan's swap index.
- **Holder Strength on Solana without `HELIUS_API_KEY`:** null, with that reason.
- **Monad ledgers:** public log endpoints cap windows at 10k blocks, so a 4-month token needs several analyses (background reads in between) before its Holder Strength appears. Until then it shows "reading holder histories…" and isn't counted.

### Env vars
- **New, optional:** `HOLDER_STRENGTH_BUDGET_MS` (default 10s, inside the request budget).
- **`HELIUS_API_KEY`:** already set in production; needed for Solana Holder Strength.

### Owner action
- **Deploy this build:** `vercel --prod --yes`, then `vercel alias set <deployment> moneymagnet.vercel.app`, then `BASE=https://moneymagnet.vercel.app node scripts/v3-matrix.mjs`. It was not run, because the approval given covered the previous build.

---

# Top-holder classification fix (2026-10-29, after v3)

**Status:** committed as `6fccb4b`. Deployed on 2026-10-30 with the owner's approval: `hoodtier-lkwktssm1`, aliased to moneymagnet.vercel.app; v3 matrix on production 15/15.

### What changed
1. **Top-5 non-LP holders are classified on every EVM chain** (`lib/onchain/holderClass.ts`, `lib/topHolders.ts`).
   - Pools, registered infrastructure and burn addresses are skipped.
   - Each remaining holder gets `eth_getCode`. A contract is then:
     - probed as a **Safe** (`getThreshold()` + `getOwners()`);
     - resolved through EIP-1167 / EIP-1967 / beacon / Safe proxies;
     - matched against function selectors computed from the published ABIs: Sablier (Lockup v2 and v1), Hedgey, Team Finance, UNCX (vesting and locker), PinkLock, OpenZeppelin VestingWallet, TokenVesting and StakingRewards.
   - **Release schedule:** read where it is exposed. VestingWallet and TokenVesting via `start()`/`duration()`/`cliff()`; Team Finance via `getDepositsByTokenAddress` + `getDepositDetails`. Sablier, Hedgey, UNCX and PinkLock keep per-stream schedules not indexed by token, so they say "not read".
   - **How each class is counted:**
     - vesting / locker / staking contracts are excluded and listed apart with their label;
     - a Safe is **counted** and labelled "treasury (multisig, Safe m/n)";
     - an unclassified contract stays excluded, as before.
   - **Solana:** account-owner programs Streamflow, Jupiter Lock, Bonfida vesting and Squads v3/v4.
   - **Monad-native lockers:** none found. JAMES's two unknown contracts (19 KB and 4 KB) match no signature.
2. **Founder softening** (`lib/scoring/factors.json`). It applies when all of these hold:
   - the largest counted holder is an EOA equal to the deployer / creator (any source's deployer, plus the creation-tx sender read from archive state);
   - the token is ≥ 30 days old;
   - that wallet's **whole** history shows 0 swap-sells and 0 transfers into a pool / router / contract.

   Then:
   - `top_holder_35` (D) gives way to `top_holder_35_founder` (**B**): "Founder holds X%, never sold in Nd — key-person risk".
   - `top_holder_20` (C) gives way to `top_holder_20_founder` (**A**).
   - Any sell sets `founderSold`, so the normal caps stand and `founder_selling` fires: a red con, "Founder started selling — red flag".
   - A history that cannot be fully read (budget, too many outflows, no archive) is null, and the normal caps stand.
   - **History sources per chain:**
     - Robinhood: the deployer's Transfer-log flows;
     - Base / Monad: archive state. The nonce test comes first; a balance-change bisection reads every outflow block. Monad also uses nad.fun's per-account swap history.
     - Solana: the creator's whole Helius history when under 100 transactions.
3. **Page:** a "Largest holder: …" line above the excluded-supply list. Opening it shows the evidence and the other classified top-5 rows. Excluded rows now show their label.
4. **Budget:** `HOLDER_CLASS_BUDGET_MS` (default 12s, at least 5s even when the sources used the whole 45s budget). It runs on a copy, so a timeout applies nothing and the normal caps stand. Measured cost: Base/Monad +0.7–3.5s; Robinhood fits in 5s.

### JAMES `0x43cf5407bda1400498b8064d50a7e17528d87777` (Monad)
- **The 61.1% holder is `0xf8baf2541defab76f2c344ff10cd6d4ef74d3432`:**
  - no code (EOA), nonce 1174;
  - no signature or label match;
  - nad.fun nickname "james.nad".
- **Not the deployer:**
  - nad.fun's creator is `0xaba951…1544e` (nonce 2, no swaps);
  - the creation tx (block 85,819,844, 385k MON dev buy of 884.8M tokens) was sent by `0x8258cf2e…a10e`;
  - `0x8258cf` sent james.nad **670M tokens** 12 minutes after launch (block 85,821,687).
- **Sell history:**
  - nad.fun: 3 buys, **0 sells**;
  - archive scan: **151 outbound transfers** (59.3M tokens, 5.9% of supply) to 147 wallets (74 EOAs, 73 EIP-7702 wallets), **0 to pools / routers / contracts**.
- **The rest of the top 5:**
  - two **Safe 6/8** multisigs, 1.5% each, now counted (top-10 64.2% → 67.2%);
  - two unclassified contracts, excluded.
- **Page line:** "Largest holder: wallet funded by the deployer, 61.1%".
- **Tier:** **D 39.9**. The founder rule needs holder == deployer, and here it is a deployer-funded wallet. Every other condition holds (≥ 30 days, 0 swap-sells, no pool transfers). The recorded fixture `tests/fixtures/holders/monad-james.json` shows the same snapshot would be capped at B if that wallet were the deployer.
- **Decision for you:** treat a wallet funded directly by the deployer as the founder. That is a one-line change in `lib/topHolders.ts`, and I left it strict as specified.

### Checks
| Step | Result |
|---|---|
| lint / typecheck / build | 0 errors (2 old warnings) / ok / ok |
| unit tests | **426/426** (+17 in `tests/holder-class.test.ts`). The live microduck integration test passes again (A). |
| snapshots | `fixtures.test.ts.snap` and `v3-fixtures.test.ts.snap` unchanged (no new rule fires on any recorded fixture) |
| `verify:api` / `verify:stability` | OK / OK (B 68.9, incl. simulated HoodScan 503) |
| Playwright | **63/63** (+1: JAMES line, evidence, classified rows, axe AA) |
| v3 matrix (local prod build) | **15/15**, JAMES D as before |
| v2.4 matrix (local prod build) | **13/15**. Kolshi C and NETANYAHU D are identical on the current production (old code): market moves. |
| junk distribution (`v3-distribution.ts`) | **0% A/S of 26 rated** (bar ≤ 10%). The GeckoTerminal "top pools" sample reads 7% A/S of 14, from mostly non-meme / LP-unlocked pools as in v3 §1.7; that bar was not part of this brief. |
| live scan (28 tokens, 4 chains) | Safes found on BRETT (2/4), TYBG (2/4), DEGEN (23.7%, 2/3, F anyway), PONS (2/5). No live token has a deployer holding > 20%. The founder path is covered by unit tests plus live archive runs on NORMIE (Base) and MOLANDAK (Monad) deployers: both active wallets, so the history comes back "incomplete", never "never sold". |

### Still null (new)
- **Founder sell history:** null when the wallet has more outflows than the call budget reads (stated as the reason), or on Solana when the creator has ≥ 100 transactions.
- **Per-stream unlock dates** (Sablier, Hedgey, UNCX, PinkLock).
- **Monad-native lockers:** none identified.

### Env vars
- **New, optional:** `HOLDER_CLASS_BUDGET_MS`.
- **Archive endpoints:** Base uses `mainnet.base.org`, Tenderly and dRPC (probed today; publicnode needs a token for archive state). Monad uses rpc2 and Originstake. `BASE_RPC_URL` / `MONAD_RPC_URL` go first when set.

### Owner action
- **Deploy:** `vercel --prod --yes`, then `vercel alias set <deployment> moneymagnet.vercel.app`, then re-run `BASE=https://moneymagnet.vercel.app node scripts/v3-matrix.mjs`.

---

# MoneyMagnet v3 — Build Report (2026-10-29)

**Production:** https://moneymagnet.vercel.app (alias re-pointed to `hoodtier-djqef87nn`, commit `d1bb990`; v3 matrix re-run on it: 15/15) · https://hoodtier.vercel.app 308-redirects to it. The previous report (stability fix, canonical host) is in git at `5e4f3ed`.

This run covered three briefs, in order:
1. **v3:** Base and Monad, error UX, the deep-research CTA, and pros/cons (§1–§5 below).
2. **Social panel.**
3. **Social stage:** lifecycle 0–5 with size and quality.

Briefs 2 and 3 were built as one panel, since the second builds on the first (§6).

**Robinhood / Solana scoring is untouched:**
- `tests/__snapshots__/fixtures.test.ts.snap` is byte-identical (no diff).
- The Base/Monad fixtures have their own snapshot file.
- The four old production-matrix rows that moved behave exactly the same on the previous deployment (§1.6), so the moves are the market, not this code.

## LOOP (final)

| Step | Result |
|---|---|
| lint | 0 errors (2 old warnings in `scripts/`) |
| typecheck | ok |
| unit tests | **408/409** (27 files; +57 new: chain detection, Base/Monad sets, fixtures, budget/slow source, pros/cons, CTA, social). The one failure is the **live** `api.integration` microduck test expecting A/S: microduck reads B live, and the same B on the old deployment (§1.6). It passed in an earlier full run today; it was not changed. |
| snapshot | Robinhood/Solana snapshot byte-identical |
| build | ok |
| `verify:api` | ok. 6 tokens, now incl. BRETT (Base) and CHOG (Monad) resolved from a bare 0x. Warm page renders server-side, cold page renders the live loader. |
| `verify:stability` | local OK (B 68.9 ×2 and B 68.9 under a simulated HoodScan 503); production OK (B 69.9 ×3, slowest cold run 45.7 s < 60 s) |
| Playwright | **62/62**, incl. axe |
| Lighthouse (mobile, warm) | home 99 · microduck 96 · PEEK 97 · NVDA 98 · BRETT (Base) 97 · CHOG (Monad) 97; a11y / best practices / SEO 100 everywhere |
| deploy | `vercel --prod --yes`, then `vercel alias set … moneymagnet.vercel.app` |
| v3 production matrix | **15/15** (§1.5) |
| old Robinhood/Solana production matrix | **11/15**. The 4 misses are market moves, proven on the old deployment (§1.6). |

**Commits** (one per section):
- `636d1e4` §2
- `224f52e` §3–4
- `8ae0e20` social
- `b1c29ed` §1
- `6ee603b` budget / refusals / raw data / Lighthouse harness
- a final commit with the cron-cost cap, the quality guard and this report

The sections share `lib/analyze.ts`, `components/Report.tsx` and the page, so the first four commits do not each build on their own; the head does.

---

## 1. Base (8453) and Monad (143)

### 1.1 Chain detection (§1a)
- **Resolver.** `/t/auto/<0x…>` asks each EVM RPC for bytecode and `totalSupply()`, and DexScreener for pairs on each chain (`lib/resolveChain.ts`, cached 10 min).
  - One chain has the token: redirect to `/t/<chain>/<ca>`.
  - Several chains: the **chain picker**, with each chain's FDV, pair count and liquidity.
  - No chain: the old default (Robinhood Chain), which then says "no contract code".
- **Home form.** It has a chain selector (Auto / Robinhood Chain / Base / Monad). It defaults to Auto, which goes through `/t/auto/`.
- **API.**
  - `POST /api/analyze` and `/api/tier` accept an optional `chain`.
  - A bare 0x on more than one chain answers `300` with the candidates.
  - `/api/checks` honours `chain`; before this, Base and Monad manual checks would have been rejected.
- **Live picker case:** USDe `0x5d3a…ef34` is an ERC-20 on all three chains. The picker shows Robinhood $367M, Base $353M, and Monad with no pairs.

### 1.2 Sources per chain
Full tables, with every endpoint called, response keys, the field mapping and limits: `docs/chains/base.md` and `docs/chains/monad.md`.

| Source | Base | Monad | Auth | Observed limit | Fills |
|---|---|---|---|---|---|
| GoPlus `token_security/<id>` | ✓ | ✓ | none | ~10 calls per burst, then HTTP 200 with `code 4029`; clears within 60 s | honeypot **claim**, mintable, open source, proxy, owner (Base only), creator + creator % (Base only), top-10 holders (contracts and locked balances excluded), holder count, LP-lock share |
| `<chain>` RPC (pools in `data/<chain>-rpc-endpoints.json`) | ✓ | ✓ | none (`BASE_RPC_URL` / `MONAD_RPC_URL` optional) | Base: `mainnet.base.org` 429s every `eth_getLogs`, publicnode serves 50k-block logs. Monad: logs ≤ 10k blocks (rpc2), 0.3 s blocks. | code, supply, decimals, name/symbol, owner, ERC-1967 proxy / EIP-1167 clone, deployer balance |
| Our sell sim (`lib/sources/evmSim.ts`) | ✓ | ✓ | — | RPC | sellable, honeypot, round-trip loss, liquidity pulled |
| DexScreener (`base` / `monad`) | ✓ | ✓ | none | 60 concurrent OK | pairs, liquidity, FDV, volume, tx counts, socials, boosts |
| GeckoTerminal (`base` / `monad`) | ✓ | ✓ | none | **429 after ~30 calls/min**, for 3–15 min | pools, per-pool buyers/sellers, OHLCV chart patterns. A 404 on Base/Monad = "not indexed" (an answer). |
| nad.fun agent API | — | ✓ | `NAD_API_KEY` optional | **10 req/min keyless** (100 with key) | launchpad, creation time (the token's own, not a pool's), creator, holders, 24h makers / flow / tx counts, creator swaps (dev sold, swaps only), candles for curve tokens |
| Basescan = Etherscan v2 `chainid=8453` | ✓ | — | `BASESCAN_API_KEY`: **a paid Etherscan plan** (free answers "Free API access is not supported for this chain") | — | creator, creation time, verified. **Not exercised:** no key. |
| Base launch signals (`lib/sources/base.ts`) | ✓ | — | — | RPC | launchpad, from the v4 pool hook (`PositionManager.poolKeys`), the token's own `getPoolKey()` (Zora), Flaunch `flaunch()`, Virtuals Bonding as `owner()`, Doppler `Airlock.getAssetData` |

- **Scanners on Monad.** GoPlus supports chain 143, but for nad.fun **curve** tokens it returns holders only, with no honeypot verdict. honeypot.is answers "Invalid chain" and RugCheck is Solana-only.
- **The page says so.** For a curve token the Sources row reads *"only sellability source for this curve token (no scanner covers it)"*.

### 1.3 Factor sets (§1c)
Four new sets, `launch_base`, `established_base`, `launch_monad` and `established_monad`, are generated from the existing factor definitions:
- same thresholds, evidence and guide notes;
- `data` points at the chain's adapters;
- factors no source on the chain fills are **absent**;
- all total 100, safety = gate-only basics (0 points), guide weight ≥ 60% in both launch sets.

| Set | Groups |
|---|---|
| launch_base | launch 40 (vol_mc, launch_retrace, chart_identical, chart_staircase) · holders 30 (top_holder, top10) · flow 30 (buyer/seller, sells, trend, round trip) |
| established_base | holders 30 (top10, top_holder, deployer_holding) · flow 28 (buyer/seller, trades/wallet, round trip) · liquidity 42 |
| launch_monad | launch 40 · holders 32 (top_holder, top10, holders_vs_makers, deployer_sold) · flow 28 (+ unique buyers, net flow) |
| established_monad | holders 34 (+ deployer_sold) · flow 26 (net flow, buyer/seller, round trip) · liquidity 40 |

**Same rules as Robinhood/Solana.** Size floor, wash cap, zero-is-data, the dead-launch gate, dev-sold from swaps only (nad.fun creator swaps), honeypot / liquidity-pulled / owner / proxy gates, and too-early U.

**One new rule, `evm_owner_mint`:**
- GoPlus `is_mintable` with a live owner forces F.
- Solana's `mint_enabled` gate was not extended to EVM: `is_mintable` only says a mint function exists, and with a renounced owner nobody can call it.

**S is out of reach on Base/Monad.** The S requirement "3+ multi-buy 0-sell accumulators" needs a swap index neither chain has. A clean token tops out at A.

### 1.4 Infrastructure registries
- `data/base-infra.json` has **86 entries**:
  - Uniswap v2/v3/v4 (PoolManager, PositionManager, V4Quoter, StateView);
  - Aerodrome, Slipstream and 3 more CL factories;
  - PancakeSwap v3 and minor DEXs;
  - Clanker v1–v4 factories, hooks and LP lockers;
  - Zora factory and hook; Doppler Airlock and initializers; Flaunch; Virtuals v1/v2; the b2-vanity launchpad;
  - UNCX lockers, the ERC-4337 EntryPoints, the quote tokens and the blue chips.
- `data/monad-infra.json` has **44 entries**: Uniswap v2/v3/v4 (native V4Quoter), PancakeSwap v3, LFJ and 7 small DEX factories, nad.fun V1 + V2 (curves, routers, Lens, pair factory, vaults), Kuru, WMON and USDC.
- Each entry says how it was identified: code size, plus a call, a log or a transaction proving its role.
- **No LP locker was verified on Monad.** nad.fun's graduated LP sits in an owner-controlled contract, which is not a lock.

### 1.5 Sell simulation (§1b) and fixtures (§1d)
**Sell sim** (`lib/sources/evmSim.ts`): transfer probe → per-pool round trip → nad.fun router sell → verdict.
1. **Transfer probe:** a real holder's `transfer(fresh, ½ balance)`.
2. **Per pool**, highest liquidity first, at most 6:
   - **v4:** the deployed V4Quoter does a buy and then a sell. The pool key comes from `PositionManager.poolKeys(bytes25)`, or the token's own `getPoolKey()` when that hashes to the pool id (Zora).
   - **v2 / v3:** reserves and slot0 math (`robinhoodSim` helpers).
3. **Monad nad.fun:** the router's **real `sell(...)` runs inside `eth_call`**, with the fresh wallet's balance and allowance set by state override. The slots come from `eth_createAccessList`, after a Lens or router buy quote.
4. **"No liquidity" reverts count as dry, not honeypot:** `SPL`, `NotEnoughLiquidity`, `Panic 0x11` on an empty curve and `INSUFFICIENT_*`.
5. **Verdict:** `verdictOf` (sellable = some pool round-trips with < 50% loss).

**Fixtures,** picked live 2026-10-29 (`tests/fixtures/v3/*.json`, why each was picked in `docs/chains/<chain>-fixtures.json`):

| Chain | Token | Kind | Recorded | Production (fresh) |
|---|---|---|---|---|
| Base | BRETT `0x532f…42e4` | established | B 68 | ✓ B 68 · cov 100% |
| Base | TOSHI `0xac1b…b2b4` | established | B 68.7 | ✓ B 68.7 · cov 100% |
| Base | 99 `0xd44b…4619` (Clanker v4, via a wrapper) | launch | C 45.1 | ✓ C 45.1 |
| Base | ADFO `0xf57b…9a82` (Zora) | launch | D 28 | ✓ D 28 |
| Base | 小小徐 `0x5ad1…6b07` (LP burned, $220k pulled) | rug | F | ✓ F, liquidity removed. Indexers still show $2.04M; the sim finds every pool dry. |
| Monad | CHOG `0x3500…7777` | established | A 76.3 | ✓ A 76.3 · cov 100% |
| Monad | JAMES `0x43cf…7777` | established | D 39.9 (one EOA holds 61%) | ✓ D 39.9 |
| Monad | Vibe `0x4c99…7777` (nad.fun V2 curve) | launch | F (dust cap, FDV $1.4k) | ✓ F |
| Monad | PERPL `0xb47f…7777` | launch | F (dust) | ✓ F |
| Monad | NAD `0x47c6…7777` | rug | F | ✓ F, liquidity removed |
| Base / Monad | USDC, WETH / WMON, USDC | blue chip | — | ✓ all four 422 |
| all | USDe | dual-chain | — | ✓ 300 + picker |

**Production matrix: `scripts/v3-matrix.mjs` = 15/15.** The bars:
- established tokens must be rated (not F/U) with ≥ 60% coverage;
- launches must answer;
- rugs must be F; blue chips 422; the dual-chain token 300.

**Distribution:** see §1.7.

### 1.6 The Robinhood/Solana matrix still holds
`scripts/v24-matrix.mjs` on production is 11/15. The 4 misses re-run identically on the **previous deployment** (`hoodtier-d7d9orvyf`, old code):

| Token | Old deployment | New deployment | Cause |
|---|---|---|---|
| microduck | B 65.8 | B 69.9 | market: 24h buyer/seller 0.35×, smart money −$23k |
| GIGATENEV | A 84.7 | A 84.7 | wash cap fired on one run, not on the next (live heuristic) |
| Kolshi | C 54.8 | C 54.8 | FDV fell to $13k |
| NETANYAHU | D 39.9 | D 39.9 | micro-cap: FDV $3.2k |

The live `api.integration` microduck test expects A/S. It passed in one full run today and failed in the final one with B, the same B production gives on the old code. It was not changed: the market moved, not the scoring.

### 1.7 Distribution check (junk ≤ 10% A/S, known-good ≥ 30% A/S)
**Junk** (`scripts/v3-distribution.ts`): the newest GeckoTerminal pools, 20 per chain.
- **0% A/S of 31 rated** (Base 0/15, Monad 0/16). Bar ≤ 10%: ✓.
- **Unrated:** 6 rows were U because GeckoTerminal 429s took ≥ 40% of the weight. That is the existing outage rule.

**Known-good, curated** (`scripts/v3-known-good.ts`): well-known memes, ≥ $25k liquidity, ≥ 72h, addresses picked live from DexScreener. **8/15 A/S = 53%.** Bar ≥ 30%: ✓.

| Chain | A/S | A | B | Other |
|---|---|---|---|---|
| Base | 5/10 | KEYCAT, SKI, doginme, BENJI, NORMIE | BRETT, TOSHI, MIGGLES, TYBG | DEGEN **F**: `evm_owner_mint`, GoPlus mintable + live owner |
| Monad | 3/5 | CHOG, MOLANDAK, shramp | emo | JAMES **D**: one wallet holds 61% |

**The first known-good attempt failed and found two bugs, both fixed:**
- **The sample itself.** It took GeckoTerminal's top-volume pools: 9% A/S, mostly DeFi and wash tokens.
- **Bug 1: `isLaunchpad = false` from nad.fun's "not my token".** That is an assumption, since another launchpad may have made it, and it fired "LP unlocked (non-launchpad) ⇒ F" on Monad tokens. It is now null with the reason.
- **Bug 2: LP lock at every age.** GoPlus's LP lock was applied to tokens of any age, while Robinhood checks LP lock only under 14 days (guide p.16-18). Base/Monad now match.

The per-token rows are in `docs/chains/v3-distribution.json` (junk + the top-volume sample).

### 1.8 Fields per chain

**Filled on both:**
- supply, owner / proxy, top-10 concentration (GoPlus), holder count, honeypot claim + own sim, round-trip loss;
- liquidity / FDV / volume / pools, buyers/sellers (per-pool rule as before), chart patterns, liquidity history, deployer holding.

**Filled on Monad only:**
- nad.fun creation time / creator / launchpad;
- 24h makers, net flow, dev sold (creator swaps), curve candles.

**Permanently null on Base/Monad, and why:**
- **Solana / pump.fun-only fields:**
  - `freezeAuthority` — an SPL concept.
  - `feesSol`, `realSolReserves`, `curveCirculatingPct`, `devBuySol` — pump.fun-specific.
  - `bundleScore`, `organicScore`, `snipeRatioPct`, `timingEntropy`, `bundlerMajority` — from the pump.fun intel feed, which has no EVM equivalent.
- **Need an address index or swap index, which neither chain has:**
  - `fundingClusterMax` / `clusterSupplyPct` — need an address index; native-ETH funding is invisible on public RPCs.
  - `freshWalletsTop20` — GoPlus lists only the top 10; a top-20 count would be a guess.
  - `accumulator*`, `earlyRetention*`, `bundlersFlushed`, `smartMoney*`, `creatorPriorMints` / `creatorRugRatePct` — no swap index or labelled-wallet source.
- **Not read within the rate limits:**
  - `devBuySharePct`, `first5mSharePct`, `bundleSharePct`, `repeatedSizeSharePct` — feasible from launch-window logs, but not read within the request budget / nad.fun 10 req/min.
- **Not stated / no source:**
  - Monad curve liquidity — nad.fun's reserve fields are not documented as real reserves, so it is not stated.
  - `lpLockedPct` on Monad — no verifiable locker.
  - Time Machine — no Base/Monad archetypes.
- **Base launchpad** is null when no hook or view matched: the creation tx isn't read, because `tx.to` is a wrapper or a 4337 EntryPoint.

**Could not be sourced for Monad:**
- Etherscan v2 / Monadscan and BlockVision responses (both need keys).
- Socialscan (no API) and Routescan (unsupported).
- A honeypot.is-style scanner.
- Crystal and Bean (no liquidity found).
- A PancakeSwap v3 quoter (slot0 math is used).
- The nad.fun V2 curve ABI.
- An LP locker.
- A swap index with full per-wallet history.

## 2. Error UX and root causes (§2)
- **The data call runs in the browser.** A cold result page's analysis is fetched by the browser (`components/LiveReport.tsx`); a warm page (memory, or the shared KV under 2 min) renders server-side.
- **Every failure shows the ERR state** (`components/ErrorState.tsx`): a big **ERR**, one plain cause, **Retry**, and an error id. Failures covered: 504/408, other 5xx, a network error or blocked call, a cut-off or unparsable JSON body, a 200 without a tier, and any render exception (`app/error.tsx`).
  - **The second failure within 2 minutes** (sessionStorage) adds *"Still failing? Try a different browser or disable extensions — ad/tracker blockers can block the data calls."*
- **Error id format:**
  - `MM-XXXXXX`: 6 Crockford base32 characters (no I/L/O/U), e.g. `MM-7KQ2XD`. A Next render error shows `MM-D<digest>`.
  - Server failures log `[MM-…] where: message`. Browser-side failures are logged by `POST /api/client-error` (best effort; a blocker may drop it too).
- **Root causes:**
  - **One analysis budget.** `collect()` stops waiting at **45 s** (`ANALYSIS_BUDGET_MS`), with per-source caps (`lib/budget.ts`: 30 s default, 35 s HoodScan / RPC / Helius). A source past its cap is `failed` with the reason and served stale when it can be.
  - **The whole request fits 52 s**, with `maxDuration = 60` on the page, `/api/analyze` and `/api/tier`. The Time Machine and the social panel share whatever is left, and RobinX runs beside `collect()`.
  - **Partial JSON renders.** `lib/normalizeReport.ts` fills missing lists and maps with empties and never invents a number. A report without a tier shows ERR with "missing parts".
  - **Tested** with a mocked never-answering DexScreener (`tests/v3-budget.test.ts`): `collect` returns in < 4 s on a 1.5 s budget, with DexScreener `failed: timed out: … budget`.
- **Playwright:**
  - mocked 504 twice ⇒ cause, Retry, id, and the hint after the second failure;
  - a blocked call, then a cut-off JSON body;
  - a 500 that carries the server's id.

## 3. Deep-research CTA and research view (§3)
- **Tier ≥ B:** a neon panel, *"This one is worth a closer look"*, with **Deep research →**. It switches to the Research view, which the toggle follows, and scrolls to Verification.
- **Below B:** *"Not worth deeper research at this score — <binding constraint>"*.
- **The Research view adds,** all from data already fetched:
  - **top-20 holders** (address, %, buys/sells, first seen, cluster tag). On Robinhood/Base/Monad, first seen says why it's empty: no address index.
  - **the deployer line:** holding, sold in swaps, handed out, prior mints, or each value's null reason.
  - **every pool with its liquidity:** GeckoTerminal + DexScreener; when both list a pool, the lower reading.
  - **the cluster summary.**
- **Raw data** now loads when opened (`/api/raw`, from the 2-minute cache). It was 115 KB of page HTML, duplicated in the RSC payload.

## 4. Pros / cons (§4)
- **Source:** `components/prosCons.ts`, 2–4 bullets per column, ≤ 12 words, deterministic, no LLM.
  - **Pros:** the top-scoring factors (most points first), then fair ones, then passed checks.
  - **Cons:** fired gates, caps and forced tiers (red), coverage binding (red), penalties, disputes that change the **tier** (`tierMovingDisputes`), then the lowest factors (orange).
- **Tested:**
  - two runs give equal output on every fixture;
  - every bullet is ≤ 12 words and each column has 2–4;
  - red is used only for gates / caps;
  - Playwright: same text on two loads.

## 5. Checks
See LOOP above.

**Tests replaced** (none deleted or weakened):
- `e2e/smoke.spec.ts` "Detected: Robinhood Chain" is now "Detected: EVM (Robinhood Chain / Base / Monad — checked on each)", because a 0x address is no longer Robinhood-only (§1a).
- `scripts/verify-api.mjs`'s page check now asserts both paths: a warm page server-renders the tier, and a cold page renders the live loader.
- The 390px raw-data overflow test now waits for the lazily loaded JSON before measuring. That makes it stricter.

**Lighthouse harness fixes:**
- The warm-up now runs a fresh API analysis.
- It retries once: the pooled keep-alive socket dies during the blocking Lighthouse run, so before this fix every warm-up "fetch failed" and pages were measured cold.
- It logs whether each page was really server-rendered.

**Cold first visits:** a cold first visit (loader, then the data call) measured 91–94 locally. The scores above are warm.

## 6. Social panel, lifecycle stage, size and quality (information only, no score effect)

### 6.1 Sources, in order, as built
| Source | Result |
|---|---|
| three.ws `social_cashtag_sentiment` / `social_x_post_impact` | Keyless, but **supplies nothing per CA.** The sentiment tool *scores post text you pass in* (tested; it works). The impact tool needs one X post URL and a **Solana curve mint**; an EVM CA is rejected (`invalid mint`, tested). No source here supplies post text, so **sentiment is null** with that reason. |
| RobinX (api.robinx.io, x402 USDC on Base) | **Robinhood Chain only** (its Solana and Base records were retired 2026-10-09). The free `/report?tier=free` (25/day per IP) gives 24h mentions, the first mention and the earliest 10 callers (handle, followers, coordinated-cluster flag). Paid, only with `ROBINX_WALLET_KEY` (x402) or `ROBINX_API_KEY`: `/mentions` $0.02 (24h unique posters, reach) and `/tg/first-call` $0.03 (Telegram vs X). The paid `/report` ($0.05) is used only when the free quota is spent. **Cap: $0.05 per analysis** (tested: never exceeded); cached 10 min. The x402 signer is tested by signature recovery; **no paid call was made in this run.** |
| DexScreener / GeckoTerminal | official X / Telegram / website / X-community links; DexScreener `boosts.active` |
| Our series | Postgres `social_series` + `social_tokens` (KV fallback locally): one sample per analysis, kept 30 days |

**Which source answered:**

| Token | Answered | Values | Null, and why |
|---|---|---|---|
| **microduck** (Robinhood) | RobinX free report + DexScreener/Gecko links | 31 posts/24h; top 5 by followers among the earliest 10 callers (biggalordTE 230k, bankrbot 115k, 0xBackwards 97k, CryptoWhales_X 78k, OrdzWorld 24k); first call 2,377 min after launch; Stage 1 · S1 · quality 86 | unique posters / reach (paid, no key) |
| **a fresh pump.fun mint** (`8eQR…pump`) | links only | — | every post field, with "no source measures X posts for solana tokens" |
| **a Base token** (BRETT) | links only | — | every post field, same reason |

**Guide rules, as warnings only:**
- the earliest post is older than the launch (guide p.43);
- Telegram call channels carried it before X (RobinX first-call, ≥ 3 rooms; guide p.37);
- ≥ 50% of the measured early callers are coordinated (p.37);
- paid boosts.

The brief cites p.47 and p.105–107; the guide pages present in `factors.json` for these rules are p.37/43/48, and p.105–107 are not in the repo.

### 6.2 Stage, size, quality (`lib/social/stage.ts`)
- **Stage 0–5:** the brief's rules, on M = unique posters per 24h (else posts), smoothed over 3 samples. Windows are −6h / −24h / −72h. Stage 3 held under 12h is "3 (early)".
  - **Age-aware:** a token < 2h old with M ≥ 50 is Stage 2.
  - **Early read:** fewer than 3 samples is tagged "early read", with no slope arrows.
  - **Rule gaps** take the nearest stage, and the panel says "nearest".
- **Size:** S1 < 50 · S2 50–300 · S3 300–2,000 · S4 > 2,000.
- **Quality 0–100** over the parts with data:
  - > 1k-follower share 25, bot share 20, not flat-positive 10, X community 10, no pre-launch posts 15, no call-channel pattern 15, no boosts 5;
  - **null unless at least 2 parts, including one poster-based part, have data** (links alone are not a quality).
- **Badge and verdict:** e.g. "Stage 3 · S3 · quality 72 — strong, holding for 3 days", and a ≤ 14-word verdict ("Plateau, but tiny — nobody new is arriving" for 3 at S1).
- **Time Machine line:** winners vs rugs at the token's age, plus the nearest archetype by stage-sequence edit distance.
  - It is **null today:** no archetype has social history, because no source exposes past post counts.
  - The library (`tm:social:v1`) is rebuilt from our own series by the social cron.
- **score_history** now records stage / early / size / quality beside the tier (`appendScore` now runs per analysis; it was unused before).

### 6.3 Cron
- **What it does:** `/api/cron/social` re-samples tokens analysed in the last 7 days, oldest-sampled first, **≤ 300 per run**, within 240 s. It stops after 5 tokens in a row without an answer (a spent free quota) and prunes samples older than 30 days.
- **Cost per run:**
  - **$0 with the free tier.** RobinX's free 25/day per IP is shared with analyses, so a run stores at most what that quota allows.
  - **With a wallet:** at most $0.02 per token (the mention tape, only when the free report fails), capped by `SOCIAL_CRON_MAX_USD` (default **$1.00 per run**).
- **Schedule:** **Vercel Hobby allows daily crons only**, so `vercel.json` runs it at 06:15 UTC. The 30-minute cadence needs Vercel Pro or an external scheduler calling it with `Authorization: Bearer $CRON_SECRET`.
- **Tested:** a dry run stores samples, 300 is the cap, tokens over 7 days old are skipped, and the run stops early.

### 6.4 Backtest
- `pnpm backtest:social` refuses to conclude before 14 days of series and 20 group observations.
- **Today:** series started 2026-10-29, so no conclusion and no points proposed. Re-run on or after 2026-11-12.

### 6.5 Playwright
The panel renders in three states:
- all sources null (no stage, the reason shown);
- early read (1 sample, tag, no arrow);
- full series (dial lit, sparkline, badge).

## Sources (final runs)
- **ok:**
  - Robinhood: HoodScan, ScanHood, Robinhood RPC, rh-sim, DexScreener;
  - Solana: RugCheck, Helius, Solana RPC, Jupiter, pump.fun feed;
  - Base/Monad: GoPlus, Base/Monad RPC, our sell sims, nad.fun, DexScreener;
  - RobinX free report.
- **partial / failed, with reasons:**
  - **GeckoTerminal:** 429 under bursts (OHLCV served stale ≤ 6h, else null with the 429 reason).
  - **nad.fun:** 429 at 10 req/min keyless (served stale ≤ 6h).
  - **Basescan:** skipped (no key; Base needs a paid Etherscan plan).
  - **Base launch signals:** partial for tokens with no registered hook / view (BRETT, TOSHI).
  - **three.ws social:** skipped (no per-CA post source).
  - **RobinX:** skipped off Robinhood Chain; its paid calls are skipped without a key.

## Still null
- **Unchanged:** cell trend · Pairless chart patterns · Robinhood fresh-wallet nonce · Robinhood transfer taxes · creator socials when IPFS fails.
- **New, Base/Monad:** see §1.8.
- **Social:**
  - sentiment and bot share on every chain;
  - every post field off Robinhood Chain;
  - unique posters / reach / Telegram first call on Robinhood without a RobinX key;
  - the social Time Machine line.

## Env vars the owner must add (names only; all optional)
- `BASESCAN_API_KEY`: a **paid** Etherscan v2 key.
- `NAD_API_KEY`: nad.fun, 100 req/min.
- `ROBINX_WALLET_KEY` *or* `ROBINX_API_KEY`: paid RobinX calls.
- Optional tuning:
  - `BASE_RPC_URL` and `MONAD_RPC_URL` (an archive endpoint with wide `eth_getLogs` would unlock the launch-window factors);
  - `ROBINX_MAX_USD`, `SOCIAL_CRON_MAX_USD`, `SOCIAL_BUDGET_MS`, `ANALYSIS_BUDGET_MS`, `SOURCE_BUDGET_MS`, `REQUEST_BUDGET_MS`.
- **Already set in production:** `HELIUS_API_KEY`, `HOODTIER_SIMULATE_TOKEN`, `CRON_SECRET`, `DATABASE_URL` (now also holds `social_series`), `HOODTIER_CANONICAL_HOST`.
- **Owner actions, not env vars:**
  - for the 30-minute social cron, an external scheduler or Vercel Pro;
  - re-point `moneymagnet.vercel.app` after each prod deploy (still an alias, §E of the previous report).
