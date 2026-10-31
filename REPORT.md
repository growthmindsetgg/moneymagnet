# Top-holder classification fix (2026-10-29, after v3)

**Status:** committed as `6fccb4b`, **not deployed**. The `vercel --prod --yes` step was refused by this session's permission check. Production still runs `hoodtier-djqef87nn`, the v3 build.

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
