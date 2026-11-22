# Ethereum mainnet (chain id 1)

Added 2026-11-20 as the fifth chain, on the Base / Monad template (commit `b1c29ed`). Every endpoint below was called in this run and every registry address was checked with `eth_getCode` plus a role-proving view call. Registry: `data/ethereum-infra.json`. Public RPCs: `data/ethereum-rpc-endpoints.json`. Fixtures: `docs/chains/ethereum-fixtures.json` and `tests/fixtures/v3/ethereum-*.json`.

## Chain facts
- `eth_chainId` 0x1. Head ≈ 26.46M blocks on 2026-11-20 (12 s blocks).
- WETH `0xc02a…6cc2`, USDC `0xa0b8…eb48` (6 decimals), USDT `0xdac1…1ec7` (6 decimals).
- Uniswap v4 PoolManager `0x0000…8a90` (24,009 B, same size as on Base / Robinhood), V4Quoter `0x52f0…1203`, StateView `0x7ffe…7227`, PositionManager `0xbd21…ee9e`. Uniswap v2 Factory `0x5c69…aa6f`, v3 Factory `0x1f98…f984`, QuoterV2 `0x61ff…b21e`.
- **Most new Ethereum launches are native-ETH Uniswap v4 pools** (`currency0 = 0x0`). The shared sell simulation treated an all-zero `currency0` as "pool unknown" and skipped those pools; fixed in `lib/sources/evmSim.ts` (an unknown id is a key whose currency0 *and* currency1 are zero). This also applies to native-ETH v4 pools on Base.
- No Ethereum launchpad (bonding curve / factory) is registered, so nothing proves `isLaunchpad` on Ethereum.

## Sources

| Source | Id | URL / call | Auth | Fields |
|---|---|---|---|---|
| Ethereum RPC (public pool) | `ethereum-rpc` | `data/ethereum-rpc-endpoints.json`; `ETHEREUM_RPC_URL` first | none | tokenExists, totalSupply, name, symbol, ownerRenounced (`owner()`), upgradeable (EIP-1967 slot / EIP-1167 clone), deployer balance now (when a source names the deployer) |
| Ethereum sell simulation | `ethereum-sim` | read-only `eth_call`s on the same pool | none | sellable, honeypot, roundTripLossPct, liquidityPulled: transfer probe from a real holder, then per pool (≤ 6) v4 V4Quoter round trip (0.01 ETH / 10 USDC), v2 reserves math, v3 slot0 math |
| GoPlus token_security | `goplus` | `https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=<ca>` | none (~10 calls per burst, then code 4029) | holders (top 10), top1/top10 share, holderCount, deployerAddress + deployerHoldingPct (creator), honeypot claim, mintable, open source, proxy, owner, LP holders → lpLockedPct |
| DexScreener | `dexscreener` | `/latest/dex/tokens/<ca>`, chainId `ethereum` | none | price, FDV, liquidity, volume, pools, buys / sells, pair creation |
| GeckoTerminal | `geckoterminal` | `/api/v2/networks/eth/…` | none (30 calls/min; 429 lasts minutes) | pools, buyers / sellers, sells, trades per wallet, OHLCV patterns, trend |
| Etherscan (v2) | `etherscan` | `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getcontractcreation…` / `getsourcecode` | **`ETHERSCAN_API_KEY`** (free plan covers Ethereum; falls back to `BASESCAN_API_KEY`, any Etherscan v2 key works for chainid=1) | deployerAddress, createdAt (token creation, not pool creation), verified |
| Liquidity history (KV) | `history` | own observations | — | 24h / 7d liquidity change, from the second analysis on |

Without an Etherscan key the `etherscan` source is **skipped** with "ETHERSCAN_API_KEY not set (…)" on every result page. Then:
- the deployer comes from GoPlus `creator_address` (GoPlus returns it for chain 1, unlike Monad);
- the age comes from the oldest DexScreener / GeckoTerminal pool. A pool is created after the token, so this can only *understate* age (age only selects the set and adds the track-record bonus, so understating it never inflates a score);
- `verified` comes from GoPlus `is_open_source`; if GoPlus is also down, `verified` is null and its reason names both sources, including the missing key.

**Not verified in this run:** an Etherscan response with a real key (none was available to this session). The adapter is the Basescan one with `chainid=1`, covered by unit tests with a mocked API.

