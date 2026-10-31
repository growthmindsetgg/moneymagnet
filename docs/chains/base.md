# Base (8453): source discovery

Run 2026-10-29, 11:50–12:40 UTC. Every endpoint below was called in this run, and every address was checked with `eth_getCode` plus a call that proves what it is. The registry is `data/base-infra.json` (86 entries, each with how it was identified). Public RPCs are in `data/base-rpc-endpoints.json`, fixtures in `docs/chains/base-fixtures.json`. Scripts stayed in the session scratchpad. No file under lib/, app/, components/ or tests/ was touched.

## Chain facts
- Chain id 8453 (`eth_chainId` 0x2105). Head was about 53.24M blocks, with ~2 s blocks: 585 blocks took 21 min (11:31:49Z to 11:53Z).
- WETH is the OP-stack predeploy `0x4200…0006`. Native USDC is `0x8335…2913`.
- Uniswap v4 PoolManager is `0x4985…2b2b`, 24,009 B, the same size as Robinhood's. It sees about 1,121 `Initialize` logs per 20k blocks (~11 h), and 4,612 distinct hooks appeared in 400k blocks.
- **Creation `tx.to` is unreliable on Base.** Clanker launches go through wrappers (e.g. `0x0b86…1065`, "Fatliners" `0xb54c…3016` with `clanker()`=factory). Zora and Doppler coins are often created by ERC-4337 smart wallets (`tx.to` = EntryPoint v0.6 `0x5ff1…2789` or v0.7 `0x0000…a032`). Use the **first-mint recipient** and the factory's own event instead (recipes below).

## Endpoint table

| Source | URL template | Auth | Rate limit (observed / documented) | TokenSnapshot fields | Sample response keys |
|---|---|---|---|---|---|
| GoPlus | `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=<ca>` | none | **~10 calls per burst, then `{"code":4029,"message":"too many requests"}` with HTTP 200.** 40 concurrent: 9 ok / 31 × 4029. Sequential: 10 ok in 2 s, then 4029. After a 60 s pause it was ok again. With 7 s spacing, 8/8 ok. A multi-address call came back 4029 during the cooldown, so it is untested. | honeypot\*, ownerRenounced\*, mintAuthority\*, upgradeable\*, verified\*, lpLockedPct\*, holders (top 10), top10SharePct, top1SharePct, holderCount, deployerAddress, deployerHoldingPct | `code, message, result{<ca>:{…}}`; see the field list below |
| Etherscan v2 (Basescan) | `https://api.etherscan.io/v2/api?chainid=8453&module=contract&action=getcontractcreation&contractaddresses=<ca>` / `…action=getsourcecode&address=<ca>` | **key; the free plan does not cover Base** | Keyless calls return `{"status":"0","message":"NOTOK","result":"Free API access is not supported for this chain. Please upgrade your api plan…"}` for getcontractcreation and `"Missing/Invalid API Key"` for getsourcecode. Not callable with a key in this run. | deployerAddress, createdAt, verified, upgradeable, once a paid key is set | only the error shape `status, message, result` was observed |
| Basescan v1 | `https://api.basescan.org/api?…` | n/a | `"You are using a deprecated V1 endpoint, switch to Etherscan API V2"` | none | error only |
| Blockscout | `https://base.blockscout.com/api/v2/…` and `/api?module=…` | none | **HTTP 403 Cloudflare challenge** to plain server requests from this host. It was not bypassed, so it is unusable server-side as observed. | none | HTML challenge page |
| Routescan | `https://api.routescan.io/v2/network/mainnet/evm/8453/etherscan/api?…` | none | `{"status":"0","message":"chain not supported"}` | none | error only |
| DexScreener | `https://api.dexscreener.com/latest/dex/tokens/<ca>`; `…/tokens/v1/base/<ca,…≤30>`; `…/latest/dex/pairs/base/<pair or v4 poolId>` | none | 60 concurrent requests on each endpoint: 60/60 HTTP 200, no rate headers. Documented limit is 300 req/min. | priceUsd, fdvUsd, liquidityUsd, volume24hUsd, poolCount, mainPool*, poolAddresses, buyTxs24h, sellTxs24h, sells24h, lastTradeHoursAgo (lower bound), name, symbol, socialLinks (from `info`) | `chainId, dexId, url, pairAddress, labels[v3/v4/CLAMM], baseToken, quoteToken, priceNative, priceUsd, txns{m5,h1,h6,h24}, volume, priceChange, liquidity{usd,base,quote}, fdv, marketCap, pairCreatedAt, info` |
| GeckoTerminal | `https://api.geckoterminal.com/api/v2/networks/base/tokens/<ca>/pools?page=1`; `…/networks/base/pools/<pool or v4 poolId>/ohlcv/{minute,hour,day}`; `…/networks/base/tokens/<ca>`; `…/new_pools`, `…/trending_pools?duration=`, `…/dexes`, `…/dexes/<dex>/pools` | none | 36 calls within ~1 s all returned 200 (same URL, probably cached). The next call got **429** with `retry-after: 0`, and 429 then persisted for **3–15 min**. Documented limit is 30 calls/min. | as the Robinhood adapter: pools, reserve, fdv, price, buyers24h/sellers24h (per pool), sells24h, tradesPerWallet, OHLCV patterns, trendScore | pool `attributes`: `address, name, pool_created_at, reserve_in_usd, fdv_usd, market_cap_usd, base_token_price_usd, volume_usd{h24…}, transactions{h24{buys,sells,buyers,sellers}}, price_change_percentage`; relationships `base_token, quote_token, dex` |
| Base RPC (public) | see `data/base-rpc-endpoints.json` | none | publicnode: logs up to 50k blocks, logs served back ≥ 2M blocks, archive refused at head − 5M, 158 ms, 0/20 429. blxrbdn: 50k blocks, pruned before 51.5M. tenderly: logs 1k blocks, archive state ok. drpc: logs 100 blocks, archive state, callTracer. mainnet.base.org: **every eth_getLogs 429 −32011** | sellable, honeypot, roundTripLossPct, liquidityPulled, ownerRenounced, upgradeable, totalSupply, tokenExists, creation (block/tx/deployer/launchpad), holders (Transfer replay, young tokens), deployer*, early cohort, bundle/first-5-min shares, LP lock | JSON-RPC |

