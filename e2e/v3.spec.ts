import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const MICRODUCK = "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725";

test.describe("§2 error UX", () => {
  test("a 504 from the data call shows ERR, a plain cause, Retry and an id; the second failure adds the browser hint", async ({ page }) => {
    let calls = 0;
    await page.route("**/api/analyze", (route) => {
      calls++;
      return route.fulfill({ status: 504, contentType: "text/html", body: "<html>An error occurred with your deployment FUNCTION_INVOCATION_TIMEOUT</html>" });
    });
    await page.goto(`/t/robinhood/${MICRODUCK}?fresh=e2e504`);
    const err = page.getByTestId("error-state");
    await expect(err).toBeVisible({ timeout: 30_000 });
    await expect(err.getByText("ERR", { exact: true })).toBeAttached();
    await expect(page.getByTestId("error-cause")).toHaveText("The analysis took too long and the server gave up.");
    await expect(page.getByTestId("error-id")).toHaveText(/^MM-[0-9A-HJKMNP-TV-Z]{6}$/);
    await expect(page.getByTestId("error-hint")).toHaveCount(0);
    const firstId = await page.getByTestId("error-id").textContent();

    await page.getByTestId("error-retry").click();
    await expect(page.getByTestId("error-hint")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("error-hint")).toHaveText("Still failing? Try a different browser or disable extensions — ad/tracker blockers can block the data calls.");
    expect(await page.getByTestId("error-id").textContent()).not.toBe(firstId);
    expect(calls).toBe(2);
  });

  test("a blocked data call (network error) and a cut-off JSON answer both land on the ERR state", async ({ page }) => {
    await page.route("**/api/analyze", (route) => route.abort("blockedbyclient"));
    await page.goto(`/t/robinhood/${MICRODUCK}?fresh=e2eblock`);
    await expect(page.getByTestId("error-cause")).toHaveText("Couldn't reach the data service — the request never got an answer.", { timeout: 30_000 });

    await page.unroute("**/api/analyze");
    await page.route("**/api/analyze", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"chain":"robinhood","tier":"A","groups":[{"id":"hol' }));
    await page.getByTestId("error-retry").click();
    await expect(page.getByTestId("error-cause")).toHaveText("The server's answer was cut off or unreadable.", { timeout: 30_000 });
    // Two failures within 2 minutes: the hint shows.
    await expect(page.getByTestId("error-hint")).toBeVisible();
  });

  test("a 500 with a server error id shows that id", async ({ page }) => {
    await page.route("**/api/analyze", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Analysis failed unexpectedly", errorId: "MM-ABC123" }) }));
    await page.goto(`/t/robinhood/${MICRODUCK}?fresh=e2e500`);
    await expect(page.getByTestId("error-id")).toHaveText("MM-ABC123", { timeout: 30_000 });
    await expect(page.getByTestId("error-cause")).toHaveText("The analysis failed on the server (HTTP 500).");
  });
});

test.describe("§3–4 CTA and pros/cons", () => {
  test("pros/cons render the same text on two runs, and the CTA matches the tier", async ({ page }) => {
    const texts: string[] = [];
    for (const q of ["a", "b"]) {
      await page.goto(`/fixture/microduck?v3=${q}`);
      await expect(page.getByTestId("pros-cons")).toBeVisible({ timeout: 30_000 });
      texts.push(await page.getByTestId("pros-cons").innerText());
    }
    expect(texts[0]).toBe(texts[1]);
    const tier = await page.getByTestId("tier-letter").textContent();
    if (["S", "A", "B"].includes(tier ?? "")) {
      await expect(page.getByTestId("research-cta")).toBeVisible();
      await page.getByTestId("deep-research-button").click();
      await expect(page.locator("html")).toHaveAttribute("data-view", "research");
      await expect(page.getByTestId("research-toggle")).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("#verify-heading")).toBeInViewport({ timeout: 5_000 });
      await expect(page.getByTestId("holders-table")).toBeVisible();
    } else {
      await expect(page.getByTestId("research-cta")).toHaveCount(0);
      await expect(page.getByTestId("no-research")).toContainText("Not worth deeper research at this score");
    }
  });

  test("below B there is no CTA, only the one-line reason", async ({ page }) => {
    await page.goto("/fixture/pangea-honeypot");
    await expect(page.getByTestId("tier-letter")).toHaveText("F", { timeout: 30_000 });
    await expect(page.getByTestId("research-cta")).toHaveCount(0);
    await expect(page.getByTestId("no-research")).toContainText("Not worth deeper research at this score");
  });
});

test.describe("social panel", () => {
  test("renders with every source null: no stage, reasons shown, information-only label", async ({ page }) => {
    await page.goto("/fixture/microduck?social=null");
    const p = page.getByTestId("social-panel");
    await expect(p).toBeVisible({ timeout: 30_000 });
    await expect(p).toHaveAttribute("data-stage", "none");
    await expect(page.getByTestId("social-verdict")).toContainText("No stage — no source measures X posts for solana tokens");
    await expect(p).toContainText("information only — not in the score");
    await expect(page.locator('[data-testid="stage-dial"] li[data-on="true"]')).toHaveCount(0);
  });

  test("early read: one sample, tagged, no slope arrow", async ({ page }) => {
    await page.goto("/fixture/microduck?social=early");
    const p = page.getByTestId("social-panel");
    await expect(p).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("early-read")).toBeVisible();
    await expect(page.getByTestId("social-m")).toHaveText("35");
    await expect(page.getByTestId("top-accounts").locator("li")).toHaveCount(5);
    await expect(page.getByTestId("social-spark-empty")).toBeVisible();
  });

  test("full series: stage dial lit, sparkline drawn, badge shown", async ({ page }) => {
    await page.goto("/fixture/microduck?social=full");
    const p = page.getByTestId("social-panel");
    await expect(p).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="stage-dial"] li[data-on="true"]')).toHaveCount(1);
    await expect(page.getByTestId("social-spark")).toBeVisible();
    await expect(page.getByTestId("social-badge")).toContainText(/^Stage \d/);
    await expect(page.getByTestId("early-read")).toHaveCount(0);
  });
});

test.describe("§1a chain detection", () => {
  test("the same 0x on several chains ⇒ a chain picker with each chain's FDV; a single-chain 0x redirects", async ({ page }) => {
    await page.goto("/t/auto/0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34"); // USDe: Robinhood Chain, Base and Monad
    await expect(page.getByTestId("chain-picker")).toBeVisible({ timeout: 60_000 });
    const options = page.getByTestId("chain-option");
    expect(await options.count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator('[data-testid="chain-option"][data-chain="base"]')).toContainText("FDV");
    await page.goto("/t/auto/0x532f27101965dd16442e59d40670faf5ebb142e4"); // BRETT: Base only
    await expect(page).toHaveURL(/\/t\/base\/0x532f27101965dd16442e59d40670faf5ebb142e4/, { timeout: 60_000 });
  });

  test("home: the chain selector defaults to auto and sends 0x to /t/auto/", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("chain-select")).toHaveValue("auto");
    await page.getByLabel("Token contract address").fill("0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34");
    await page.getByRole("button", { name: "Analyze" }).click();
    await expect(page.getByTestId("chain-picker")).toBeVisible({ timeout: 60_000 });
    await page.goto("/");
    await page.getByTestId("chain-select").selectOption("base");
    await page.getByLabel("Token contract address").fill("0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34");
    await page.getByRole("button", { name: "Analyze" }).click();
    await expect(page).toHaveURL(/\/t\/base\/0x5d3a1ff2/, { timeout: 30_000 });
  });
});

test.describe("top-holder classification", () => {
  test("the largest holder is shown with its class; classified top-5 rows are listed (JAMES fixture)", async ({ page }) => {
    await page.goto("/fixture/monad-james");
    await expect(page.getByTestId("tier-letter")).toHaveText("D", { timeout: 30_000 });
    const line = page.getByTestId("largest-holder");
    await expect(line).toContainText("Largest holder: wallet funded by the deployer, 61.1%");
    await expect(line).toHaveAttribute("data-class", "wallet");
    await line.locator("summary").click();
    await expect(line).toContainText("not the deployer");
    await expect(line).toContainText("treasury (multisig, Safe 6/8)");
    await expect(line).toContainText("unclassified contract");
    const results = await new AxeBuilder({ page }).include('[data-testid="largest-holder"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
  });
});