## RPC endpoints (`data/ethereum-rpc-endpoints.json`)
Probed 2026-11-20 with a chain-1 copy of `scripts/probe-rpcs.mjs` (chain id must be 0x1). Kept: 11 keyless endpoints. eth_getLogs (≥ 10k blocks): the two Tenderly gateways (50k-block span, archive) first, then publicnode, mevblocker (archive) and 0xrpc.io (10k). Archive state: Tenderly ×2, mevblocker, drpc, blastapi, nodies. State-override `eth_call` (needed by the sim): all kept endpoints. Rejected with the probe result recorded in the file: llamarpc (525), ankr (key required), cloudflare-eth (internal errors), tatum / meowrpc (429 burst), 1rpc / flashbots (no state override), zan (burst failures), merkle / onfinality (429), subquery / payload (unreachable), omniatech (521), therpc (403).

## Factor sets
`launch_ethereum` (< 72 h) and `established_ethereum` (≥ 72 h) are the Base sets with the sources renamed (`base-rpc` → `ethereum-rpc`, `base-sim` → `ethereum-sim`, `basescan` → `etherscan`) and **without the `launchpad` factor** (`base-launch` has no Ethereum counterpart; it would be permanently null). Group weights are unchanged (launch 40 / holders 30 / flow 30; established holders 30 / flow 28 / liquidity 42; safety basics are gates with 0 points). Age selects the set and never penalises; the Established track-record bonus (`track_record_7d` +1.5, `track_record_30d` +3) applies as on every chain.

| Set | Factor | Source(s) on Ethereum | Status |
|---|---|---|---|
| launch | vol_mc | DexScreener / GeckoTerminal | filled |
| launch | launch_retrace, chart_identical, chart_staircase | GeckoTerminal OHLCV | filled; null with the 429 reason when GeckoTerminal rate-limits |
| both | sellable (gate) | ethereum-sim, GoPlus | filled; null when no pool can be simulated (no listed pool with liquidity) |
| both | mint_authority (gate) | GoPlus `is_mintable` (claim) | filled when GoPlus has the token |
| both | owner_renounced, upgradeable (gates) | ethereum-rpc, GoPlus | filled |
| both | lp_lock (gate) | GoPlus `lp_holders` | filled for tokens < 14 days (as on Base); n/a for older tokens |
| established | verified (gate) | GoPlus, Etherscan | filled (GoPlus claim) without a key |
| launch | top_holder, top10_share | GoPlus top 10 | filled; **null** when GoPlus's list is impossible (see below) |
| established | top10_share, top_holder, deployer_holding | GoPlus; deployer balance re-read on-chain | filled |
| both | buyer_seller_ratio | GeckoTerminal / DexScreener | filled |
| launch | sell_count | GeckoTerminal / DexScreener | filled |
| established | trades_per_wallet | GeckoTerminal | filled; null on 429 |
| both | trend | GeckoTerminal OHLCV | filled; null on 429 |
| both | round_trip_loss | ethereum-sim | filled when a pool simulates |
| established | liq_fdv, main_pool_share, pool_count | DexScreener / GeckoTerminal | filled |
| established | liq_change_24h, liq_change_7d | own history | null on the first analysis ("first liquidity observation"), then filled |

Known nulls: Holder Strength needs Transfer-log ledgers of the top-20 wallets (works through the log endpoints; PEPE-scale tokens rarely finish inside one request and continue in the background); the Time Machine has no Ethereum archetypes ("no Ethereum archetypes in the library yet"); the social panel has no Ethereum X-post source (as on Base / Monad); `lp_unlocked_unproven` (cap D) fires on a young token whose measured LP lock is < 50%, because no Ethereum launchpad can be proven.

### GoPlus quirks seen on Ethereum
- **Impossible holder lists.** PIPI (`0x7bce…7b9`) came back with its minter listed at 100% of supply while the buyers listed under it held another 53%. `lib/sources/goplus.ts` now refuses a list whose shares add up to > 100.5% of supply: top1 / top10 are null with "GoPlus holder list is inconsistent: the listed balances add up to N% of supply … — concentration not scored". Applies on every GoPlus chain.
- **CEX wallets.** PEPE's top holder (11.9%) is Binance 8 with no GoPlus tag. `data/ethereum-infra.json → cexWallets` names nine exchange wallets (Etherscan public name tags; EOAs on-chain — the label itself cannot be proven on-chain). They only label holder rows: they are **not** infrastructure and stay counted in top1 / top10; Holder Strength already excludes CEX-labelled wallets.

