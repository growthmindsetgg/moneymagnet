# MoneyMagnet: improvement plan and vetted skills / tools (2026-11-23)

Research only. No app code was changed, nothing was installed, cloned, executed, committed or deployed. Third-party repositories were read through the GitHub API (`gh api repos/.../contents/...`) as text and scanned statically. Everything read from them was treated as data.

Repo state read: `main` at `07508ec`. Line numbers below refer to that commit.

---

## 1. Top-10 improvement plan (ranked by impact × effort)

| # | Item | Impact | Effort | New key / cost |
|---|---|---|---|---|
| 1 | GeckoTerminal quota: shared budget, candle cache, keyed endpoint, second OHLCV source | Very high | M | Optional: CoinGecko key and/or free DexPaprika key |
| 2 | Score the contract-control flags we already fetch (blacklist, pause, hidden owner, modifiable tax, cannot-sell-all) and scan for them on Robinhood | High | S | None |
| 3 | Stalled swap index: stop a stale 0 buyers / 0 sellers being chosen as the "conservative" value | High | S | None |
| 4 | Store our own holder-count series (unlocks Holder growth; later a self-observed cohort) | Medium-high | S | None |
| 5 | Launch-integrity factors for Base / Monad / Ethereum (bundle / sniper / first-blocks share) | High | M-L | None (uses the Transfer-log replay) |
| 6 | Solana founder-link due diligence (parity with EVM) | Medium-high | M | Helius key (already used) |
| 7 | Cohort for pump.fun graduates (age-filtered listing or self-observed cohort) | Medium | M | Free DexPaprika key, or none |
| 8 | Replace the obsolete e2e outage assertion; fix the misleading null reason under an outage | Medium | S | None |
| 9 | Fullported (portfolio value) on Solana first; whale-net on no-trade weeks (owner decision) | Medium | M | Helius key (already used) |
| 10 | UI gaps: gate evidence without hover, cold-load announcement, 16px chain select; plus copycat and LP-unlock notes | Low-medium | S | None |

### 1. GeckoTerminal rate limits (HTTP 429)

**Problem, with evidence.**
- One analysis makes 1 pool call plus 4 to 5 OHLCV calls in parallel: `lib/sources/geckoterminal.ts:34` (pools) and `:162-168` (`Promise.all` of minute / 5-minute / day / hour / launch candles).
- Each call is retried twice on 429 inside the same request (`geckoterminal.ts:36-39` and `:151-154`, delays 1.5s and 3s). Under a 429 this triples the burst: up to 18 calls for one analysis.
- The cohort adds up to 3 listing pages plus 8 peer OHLCV calls (`lib/cohort.ts:28-30`, `COHORT_LIST_PAGES = 3`, `COHORT_MAX_PEERS = 8`).
- There is no shared outbound budget. `lib/rateLimit.ts` limits inbound clients only. `lib/sources/http.ts:17-22` sends no API key.
- No candle cache exists besides the 2-minute whole-report cache (`lib/analyze.ts:692`) and the last-good stale store.
- REPORT.md: line 98 (verify:api failed a token because every GeckoTerminal call was 429), line 105 ("rate-limiting production heavily"), line 604 and 639 (ok on only 5 of 25 tokens in the live audit), line 478 (6 of 7 Base known-good tokens capped at B by coverage because GeckoTerminal and GoPlus failed).
- The failing e2e run of 2026-11-23 shows the same thing: `test-results/smoke-HoodScan-outage-…/error-context.md` line 90 reads "Rate-limited this run: geckoterminal, cohort", and the result is "coverage 50% < 60% ⇒ cap B".
- The published keyless limit is unclear: CoinGecko's keyless docs say about 10 calls/min, GeckoTerminal's FAQ says 30. Either way one cold analysis can use most of a minute's quota, and Vercel functions share egress IPs.

**Fix (in this order; each step stands alone).**
1. **Do not retry a 429 inside the request.** Honour `Retry-After`, mark the call as an outage and let the existing last-good path serve it. Keep retries for timeouts only.
2. **Shared outbound budget in KV.** A per-minute counter (same pattern as `takeLiveSlot` in `lib/rateLimit.ts`) keyed `gt:budget:<minute>`. Priority order: token pools, then the candles the active factor set needs, then the cohort. A call that does not get a slot is null with "GeckoTerminal budget for this minute used (N of M)", or stale from the last good reading.
3. **Candle cache in KV, per pool and timeframe.** Closed daily candles never change: store them and fetch only the tail. 1h candles: 10 to 15 minutes. Per CLAUDE.md a cached reading is not "live": label it "stale Xm" from its fetch time. This also cuts latency.
4. **Fetch only what the mode needs.** Established mode needs day + hour + 5-minute (staircase / up-only). The 1-minute calls are launch-only already; the 1000-row daily call can be replaced by the cached series plus a short tail.
5. **Keyed endpoint.** Add `GECKO_API_KEY` (document in `.env.example`). With a key, call the CoinGecko onchain API host with its key header instead of the public host. Exact host, header and limits must be confirmed against the current CoinGecko docs before coding (see section 4).
6. **Second OHLCV source: DexPaprika.** Its `/networks` list, read live on 2026-11-23, includes `robinhood`, `monad`, `solana`, `base` and `ethereum`. Pool OHLCV is `GET /networks/{network}/pools/{pool}/ohlcv`. Per its own skill file: keyless is 15 req/min, 1h candles and longer over the last 24h only; a free key is 30 req/min, 100,000 credits per rolling 30 days, 10-minute candles and longer over 7 days; the $30/month plan gives every interval over 30 days. So a free key can supply the 1h trend and the 7d change when GeckoTerminal fails, but not 1-minute launch candles or the lifetime daily series. Register it as its own adapter and provenance source; never merge its candles silently into GeckoTerminal's.
7. **Robinhood:** `hoodscanCandles` already exists but is only tried for young tokens with a null trend (`lib/analyze.ts:417`). Extend it to Established mode as the trend fallback.