\* GoPlus values are **claims**: GoPlus's own simulation or static analysis, not our measurement. Use them as a second source and verify on-chain where possible (see the mapping).

GeckoTerminal Base dex slugs seen on BRETT pools: `uniswap-v2-base, uniswap-v3-base, uniswap-v4-base, aerodrome-base, aerodrome-slipstream, aero-slipstream-base, pancakeswap-v3-base, baseswap, squadswap-base, hydrex-integral`. On other pools: `aerodrome-slipstream-2, aerodrome-slipstream-3, virtuals-base, virtuals-unicorn-base, bankr, o1-launchpad`. Full list: `GET /networks/base/dexes` (2 pages). `aero-volatile-base` exists, but its pool list came back empty.

DexScreener `dexId` values on Base include `aerodrome, uniswap (labels v2/v3/v4), pancakeswap, aero, baseswap, sushiswap, hydrex (label CLAMM)`. Unknown DEXs appear as a raw factory address, e.g. `0xba34…eef9`. **`pairCreatedAt` is missing on some Aerodrome pairs** (BRETT's main Slipstream pair). `/tokens/v1/base/<ca>` returned only 1 pair for BRETT, against 30 from `/latest/dex/tokens`, so use the latter for pool lists.

### GoPlus field list (BRETT: 39 keys; TOSHI: 33; USDC: 19 — the key set varies per token)
`anti_whale_modifiable, buy_tax, can_take_back_ownership, cannot_buy, cannot_sell_all, creator_address, creator_balance, creator_percent, dex[{liquidity_type,name,liquidity,pool_fee,pair}], external_call, hidden_owner, holder_count, holders[top 10 {address,tag,is_contract,balance,percent,is_locked}], honeypot_with_same_creator, is_anti_whale, is_blacklisted, is_honeypot, is_in_dex, is_mintable, is_open_source, is_proxy, is_whitelisted, lp_holder_count, lp_holders[{address,tag,value,is_contract,balance,percent,NFT_list[{value,NFT_id,amount,in_effect,NFT_percentage}],is_locked}], lp_total_supply, owner_address, owner_balance, owner_change_balance, owner_percent, personal_slippage_modifiable, selfdestruct, sell_tax, slippage_modifiable, token_name, token_symbol, total_supply, trading_cooldown, transfer_pausable, transfer_tax`.
- `percent` fields are **fractions** (BRETT top holder `0.115…` = 11.5%). TOSHI came back with no `buy_tax`/`sell_tax` and an empty `dex`. ADOF had `buy_tax: ""`. Empty string or missing means null, never 0.

| GoPlus field | TokenSnapshot | Kind | Verify on-chain with |
|---|---|---|---|
| `is_honeypot`, `cannot_sell_all`, `buy_tax`/`sell_tax` | honeypot (second source only) | claim (GoPlus sim) | our sell sim (below). 小小徐 got `is_honeypot 0` after its liquidity was pulled. |
| `owner_address` (0x0 / dead ⇒ renounced), `can_take_back_ownership`, `hidden_owner` | ownerRenounced | owner = read of `owner()`; the other two are static analysis | `eth_call owner()` |
| `is_mintable` | mintAuthority | claim (static analysis) | none cheap; a bytecode selector scan is derived, not proof |
| `is_proxy` | upgradeable | claim | `eth_getStorageAt` EIP-1967 slot `0x3608…2bbc` / beacon slot |
| `is_open_source` | verified | claim (explorer verification status) | Etherscan v2 getsourcecode (paid key) |
| `lp_holders[].is_locked`, `percent` | lpLockedPct | claim (GoPlus locker list) | LP NFT `ownerOf` / v2 LP `balanceOf` against registered lockers and burn |
| `holders[]` (top 10, `is_contract`) | holders, top10SharePct, top1SharePct | indexer measurement; includes pools and lockers | exclude infra (`is_contract` + registry); Transfer replay for young tokens |
| `holder_count` | holderCount | indexer measurement | none on RPC |
| `creator_address`, `creator_percent` | deployerAddress, deployerHoldingPct | indexer | archive bisection of the creation block + `balanceOf(deployer)` |
| `honeypot_with_same_creator` | (no metric; evidence for creatorRugRatePct only with a prior-mint total, which GoPlus does not give) | claim | none |
| `dex[]` | poolAddresses (second source) | claim | pool `factory()` |

## DEXs and quoters (all verified; see the registry)
- **Uniswap v2.** Factory `0x8909…8ec6`, Router02 `0x4752…aD24`.
- **Uniswap v3.** Factory `0x3312…FdfD`, QuoterV2 `0x3d4e…B76a`, SwapRouter02 `0x2626…e481`, NPM `0x03a5…34f1`.
- **Uniswap v4.** PoolManager `0x4985…2b2b`, V4Quoter `0x0d5e…048D`, StateView `0xA3c0…7A71`, PositionManager `0x7C5f…9bDc`, Universal Router `0x6fF5…9b43`.
- **Aerodrome.** PoolFactory (v2 volatile/stable) `0x420D…40Da`, Router `0xcF77…4E43`. Slipstream CLFactory `0x5e7B…809A` with QuoterV2 `0x254c…15b0`, SwapRouter `0xBE6D…18a5` and NPM `0x8279…5b72`.
- **Three more CL factories.** `0x9cb2…7a76` (GT `aero-slipstream-base`, its own voter), `0xade6…716a` (`aerodrome-slipstream-2`) and `0xf8f2…61ef` (`aerodrome-slipstream-3`). The Slipstream quoter has no deployed twin for these; patch it (below).
- **PancakeSwap v3.** Factory `0x0BFb…1865`, QuoterV2 `0xB048…5997`.
- **Minor DEXs.** BaseSwap, Hydrex and SquadSwap factories.

### Live quote, 1000 BRETT → WETH (~11:58 UTC)

| Venue | Call | Result |
|---|---|---|
| Uniswap v2 | `Router02.getAmountsOut(1000e18,[BRETT,WETH])` | 0.0019264 WETH |
| Uniswap v3 1% | `QuoterV2.quoteExactInputSingle((BRETT,WETH,1000e18,10000,0))` | 0.0019442 (gas 88,359) |
| Uniswap v4 (no hook, 0.03%) | `V4Quoter.quoteExactInputSingle(((ETH,BRETT,300,6,0x0),false,1000e18,""))` | 0.0019541 ETH |
| Aerodrome v2 volatile | `Router.getAmountsOut(1000e18,[(BRETT,AERO,false,0x420d…)])` = `pool.getAmountOut(1000e18,BRETT)` | 6.6884 AERO |
| Slipstream CL | `QuoterV2.quoteExactInputSingle((BRETT,WETH,1000e18,200,0))` | 0.0019688 |
| CL factory `0x9cb2…` | the same call on the Slipstream quoter code with `5e7bb104…809a` replaced by `9cb22058…7a76` (3 occurrences), injected via state override | 0.0019687 |
| PancakeSwap v3 0.25% | `QuoterV2.quoteExactInputSingle((BRETT,WETH,1000e18,2500,0))` | 0.0016952 |

Hooked v4 pools went through the **deployed V4Quoter**. Round trip is 0.001 ETH (or 1 quote unit) bought, then the received tokens sold:

| Pool | Round-trip loss |
|---|---|
| Clanker hook, '99' | 0.73% |
| Clanker hook, CABLEFABLE | 2.40% |
| Zora, ADFO | 2.00% |
| Zora, DOAS | 2.23% |
| Doppler, wtCOIN | 5.51% |

Fresh Clanker, Flaunch, b2-vanity and `0xbb77` pools quote the buy, but the sell reverts with `UnexpectedRevertBytes(NotEnoughLiquidity(poolId))` (`0x6190b2b0` wrapping `0x7a5ed734`). These are single-sided launch positions with no liquidity below the start tick. The quoter runs on current state, so the buy is not applied before the sell.

## Sell-sim method (recommendation)
The Robinhood approach carries over, simplified:

1. **Pools.**
   - Use DexScreener `/latest/dex/tokens/<ca>` (≤ 30 pairs) plus GT pools.
   - v2/v3/CL pools: call `factory()` on each pool address and match it to a registered factory. That also gives the venue.
   - v4 ids: get the pool key from `PositionManager.poolKeys(bytes25(poolId))`, which worked for Clanker and BRETT pools. Zora coins have `coin.getPoolKey()`.
   - If neither works, fall back to the PoolManager `Initialize(bytes32 indexed id, …)` log. Filtering by `topic1 = id` is cheap but needs the pool's creation window: publicnode serves 50k-block spans and history ≥ 2M blocks back.
2. **Quote.** No bytecode patching is needed for v2/v3/v4/Slipstream/Pancake, because the quoters are deployed on Base. Pass `from` = a real holder (as robinhoodSim) and cap `gas` at ~3M. Exact selectors:
   - v4: `V4Quoter 0x0d5e…048D` `quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))` → `(uint256 amountOut, uint256 gasEstimate)`. Same encoder as `encodeQuote` in robinhoodSim; `hookData` is empty.
   - v3: `QuoterV2 0x3d4e…B76a` `quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96))` → `(amountOut, sqrtPriceX96After, ticksCrossed, gasEstimate)`. PancakeSwap uses the identical ABI on `0xB048…`.
   - Slipstream: `QuoterV2 0x254c…15b0` `quoteExactInputSingle((address,address,uint256,int24 tickSpacing,uint160))`.
     - For the other CL factories (`0x9cb2…`, `0xade6…`, `0xf8f2…`), state-override the same code at a scratch address with the factory address replaced. Verified on all three.
     - The pool's `factory()` and `tickSpacing()` give the parameters.
   - Aerodrome v2: `pool.getAmountOut(uint256,address tokenIn)` on the pair, or `Router.getAmountsOut(uint256,(address from,address to,bool stable,address factory)[])`. This handles stable pools; Uniswap's 0.3% x·y=k formula in `simV2` is **wrong for Aerodrome**, whose fees are per pool and whose stable pools use x³y+y³x.
   - Uniswap v2 / BaseSwap: `Router02.getAmountsOut(uint256,address[])`, or reserves with the pair's fee. BaseSwap's fee is 0.25% per GoPlus `dex[].pool_fee`, a claim.
3. **Transfer probes** from a real holder, as on Robinhood:
   - `eth_call transfer(fresh, amt)` and `transfer(custody, amt)`.
   - Custody is the PoolManager for v4, and the pair/pool for v2/v3/CL.
   - All usable public RPCs accept state overrides, including `stateDiff` and `state`.
4. **Single-sided launch pools (NotEnoughLiquidity on the sell).** Report them as **dry/unbuyable-back, not honeypot**. Do the same when the in-range `StateView.getLiquidity(id)` is 0.
   - A true buy-then-sell needs a sim contract that runs both swaps inside one `PoolManager.unlock` callback, injected by state override.
   - That is not built. With today's quoter-only method these pools give `sellable: null` with the reason stated.
5. **Liquidity pulled.** Read the pool's quote-token `balanceOf(pool)` on-chain. 小小徐's pool holds 0.0015 USDC, while DexScreener and GeckoTerminal both still say $2.24M. Indexer liquidity on Base can be badly stale.

Use `base-rpc.publicnode.com` for logs (50k span) and any endpoint in the list for `eth_call` overrides. drpc had the lowest latency (78 ms) but gave 2/20 429s and only 100-block logs.

## Launchpad detection recipes (each verified on real tokens)
Generic first step: find the creation block by bisecting `eth_getCode(token, block)` on an archive endpoint (tenderly or drpc, ~26 calls). Then run `eth_getLogs` with `Transfer(from=0x0)` on that block, which gives the mint tx, the **mint recipient**, and `tx.from` = deployer. publicnode/blxrbdn cannot do this, because historical state is refused.

| Launchpad | On-chain test | Verified on |
|---|---|---|
| **Clanker v4** | First mint recipient = factory `0xE85A…83a9`. Or a `TokenCreated` log in the creation receipt: topic0 `0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67`, token = topic1. Or the token's `admin()`/`originalAdmin()`/`metadata()`/`context()` views. Pool hook ∈ {`0xb429…28cc`, `0xd60d…68cc`, `0xdd5e…68cc`}. | 99 (tx.to wrapper `0x0b86…`), 小小徐 (tx.to = factory), FATLINE (wrapper "Fatliners"), CLOWDER views |
| Clanker v3.1 | Factory `0x2a78…7382`, TokenCreated `0x6b04d68c…` (topic1 = token). | token `0x2e0f…4953`, block 27,733,501 |
| Clanker v3 | Factory `0x375C…2c5E`; first event topic0 `0x8df367d1…`, data word 0 = token. | MTK `0x131a…1e5f` |
| Clanker v2 / pre-v2 | Factories `0x7325…3833`, `0x9B84…c3e1`, TokenCreated `0x0e9d60e5…` (data word 0 = token). | tt `0x0707…2984`, tt `0x1b44…af12` |
| Clanker (earliest) | Factory `0x250c…aea47`, TokenCreated `0xcd465ace…`. | TEST `0x1070…011c` |
| Clanker-compatible | Factories `0x04f1…7760`, `0xd850…c8cb` (same `deployToken` 0xdf40224a, other owners). | Zetta, DRCAT |
| **Zora** | Creation `tx.to` = ZoraCoinFactory `0x7777…baf3` (proxy, `contractName()` = "ZoraCoinFactory"), unless sent by a 4337 wallet. **Mint recipient = the coin itself**, so the factory log is the reliable test: CoinCreatedV4 `0x2de43610…` from the factory, coin = data word 4. Token views: `platformReferrer()`, `payoutRecipient()`, `currency()`, `getPoolKey()`, `hooks()` = `0x0469…50c0`, `contractVersion()` ("2.6.0"). | ADFO, ADOF (tx.to = factory), DTCC HEDERA, RIPPLE USD |
| **Doppler (Bankr)** | First mint recipient = Airlock `0x660e…8d12`. Or `Airlock.getAssetData(token)`: non-zero numeraire; poolInitializer `0xbdf9…6544` for Bankr-style coins. Or Airlock `Create` log `0x68ff1cfc…`, asset = data word 0. `tx.to` is usually an EntryPoint. | Robitaxi, Ratspeak (GT dex `bankr`), wtCOIN |
| **Flaunch** | First mint recipient = Flaunch PositionManager `0x2332…2fdc`. Token `flaunch()` = Flaunch NFT `0x516a…0109` ("Flaunch Revenue Streams"). Creation `tx.to` = FlaunchZap `0x3911…10f9`. Pool hook = the PositionManager, quote = flETH. | DWPAProbe2, QATEST. **None of the 442 Flaunch pools initialized in the last 400k blocks has a DexScreener listing.** |
| **Virtuals** | v1: token `owner()` = Bonding `0xF66D…3259`, and `Bonding.tokenInfo(token)` returns (creator, token, FPair, …). v2 ("unicorn"): the token's FPair `router()` = FRouter v2 `0xbfce…3f95` (`bondingV2()` = `0xc353…958d`); the token is an EIP-1167 clone with `owner()` `0xe220…2567` = the Bonding v1 owner. Graduated pairs are against VIRTUAL. | ALIENS (v1), ECC (v2). No Virtuals launch event in the last 49k blocks. |
| b2-vanity launchpad (name unconfirmed) | Factory `0x1176…a3dc` / `0x53c5…81ee` (`hook()`), tokens `0xb2000000000000000000…`; memes quoted against tokenized-stock coins (NVDAc …). | BUDDIES, MBG |

Code note: `launchpadOfFactory(creation.factory)` (tx.to) misses Clanker wrapper launches and every 4337-wallet launch. On Base, match **`creation.mintedTo`** and the factory event as well. Never treat the EntryPoints as launchpads; they are registered as `router`.

## LP lockers / burn
- **Clanker v4 LP locker** `0xFFA3…0762`: receives the PositionManager LP NFTs in every deployToken tx (5 NFTs in tx 0x045c45ea…).
- **Clanker v3.1 locker** `0x33e2…c8f9`; Clanker v2-era locker `0x618a…417D`.
- **UNCX:** UniswapV2Locker `0xc4e6…4131` (`uniswapFactory()` = v2 factory), UNCX V4 Lock `0x610b…8502` (`name()` "UNCX V4 Lock"), and UNCX V3 `0x2312…bcc1` (owner only, medium confidence).
- **Team Finance:** `0x4f0f…c33a` answers `depositId()` but proves nothing more, so it is **not registered**.
- Doppler assets use `0x…dEaD` as timelock/governance.
- **Zora and Flaunch** keep liquidity inside their hook / PositionManager, not in an NFT held by a locker. Lock status for those is "held by launchpad contract", not "locked by a locker", and must say so.

## Funding-graph clustering via RPC (what is possible)
- **No address index.** No public endpoint answers "transactions of wallet X":
  - `trace_filter`: drpc times out on the free plan, pocket says not supported, tenderly 429.
  - Etherscan's `txlist` needs a paid key for Base.
  - Blockscout is behind Cloudflare.
- **ERC-20 funding only.** `eth_getLogs(Transfer, topic2 = wallet)` over 50k-block windows on publicnode, back ≥ 2M blocks (~46 d). That is 40 calls per wallet for full retention, and older history is refused. It cannot see native-ETH funding, which is the usual way wallets are funded.
- **Per-tx native transfers:** `debug_traceTransaction(callTracer)` works on drpc and pocket, but only when the tx hash is already known.
- **Usable cheap signals:** `eth_getTransactionCount(wallet)` (nonce 0 = never sent a tx; this is not wallet age) and `eth_getBalance`. Same-block buyers (bundle) come from Transfer logs of the launch block.
- **Not possible on public RPC:**
  - fundingClusterMax and clusterSupplyPct (common ETH funder);
  - freshWalletsTop20 as "wallet age". Only a nonce-based proxy can be derived, and it must be labelled "derived: nonce 0".

## TokenSnapshot fields: permanently null on Base, and why
- `freezeAuthority`: an SPL concept; ERC-20s have none. GoPlus `is_blacklisted`/`transfer_pausable` are different properties and must not be mapped into it. The null reason: "EVM token: no freeze authority".
- `feesSol`, `feesPerMcap15k`, `devBuySol`, `realSolReserves`, `curveProgressPct`, `curveCirculatingPct`, `deadCurve`: pump.fun / SOL-specific.
  - Zora, Flaunch and Virtuals curves exist, but their state is not the pump.fun curve, so these stay null unless new metrics are defined.
- `bundleScore`, `organicScore`, `snipeRatioPct`, `feedWindow`, `timingEntropy`, `bundlerMajority`: no pump.fun-feed equivalent for Base.
- `smartMoneyNetUsd`, `smartBuyers`: no labelled smart-money source on Base (keyless).
- `fundingClusterMax`, `clusterSupplyPct`, `creatorPriorMints`, `creatorRugRatePct`: need an address index (see above).
  - `creatorPriorMints` is possible only for one factory: count TokenCreated logs with topic2 = creator, Clanker v4 only. That is not a total across launchpads.
- `assetKind`: HoodScan-only classification. Base would need the meme filter plus registry instead.
- `swapHolders`, and everything derived from per-wallet lifetime buy/sell counts (`accumulatorCount`, `accumulatorSupplyPct` for tokens older than ~46 d): no swap index. These are feasible only for tokens inside publicnode's log retention, by replaying Transfer and Swap logs.
- `holderCount` is GoPlus-only, an indexer claim. There is no RPC equivalent.

## Factors that can be built (from lib/scoring/factors.json)

`launch_robinhood` set (used for Base launches < 72 h):

| Factor (metric) | Base source | Status |
|---|---|---|
| vol_mc (volMcVsBar) | DexScreener volume24h / fdv | yes. Zora fdv ≈ "liquidity" (single-sided), so liquidity is not used here. |
| dev_buy_share (devBuySharePct) | creation receipt Transfer logs (Clanker devBuy extension, Zora initial buy) | yes, derived |
| bundle_share (bundleSharePct) | Transfer logs of the creation block(s), publicnode | yes |
| first5m_share (first5mSharePct) | Transfer logs of the first 150 blocks | yes |
| repeated_size (repeatedSizeSharePct) | Transfer/Swap logs since creation | yes |
| launch_retrace / chart_identical / chart_staircase / chart_huge | GeckoTerminal OHLCV (works for v4 pool ids) | yes, rate-limited |
| sellable (gate) | sell sim above | yes; null for untouched single-sided pools |
| lp_lock (lpLockedPct) | LP NFT owner vs registered lockers; v2 LP `balanceOf(locker/burn)`; GoPlus `lp_holders.is_locked` as second source | yes |
| launchpad (isLaunchpad) | recipes above | yes |
| owner_renounced (ownerRenounced) | `owner()` eth_call + GoPlus | yes |
| upgradeable | EIP-1967 slots + GoPlus `is_proxy` | yes |
| top_holder / top10_share | Transfer replay (young tokens) or GoPlus top 10 minus infra | yes |
| fresh_wallets (freshWalletsTop20) | nonce-0 proxy only | partial, derived, must be labelled |
| holders_vs_makers (makersHoldersRatio) | GT buyers+sellers (main pool) / holderCount (replay or GoPlus) | yes |
| deployer_sold (deployerSoldPct) | Transfer logs from deployer (young token, full history in retention) | yes |
| buyer_seller_ratio, unique_buyers (buyers24h) | GeckoTerminal per-pool counts (≥ 90% volume rule as now) | yes |
| net_flow_24h (netFlowRatio24h) | Swap logs over 43,200 blocks (v4 `Swap` topic1 = poolId; v2/v3/CL on the pair address) | yes, derived |
| sell_count (sells24h) | DexScreener / GT | yes |
| trend (trendScore) | OHLCV | yes |
| round_trip_loss | sell sim | yes |

`established` set:

| Factor (metric) | Base source | Status |
|---|---|---|
| top10_share / top_holder | GoPlus top 10 (exclude `is_contract` infra) | yes (indexer); replay only < ~46 d |
| accumulator_count / accumulator_supply | needs lifetime per-wallet buys/sells | **no** for tokens > ~46 d (logs refused); yes for younger |
| early_retention / bundlers_flushed | archive bisection → creation block → early Transfer logs via tenderly (1k-block windows around creation) → current `balanceOf` | yes, derived |
| deployer_holding | `balanceOf(deployer)` | yes |
| deployer_sold | deployer Transfer history; > 46 d needs archive logs (1k-block windows: impractical) | partial |
| net_flow_24h, single_trade_share, trades_per_wallet, wash_trade | Swap logs 24h + GT counts | yes, derived |
| buyer_seller_ratio | GT | yes |
| smart_money_net | no source | **no** |
| flow_consistency | Swap logs over 7 d (~302k blocks = 7 publicnode calls per pool) | yes |
| round_trip_loss, sellable | sim | yes |
| mint_authority (gate) | GoPlus `is_mintable` (claim) | partial: claim only |
| freeze_authority (gate) | n/a on EVM | **no** (null with reason) |
| verified | GoPlus `is_open_source` (claim); Etherscan v2 with paid key | yes (claim) |
| owner_renounced, upgradeable, lp_lock, launchpad | as above | yes |
| liq_fdv, main_pool_share, pool_count | DexScreener / GT, **cross-checked with on-chain `balanceOf(pool)`** (小小徐 case) | yes |
| liq_change_24h / 7d | own KV history of liquidityTotalUsd | yes, after history accrues |
| trend | OHLCV | yes |

## Env vars
- `BASE_RPC_URL`: optional private RPC, tried first (already in lib/onchain/rpc.ts). An archive endpoint with wide `eth_getLogs` would unlock the established-token replay factors.
- `BASESCAN_API_KEY`: this is an **Etherscan v2 key** (one key for all chains via `chainid=8453`). Basescan v1 is deprecated. **The free plan returns "Free API access is not supported for this chain"**, so a paid Etherscan plan is required. Without it: deployer/creation via archive bisection, verified via GoPlus.
- GoPlus: keyless worked. GoPlus documents an optional app key for higher limits; it was not tested in this run.

## Could not be verified
- Etherscan v2 responses with a key (no key available). Blockscout (Cloudflare challenge, not bypassed).
- GoPlus multi-address calls (hit 4029 at that moment) and its exact window. Observed: ~10 calls, then a ≤ 60 s cooldown.
- A Flaunch token with a DexScreener/GT listing, and a Virtuals launch in the last ~27 h (none found).
- The product names behind CL factory `0x9cb2…7a76` (`aero-slipstream-base`) and the b2-vanity launchpad. They are labelled "name not confirmed".
- UNCX V3 locker `0x2312…bcc1` (owner match only). Team Finance (not registered).
- `aero-volatile-base` GT dex (empty pool list).
- A buy-then-sell round trip on untouched single-sided launch pools (needs an unlock-callback sim contract).

## Dual-chain addresses
**USDe `0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34`** is a live token with `symbol()` "USDe" on Base, Robinhood Chain and Monad. It has DEX pairs on Base (Uniswap v3, $1.0M) and Robinhood (Uniswap v4 USDe/USDG, $1.0M). sUSDe `0x211C…E5d2` is likewise on all three. Non-token contracts at the same address:
- Multicall3: identical bytecode on all three.
- Permit2.
- Doppler initializer `0x9982…fdbb`, 17,609 B on all three. On Robinhood it is registered as the "…aac launchpad pool initializer", which suggests that launchpad is Doppler-based. The Doppler Airlock `0x660e…8d12` exists on Base and Monad but not on Robinhood.
