// Review-fix e2e on the LIVE apollo-v2 site with a disposable test task:
//  A) as the SUBMITTER: own task must not be claimable (self-review exclusion)
//  B) as a DIFFERENT reviewer: claim → navigate away → resume card → resume → release
// Non-destructive: no approve/reject; the test task is deleted by the shell after.
import { chromium } from "playwright";

const BASE = "https://apollo-v2-site.vercel.app";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const browser = await chromium.launch();

async function login(page, name, email) {
  await page.goto(BASE);
  await page.fill('input[placeholder="Your name"]', name);
  await page.fill('input[placeholder="you@example.com"]', email);
  await page.check(".login-consent-check input");
  await page.click('button:has-text("Start")');
  await page.waitForSelector(".topbar", { timeout: 15000 });
}

async function gotoQueue(page) {
  await page.click('.topnav-link:has-text("Review")');
  await page.waitForSelector('h2, .display', { timeout: 15000 });
  await page.waitForTimeout(2500); // queue status fetch
}

try {
  // ---- A: submitter must not see their own task as claimable
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const a = await ctxA.newPage();
  await login(a, "E2E Submitter", "clde-e2e-sub@example.com");
  await gotoQueue(a);
  const bodyA = await a.locator("body").innerText();
  const ownNote = /your own submissions?/i.test(bodyA);
  const claimableA = await a.locator('button:has-text("Claim the next task"):not([disabled])').count();
  console.log(`A submitter: own-submission note shown: ${ownNote}; claimable button enabled: ${claimableA > 0}`);
  await a.screenshot({ path: SHOTS + "s1-submitter-queue.png", fullPage: true });
  if (claimableA > 0) {
    // Defensive: if it IS enabled, do NOT click — that would be the bug. Report only.
    console.log(/waiting for review/.test(bodyA) ? "  (queue text: see screenshot)" : "");
  }
  await ctxA.close();

  // ---- B: a different reviewer claims, leaves, resumes, releases
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const b = await ctxB.newPage();
  await login(b, "Claude Review E2E", "claude-review-e2e@example.com");
  await gotoQueue(b);
  const claimBtn = b.locator('button:has-text("Claim the next task")');
  if ((await claimBtn.count()) === 0 || (await claimBtn.first().isDisabled())) {
    console.log("B: no claimable task — cannot exercise claim path (unexpected)");
    await b.screenshot({ path: SHOTS + "s2-no-claim.png", fullPage: true });
  } else {
    await claimBtn.first().click();
    await b.waitForURL(/review-task/, { timeout: 30000 });
    const title = await b.locator("body").innerText();
    if (!/E2E TEST/.test(title)) {
      console.log("B WARN: claimed a task that is NOT the e2e test task — releasing immediately");
    } else {
      console.log("B: ✓ claimed the e2e test task → review-edit");
    }
    await b.screenshot({ path: SHOTS + "s3-claimed.png", fullPage: true });

    // Navigate away in-app (the reported bug scenario)
    await b.click(".topbar-brand");
    await b.waitForTimeout(700);
    await gotoQueue(b);
    const resumeVisible = await b.locator("text=/Resume/i").count();
    console.log(`B: ${resumeVisible ? "✓" : "✗ FAIL:"} resume card visible after navigating away`);
    await b.screenshot({ path: SHOTS + "s4-resume-card.png", fullPage: true });
    const claimDisabled = await b.locator('button:has-text("Claim the next task")').first().isDisabled().catch(() => "n/a");
    console.log(`B: claim-next disabled while holding claim: ${claimDisabled}`);

    // Resume
    await b.click('button:has-text("Resume")');
    await b.waitForURL(/review-task/, { timeout: 20000 });
    console.log("B: ✓ resumed claimed review");

    // Back out and release
    await b.click(".topbar-brand");
    await b.waitForTimeout(700);
    await gotoQueue(b);
    await b.click('button:has-text("Release")');
    await b.waitForTimeout(3000);
    const still = await b.locator("text=/Resume/i").count();
    console.log(still === 0 ? "B: ✓ released — lock freed, card gone" : "B: WARN resume card still visible after release");
    await b.screenshot({ path: SHOTS + "s5-released.png", fullPage: true });
  }
  await ctxB.close();
} catch (err) {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