**Files:** `lib/sources/geckoterminal.ts`, `lib/cohort.ts`, `lib/sources/http.ts`, `lib/sources/retry.ts`, new `lib/sources/dexpaprika.ts`, `lib/analyze.ts`, `lib/stale.ts` (bump `STALE_VERSION`), `.env.example`, `README.md` sources table.

**Risks.** Two candle sources can disagree: the verifier must treat them like for like (same pool, same interval) or keep them as separate, labelled readings. A shared budget can starve the cohort; that is acceptable because the cohort has an hourly cache.

**Test.** Unit tests with a fake fetch: 429 is not retried; budget exhaustion gives the exact null reason; cached candles carry a stale age; fallback source appears in provenance. Then `pnpm verify:api`, `pnpm verify:stability`, and a 20-token serial sweep counting GeckoTerminal ok / partial / stale / failed before and after.

### 2. Contract-control flags are fetched but never scored

**Problem, with evidence.**
- `lib/sources/goplus.ts:132` puts `cannotSellAll`, `transferPausable`, `hiddenOwner` and `blacklist` into `raw`. A repo-wide search finds no other reader, so they affect neither the score nor the page.
- GoPlus fields not read at all: `slippage_modifiable`, `personal_slippage_modifiable`, `owner_change_balance`, `selfdestruct`, `trading_cooldown`, `is_anti_whale`, `anti_whale_modifiable`, `external_call`, `can_take_back_ownership` (declared at `goplus.ts:44`, unused).
- `factors.json` has rules for honeypot, sell tax, mint, freeze, LP, owner and proxy, but none for blacklist, pause or modifiable tax (rule ids listed in `lib/scoring/factors.json` `rules[]`).
- Robinhood Chain has no GoPlus coverage. `lib/onchain/mintScan.ts` already proves the pattern needed: find `PUSH4 <selector>` in runtime bytecode and combine it with whether the owner is live.
- Solana: Token-2022 permanent delegate and transfer hook are only signals from RugCheck (`lib/sources/rugcheck.ts:112-125`); they are not read from the mint account itself.

**Fix.**
- Add snapshot fields (`canBlacklist`, `transferPausable`, `taxModifiable`, `hiddenOwner`, `ownerCanChangeBalance`, `cannotSellAll`, `tradingCooldown`), each live / null with the reason. Fill from GoPlus on Base / Monad / Ethereum.
- Robinhood: generalise `mintScan.ts` into a selector scan for blacklist / pause / fee-setter entry points. A selector proves the function exists, not who may call it, so the evidence must say "bytecode has X and the owner is live" exactly as mintScan does, and stay null when the owner is unknown.
- Solana: read the mint account with `jsonParsed` from the Solana RPC (already called for authorities) and take the extension list from chain: permanent delegate, transfer hook program, transfer-fee config and its authority, default-frozen state. On-chain wins over RugCheck under the existing verification rule.
- Rules in `factors.json` only (engine stays generic). Suggested: `ownerCanChangeBalance` or `cannotSellAll` ⇒ force F; blacklist or pause with a live owner ⇒ cap C; modifiable tax with a live owner ⇒ cap B; hidden owner ⇒ treat owner as not renounced. All are owner decisions.

**Files:** `lib/sources/goplus.ts`, `lib/onchain/mintScan.ts`, `lib/sources/rpc.ts` (Solana mint read), `lib/types.ts`, `lib/snapshot.ts`, `lib/verify/metrics.ts`, `lib/scoring/factors.json`, tests.

**Data source / cost.** None new.

**Risks.** False positives on legitimate tokens with a pause function (USDC-style). Mitigate by requiring a live owner and by capping, not failing. GoPlus booleans are a third party's claim: label the source.

**Test.** Unit tests per flag; a fixture for a known blacklist token and a known clean token on Base; the selector scan against recorded bytecode. The installed `evm-token-due-diligence` skill has `scripts/selector_scan.py` and `references/surfaces/token-controls.md`, useful as the reference list of selectors.

### 3. Stalled swap index: a stale 0 wins the cross-check

**Problem, with evidence.**
- `lib/sources/hoodscan.ts:199-200`: `buyers = flow?.buyers ?? t.market?.h24?.buyers ?? st.buyers24 ?? num(f.buyers)`. A stalled index returns 0, which is a value, so it passes.
- `lib/verify/metrics.ts:31-32`: `buyers24h` is resolved as "fewest buyers", `sellers24h` as "most sellers". A stale 0 therefore beats any real reading.
- REPORT.md line 255 and 277: live microduck read "0 buyers / 0 sellers beside $52k of DexScreener volume"; a count floor in `thin_trading` had to be dropped because of it.
- REPORT.md line 426: the 2026-11-22 stalled-index fix covers only `lastTradeHoursAgo`; "HoodScan's other swap-derived fields (net flow, swap holders) may also be stale … not measured."

