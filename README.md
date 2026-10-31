# HoodTier

Paste a **Robinhood Chain** (chain id 4663), **Base** (8453), **Monad** (143) or **Solana** token address and get a tier:
**S / A / B / C / D / F**, or **U** (Unrated) when too little live data exists. Every factor shows:
- its value and points;
- an evidence sentence;
- its rule source ("guide p.N" or HoodTier) and data source;
- whether it is **live**, **stale Xm**, or **no data — exact reason**.

- 0x addresses exist on three EVM chains. `/t/auto/<0x…>` (the home form's default) asks every chain's RPC for code + `totalSupply()` and DexScreener for pairs, then redirects to the one chain that has the token or shows a **chain picker** with each chain's FDV. `POST /api/analyze` takes an optional `"chain"`; without it an ambiguous 0x answers `300` with the candidates.
- Shareable URL: `/t/<chain>/<address>` (`?fresh=1` bypasses the 2-minute cache; this is the "Retry sources" button).
- API: `POST /api/analyze { "address": "...", "fresh"?: true }` returns a `ScoreReport`.
- Manual guide checks: `GET/POST /api/checks`, with ticks stored per token in KV.

## Quick start

```bash
pnpm install
cp .env.example .env.local   # every variable is optional — see the comments
pnpm dev                     # http://localhost:3000
pnpm replay <0x token>       # optional: pre-warm the Robinhood holder replay into KV
```

## Result page, errors and budgets (v3 §2)
- A cold result page fetches `/api/analyze` from the browser (`components/LiveReport`); a result under 2 minutes old (memory or the shared KV) renders server-side.
- Every failure (504, network / blocked call, cut-off or partial JSON, any exception) shows the **ERR** state: one plain cause, **Retry**, and an error id `MM-XXXXXX` (6 Crockford base32 chars; Next render errors show `MM-D<digest>`). The id is in the server log (`[MM-…]`), or sent there by `/api/client-error`. A second failure within 2 minutes adds the browser / extension hint.
- One analysis stops waiting at **45s** (`ANALYSIS_BUDGET_MS`), each source at its own cap (`lib/budget.ts`); a source past it is `failed` with the reason and served stale when it can be. Routes have `maxDuration = 60`.

## Deep research, pros / cons, social (v3 §3–4, social panel)
- **B and above:** a neon "worth a closer look" panel opens the Research view at Verification. Below B: "Not worth deeper research at this score" plus the binding constraint.
- **PROS / CONS** (`components/prosCons.ts`): 2–4 bullets each, ≤ 12 words, deterministic from the ScoreReport.
- **Research view** adds the top-20 holders (%, buys/sells, first seen, cluster tag), the deployer line, every pool with its liquidity and the cluster summary — all from data the run already fetched.
- **SOCIAL panel** (`lib/social`, information only, never in the score): stage 0–5 × size S1–S4 × quality 0–100, from our own `social_series` (Postgres) of posts / posters per 24h. Sources: RobinX (Robinhood Chain; free report tier, paid calls capped at $0.05 per analysis, cached 10 min), DexScreener / GeckoTerminal official links and boosts. three.ws is listed but supplies nothing per CA (it scores post text it is given, and rejects EVM CAs). Cron `/api/cron/social` re-samples tokens analysed in the last 7 days (≤ 300 per run, oldest first) and keeps 30 days; `pnpm backtest:social` reports the stage-2 × S2+ × quality ≥ 60 test after 14 days.

## The LOOP: run before every deploy

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # unit, guide-rule, fixture, live API tests
pnpm verify:api                                          # prod server: 4 fixture tokens → 200, tier, ≥3 groups with data
pnpm verify:stability                                    # microduck ×3, 30s apart + simulated HoodScan 503: no tier flips
pnpm test:e2e                                            # Playwright: mode badge, stale labels, U tier, Retry, 390px
BASE=https://hoodtier.vercel.app RUNS=3 node scripts/stability.mjs   # after deploying
vercel alias set <new deployment> moneymagnet.vercel.app              # after deploying, until it is a project domain (REPORT §B.7)
```

Never delete or weaken a test to go green (see `CLAUDE.md`).

## Scoring (`lib/scoring/factors.json` → generic `engine.ts`)

- **Per-chain sets.** Robinhood launch tokens use `launch_robinhood`; Base and Monad use `launch_base` / `established_base` / `launch_monad` / `established_monad`, built only from fields their sources fill (docs/chains/<chain>.md).
- **Two factor sets, chosen by age.** `launch` applies under 72h: Launch mechanics 35, Contract safety 25, Holders 25, Flow 15. `established` applies from 72h: Holders 30, Flow 25, Safety 25, Liquidity 20. Age never subtracts points; it only picks the set, and S requires ≥ 72h.
- **Score.** The weighted factor points are renormalized over the weight that has data, so a missing factor is neutral.
- **Rules.** One list covers gates, caps and penalties (`rules[]`). Each rule has `when`/`anyOf` conditions and effects (`points`, `capTier`, `forceF`), plus a `source` ("guide" with page `note`, or "hoodtier").
- **Coverage.** Under 40% of weight with data gives **U**. 40–60% caps the tier at B. S and A need at least 80%. Stale data counts as covered.
- **Monotone display.** When a cap applies, the displayed score is clamped to the top of the capped band, with `raw N` shown beside it. A higher displayed score never means a lower tier.
- **Guide rules.** Every memecoin-guide rule (`source: "guide"`, page in `note`) is a factor or rule. Guide-sourced factors carry at least 60% of launch-mode weight. Rules with no data source appear as the **Manual checks** panel.

### How to add a factor
Add an object to a group's `factors` in the right set(s) of `factors.json`. It needs:
- `id`, `label`, `weight`, `metric` (a `TokenSnapshot` key), `direction`, `format`, `thresholds` and `evidenceTemplate`;
- `source` plus `data` (the adapter ids that can supply the metric);
- optionally `labels`, `chains`, `gate`/`gatePass` and `whenMissing`.

Then rebalance the group's weights so they still add up. `loadConfig` throws otherwise, and the tests catch it.

## Data sources (`lib/sources/*`, `lib/onchain/*`)
Every adapter fails soft. If an adapter fails outright, its last good output (stored in KV, at most 6h old) is used and labelled stale. HoodScan does this per call, after 4 retries with backoff (1/2/4/8s) on 503, "trade index is busy" and timeouts.

| Source | Chain | Provides |
| --- | --- | --- |
| HoodScan MCP + swaps-api | RH | flow, swap-index holders (buys/sells), early cohort, smart money, first-5m share, makers, launchpad, main-pool liquidity |
| ScanHood MCP | RH | honeypot simulation / sellability, round-trip loss |
| Robinhood RPC | RH | supply, owner, proxy; **deployer** = sender of the first mint tx; deployer flows; **holders** by replaying every Transfer log (resumable, cached in KV); v2/v3 LP lock |
| GeckoTerminal | both | pools, liquidity, buyers/sellers, sells, **OHLCV chart patterns** (logged with candle windows) |
| DexScreener | both | pairs, FDV, volume, sells |
| RugCheck | SOL | mint/freeze authority, sellability inputs, LP lock, top holders (LP/curve/lockers excluded), insider networks, launchpad, metadata socials |
| Solana RPC | SOL | mint account (mint/freeze authority, supply — on-chain truth); pump.fun bonding curve: progress, real SOL reserves, circulating share, curve-math price |
| Helius (`HELIUS_API_KEY`) | SOL | holders, wallet age, funding clusters, creator history, curve trades (dev buy, snipes, buyer exits) |
| pump.fun intel feed (three.ws, keyless) | SOL | bundle/organic/snipe scores, dev buy, creator, authorities, largest token accounts (no fees field) |
| Liquidity history (KV) | all | 24h/7d liquidity change, from the second analysis on |
| GoPlus token_security | Base, Monad | honeypot claim, taxes, mintable, proxy, open source, owner (Base), creator (Base), top-10 holders, LP lock |
| Base / Monad RPC | Base, Monad | code, supply, owner, proxy / EIP-1167 clone, deployer balance |
| Base / Monad sell simulation | Base, Monad | transfer probe + v2/v3/v4 round trips; on Monad the nad.fun router's real `sell` in eth_call (the only sellability source for nad.fun curve tokens) |
| nad.fun agent API (`NAD_API_KEY` optional) | Monad | launchpad, creation time, creator, holders, 24h makers / flow, creator swaps (dev sold), candles for curve tokens |
| Basescan (`BASESCAN_API_KEY`) | Base | creator, creation time, verified source |

`scripts/mcp-bridge.mjs` wraps an MCP-only feed as HTTP (`/intel`, `/holders`, `/curve`, `/trades`).

## Cross-source verification (`lib/verify`)
Every metric keeps `provenance[]`: each source that supplied it, with value and fetch time. Metrics in `lib/verify/metrics.ts` are cross-checked:
- **Agreement.** Readings more than 15% apart (numbers, above a small absolute floor) or different at all (booleans, addresses) are **disputed**.
- **On-chain is truth.** Robinhood RPC, Solana RPC and Helius readings win. An API that disagrees with them is flagged "API stale/wrong" in Sources.
- **Otherwise the most conservative value is scored:** lowest liquidity, highest concentration, "sold" over "not sold", "not sellable" over "sellable", an unknown creator over either of two disagreeing ones. A disputed sellability therefore never passes the gate.
- **Like for like only.** Sources measuring different things are not compared. HoodScan's liquidity is main-pool, GeckoTerminal's buyer counts are per pool, and the feed's snipe ratio covers the first 90s while Helius's covers the first slots.
- The page shows a **Verification** strip (verified by ≥ 2 sources / single-source / disputed), every disputed value with its source, and a badge on affected factors. `pnpm verification [addr…]` prints the same locally; `pnpm verify:prod-verification` runs it on production.

## Time Machine (`lib/timemachine`)
The Time Machine rebuilds how tokens looked at **+1h / +6h / +24h / +72h** from real history only, then compares the pasted token at its own age bucket (rounded down).
- **Solana:** Helius mint history, oldest first. Owner balances come from token-balance deltas, with off-curve program owners excluded as pools. Buys and sells are fee payers trading against a pool. Price is the 5-minute VWAP of swap execution prices × Coinbase SOL/USD. Liquidity is the pump.fun curve's SOL reserve up to graduation. Fresh wallets and funders come from each top-10 wallet's first transaction.
- **Robinhood:** a Transfer-log replay to the block at each bucket edge (found by timestamp binary search). Contracts are identified by bytecode. Prices are GeckoTerminal candles. Wallet age, funders and past pool reserves stay null: the RPC has no address index or archive state.
- **Never sampled.** A bucket whose history exceeds the budget (`TM_MAX_TX` / `TM_MAX_LOGS`) is null with that reason. Every null field says why.
- **Library** (`data/archetypes/`, cached in KV `tm:library:v1`): named Solana memes, the top three.ws graduations by peak mcap, the top HoodScan memes by peak mcap, and rugs (three.ws outcome = rugged, ScanHood honeypots). Build it with `pnpm timemachine:build`. The weekly cron `/api/cron/timemachine` (`CRON_SECRET`) rebuilds archetypes older than 7 days.
- **Similarity:** the mean per-field similarity over the fields both sides have. Sizes are log-scaled; at least 4 shared fields are required. It is symmetric, and a token scores 100% against itself.
- **Score effect:** information only, except two Launch-mode rules in `factors.json`: +5 when ≥ 70% like a winner and ≤ 40% like a rug, −5 when ≥ 70% like a rug.
- `pnpm timemachine:prewarm [addr…]` caches a token's own reconstruction at library depth.