## Meme filter
- Registered quote tokens and blue chips (`role: quote-token / blue-chip` in `data/ethereum-infra.json`: WETH, USDC, USDT, DAI, WBTC, cbBTC, stETH, wstETH, rETH, weETH, USDe, PYUSD, LINK, UNI, AAVE, MKR, LDO, ENA) are refused before any fetch, as on Base / Monad.
- **Decision:** the "> $1B FDV with no launchpad origin ⇒ blue chip" heuristic used on Solana / Base / Monad is **not** applied on Ethereum. Ethereum memes never have a launchpad origin and the largest ones are > $1B (PEPE $1.57B on 2026-11-20), so the heuristic would refuse exactly the tokens the product is for. Ethereum's non-memes are covered by the registry and the name / symbol filters (wrapped, staked, stable). Risk: an unregistered large non-meme is scored as a meme — extend the registry when one turns up.

## Auto-detection (decision)
- An 0x address is still ambiguous. `lib/resolveChain.ts` now asks **all four** EVM chains (Robinhood Chain, Base, Monad, Ethereum) for bytecode + `totalSupply()` in parallel and DexScreener (one call, all chains, chainId `ethereum`) for pairs. Candidates are sorted by FDV, highest first.
- **Each chain now has its own hard deadline (12 s, `CHAIN_TIMEOUT_MS`).** A slow or rate-limited Ethereum endpoint answers "RPC unreachable" for Ethereum instead of holding up the others; such an answer is not cached. Cache key bumped to `resolve:v2:` so results cached before Ethereum existed are not served.
- **Same address on Ethereum and Base** (bridged / CREATE2 tokens): both are candidates; the API answers 300 with both and the page shows the picker, the real market (higher FDV) first. Nothing is auto-picked across chains — FDV only orders the choices, because a CREATE2 twin with a thin market is still a different token.
- **No-hint fallback stays Robinhood Chain** (`detectChain` without a hint). The resolver runs before it on every entry point that matters (API, `/t/auto/`), so the fallback only decides addresses with no contract on any chain, which then show "no contract code at this address". There was no reason to change the original default.
- Checked live: PEPE resolves to Ethereum only (19 pairs, $1.57B); BRETT stays Base only (no code on Ethereum); USDe `0x5d3a…ef34` stays a Robinhood / Base / Monad picker (on Ethereum that address is a contract without `totalSupply()`).

## Env vars
- `ETHEREUM_RPC_URL` (optional): private endpoint tried before the public list (assumed log-, override- and archive-capable).
- `ETHERSCAN_API_KEY` (optional, recommended): Etherscan v2 key; free plan works for chainid=1. Falls back to `BASESCAN_API_KEY`. Base now also falls back to `ETHERSCAN_API_KEY` when `BASESCAN_API_KEY` is unset (a free key then makes Basescan **failed** with Etherscan's "Free API access is not supported for this chain", which is printed as the reason).

## Live results (2026-11-20, local, `fresh: true`, no Etherscan key)

| Token | Tier | Score (raw) | Coverage | Mode | Why |
|---|---|---|---|---|---|
| PEPE `0x6982…1933` | B | 64.6 (61.6) | 87% | Established | no cap; top holder Binance 8 11.9%, top 10 39.4%, liq/FDV 1.8%; 0.6% round trip; +3 track record |
| Mog `0xaaee…1c7a` | C | 54.9 (78.3) | 80% | Established | cap: top holder > 20% (a 2,513 B unclassified contract with 29%) |
| PIPI `0x7bce…47b9` | F live / D recorded | 22.9 live; 39.9 (82.9) recorded | 33% live / 70% recorded | Launch | unlocked LP, no launchpad proof (cap D); live run lost GeckoTerminal to 429, the recorded run had it |
| RUGGED `0xab2f…088d` | F | 0 (42.9) | 23% | Launch | gate: liquidity removed (our sim), dead launch |

Every factor was live or null with its reason (GeckoTerminal 429, "first liquidity observation", inconsistent GoPlus list, GoPlus has no record); Etherscan was `skipped` with "ETHERSCAN_API_KEY not set" on every page.
