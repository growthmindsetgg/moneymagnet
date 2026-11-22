export const FIXTURES = [
  {
    name: "microduck",
    address: "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725",
    note: "Robinhood Chain meme on NVDA (Pons). Expected A or S with full HoodScan data and ≥ 80% coverage.",
    expectTiers: ["S", "A"],
    critical: ["hoodscan", "scanhood", "rpc"],
    // The recorded fixture keeps S/A; the live tier moves with the market (net flow, holders), so the live test asserts
    // "same tier as the previous deployment" (the owner's brief, item 4) instead of a fixed letter.
    liveSameAsPrevious: true,
  },
  {
    name: "offline",
    address: "4Kz2m4F347YzLyvgHDjqD1pS8p4NGV64Mucaj7LXpump",
    note: "Solana pump.fun launch ('offline'). Expected F (all buyers exited) or ≤ C (dev-buy share / VOL-MC bundle) — never B or better.",
    expectTiers: ["C", "D", "F"],
    critical: ["rugcheck", "dexscreener"],
  },
  {
    name: "fartcoin",
    address: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
    note: "Solana pump.fun graduate with mint + freeze authority revoked.",
    expectTiers: ["S", "A", "B", "C", "D"],
    critical: ["rugcheck"],
  },
  {
    name: "pangea-honeypot",
    address: "0x30de7ae4c9578d110a97367ede9f7765cdce06ea",
    note: "Robinhood Chain token ScanHood flagged DANGER: honeypot (97.8% round-trip loss) when recorded. Expected F for the recorded fixture. Since 2026-10-24 ScanHood's live simulation (now on the v4 pool) returns PASS / 0% loss, so the live test asserts the gate follows the simulator instead of a fixed tier.",
    expectTiers: ["F"],
    critical: ["scanhood"],
    liveFollowsSimulator: true,
  },
  {
    name: "peek",
    address: "A7Hm1SaHZZz8ZKFqZpsnZoGhri9f1iHEzYBPQGiPpump",
    note: "§7 PEEK: pump.fun launch that never traded (0 buyers, curve 0% / 0 SOL, no pool) at ~15h. Expected F (dead launch) with coverage ≥ 90% and a numeric score.",
    expectTiers: ["F"],
    critical: ["helius", "solana-rpc"],
  },
] as const;
