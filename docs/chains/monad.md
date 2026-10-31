# Monad mainnet: source discovery

Probed on 2026-10-29. Every address and endpoint below was called in this run. Scratch probes are kept outside the repo. Registry: `data/monad-infra.json`. RPCs: `data/monad-rpc-endpoints.json`. Fixtures: `docs/chains/monad-fixtures.json`.

## Chain facts

| | |
|-|-|
| Chain id | **143** (`eth_chainId` = `0x8f` on every public RPC). chainid.network lists 143 as "Monad" mainnet and 10143 as "Monad Testnet". docs.monad.xyz says Mainnet = 143. |
| Native / wrapped | MON (18 dec) / WMON `0x3bd359c1119da7da1d913d1c4d2b7c461115433a` |
| USDC | `0x754704bc059f8c67012fed69bc8a327a5aafb603` (6 dec) |
| Block time | **0.302 s** measured over 1,000 blocks on all 13 working RPCs. That is about 286k blocks/day and 858k blocks per 72h. |
| Head at probe | ≈117,605,000 |
| Explorers | MonadVision (BlockVision) and Monadscan (Etherscan). Socialscan has no usable API (see below). |
| Multicall3 | `0xca11bde05977b3631167028862be2a173976ca11` (canonical, verified) |

## Endpoint table