**Fix.** One freshness verdict for the whole HoodScan adapter. When the index's newest swap is older than DexScreener's `lastTradeWithinHours` bound, or HoodScan reports 0 buyers and 0 sellers while DexScreener counts trades in the same 24h, every swap-derived 24h field (`buyers24h`, `sellers24h`, `netFlowRatio24h`, `netFlowUsd24h`, `tradesPerWallet`, `singleTradeWalletSharePct`, `smartMoneyNetUsd`) becomes null with both readings in the reason. Add the same guard to the verifier: a reading from a source flagged stalled is not eligible as the conservative choice.

**Files:** `lib/sources/hoodscan.ts`, `lib/snapshot.ts` (where `lastTradeWithinHours` is applied), `lib/verify/metrics.ts`, `tests/stalled-index.test.ts`.

**Risks.** Tokens with no DexScreener pair still have no contradiction (the UHI limit stays). Coverage drops when the index stalls; the tier hold already handles outages.

**Test.** Extend `tests/stalled-index.test.ts`: 0/0 with DexScreener trades ⇒ nulls with the reason; a genuinely dead token (no DexScreener trades in 24h) still scores 0 and fires `dead_no_trades`.

### 4. Our own holder-count series

**Problem, with evidence.** `lib/holderStrengthData.ts:88-89` passes `holderSeries: null` on every run; the scorer already supports a series (`lib/holderStrength.ts:550-553`). REPORT.md line 232 says the pieces are in place: `lib/history.ts` records liquidity points the same way.

**Fix.** Record `{t, count, source}` beside the liquidity point, only when `holderCount` is live this run and from one consistent source per token (counts from different sources are not comparable). Minimum spacing 1h, keep 30 days. Pass the series to `computeHolderStrength`; under 7 days of our own observations the component is null with "our holder-count series starts <date>; a 7d change needs a point from <date> or earlier". The daily social cron (`/api/cron/social`, re-samples tokens analysed in the last 7 days) is the natural place to add one cheap holder-count sample per token so the series does not depend on visits.

**Files:** `lib/history.ts`, `lib/analyze.ts` (`recordLiquidity` step), `lib/holderStrengthData.ts`, the social cron route, tests.

**Cost.** KV / Postgres rows only.

**Risks.** A source switch mid-series fakes growth: store the source and refuse to diff across sources. A series that starts at the first analysis says nothing about earlier weeks: the reason text must say so.

**Test.** Unit tests: stale or mixed-source points are not recorded; too-short series is null with the reason; a 7d series scores. Follow-up: the same store gives a self-observed cohort (item 7).

### 5. Launch-integrity factors on Base / Monad / Ethereum

**Problem, with evidence.** Of the launch-integrity factors, the per-chain sets contain: `launch` (Solana) bundle score, first-5-minute share, snipe ratio, funding cluster, fresh wallets, insider supply, creator history, timing entropy; `launch_robinhood` bundle share, first-5-minute share, fresh wallets, repeated size; `launch_base`, `launch_monad`, `launch_ethereum` only `lp_lock` and `upgradeable` (read from `lib/scoring/factors.json` `sets`). A bundled or sniped launch on Base, Monad or Ethereum is invisible to the score. `wash_trade` exists only in the generic `established` set.

**Fix.** The EVM Transfer-log ledger already exists for Holder Strength (`lib/holderStrengthData.ts`, "EVM … Transfer-log ledger, resumable"). From the first N blocks after the first pool / curve trade, derive:
- share of supply bought in the first 5 minutes and in the first block;
- number of distinct buyers per block and the share bought in blocks with ≥ 3 buyers (same-block bundle);
- how much of that early cohort still holds (bundlers flushed);
- shared first funder among the early buyers (reuse `shared_funder` from `lib/onchain/founderLink.ts`).
Add the factors to the three launch sets in `factors.json`, rebalance weights, add n/a rules for tokens whose launch window is outside the readable log range (never guess).

**Files:** new `lib/onchain/launchCohort.ts`, `lib/analyze.ts`, `lib/types.ts`, `lib/scoring/factors.json`, `docs/chains/*.md`, fixtures.

**Data source / cost.** Public RPC logs. Base public RPCs cap `eth_getLogs` windows (REPORT.md line 1268), so the read must be resumable in KV like the replay.

**Risks.** Launchpad routers batch buys in one block for honest users; exclude registered infrastructure (`lib/onchain/chainInfra.ts`). Budget: must fit the 45s analysis budget or run after the response and appear on the next visit, labelled pending.

**Test.** Fake-RPC unit tests for each derived value; recorded fixtures for one known bundled launch and one clean launch per chain. Reference method: `references/surfaces/launch-integrity.md` and `deep-dives/launch-cohort-accounting.md` in the installed `evm-token-due-diligence` skill.

### 6. Solana founder-link due diligence

