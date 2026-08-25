// Chrome-extension live-import test: REAL headed Chromium with the Apollo
// History Helper loaded unpacked (pinned key → production extension ID).
// Seeds real browsing history in a fresh profile, then drives the LIVE site
// through the one-button extension import.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const EXT = "/Users/lawrencejang/Developer/realEvals/apollo-v2/extension";
const SHOTS = new URL("./shots-gaps/", import.meta.url).pathname;
const PROFILE = new URL("./ext-profile/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "✓" : "✗ FAIL:"} ${msg}`);
  if (!ok) failures++;
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1440, height: 950 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

try {
  const page = await ctx.newPage();

  // Seed real history: two "sessions" of browsing the extension can read back.
  for (const url of [
    "https://example.com/",
    "https://developer.mozilla.org/en-US/docs/Web/API/History",
    "https://en.wikipedia.org/wiki/Tokyo",
    "https://en.wikipedia.org/wiki/Shinjuku",
    "https://www.japan-guide.com/e/e2164.html",
  ]) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => console.log(`  (seed skip: ${url})`));
    await page.waitForTimeout(400);
  }
  console.log("✓ seeded real Chrome history in the profile");

  // Live site → login → journeys mode → history screen
  await page.goto("https://apollo-v2-site.vercel.app/");
  await page.fill('input[placeholder="Your name"]', "Ext E2E");
  await page.fill('input[placeholder="you@example.com"]', "ext-e2e@example.com");
  await page.check(".login-consent-check input");
  await page.click('button:has-text("Start")');
  await page.waitForSelector(".topbar", { timeout: 20000 });
  await page.click("text=Submit tasks");
  await page.waitForSelector(".mode-rows");
  await page.locator(".mode-row", { hasText: "journeys" }).locator(".btn.primary").first().click();

  // Extension detection
  await page.waitForSelector(".badge.ok", { timeout: 30000 });
  const badge = await page.locator(".badge.ok").first().innerText();
  check(/connected/i.test(badge), `extension detected by the live site ("${badge.trim()}")`);
  await page.screenshot({ path: SHOTS + "x1-detected.png", fullPage: true });

  // One-button live import
  await page.click('button:has-text("Import my Chrome history")');
  await page.waitForTimeout(4000);
  const body = await page.locator("body").innerText();
  check(/Tokyo|Shinjuku|mozilla|example|wikipedia/i.test(body), "live history imported through the extension → journeys listed");
  await page.screenshot({ path: SHOTS + "x2-journeys.png", fullPage: true });
} catch (err) {
  console.error("FAIL (exception):", err.message);
  failures++;
  const p = ctx.pages()[ctx.pages().length - 1];
  await p?.screenshot({ path: SHOTS + "x9-failure.png", fullPage: true }).catch(() => {});
} finally {
  await ctx.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nEXTENSION LIVE-IMPORT PASSED");
  process.exitCode = failures ? 1 : 0;
}
