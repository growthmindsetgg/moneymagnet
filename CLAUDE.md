# HoodTier — rules for every session

**Product:** HoodTier is a token tier scorer for Robinhood Chain (chain id 4663) and Solana. You paste an address and get a tier (S/A/B/C/D/F, or U for unrated) with every factor's evidence.

## Data integrity (non-negotiable)
- **No pseudo data.** Every factor is in one of three states:
  - **live:** fetched in this run.
  - **stale:** from the last good snapshot. It is always labelled "stale Xm" and expires after 6h.
  - **null:** with the exact reason stated (e.g. "Helius key not set", "RugCheck timed out").
- Never default a missing value to a number. Never estimate a field and present it as measured. If a value is derived, the evidence line says so.
- Sources and their status (ok / partial / stale / failed / skipped, with the reason) must be printed on every result page.

## Scoring
- Scoring lives only in `lib/scoring/factors.json`. `lib/scoring/engine.ts` stays generic, with no factor-specific code.
- The tier and the displayed score must be monotone: a higher displayed score never means a lower tier. When a cap applies, the displayed score is clamped to the capped band, with "raw N" shown beside it.
- **Age never gates or penalises** — anywhere, including S. It selects the factor set (`launch` < 72h, `established` ≥ 72h) and can only add points (Established track-record bonus, ≤ 3).
- **Always score.** Zero activity is a value (0, minimum points, "no activity"), not missing. U only for < 5 min with < 10 buyers, or when ≥ 40% of the weight is missing because a source failed (the reason names them).

## Workflow
- Run the LOOP in `README.md` (lint → typecheck → test → build → API verify → stability → Playwright) before any deploy.
- Never delete or weaken a test to make it pass. If a spec change makes a test obsolete, replace it with one asserting the new rule and say so in REPORT.md.
- Every run ends with `REPORT.md` covering:
  - tasks done and decisions made;
  - sources ok/failed, with reasons;
  - factors still null, and why;
  - env vars the owner must set.
- Secrets never go in the repo. Read them from env vars (`.env.local` locally, Vercel project env in production) and document them in `.env.example`.