**Problem, with evidence.** `lib/topHolders.ts:318-323` gives Solana a single clue (the creator sent the wallet's first SOL or first tokens) and the verdict "team". The EVM path reads five clues and can prove "founder wallet (linked to the deployer)" (`lib/onchain/founderLink.ts`). REPORT.md line 59: "Solana is unchanged (team detection only); founder linking there is a follow-up." A Solana founder holding through a second wallet therefore gets the harsher team caps, exactly the $JAMES case fixed on EVM.

**Fix.** Port the five clues using the Helius history already fetched in `solanaFunding`: tokens from creator by plain transfer; first SOL from creator; stake handed over (transfer ≥ 80% of the current balance); creator emptied (kept ≤ 1% of what it sent); shared first funder (exclude exchange hot wallets and program-owned funders). Reuse the pure verdict function from `founderLink.ts` so both chains share the rule (≥ 2 clues with at least one direct).

**Files:** `lib/topHolders.ts`, `lib/onchain/founderLink.ts` (export the verdict), new Solana clue reader, `tests/founder-link.test.ts`.

**Cost.** 1 to 2 extra Helius calls for one wallet per analysis; null with "Helius key not set" without the key.

**Risks.** pump.fun tokens are created by the launchpad program; "creator" must be the pump.fun creator field, not the mint authority. A CEX-funded creator and wallet must not link.

**Test.** Fake-Helius cases mirroring the nine EVM tests.

### 7. Cohort for pump.fun graduates

**Problem, with evidence.** REPORT.md lines 350-354: `solana/dexes/pumpswap` volume pages 1 to 3 had 0 qualifying pools; "most pump.fun graduates will read null". GeckoTerminal category endpoints return 401 on the public API.

**Fix options.**
- **A. Age- and liquidity-filtered listing.** DexPaprika's `/networks/{network}/pools/search` documents filters for `liquidity_usd`, 24h/7d volume and `created_after` / `created_before`. Asking for Solana pools with ≥ $10k liquidity created more than 7 days ago removes the "newborn dust" problem at the source. Not verified: whether the search can be restricted to one DEX (`pumpswap`), and whether creation-date filters are limited on keyless / free keys (the skill file says "keyless and free keys see up to an hour ago" for one relative-time example). Paging needs a key.
- **B. Self-observed cohort.** From item 4's store: tokens HoodTier itself analysed on the same venue in the last 24h whose live 7d change was recorded. Label it "N tokens analysed by MoneyMagnet on <venue>". Needs ≥ 5 peers, same rule as today. No new source, but biased to what users paste.
Recommend A with B as fallback, both clearly labelled in the cohort label.

**Files:** `lib/cohort.ts`, new source adapter, tests with recorded responses.

**Risks.** Different candle source for peers vs token breaks like-for-like: read peer and token 7d change from the same source in one cohort.

**Test.** Recorded-fixture tests as in `tests/liquidity-relative-strength.test.ts`.

### 8. e2e "HoodScan outage" test and the outage null reason

**Problem, with evidence.**
- `e2e/smoke.spec.ts:88-104` fails at line 99: it expects text `stale, Nm old` inside the "Holder conviction" group.
- The saved page snapshot (`test-results/smoke-HoodScan-outage-…/error-context.md` lines 181-200) shows why: top-10 and top-holder are now scored live from the on-chain replay ("scored: on-chain 26.6% … HoodScan 2.8% (swap-index only) (stale)"). The holder group no longer contains a stale-scored factor, so the assertion is obsolete, not the product broken. The stale headline, badges and the HoodScan source row are present (line 64).
- Same snapshot, lines 209-212: under the simulated outage "Early-cohort retention" reads "no data — not provided by HoodScan for this token". During an outage with no last-good value the reason should name the outage, not say the source did not provide it.
- The test's last assertion (tier equals the live tier) is exposed to item 1: in the saved run the tier was B from "coverage 50% < 60%" because GeckoTerminal and the cohort were rate limited.

**Fix.** Per CLAUDE.md, replace the assertion rather than weaken it: assert that the holder group is still scored from on-chain data during the outage and that a HoodScan-fed factor in the Flow group shows `stale, Nm old`; say so in REPORT.md. Fix the null reason to "HoodScan failed (HTTP 503 …) and no last good value ≤ 6h" when the adapter failed.

**Files:** `e2e/smoke.spec.ts`, the null-reason builder (search "not provided by" in `lib/scoring/engine.ts` / `lib/snapshot.ts`), REPORT.md.

**Test.** `pnpm test:e2e` locally with a warmed KV.

### 9. Fullported and whale-net

**Fullported (always null today).** `lib/holderStrengthData.ts:101-106` gives the reason per chain. On Solana, a Helius asset listing with fungible tokens and native balance returns priced balances for tokens Helius can price, which is a real portfolio value for most wallets. Plan: Solana only first; one call per top-20 wallet inside the existing Helius queue; a wallet whose assets are mostly unpriced counts as "value unknown" and the existing `coverage < 30% = missing` rule applies. The exact method name, response fields and credit cost must be checked against Helius docs (the official `helius-labs/core-ai` skill references `wallet-api.md` and `das.md` cover it). EVM chains stay null with their reason until a keyed balance API is chosen.

**Whale net on no-trade weeks (owner decision).** `lib/holderStrength.ts:491-500` scores 0 when no top-20 wallet swapped in 7 days ("no buying is no demand"). REPORT.md lines 216-218 accept the cost (up to 9 of 100 weight for a quiet diamond-hand token). The sibling component is treated differently: dip absorption with no red day is n/a. Options: (a) keep as is; (b) n/a when the top 20 neither bought nor sold, 0 only when they were net sellers; (c) 0 only when the token itself traded in those 7 days (others traded, whales did not buy), n/a when the whole token was quiet. Option (c) keeps "zero activity is a value" for the token and stops penalising holders for a dead week. Whatever is chosen belongs in the weights header and a test.

**Files:** `lib/holderStrengthData.ts`, `lib/holderStrength.ts`, `lib/sources/heliusQueue.ts`, tests.

### 10. UI gaps and smaller detections

- **Chain select is 12px:** `components/AnalyzeForm.tsx:72` uses `text-xs`. Use `text-base sm:text-xs` as the address input does (line 62), so iOS does not zoom.
- **Cold result not announced:** `components/LoadingSkeleton.tsx:42` has a `role="status"` for loading, but nothing announces completion. Add a polite live region in `components/LiveReport.tsx` that reads "Tier B, score 69.9" (the sentence already rendered in the header) and move focus to the result heading.
- **Gate pill evidence hover-only:** REPORT.md line 151. Render the evidence as a `<details>` or a tap-to-expand row; keep the tooltip as an enhancement.
- **Copycat tokens (no detection today):** a search for "copycat / impersonat / same symbol" in `lib` and `components` finds nothing. Cheap version: DexScreener search by symbol on the same chain; if an older token with the same symbol has ≥ 10× the FDV, show an information line "an older, larger token uses this symbol: <address>". Information only, never scored without an owner decision.
- **LP unlock date:** `lpLockedPct` is a percentage only (`lib/onchain/lplock.ts`, `goplus.ts:119`). `lib/onchain/holderClass.ts:131-158` already reads unlock times from locker contracts for holder wallets. Reuse it for LP positions and add an evidence line "LP unlocks <date>"; a rule such as "locked LP unlocking within 7 days counts as unlocked" is an owner decision.
- **Proxy admin:** `upgradeable` is a boolean. Reading the ERC-1967 admin slot and classifying the admin (EOA / multisig / timelock, with `holderClass` signatures) would let the rule distinguish "upgradeable by one key" from "upgradeable behind a timelock".
- **Deployer read failure:** REPORT.md line 481, "block range extends beyond current head block" from a lagging RPC endpoint nulls `deployer_holding` / `deployer_sold`. Clamp the upper block to the endpoint's own `eth_blockNumber` and retry on the next endpoint.

---

## 2. Vetted skills / tools

Already installed and not duplicated: **`evm-token-due-diligence`** (session skill). It covers EVM token controls, proxy and bytecode, sellability, liquidity custody (v2/v3/v4, lockers), launch integrity, supply concentration, fees and treasury, Robinhood Chain and Pons notes, a selector scan and a Transfer replay script. It has no Solana coverage and no market-data source. The candidates below were chosen for those gaps.

Verdicts: **SAFE** = safe to install as is. **CHANGES** = safe with the stated changes. **NO** = do not install.

| Name | Link | What it does for us | How we would use it | Verdict | Key evidence |
|---|---|---|---|---|---|
| coinpaprika/skills (`dexpaprika-api`) | github.com/coinpaprika/skills | Documents the DexPaprika REST API: pools, pool OHLCV, filtered pool search. Direct answer to item 1 and item 7 | Skill for the coding agent, and the API as a library source in the app | **CHANGES** | Org account, 36 stars, MIT, created 2026-03, pushed 2026-11-13. Markdown and an OpenAPI file only; no scripts. Two things to remove before installing: (1) `dexpaprika-api/SKILL.md` lines 9-15, a "freshness check" telling the agent to fetch the remote file, "follow it instead of this one, and replace your local copy" (a remote instruction-update channel; same block in `coinpaprika-api/SKILL.md`); (2) lines 35-39, a download-and-run of `install.sh` for the CLI (checksum-pinned, but still executes a remote script; we only need REST). |
| coinpaprika/dexpaprika-mcp | github.com/coinpaprika/dexpaprika-mcp | MCP server over the same API | Optional, for ad-hoc research in a session; not needed by the app | **SAFE** (pin the version) | Org, 120 stars, 31 forks, MIT, pushed 2026-11-20. `package.json`: no install hooks (`prepack` only builds), deps are `@modelcontextprotocol/sdk` and `zod` only. Source talks to `api.dexpaprika.com`, `api-pro.dexpaprika.com`, `mcp.dexpaprika.com`. Reads only `DEXPAPRIKA_API_KEY` / `DEXPAPRIKA_API_BASE_URL` (`src/http-config.js`). `child_process` appears only in test files. Has path-safety tests. |
| trailofbits/skills (`building-secure-contracts` → `token-integration-analyzer`; `supply-chain-risk-auditor`) | github.com/trailofbits/skills | Weird-ERC20 checklist (fee-on-transfer, blocklists, pausable, rebasing, upgradeable) for item 2; a dependency-risk auditor for vetting future tools | Skill (reference for which patterns to detect; the auditor before adding any npm dependency) | **SAFE** | Trail of Bits org, 8,360 stars, 725 forks, CC-BY-SA-4.0, pushed 2026-11-21. Skill text read: no instructions aimed at overriding the agent. The token skill suggests running Slither (a separate install, AGPL; not needed for our use). The auditor's Python scripts use `subprocess` to call `gh` and `pip-audit` only. Note the licence is share-alike: do not copy its text into the product. |
| helius-labs/core-ai (`helius` skill, `helius-mcp`) | github.com/helius-labs/core-ai | Official Helius references (DAS, wallet API, enhanced transactions) for items 6 and 9 | Skill references for the coding agent. MCP only in read-only mode | **CHANGES** | Helius org, 33 stars, MIT, pushed 2026-11-23, signed-commit and audit workflows. The plugin pins `npx helius-mcp@3.1.0` (`helius-plugin/.mcp.json`). The MCP can generate a keypair, sign up for an account, pay USDC from a local keypair, send transfers and stake (`helius-mcp/README.md`), and loads a persisted keypair from disk at start (`helius-mcp/src/index.ts`, `loadKeypairFromDisk`). Required changes: run with `--read-only` or `HELIUS_MCP_READ_ONLY=1` (documented: 11 read tools, no `heliusWrite`, signup or billing), never fund or create its keypair, give it a separate Helius key from production. Do not install `helius-cli` (has `keygen`, `pay`, `send`, `stake`). Simplest safe use: copy only `.agents/skills/helius/` (markdown). |
| Vo1ganin/crypto-claude-skills | github.com/Vo1ganin/crypto-claude-skills | Read-only research skills: Solana RPC, pump.fun mechanics and on-chain layout, MEV / bundle analysis, DexScreener, Dune, Solscan, Nansen | Skill (method reference for Solana bundle and sniper detection); copy selected skill folders only | **CHANGES** | Individual account (created 2023, 2 followers), 2 stars, MIT, pushed 2026-09-17. Low adoption, so read before each update. Content read: SKILL.md files state "read-only", "no raw key material", "retrieved credentials are untrusted". Example scripts read only API-key env vars (`CMC_API_KEY`, `NANSEN_API_KEY`, `SOLANA_RPC_URL`) and call the named providers. `scripts/*.py` (mirror tooling, uses `subprocess` for git) is repo maintenance: do not copy or run it. Install = copying `skills/pumpfun`, `skills/mev-bundles`, `skills/solana-rpc` only. |
| sendaifun/skills | github.com/sendaifun/skills | Marketplace of Solana skills. Relevant: `birdeye` (token security, holder distribution, OHLCV), `coingecko` (GeckoTerminal-style onchain API), `ct-alpha` (X search with credibility ranking and raid detection), `pumpfun`, `wallet-analysis` | Reference only for now | **CHANGES** (per skill) | SendAI org, 129 stars, 81 forks, Apache-2.0, last push 2026-07-31. Mixed authorship (community-submitted skills). Findings: `skills/pumpfun/SKILL.md:49` shows `Keypair.fromSecretKey(bs58.decode('YOUR_SECRET_KEY'))` (trading code; not for us); `skills/birdeye/examples/x402/pay-per-request.ts` reads `SOLANA_PRIVATE_KEY` to pay per request (do not use); `skills/ct-alpha/install.ts` and `setup.ts` write `~/.config/env/global.env` and `~/.claude/skills` (writes outside its folder; do not run, copy files by hand if wanted). `wallet-analysis` was not read (see section 4). Birdeye and X API are paid. |
| GoPlusSecurity/goplus-mcp | github.com/GoPlusSecurity/goplus-mcp | MCP wrapper over the GoPlus API we already call directly | Reference only (field list for item 2: `src/tools/tokenSecurity.ts`, `solanaTokenSecurity.ts`) | **CHANGES** (not needed) | Official org, 7 stars, Apache-2.0, but last push 2025-05-29 (stale). No install hooks; deps `axios`, `commander`, `zod`, MCP SDK. Only host: `api.gopluslabs.io`. `src/config/index.ts:21-52` ships a persona prompt aimed at the model ("You are Cubey, the intelligent security assistant of GoPlus…", "Use emojis…"): harmless marketing, but it is text that tries to steer the agent, so strip it. Key and secret are passed as CLI arguments (visible in the process list). Commits a prebuilt `dist/`. |
| Molzard/solana-rugcheck-mcp | github.com/Molzard/solana-rugcheck-mcp | Small MCP over RugCheck + DexScreener for Solana | Reference only; we already call both APIs | **CHANGES** (not needed) | Individual, 0 stars, no licence file (all rights reserved by default), created and last pushed 2026-10-25. Code is clean: deps `@modelcontextprotocol/sdk`, `bs58`, `zod`; hosts `api.rugcheck.xyz`, `api.dexscreener.com`; no env secrets; `child_process` only in a smoke-test script. Blocked for reuse by the missing licence and zero track record. |
| nirholas/pumpfun-mcp (`@three-ws/pumpfun-mcp`) | github.com/nirholas/pumpfun-mcp | The pump.fun intel feed the app already reads over HTTP | Keep using the HTTP backend; do not add the MCP to agent sessions | **CHANGES** | Individual, 12 stars, Apache-2.0, pushed 2026-11-19. One dependency (MCP SDK), no install hooks. Read-only except `pumpfun_vanity_mint` (`src/native.js:229-301`, `src/vanity.js`), which generates a Solana keypair locally and returns the **secret key in the tool result**, i.e. into the model's context. If ever installed, disable that tool. Backend host `three.ws` is a single small operator: keep it non-critical (it is, in `lib/sources/pumpfeed.ts`). |
| kukapay/honeypot-detector-mcp | github.com/kukapay/honeypot-detector-mcp | 80-line MCP over `api.honeypot.is/v2/IsHoneypot` (Ethereum, BSC, Base) | Reference only: the takeaway is the honeypot.is API as a possible second sellability opinion on Base / Ethereum | **CHANGES** (not worth installing) | Individual (author of many small crypto MCPs), 3 stars, MIT, single commit 2025-06-14. Only host: `api.honeypot.is`. No secrets read. Defects: `main.py` imports `httpx` but `pyproject.toml` declares only `mcp[cli]`; missing fields default to `False` / "unknown" (`data.get(...).get("isHoneypot", False)`), which presents "not reported" as "not a honeypot". That pattern must not be copied into the app (CLAUDE.md: no pseudo data). |
| malvaphe/Crypto_Honeypot_Detector | github.com/malvaphe/Crypto_Honeypot_Detector | Honeypot check by simulating buy and sell inside one read-only `eth_call` with injected contract code; multi-chain | Reference only: compare its simulator contract with `lib/sources/evmSim.ts` for edge cases (transfer tax, max-tx, cooldown) | **SAFE** as reference (not installed) | Individual, 68 stars, 27 forks, MIT, since 2022, v2.0.0 pushed 2026-09-28. Core package depends on `viem` only; no install hooks; no private keys (`docs/SECURITY_REVIEW.md`: "No private key is…", simulation only). RPC URLs from env. Not all files were read (see section 4). |
| degenfrends/solana-rugchecker | github.com/degenfrends/solana-rugchecker | TypeScript library: Solana holders, liquidity, metadata, website (whois) checks | Reference only | **NO** | 78 stars, 30 forks, but **no licence** and unmaintained since 2024-06-14 (version 0.0.16). Heavy, old dependency tree: `@raydium-io/raydium-sdk` beta, `@metaplex-foundation/js` (deprecated), `web3`, `whois`, `whois-json`. No malicious code seen in `src/`; the verdict is about licence and dependency risk, and everything it does we already do with better sources. |
| mcpdotdirect/evm-mcp-server | github.com/mcpdotdirect/evm-mcp-server | General EVM MCP (reads, ABIs, ENS, multi-chain) | Not needed: the app has its own RPC layer and the installed skill has scripts | **CHANGES** (not recommended) | Org, 381 stars, 105 forks, MIT. README lines 203-230: takes `EVM_PRIVATE_KEY` or `EVM_MNEMONIC` and exposes `transfer_native`, `transfer_erc20`, `write_contract`. Only acceptable with no key configured, and then it adds nothing over what we have. |
| brebros/chainsleuth | github.com/brebros/chainsleuth | "AI rug detector" web app (Etherscan + GoPlus + an LLM) | None | **NO** | No licence, 20 stars, 0 forks. `scripts/0g-login.exp:5` hard-codes a wallet private key; `api/analyze.js:48` hard-codes an Etherscan API key; `api/analyze.js:9` and another file default the backend to a raw IP, `http://77.90.51.232:3001`. Scores come from an LLM, which conflicts with our "no estimated values" rule. |
| daemonbrewerbreak/rugcheck-scout | github.com/daemonbrewerbreak/rugcheck-scout | Claims to be a rug-check tool | None | **NO — malware lure** | Account created 2026-11-01, repo 2026-11-16, 83 stars with 0 forks. The repo has **no code**: README, CHANGELOG, `DOWNLOAD.txt`, `LAUNCH-NOTES.txt`. Every button points to `https://go-release.xyz/`. README tells Windows users to "Run the command exactly as shown — quotes, pipes and semicolons matter", mentions a "clipboard helper" and whitelisting it in antivirus. This is the paste-a-command ("ClickFix") pattern. Do not open the link. |
| nikitasio1997h6/gmgn-bullx-copytrade-bot-2026 (and the look-alike "solana-pump-fun-jito-bundler" repos by `v-nancythom-r84`, `kevin-techeng95w9`, `nikita-berg-io2090h6`) | github.com/nikitasio1997h6/gmgn-bullx-copytrade-bot-2026 | Claims a copy-trade bot "with RugCheck Guard" | None | **NO — malware lure** | Created 2026-11-23 (today), 130 stars, 0 forks. `src/engine.py` is a 30-line stub that prints a heartbeat; the README's only real content is a button to download `…-v1.2.0-win64.zip` from Releases ("1-Click Prebuilt Package (No Compiler Required)"). `docs/index.html` is keyword stuffing (sniper bot, bundler, etc.). Several near-identical repos from different new accounts appeared in the same searches. Treat any high-star, zero-fork, days-old repo in this niche the same way. |

Also seen, not vetted in depth: `solana-foundation/solana-dev-skill` (594 stars, MIT; a program-development skill, not token checking; its README suggests `npx -y mcp-remote https://mcp.solana.com/mcp`), `nansen-ai/nansen-skills` (moved; paid API), `bitquery/mcp` (hosted MCP config only; paid data), `sendaifun/solana-mcp` and `solana-foundation/solana-mcp` (agent kits with signing; out of scope), `crytic/slither` (6,422 stars, AGPL-3.0; a well-known static analyser, useful only when verified source exists; not needed for a selector-level scan).

---

## 3. Recommended "adopt first" shortlist (nothing below was executed)

1. **DexPaprika as a second market-data source (item 1, item 7) — SAFE WITH CHANGES.**
   - In the app: no install. Add an adapter that calls `https://api.dexpaprika.com/networks/{network}/pools/{pool}/ohlcv?start=-7d&interval=1h&limit=168` with header `Authorization: <key>` when `DEXPAPRIKA_API_KEY` is set. Register a free key at console.dexpaprika.com (owner action; accepting their terms is the owner's decision). Add the variable to `.env.example` and Vercel.
   - As a skill for the coding agent (optional): copy `dexpaprika-api/SKILL.md` and `references/` into `.claude/skills/dexpaprika-api/`, pinned to a commit SHA, then delete the "Freshness check" block (lines 9-15) and the CLI install block (lines 33-41). Record it in `skills-lock.json` with the file hash, like the two Neon skills.
2. **Trail of Bits `token-integration-analyzer` (item 2) and `supply-chain-risk-auditor` — SAFE.**
   - `/plugin marketplace add trailofbits/skills`, then install only `building-secure-contracts` and `supply-chain-risk-auditor`. Or copy the two skill folders at a pinned commit. Do not install Slither for this.
3. **Helius skill references (items 6, 9) — SAFE WITH CHANGES.**
   - Copy only `.agents/skills/helius/SKILL.md` and `references/` at a pinned commit into `.claude/skills/helius/`. Do not install `helius-cli`. If the MCP is wanted later: `npx helius-mcp@3.1.0 --read-only` with `HELIUS_MCP_READ_ONLY=1` and a non-production key, and no keypair on disk.
4. **Vo1ganin `pumpfun`, `mev-bundles`, `solana-rpc` skills (items 5, 6) — SAFE WITH CHANGES.**
   - Copy those three folders only, at a pinned commit, into `.claude/skills/`. Do not copy or run the repo's `scripts/`. Re-read on any update (single maintainer, low adoption).
5. **Use what is already installed: `evm-token-due-diligence`** for the selector list (`scripts/selector_scan.py`, `references/surfaces/token-controls.md`) and the launch-cohort method (`references/deep-dives/launch-cohort-accounting.md`). No install step.

Not on the shortlist on purpose: GoPlus MCP, RugCheck MCP, honeypot MCP and EVM MCP wrap APIs the app already calls directly; they add attack surface and no data.

---

## 4. What I could not verify

- **Rate limits.** GeckoTerminal's keyless limit (10 vs 30 calls/min) and the CoinGecko Demo-key limits for onchain endpoints are stated differently on different CoinGecko pages. The exact keyed host and header were not confirmed. DexPaprika's limits are taken from its own skill file, not measured.
- **DexPaprika details.** Only `/networks` was called live (it lists robinhood, monad, solana, base, ethereum). Not checked: how many Robinhood Chain and Monad pools it actually indexes, candle quality against GeckoTerminal, whether pool search can filter by DEX, and whether creation-date filters work on a free key. Its terms of use were not read; check that product use is allowed before depending on it (the Sparsity lesson).
- **The e2e failure** was diagnosed from the saved Playwright snapshot of the last run; the test was not re-run.
- **Stalled-index mechanism.** The fallback chain and the "fewest buyers" resolution are in the code, but I did not reproduce a stalled index live.
- **Helius portfolio values.** That a wallet's priced assets are available in one call is from Helius' reference file names and general knowledge, not a live call; credit cost unknown.
- **honeypot.is.** Supported chains, free limits and terms were not confirmed (the docs page did not come up in search).
- **Third-party repos.** Only source text was read, and not every file: `sendaifun/skills` `wallet-analysis` was not read; `malvaphe/Crypto_Honeypot_Detector` server and webapp packages were not read; `trailofbits/skills` was read only for the two plugins named. Published npm / PyPI packages were not compared with the GitHub source, so a package could differ from the repo: pin versions and prefer copying markdown over installing packages. Star counts were not checked for authenticity except where the pattern was obvious.
- **The download site `go-release.xyz`** was not opened, by design. The malware verdicts rest on the repository contents and account metadata.
- **Production behaviour.** No production KV, logs or Vercel settings were read; every claim about production comes from REPORT.md.

Sources for the rate-limit notes: [CoinGecko keyless API docs](https://docs.coingecko.com/docs/keyless-public-api), [GeckoTerminal API FAQ](https://apiguide.geckoterminal.com/faq), [CoinGecko rate-limit docs](https://docs.coingecko.com/docs/common-errors-rate-limit), [CoinGecko API pricing](https://www.coingecko.com/api/pricing), [honeypot.is docs](https://docs.honeypot.is).