| Source | URL template | Auth | Rate limit (observed / documented) | TokenSnapshot fields | Sample response keys |
|-|-|-|-|-|-|
| Monad RPC (rotation) | `data/monad-rpc-endpoints.json` | none. Optional `MONAD_RPC_URL`. | rpc.monad.xyz: 0/20 429 in a burst; doc 25 rps. rpc2: 0/20; doc 300/10 s. rpc1: 9/20 429. monadinfra: 10/20 429. | tokenExists, totalSupply, name/symbol, deployer (creation-block bisection), holders (Transfer replay ≤ 24h), ownerRenounced, upgradeable, sellable/honeypot/roundTripLossPct (sim), freshWalletsTop20 (nonce), deployerHoldingPct, curveProgressPct | JSON-RPC |
| ↳ eth_getLogs span | — | — | **max 10,000 blocks (≈50 min)** on rpc2 and originstake only. 1,000 on rpc4/thirdweb/sentio/huginn/htw/spidernode. 100 on rpc/rpc1/rpc3/ankr/monadinfra/tatum. | — | — |
| ↳ eth_call state override | — | — | works on all 13 listed endpoints (`code` override; `stateDiff` used by the sim on rpc.monad.xyz). drpc refuses ("gas exceeds provider limit"). | sim | — |
| ↳ historical state | — | — | eth_getCode at an old block works on rpc2, monadinfra and originstake. rpc, rpc3 and ankr answer "Block requested not found". | creation-block bisection | — |
| ↳ eth_createAccessList | — | — | works (rpc, rpc2) | storage-slot discovery for the sim | `accessList[].storageKeys` |
| DexScreener | `https://api.dexscreener.com/tokens/v1/monad/<ca,ca…>` (≤30), `/latest/dex/tokens/<ca>` (all chains, filter `chainId==="monad"`), `/latest/dex/pairs/monad/<pair>` | none | 20/20 burst OK; doc 300/min | priceUsd, fdvUsd, liquidityUsd, volume24hUsd, poolCount, mainPool*, poolAddresses, buyTxs24h/sellTxs24h, sells24h, createdAt (pairCreatedAt), socialLinks (`info.socials`) | `chainId dexId url pairAddress labels baseToken quoteToken priceNative priceUsd txns{m5,h1,h6,h24} volume priceChange liquidity{usd,base,quote} fdv marketCap pairCreatedAt info` |
| ↳ slug / dexIds | chain `monad` | | | | dexIds seen: `nad-fun` (V1 v3 pools **and** V2 v2-pairs), `uniswap` (labels v2/v3), `pancakeswap` v3, `traderjoe` v1/v2.2, `atlantis-dex`, `dyorswap`, `monday-trade`, `noxa` v3, `octoswap`, `pinot`, plus a raw-address dexId. **nad.fun curve tokens (V1 and V2) return no pairs.** |
| GeckoTerminal | `https://api.geckoterminal.com/api/v2/networks/monad/tokens/<ca>/pools`, `/networks/monad/pools/<pool>/ohlcv/{minute,hour,day}`, `/networks/monad/new_pools` | none | **429 after ≈8–10 calls in a minute** (three times this run); doc 30/min | pools, liquidity, OHLCV → chart patterns, trendScore, launchRetraced30 | network id `monad`. dex ids: `uniswap-v4-monad uniswap-v3-monad uniswap-v2-monad pancakeswap-v3-monad capricorn-monad` (= nad.fun V1 DEX) `curve-monad balancer-v3-monad atlantis-monad`. Pool attrs `base_token_price_usd … address name pool_created_at fdv_usd market_cap_usd transactions volume_usd reserve_in_usd`. OHLCV `data.attributes.ohlcv_list [[t,o,h,l,c,v]]`. nad.fun V2 curve token → 404. |
| nad.fun API | `https://api.nad.fun/agent/{token,market,metrics,chart,swap-history}/<ca>` | optional `X-API-Key` (env **`NAD_API_KEY`**, the name nad.fun's docs use) | keyless: response header `x-ratelimit-limit: 10`, window 1m. With a key: 100/min (agent-api.md). 429 carries `retry_after`. | launchpad, isLaunchpad, createdAt (`created_at`), deployerAddress (`creator.account_id`), socialLinks, curve vs DEX (`market_type` CURVE / DEX / V2_CURVE / V2_DEX, `is_graduated`), holderCount (`holder_count`), priceUsd, buyers24h/sellers24h (`metrics[1D].makers`), buyTxs24h/sellTxs24h/sells24h (`transactions`), net flow (`volume.buy/sell`, MON), OHLCV (`chart`), per-wallet swaps (`swap-history?account_id=`) | token: `token_id name symbol image_uri description is_graduated twitter telegram website created_at creator{account_id} is_cto version`. market: `market_type token_id quote_info market_id reserve_native reserve_token price_usd total_supply volume ath_price holder_count`. metrics: `[{timeframe percent transactions{buy,sell,total} volume{buy,sell,total} makers{buy,sell,total}}]`. chart: `{k,t[],o[],h[],l[],c[],v[]}`. swap-history: `{swaps[{account_info,swap_info{event_type native_amount token_amount value market_cap_usd transaction_hash created_at}}], total_count}` |
| GoPlus | `https://api.gopluslabs.io/api/v1/token_security/143?contract_addresses=<ca>` | none | **10/20 OK in a burst, then `code 4029 "too many requests"`** | honeypot (`is_honeypot`), buy/sell tax, mintAuthority (`is_mintable`), verified (`is_open_source`), upgradeable (`is_proxy`), holderCount, top holders (`holders[]` top 10 with `is_contract`, `is_locked`), lp holders (v2/v4 NFT) | `anti_whale_modifiable buy_tax sell_tax cannot_buy dex[] external_call hidden_owner holder_count holders[] is_blacklisted is_honeypot is_in_dex is_mintable is_open_source is_proxy lp_holder_count lp_holders[] owner_balance owner_percent selfdestruct total_supply trading_cooldown transfer_pausable transfer_tax`. **No `creator_address` / `owner_address` for 143.** For nad.fun curve tokens only `holder_count holders total_supply cannot_buy is_in_dex=0`: no honeypot or tax verdict. GoPlus `dex[]` omits nad.fun pools (it lists Uniswap v4/v3/v2 and Pancake only). |
| Etherscan v2 (Monadscan) | `https://api.etherscan.io/v2/api?chainid=143&module=…` | **key required** (keyless → `"Missing/Invalid API Key"`). Env **`ETHERSCAN_API_KEY`**. | Etherscan chainlist: status 1, "Free-tier available". Not tested with a key. | (with key) deployer via `getcontractcreation`, verified source | — |
| BlockVision (MonadVision) | `https://api.blockvision.org/v2/monad/token/{holders,detail}…` | **key required** (keyless → HTTP 403 `{"code":-32002,"message":"apikey must"}`). Env **`BLOCKVISION_API_KEY`**. | not tested with a key | (with key) holder list / count | — |
| Kuru | on-chain `OrderBook.bestBidAsk()`, `getL2Book(uint256)`, `getMarketParams()` | none | RPC | none for memes: 9 markets (MON, WETH, cbBTC, XAUt0, NVDAx, SPYx, QQQx, TSLAx, EWYx), all quoted in USDC | `bestBidAsk()` on MON/USDC = 2047400 / 2050300 |

Calls that failed:
- `honeypot.is` with `chainID=143` returns `{"code":400,"error":"Invalid chain"}`.
- Routescan `/evm/143/` returns "chain not supported".
- Socialscan: `api.socialscan.io/monad*/…` returns 404, and `monad.socialscan.io/api` sits behind a Vercel security checkpoint.
- The MonadVision web API sits behind a Cloudflare challenge.
- RugCheck is Solana-only and was not applicable.

## Scanners

- **GoPlus supports 143.** `supported_chains` contains `{name:"Monad", id:"143"}`. A real query (CHOG) returned `is_honeypot 0`, taxes 0, 33,927 holders and top 10. For nad.fun **curve** tokens it returns holders only, with no honeypot or tax verdict.
- There is **no honeypot.is or RugCheck-style simulator for Monad**. For curve-stage tokens, **our own sell sim is the only sellability source.** For DEX tokens, GoPlus `is_honeypot` is a second opinion.

## DEXs and quoters (all verified, see registry)

| DEX | Factory / manager | Quote |
|-|-|-|
| Uniswap v4 | PoolManager `0x188d…9ea8e` | **Native V4Quoter `0xa222dd357a9076d1091ed6aa2e16c9742dd26891`**. `quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))` returns `(amountOut, gasEstimate)`. Pool key: `PositionManager(0x5b7e…4016).poolKeys(bytes25(poolId))` returns `(currency0,currency1,fee,tickSpacing,hooks)`. StateView `0x7739…9d64` `getSlot0/getLiquidity(bytes32)`. |
| Uniswap v3 | `0x204f…0498` | QuoterV2 `0x661e…f08d` `quoteExactInputSingle((address,address,uint256,uint24,uint160))`. Tested: 100 WMON → 2.058 USDC. |
| Uniswap v2 | `0x182a…0f59`, Router02 `0x4b2a…6804` | `getReserves()` math |
| PancakeSwap v3 | `0x0bfb…1865` | pool `slot0/liquidity/fee` math (no Pancake quoter verified) |
| nad.fun V1 DEX ("capricorn") | v3 factory `0x6b5f…b7f3` (1% fee, tickSpacing 200) | nad.fun V1 Lens `getAmountOut(address token,uint256 amountIn,bool isBuy)` returns `(router, amountOut)`. Real swap: DexRouter `sell((uint256 amountIn,uint256 amountOutMin,address token,address to,uint256 deadline))` returns `amountOut`. |
| nad.fun V2 pairs | factory `0xa25b…1001` (v2-style; pairs are 45-B EIP-1167 clones) | V2 router `0x8986…6f91` `getAmountOut(address,uint256,bool)` and `sell((uint256,uint256,address,address,uint256))`. **The V1 Lens reverts on V2 tokens** (`ERR_BONDING_CURVE_LIBRARY_INVALID_INPUTS`). |
| LFJ LB v2.2, Atlantis, DYORSwap, OctoSwap, Pinot (v2); Monday Trade, Noxa (v3) | see registry | v2 reserves / v3 slot0 math. Liquidity in the sampled meme pairs was < $1k on all of these. |
| Kuru | CLOB, majors and stocks only | `bestBidAsk()`. Not a meme venue. |
| Crystal, Bean | **not found**: no Crystal or Bean dexId in DexScreener or GeckoTerminal results for Monad. DefiLlama lists Crystal at ≈$22k TVL. | — |

Tested quote: CHOG Uniswap v4 MON/CHOG 5% pool, selling 10,000 CHOG → 581.50 MON, buyback → 8,790.49 CHOG. Round-trip loss is **12.10%** (two 5% fees plus impact). On the nad.fun V1 pool, 10 MON → CHOG → 9.703 MON, a **2.97%** loss.

## Sell-sim method (what works on Monad)

`robinhoodSim.ts` patches the mainnet V4Quoter bytecode and scans PoolManager `Initialize` logs. On Monad, do this instead:

1. **No bytecode patch.** Call the native V4Quoter `0xa222…6891` directly with plain `eth_call`.
2. **Pool key without a log scan.** Call `PositionManager.poolKeys(bytes25)` with the first 25 bytes of the pool id. This worked for the CHOG pool. An `Initialize` scan is not viable: logs are capped at 10k blocks, so 1 day takes about 29 calls and the pool's full history takes thousands.
3. **nad.fun tokens (most memes): use a real router sell inside eth_call with state overrides.**
   - Discover storage slots with `eth_createAccessList` on `balanceOf(F)` and `allowance(F, router)`. This works for both token layouts: V1 clones use OZ slots 0/1, V2 clones use a different hashed layout.
   - Call `eth_call({from:F, to:router, data: sell((amt, 1, token, F, now+600))}, "latest", {token:{stateDiff:{balKey:amt, allowKey:MAX}}})`.
   - **`amountOutMin` must be ≥ 1.** With 0, the call reverts `0x4e969c58 InvalidAmountOut()`.
   - Router choice. V1 graduated tokens go to the DexRouter `0x0b79…b137`. V1 curve tokens go to the BondingCurveRouter `0x6f6b…1a22`. V2 tokens, curve or DEX, go to the V2 router `0x8986…6f91`.
   - Result. `sell` returns amountOut. It matched `getAmountOut` exactly for CHOG (DEX), VIBE (V2 curve) and JAMES (V2 DEX).
   - This runs the token's real `transferFrom`, so it catches blacklists and transfer locks.
4. Limitation: a curve whose real MON reserve is 0 reverts with Panic 0x11 on any sell, as AKITAINU did (all buys sold back). Read it as "nothing to sell into" (liquidityPulled/dead), not as a honeypot.
5. Transfer probe: `transfer(fresh, 1e18)` from a GoPlus top holder succeeded for CHOG, both to a fresh address and to the nad.fun pool.
6. Uniswap v2/v3 and other forks: reserves / slot0 math (unchanged from robinhoodSim), or QuoterV2 for Uniswap v3.

## Launchpad detection recipes

**nad.fun V1** (vanity `…7777`):
- Bytecode is `0x363d3d37…73 7f64ccfeb3e3afd7691ea0ef404e947786cefae8 5af4…`, a 45-byte EIP-1167 clone of impl `0x7f64…fae8`.
- `CURVE(0xa728…0ace).createdAt(token)` returns the **creation block**, verified: CHOG gives 37,998,426, timestamp = API `created_at`.
- Graduation state: `isGraduated(token)`, `isLocked(token)`, `curves(token)` (8-word tuple, zeroed after graduation), `Lens.getProgress(token)` (0–10000).
- Events on CURVE:
  - `CurveCreate(address indexed creator,address indexed token,address indexed pool,string,string,string,uint256,uint256,uint256)` = `0xd37e3f4f…`
  - `CurveBuy` = `0x00a7ba87…`
  - `CurveSell(address,address,uint256,uint256)`
  - `CurveGraduate(address indexed token,address indexed pool)` = `0xa1cae252…`
- Creation tx.to = BondingCurveRouter `0x6f6b…1a22`. The DEX pool (v3 1%) is created at launch.

**nad.fun V2** (vanity `…7777`, API `version:"V2"`, `market_type` V2_CURVE / V2_DEX):
- Bytecode is a clone of impl `0x4f44eafa383fe5f97a0d6cff97fc5d605d026fbd`.
- `V2curve(0x9f38…4ae4).getCurve(token)` returns a 16-word tuple. word0 = token, word1 = creator (or the creation entry for JAMES), word2 = WMON, word14 = pair. **No published ABI for the reserve words.**
- `V2router(0x8986…6f91).isGraduated(token)`.
- Create event topic `0xac11ceed…` (topics: creator, token, pair).
- Creation tx.to is the V2 router (selector `0x6f7ae8c3`), or `0xa3dc…12bc` for JAMES.
- The pair is pre-created at launch in factory `0xa25b…1001`.

**Fast path for both:** `GET api.nad.fun/agent/token/<ca>` returns 200 with `token_info`. Fallback: `isGraduated` / `getCurve` answer non-zero.

**satsfun.markets**: v4 pools with hook `0x028a…60cc`, cbBTC-paired. 10 pools in 24h, none indexed by DexScreener.

Activity in the last 300k blocks (≈25h): 11 V1 creates, 9 V2 creates. 63 V1 graduations, of which 59 were batch-pushed between 10:14 and 10:16 UTC by `0x6f94…7881` via `0xbf73…e366`: tiny buys on long-dead curves. All the new capricorn pools on GeckoTerminal at that time show the same $5,286 liquidity and absurd FDVs. Treat them as dead, not as launches.

## LP lockers / burn

- **No LP locker verified on Monad.** UNCX and Team Finance were not found.
- nad.fun V1 graduated LP is minted to `0xcd68…a8c2`, which has `burn(int24,int24,uint128)` and `owner()` = nad.fun fee collector. That is **not a lock**.
- GoPlus `lp_holders[].is_locked` is the only lock signal. It was 0 for CHOG's v4 positions.
- `0x…dead` is treated as burn. GoPlus marks it `is_locked:1`.

## TokenSnapshot fields: Monad source map

| Field(s) | Source |
|-|-|
| name, symbol, totalSupply, tokenExists | RPC (`eth_getCode`, ERC-20 calls). **nad.fun tokens are 45-byte clones**: `tokenExists` must not require > 100 B. |
| priceUsd, fdvUsd, liquidityUsd, volume24hUsd, poolCount, mainPool*, liqFdvPct, poolAddresses | DexScreener / GeckoTerminal (DEX tokens). Curve tokens: nad.fun market `price_usd`; FDV derived (price × supply). |
| createdAt, ageHours | nad.fun `created_at`; V1 `createdAt(token)` block; other tokens via creation-block bisection on rpc2 or monadinfra (historical `eth_getCode`); DexScreener `pairCreatedAt` as lower bound |
| deployerAddress | nad.fun `creator.account_id` / CurveCreate topic1; others: tx.from of the creation tx found by bisection |
| launchpad, isLaunchpad, curveProgressPct | nad.fun API / V1 curve + Lens / V2 router `isGraduated` |
| holderCount | nad.fun `holder_count`, GoPlus `holder_count` |
| top1SharePct, top10SharePct, liquidityHolders | GoPlus `holders[]` (top 10 with `is_contract`); on-chain Transfer replay only for tokens < ~24h (29 × 10k-block calls on rpc2) |
| buyers24h, sellers24h, buyerSellerRatio, netFlowRatio24h/Usd, sells24h, buyTxs24h, sellTxs24h, makersCount, makersHoldersRatio | nad.fun metrics (nad.fun tokens incl. graduated); DexScreener txns (tx counts) for others |
| honeypot, sellable, roundTripLossPct, liquidityPulled | own sim (above) + GoPlus `is_honeypot` (DEX tokens only) |
| mintAuthority (EVM: mintable), verified, upgradeable, ownerRenounced | GoPlus `is_mintable`, `is_open_source`, `is_proxy`; RPC `owner()` and ERC-1967 slot (nad.fun clones have no `owner()` → renounced-by-design, EIP-1167 → not upgradeable) |
| devBuySharePct, devBuySol (→ MON) | creation tx receipt (CurveBuy in the create tx) |
| first5mSharePct, bundleSharePct, repeatedSizeSharePct, snipeRatioPct | curve Buy logs in the first blocks after creation (5 min ≈ 1,000 blocks = 1 getLogs call on rpc2) or nad.fun swap-history |
| freshWalletsTop20 | RPC `eth_getTransactionCount` |
| deployerHoldingPct, deployerSoldPct | RPC `balanceOf(creator)`; nad.fun `swap-history?account_id=<creator>` (tested, returns the creator's trades) |
| OHLCV → launchRetraced30, identicalCandleSharePct, staircase, hugeCandlesOnly, trendScore, upOnlyChart | GeckoTerminal (DEX pools), nad.fun `/agent/chart` (curve tokens) |
| socialLinks | nad.fun `twitter/telegram/website`; DexScreener `info.socials` |

**Permanently null on Monad, and why:**
- `freezeAuthority`: Solana concept, no EVM equivalent.
- `feesSol` and `feesPerMcap15k`: pump.fun-specific.
- `realSolReserves` and `curveCirculatingPct`: pump.fun-specific. nad.fun V1 `curves()` gives real MON reserves, but these fields are SOL-named.
- `bundleScore`, `organicScore`, `timingEntropy`, `fundingClusterMax`, `clusterSupplyPct`, `bundlerMajority`: these come from the pump.fun intel feed, and no Monad equivalent exists.
- `creatorPriorMints` / `creatorRugRatePct`: no Monad source. Partially derivable from nad.fun `/agent/token/created/<creator>`, which was not tested.
- `smartMoneyNetUsd` and `smartBuyers`: no labelled-wallet source.
- `assetKind`: HoodScan-only. Meme classification must come from the nad.fun / launchpad origin plus a blue-chip list.
- `lpLockedPct`: no verifiable locker. nad.fun LP is owner-controlled.
- `accumulator*`, `earlyCohortSize`, `earlyExitRatePct`, `earlyRetentionPct`, `insiderNetworks` for established tokens: these need full per-wallet swap history since launch. RPC replay of CHOG's 79.6M blocks is about 8,000 calls. It might be possible via nad.fun `swap-history` paging with `NAD_API_KEY`, which was not tested at scale.

## Factors that can be built

`launch_robinhood` set:
- **Can feed (all nad.fun launches):**
  - `vol_mc` (nad.fun volume + derived FDV)
  - `dev_buy_share` (create-tx CurveBuy)
  - `bundle_share`, `first5m_share`, `repeated_size` (first-1,000-block curve logs)
  - `launch_retrace`, `chart_identical`, `chart_staircase`, `chart_huge` (nad.fun chart)
  - `sellable` (router-sell sim), `launchpad`, `owner_renounced`, `upgradeable`
  - `top_holder`, `top10_share` (GoPlus or Transfer replay)
  - `fresh_wallets` (nonce)
  - `holders_vs_makers` (nad.fun makers / holder_count)
  - `deployer_sold` (swap-history by creator)
  - `buyer_seller_ratio`, `unique_buyers`, `net_flow_24h`, `sell_count` (nad.fun metrics)
  - `trend` (chart), `round_trip_loss` (sim)
- **Cannot:** `lp_lock` (no locker; null with reason).
- **Non-nad.fun launches** (e.g. raw Uniswap v2 spam, satsfun v4): fall back to DexScreener / GeckoTerminal. Unique buyers there are null, because they need tx.from for every Swap log.

`established` set:
- **Can feed:**
  - `top10_share`, `top_holder` (GoPlus)
  - `deployer_holding` (balanceOf)
  - `deployer_sold` (nad.fun swap-history, nad.fun tokens only)
  - `net_flow_24h`, `buyer_seller_ratio` (nad.fun metrics for nad.fun tokens; else null)
  - `flow_consistency` (metrics 1/5/60/1D timeframes)
  - `round_trip_loss`, `sellable` (sim)
  - `mint_authority` (GoPlus `is_mintable`), `verified` (GoPlus `is_open_source`; Etherscan needs a key)
  - `owner_renounced`, `upgradeable`, `launchpad`
  - `liq_fdv`, `main_pool_share`, `pool_count` (DexScreener / GeckoTerminal)
  - `liq_change_24h/7d` (own history store)
  - `trend` (GeckoTerminal OHLCV)
- **Partial:**
  - `single_trade_share`, `trades_per_wallet`, `wash_trade`: nad.fun swap-history paging, 10/min keyless.
- **Cannot:**
  - `accumulator_count`, `accumulator_supply`, `early_retention`, `bundlers_flushed`: there is no swap index.
  - `smart_money_net`: no source.
  - `freeze_authority`: not applicable on EVM.
  - `lp_lock`: no locker.

## Could not be sourced

- An Etherscan v2 / Monadscan response for 143. It needs `ETHERSCAN_API_KEY`, and holder-list endpoints are documented as Pro-only (not tested).
- BlockVision / MonadVision holders. They need `BLOCKVISION_API_KEY`.
- A Socialscan API for Monad.
- Routescan support (it does not support 143).
- Any honeypot.is-style simulator for 143.
- Crystal and Bean exchange contracts. Neither appears as a dexId with liquidity.
- A PancakeSwap v3 quoter. It was not looked up; slot0 math is used instead.
- A published nad.fun V2 ABI. The `getCurve` reserve words are unlabelled, so V2 curve real liquidity is not stated. The V2 router `getAmountOut`/`sell` work.
- The meaning of V2 curve event `0x9cf337bf…`, seen once at VIBE creation.
- A Monad LP locker contract.
- A swap index with full per-wallet history (HoodScan equivalent).

## Env vars

- `MONAD_RPC_URL`: optional private RPC, which goes first. Use one with getLogs ≥ 10k blocks and archive state.
- `NAD_API_KEY`: optional. Raises nad.fun from 10 to 100 req/min. Sent as the `X-API-Key` header.
- `ETHERSCAN_API_KEY`: optional, Monadscan via Etherscan v2.
- `BLOCKVISION_API_KEY`: optional, MonadVision.

## Code notes for the implementer (lib/ untouched by this run)

- `isInfrastructure(codeKind)` treats contracts ≤ 100 B as wallets. **nad.fun V2 pairs are 45-byte clones and nad.fun V2 core contracts are 163-byte proxies.** Register them, or treat an EIP-1167 or ERC-1967 proxy prefix as a contract. Otherwise the pair will show up as a top "wallet" holder.
- `robinhoodSim` `SPAN = 9,000,000` getLogs windows do not work on any Monad RPC (max 10,000). Use `poolKeys(bytes25)` and nad.fun getters instead of log scans.
- Mass graduations of dead V1 curves (10:14Z today) create fresh-looking capricorn pools with $5,286 liquidity. Do not treat pool age as token age; use `createdAt(token)` or nad.fun `created_at`.
