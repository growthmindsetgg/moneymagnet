import { expect, test } from "@playwright/test";

const MICRODUCK = "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725";

test("analyze microduck from the home page", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Token contract address").fill(MICRODUCK);
  // Replaced (v3 §1a): 0x addresses are ambiguous across Robinhood Chain, Base and Monad. With the chain
  // selector on "auto" the form says so, and the server resolves the chain (microduck is on Robinhood only).
  await expect(page.getByText("Detected: EVM (Robinhood Chain / Base / Monad — checked on each)")).toBeVisible();
  await page.getByRole("button", { name: "Analyze" }).click();

  await expect(page).toHaveURL(new RegExp(`/t/robinhood/${MICRODUCK}`), { timeout: 15_000 });
  const tier = page.getByTestId("tier-letter");
  await expect(tier).toBeVisible({ timeout: 90_000 });
  await expect(tier).toHaveText(/^[SABCDFU]$/);

  await expect(page.getByTestId("group-card")).toHaveCount(4);
  await expect(page.getByTestId("factor-row").first()).toBeVisible();
  await expect(page.getByText("Holder conviction")).toBeVisible();
  await expect(page.getByTestId("verdict")).not.toBeEmpty();
  await expect(page.getByTestId("mode-badge")).toHaveText("Established mode");
  await expect(page.getByTestId("raw-score")).toContainText("raw");
  await expect(page.getByTestId("sources")).toBeVisible();
  // Round 3: manual checks live in the research view.
  await page.getByTestId("research-toggle").click();
  await expect(page.getByTestId("manual-checks")).toBeVisible();
  // Every applicable factor row says where its data comes from. Replaced (round 3, "fewer words"): the
  // list no longer starts with "MoneyMagnet ·" (it is always us) — it names the data sources.
  const source = page.getByTestId("factor-source").first();
  await expect(source).toBeVisible();
  await expect(source).toContainText(/^sources: \S/);
  await expect(source).not.toContainText("MoneyMagnet ·");
});

const UNRATED = "HoodTierUnratedTest11111111111111111111111111".slice(0, 44);

