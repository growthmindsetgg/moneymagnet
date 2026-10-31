import { expect, test, type Page } from "@playwright/test";

// UI fix round 1, item 1: the hero tier letter and the "NN.N/100" score never clip or wrap.
// Bounding-box checks at 360/375/390/768/1440 in light and dark, plus a screenshot diff of the hero on
// fixed data (/fixture/microduck renders the recorded fixture; it exists only on the e2e server).
const WIDTHS = [360, 375, 390, 768, 1440];
const THEMES = ["light", "dark"] as const;

/** The glyph / text box of an element, and whether any clipping ancestor cuts it or the viewport does. */
async function clipReport(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    // line-height is 1em: one line is at most ~1.3 × the font size tall, a wrap doubles it.
    const fontPx = parseFloat(getComputedStyle(el).fontSize);
    const lines = Math.round(el.getBoundingClientRect().height / (fontPx * 1.3)) || 1;
    const cut: string[] = [];
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const ar = a.getBoundingClientRect();
      if (cs.overflowX !== "visible" && (r.left < ar.left - 0.5 || r.right > ar.right + 0.5)) cut.push(`${a.className} clips x`);
      if (cs.overflowY !== "visible" && (r.top < ar.top - 0.5 || r.bottom > ar.bottom + 0.5)) cut.push(`${a.className} clips y`);
    }
    const vw = document.documentElement.clientWidth;
    if (r.left < -0.5 || r.right > vw + 0.5) cut.push(`viewport clips x (${Math.round(r.left)}..${Math.round(r.right)} of ${vw})`);
    return { cut, lines, overflow: el.scrollWidth - el.clientWidth, text: el.textContent };
  });
}

/** The fonts use display: optional — load once so the measured visit renders in Anton / JetBrains Mono. */
async function openWarm(page: Page, path: string, ready = "tier-letter") {
  await page.goto(path);
  await expect(page.getByTestId(ready)).toBeVisible({ timeout: 90_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.reload();
  await expect(page.getByTestId(ready)).toBeVisible({ timeout: 90_000 });
  await page.evaluate(() => document.fonts.ready);
}

for (const theme of THEMES) {
  test(`hero (fixture) · ${theme}: letter and score unclipped at every width, screenshot matches`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await openWarm(page, "/fixture/microduck");
      const letter = await clipReport(page, "tier-letter");
      expect(letter.cut, `tier letter clipped at ${width}px ${theme}`).toEqual([]);
      const score = await clipReport(page, "score");
      expect(score.cut, `score clipped at ${width}px ${theme}`).toEqual([]);
      expect(score.lines, `score wraps at ${width}px ${theme}: ${score.text}`).toBe(1);
      expect(score.text).toMatch(/^\d{1,3}\.\d\/100$/);
      await expect(page.getByTestId("hero-score")).toHaveScreenshot(`hero-${width}-${theme}.png`, { maxDiffPixelRatio: 0.01 });
    }
  });
}

test("hero stress: S at 100.0, U with no score, and a long name never clip at 360 and 1440", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const q of ["tier=S&score=100", "tier=U", "tier=D&score=39.9&title=SUPERCALIFRAGILISTICEXPIALIDOCIOUS%20INU"]) {
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/fixture/microduck?${q}`);
      await expect(page.getByTestId("tier-letter")).toBeVisible();
      expect((await clipReport(page, "tier-letter")).cut, `${q} @${width}`).toEqual([]);
      const score = await clipReport(page, "score");
      expect(score.cut, `${q} @${width}`).toEqual([]);
      expect(score.lines).toBe(1);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${q} @${width} scrolls sideways`).toBeLessThanOrEqual(0);
    }
  }
});

test("hero on live microduck: letter and score unclipped at 360 and 1440", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/t/robinhood/0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725");
    await expect(page.getByTestId("tier-letter")).toBeVisible({ timeout: 90_000 });
    expect((await clipReport(page, "tier-letter")).cut).toEqual([]);
    const score = await clipReport(page, "score");
    expect(score.cut).toEqual([]);
    expect(score.lines).toBe(1);
  }
});
