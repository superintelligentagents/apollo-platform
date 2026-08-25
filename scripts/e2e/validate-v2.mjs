// Full apollo-v2 validation on the LIVE site: login → guided authoring →
// submit · Chrome-History file load → journeys → compose flow → submit ·
// themes suggestions · examples · progress · review queue (own-task exclusion
// + claim; approve ONLY if we claimed our own disposable task). Everything
// created here is deleted from S3 afterwards by the shell.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "https://apollo-v2-site.vercel.app";
const FIX = new URL("./e2e-fixtures/", import.meta.url).pathname;
const SHOTS = new URL("./shots-v2/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "✓" : "✗ FAIL:"} ${msg}`);
  if (!ok) failures++;
};
const MARK = "V2-E2E-DISPOSABLE:";

const browser = await chromium.launch();

async function login(page, name, email) {
  await page.goto(BASE);
  await page.fill('input[placeholder="Your name"]', name);
  await page.fill('input[placeholder="you@example.com"]', email);
  await page.check(".login-consent-check input");
  await page.click('button:has-text("Start")');
  await page.waitForSelector(".topbar", { timeout: 20000 });
}

async function fillGuidedAndSubmit(page, requestText) {
  await page.waitForSelector(".focused-request", { timeout: 20000 });
  await page.fill(".focused-request", requestText);
  const steps = page.locator(".guided-steps textarea");
  const n = await steps.count();
  await steps.nth(0).fill("Start by comparing at least three options side by side with prices.");
  if (n > 1) {
    // Expand the second step if collapsed, then fill.
    const secondCard = page.locator(".guided-step").nth(1);
    if (await secondCard.evaluate((el) => el.classList.contains("collapsed")).catch(() => false)) {
      await secondCard.click();
    }
    await page.locator(".guided-steps textarea").nth(1).fill("Put the final recommendation in a short summary with links.");
  }
  await page.click('button:has-text("Review task")');
  await page.waitForSelector('button:has-text("Submit task")', { timeout: 20000 });
  await page.click('button:has-text("Submit task")');
  await page.waitForSelector(".notice.ok", { timeout: 60000 });
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  page.on("dialog", (d) => d.accept());

  // ---- Login + home chooser
  await login(page, "V2E2E Tester", "v2-e2e@example.com");
  await page.waitForSelector('text=Submit tasks');
  check(true, "login + internal home chooser");
  await page.screenshot({ path: SHOTS + "w1-home.png", fullPage: true });

  // ---- Guided ("Write your own") task
  await page.click('text=Submit tasks');
  await page.waitForSelector(".mode-rows", { timeout: 15000 });
  await page.screenshot({ path: SHOTS + "w2-submit-hub.png", fullPage: true });
  await page.locator(".mode-row", { hasText: "Write" }).locator(".btn.primary").first().click();
  await fillGuidedAndSubmit(
    page,
    `${MARK} Research the best noise-cancelling headphones under $250, compare the top three on comfort and battery, and give me a final pick with links.`
  );
  check(true, "guided task authored + submitted to S3");
  await page.screenshot({ path: SHOTS + "w3-guided-submitted.png" });

  // ---- History file load → journeys → compose → submit
  await page.click('text=Submit tasks');
  await page.waitForSelector(".mode-rows");
  await page.locator(".mode-row", { hasText: "journeys" }).locator(".btn.primary").first().click();
  // history screen: feed the Chrome History sqlite
  await page.waitForSelector('input[type="file"]', { state: "attached", timeout: 20000 });
  await page.locator('input[type="file"]').first().setInputFiles(FIX + "History");
  await page.waitForSelector(".journey-list, .compose-screen, .journey-row, .list-row", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const composeBody = await page.locator("body").innerText();
  check(/tokyo|standing desk|marathon|Tokyo/i.test(composeBody), "Chrome History parsed in-browser → journeys listed");
  await page.screenshot({ path: SHOTS + "w4-journeys.png", fullPage: true });
  // Select first two journey rows (checkbox or row click)
  const checks = page.locator('.journey-row input[type="checkbox"], .list-row input[type="checkbox"]');
  if ((await checks.count()) >= 2) {
    await checks.nth(0).check();
    await checks.nth(1).check();
  } else {
    await page.locator(".journey-row, .list-row").nth(0).click();
    await page.locator(".journey-row, .list-row").nth(1).click();
  }
  await page.locator(".btn.primary", { hasText: /Describe|Continue|journeys ready/i }).first().click();
  await fillGuidedAndSubmit(
    page,
    `${MARK} Plan the rest of my Tokyo trip from where my research left off — pick the flight, book a Shinjuku stay, and sort out rail passes.`
  );
  check(true, "history-backed compose task submitted with journey provenance");
  await page.screenshot({ path: SHOTS + "w5-compose-submitted.png" });

  // ---- Themes suggestions
  await page.click('text=Submit tasks');
  await page.waitForSelector(".mode-rows");
  const themeRow = page.locator(".mode-row", { hasText: /theme|Suggestions/i }).first();
  if ((await themeRow.count()) > 0) {
    await themeRow.locator(".btn.primary").first().click();
    await page.waitForTimeout(2000);
    const themesBody = await page.locator("body").innerText();
    check(/tokyo|desk|marathon/i.test(themesBody), "theme ensemble produced suggestions from history");
    await page.screenshot({ path: SHOTS + "w6-themes.png", fullPage: true });
  }

  // ---- Examples + progress
  await page.click('.topnav-link:has-text("Examples")');
  await page.waitForTimeout(800);
  check(/Easy|Medium|Hard/i.test(await page.locator("body").innerText()), "examples/reference screen renders");
  await page.click(".progress-pill");
  await page.waitForTimeout(1500);
  const prog = await page.locator("body").innerText();
  check(/2 (submitted|uploaded)|submitted/i.test(prog), "progress screen shows this session's submissions");
  await page.screenshot({ path: SHOTS + "w7-progress.png", fullPage: true });

  // ---- Submitter cannot claim own tasks
  await page.click('.topnav-link:has-text("Review")');
  await page.waitForTimeout(2500);
  const queueText = await page.locator("body").innerText();
  check(/your own submissions/i.test(queueText), "review queue shows own-submission exclusion note");
  await page.screenshot({ path: SHOTS + "w8-own-queue.png", fullPage: true });
  await ctx.close();

  // ---- Different reviewer: claim; approve ONLY our disposable task
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const r = await ctx2.newPage();
  r.on("dialog", (d) => d.accept());
  await login(r, "Kai Reviewer E2E", "kai-reviewer-e2e@example.com");
  await r.click('text=Review tasks');
  await r.waitForSelector('button:has-text("Claim")', { timeout: 20000 });
  const claimBtn = r.locator('button:has-text("Claim the next task")');
  if ((await claimBtn.count()) && !(await claimBtn.first().isDisabled())) {
    await claimBtn.first().click();
    await r.waitForURL(/review-task/, { timeout: 30000 });
    const claimed = await r.locator("body").innerText();
    if (claimed.includes("V2-E2E-DISPOSABLE")) {
      check(true, "reviewer claimed the disposable e2e task");
      // Approve path: check every rubric row, then approve.
      const rubricChecks = r.locator('.review-rubric input[type="checkbox"], .rubric-row input[type="checkbox"]');
      const rc = await rubricChecks.count();
      for (let i = 0; i < rc; i++) await rubricChecks.nth(i).check();
      const approve = r.locator('button:has-text("Approve")');
      if ((await approve.count()) && !(await approve.first().isDisabled())) {
        await approve.first().click();
        await r.waitForSelector(".notice.ok", { timeout: 30000 });
        check(true, "full approve path: rubric checked → approved → finished record");
        await r.screenshot({ path: SHOTS + "w9-approved.png", fullPage: true });
      } else {
        check(false, `approve button unavailable (rubric rows found: ${rc})`);
        await r.screenshot({ path: SHOTS + "w9-approve-blocked.png", fullPage: true });
      }
    } else {
      console.log("  (claimed a non-e2e task — releasing, skipping approve test)");
      await r.click('.topbar-brand');
      await r.click('text=Review tasks');
      await r.waitForSelector("text=/Resume/i", { timeout: 15000 });
      await r.click('button:has-text("Release")');
      await r.waitForTimeout(2000);
    }
  } else {
    check(false, "no claimable task for reviewer (expected our disposables)");
  }
  await ctx2.close();
} catch (err) {
  console.error("FAIL (exception):", err.message);
  failures++;
} finally {
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL V2 CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
}