// Replaced (§7e): U is reserved for failed sources. An address where the chain says no token
// exists is refused with the CA-only message instead of being tiered.
test("an address with no token is refused: 'paste a contract address'", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/t/solana/${UNRATED}`);
  const rejected = page.getByTestId("rejected");
  await expect(rejected).toBeVisible({ timeout: 90_000 });
  await expect(rejected).toHaveText("paste a contract address");
  await expect(page.getByTestId("tier-letter")).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("launch-mode token shows the launch badge and guide rules", async ({ page }) => {
  await page.goto("/t/solana/4Kz2m4F347YzLyvgHDjqD1pS8p4NGV64Mucaj7LXpump");
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  const badge = page.getByTestId("mode-badge");
  const text = await badge.textContent();
  // The token ages out of launch mode after 72h; the badge must match whichever applies.
  expect(text === "Launch mode (<72h)" || text === "Established mode").toBe(true);
  await expect(page.locator('[data-testid="factor-row"][data-status="null"]').first()).toContainText("no data —");
});

test("result page has no horizontal scroll at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/t/robinhood/${MICRODUCK}`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  // Open the raw JSON too — long unbroken strings are the usual overflow culprit. Round 3: the raw JSON
  // is in the research view, which also expands every factor row (more width pressure, not less).
  await page.getByTestId("research-toggle").click();
  await page.getByText("Raw data").click();
  // v3: the raw JSON loads on demand (/api/raw) — measure only once it is on the page.
  await expect(page.getByTestId("raw-data").locator("pre")).toContainText('"snapshot"', { timeout: 30_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await page.goto("/");
  const homeOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(homeOverflow).toBeLessThanOrEqual(0);
});

test("recent searches chips appear after an analysis", async ({ page }) => {
  await page.goto(`/t/robinhood/${MICRODUCK}`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  await page.goto("/");
  await expect(page.getByLabel("Recent searches")).toContainText("microduck");
});

test("HoodScan outage shows stale badges and still scores holder data", async ({ page }) => {
  // A normal run first, so a last-good HoodScan snapshot exists.
  await page.goto(`/t/robinhood/${MICRODUCK}?fresh=warm`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  const liveTier = await page.getByTestId("tier-letter").textContent();

  await page.goto(`/t/robinhood/${MICRODUCK}?simulate=hoodscan-down&fresh=1`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("stale-headline")).toBeVisible();
  await expect(page.getByTestId("stale-badge").first()).toBeVisible();
  // Round 3: the evidence line ("… (stale, Nm old)") is in the expanded row — the research view opens every row.
  await page.getByTestId("research-toggle").click();
  const holders = page.getByTestId("group-card").filter({ hasText: "Holder conviction" });
  await expect(holders.getByText(/stale, \d+m old/).first()).toBeVisible();
  await expect(page.locator('[data-testid="source-row"][data-source="hoodscan"]')).toContainText("stale");
  await expect(page.locator('[data-testid="factor-row"][data-status="stale"]').first()).toBeVisible();
  expect(await page.getByTestId("tier-letter").textContent()).toBe(liveTier);
});

test("Retry sources re-runs the analysis, bypassing the cache", async ({ page }) => {
  await page.goto(`/t/robinhood/${MICRODUCK}`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  const before = await page.getByTestId("generated-at").textContent();
  await page.getByTestId("retry-sources").click();
  // A cache-bypassing re-run takes as long as a full analysis (seconds warm, up to ~45s cold).
  await expect(page).toHaveURL(/fresh=\d+/, { timeout: 90_000 });
  await expect(page.getByTestId("generated-at")).not.toHaveText(before ?? "", { timeout: 90_000 });
  await expect(page.getByTestId("generated-at")).not.toContainText("cached");
  await expect(page.getByTestId("tier-letter")).toBeVisible();
});

test("verification strip counts cross-checked metrics and disputed values show every source", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/t/robinhood/${MICRODUCK}`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  // Round 3: the Verification column is part of the research view.
  await page.getByTestId("research-toggle").click();
  const strip = page.getByTestId("verification-strip");
  await expect(strip).toBeVisible();
  await expect(page.getByTestId("verified-count")).toContainText(/\d+ verified by ≥2 sources/);
  await expect(page.getByTestId("single-count")).toContainText(/\d+ single-source/);
  await expect(page.getByTestId("disputed-count")).toContainText(/\d+ disputed/);
  // Several sources report price/FDV for microduck, so at least one metric is verified.
  expect(Number((await page.getByTestId("verified-count").textContent())?.match(/\d+/)?.[0])).toBeGreaterThan(0);
  const disputed = Number((await page.getByTestId("disputed-count").textContent())?.match(/\d+/)?.[0]);
  if (disputed > 0) {
    // Each disputed metric lists every source's value; factors on that metric carry the badge.
    // Replaced wording (round 3, "fewer words"): "scored: on-chain 17.9% · HoodScan 53.2%" instead of "← scored".
    const first = page.getByTestId("disputed-metric").first();
    await expect(first.locator("[data-source]")).not.toHaveCount(0);
    expect(await first.locator("[data-source]").count()).toBeGreaterThanOrEqual(2);
    await expect(first).toContainText("scored:");
    await expect(first.locator("[data-scored]")).toHaveCount(1);
  }
  const badges = page.getByTestId("disputed-badge");
  if ((await badges.count()) > 0) {
    const row = page.getByTestId("factor-row").filter({ has: page.getByTestId("disputed-badge") }).first();
    await expect(row.getByTestId("disputed-values")).toBeVisible();
    await expect(row.getByTestId("readings").locator("[data-source]").nth(1)).toBeVisible();
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("Time Machine panel renders under the factors at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/t/robinhood/${MICRODUCK}`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  // Round 3: the Time Machine is part of the research view.
  await page.getByTestId("research-toggle").click();
  const tm = page.getByTestId("time-machine");
  await expect(tm).toBeVisible({ timeout: 30_000 });
  if ((await tm.getAttribute("data-status")) === "ok") {
    await expect(page.getByTestId("tm-sentence")).toContainText(/At \d+h old, this token looks/);
    await expect(page.getByTestId("tm-table")).toBeVisible();
    await expect(page.getByTestId("tm-table").locator("tr[data-field]")).toHaveCount(17);
    // Fields that could not be rebuilt say so instead of showing a number.
    await expect(page.getByTestId("tm-table")).toContainText("not reconstructable");
  } else {
    await expect(page.getByTestId("tm-reason")).toContainText("Not available —");
  }
  // The panel sits below the factor groups.
  const groupsBottom = await page.getByTestId("group-card").last().evaluate((el) => el.getBoundingClientRect().bottom + window.scrollY);
  const tmTop = await tm.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  expect(tmTop).toBeGreaterThan(groupsBottom);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("headline gives a clear tier with conviction-vs-churn and at most five short reasons", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/t/robinhood/${MICRODUCK}`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  const box = page.getByTestId("short-reasons");
  await expect(box).toBeVisible();
  await expect(page.getByTestId("conviction-label")).toHaveAttribute("data-lean", /conviction|churn|mixed|unknown/);
  const n = await page.getByTestId("reason").count();
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(5);
  // The reasons sit above the factor detail.
  const boxTop = await box.evaluate((el) => el.getBoundingClientRect().top);
  const firstGroupTop = await page.getByTestId("group-card").first().evaluate((el) => el.getBoundingClientRect().top);
  expect(boxTop).toBeLessThan(firstGroupTop);
});

test("GET /api/tier returns a compact tier; non-memes get 422", async ({ request }) => {
  const res = await request.get(`/api/tier?ca=${MICRODUCK}`, { timeout: 90_000 });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.tier).toMatch(/^[SABCDFU]$/);
  expect(body.reasons.length).toBeLessThanOrEqual(5);
  expect(body.conviction.label).toMatch(/conviction|churn|mixed|unknown/);
  expect(body.url).toContain(`/t/robinhood/${MICRODUCK}`);
  // Second call is served from the shared cache.
  const again = await request.get(`/api/tier?ca=${MICRODUCK}`);
  expect((await again.json()).cached).toBe(true);
  const usdc = await request.get("/api/tier?ca=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  expect(usdc.status()).toBe(422);
  const usdcBody = await usdc.json();
  expect(usdcBody.rejected).toBe("USDC (stablecoin) — HoodTier scores memecoins only");
  expect(usdcBody.meme).toBe(false);
  expect((await request.get("/api/tier?ca=nope")).status()).toBe(400);
});

const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

test("a stock token is rejected instead of tiered (390px)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/t/robinhood/${NVDA}`);
  const rejected = page.getByTestId("rejected");
  await expect(rejected).toBeVisible({ timeout: 90_000 });
  await expect(rejected).toHaveText("stock token — MoneyMagnet scores memecoins only");
  await expect(page.getByTestId("tier-letter")).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a pump.fun mint minutes old: U 'too early' only while < 5 min and < 10 buyers, otherwise scored (390px)", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // A launch from the last few minutes, straight from three.ws.
  const res = await request.post("https://three.ws/api/pump-fun-mcp", {
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_new_tokens", arguments: { limit: 5 } } },
    timeout: 30_000,
  });
  const text = (await res.text()).replace(/^data: /m, "");
  const tokens = JSON.parse(JSON.parse(text).result.content[0].text).tokens as { mint: string }[];
  test.skip(!tokens?.length, "three.ws returned no new tokens");
  await page.goto(`/t/solana/${tokens[0].mint}`);
  const tier = page.getByTestId("tier-letter");
  await expect(tier).toBeVisible({ timeout: 90_000 });
  // §7a: a fresh mint is unrated only for "< 5 minutes and < 10 buyers" (or failed sources);
  // otherwise it gets a numeric score and a tier.
  if ((await tier.textContent()) === "U") {
    await expect(page.getByTestId("why-tier")).toContainText(/too early — \d+ buyers, [\d.]+ minutes old|sources failed: /);
  } else {
    await expect(page.getByTestId("score")).not.toContainText("—");
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("'why this tier' names the single binding constraint", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/t/robinhood/${MICRODUCK}`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  const why = page.getByTestId("why-tier");
  await expect(why).toBeVisible();
  await expect(why).toHaveAttribute("data-kind", /^(gate|cap|coverage|requirement|score|too-early)$/);
  await expect(why).toContainText("Why this tier:");
});

// Replaced twice. v2.4: basics as a Basics column of gates. Round 1: basics as separate pills next to the
// gates. Round 3 ("one row of pills, each check once"): every basic is merged into the gate that reads the
// same metric (or stands alone if none does). Same rule asserted: basics are pass / fail / unknown checks
// worth no points; plus no check appears twice, and the grid has no Basics column.
test("gates and basics are one row of pills, each check once (no points); the grid has no Basics column", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/t/robinhood/${MICRODUCK}`);
  await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("group-card").filter({ hasText: "Basics (gates only" })).toHaveCount(0);
  const pills = page.getByTestId("gate-pill");
  expect(await pills.count()).toBeGreaterThan(0);
  const labels: string[] = [];
  for (const pill of await pills.all()) {
    await expect(pill).toHaveAttribute("data-state", /^(pass|fail|unknown|n\/a)$/);
    const text = (await pill.textContent()) ?? "";
    expect(text).not.toMatch(/\d+\/\d+/);
    labels.push(text.replace(/^[✓✗?–]\s*/, "").trim().toLowerCase());
  }
  expect(new Set(labels).size).toBe(labels.length);
  await expect(pills.filter({ hasText: /Sellable|Honeypot/ })).toHaveCount(1);
  const groups = await page.getByTestId("group-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-group")));
  expect(groups).toEqual(["holders", "flow", "liquidity", "verification"]);
  // The Verification column shows only in the research view.
  await expect(page.locator('[data-group="verification"]')).toBeHidden();
  await page.getByTestId("research-toggle").click();
  await expect(page.locator('[data-group="verification"]')).toBeVisible();
});
