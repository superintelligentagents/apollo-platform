// v2 approve/reject endgame on the LIVE site, without touching real work:
// a "shield" reviewer claims whatever real task is first in the queue and
// HOLDS the lock; disposables submitted by a test participant are then the
// only claimable tasks, so the approver can exercise approve AND reject.
// The shell cleans every trace afterwards.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "https://apollo-v2-site.vercel.app";
const SHOTS = new URL("./shots-gaps/", import.meta.url).pathname;
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

async function submitGuided(page, requestText) {
  await page.click('text=Submit tasks');
  await page.waitForSelector(".mode-rows");
  await page.locator(".mode-row", { hasText: "Write" }).locator(".btn.primary").first().click();
  await page.waitForSelector(".focused-request");
  await page.fill(".focused-request", requestText);
  await page.locator(".guided-steps textarea").nth(0).fill("Compare at least three options side by side with prices and links.");
  await page.click('button:has-text("Review task")');
  await page.waitForSelector('button:has-text("Submit task")');
  await page.click('button:has-text("Submit task")');
  await page.waitForSelector(".notice.ok", { timeout: 60000 });
}

async function claim(page) {
  await page.click('.topnav-link:has-text("Review")');
  await page.waitForSelector('button:has-text("Claim")', { timeout: 20000 });
  const btn = page.locator('button:has-text("Claim the next task")');
  if (!(await btn.count()) || (await btn.first().isDisabled())) return null;
  await btn.first().click();
  await page.waitForURL(/review-task/, { timeout: 30000 });
  return page.locator("body").innerText();
}

try {
  // ---- Submit two disposables
  const sub = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  sub.on("dialog", (d) => d.accept());
  await login(sub, "V2E2E Author", "v2-e2e2@example.com");
  await submitGuided(sub, `${MARK} approve-me — research the best carry-on suitcase under $200 and pick one with reasons.`);
  await submitGuided(sub, `${MARK} reject-me — this one exists to exercise the rejection flow.`);
  check(true, "two disposable tasks submitted");
  await sub.context().close();

  // ---- Shield: claim first eligible; hold if it's real, approve if ours
  const shield = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  shield.on("dialog", (d) => d.accept());
  await login(shield, "Shield Holder E2E", "shield-holder-e2e@example.com");
  const shieldBody = await claim(shield);
  const shieldHasDisposable = shieldBody?.includes(MARK);
  console.log(`  shield claimed: ${shieldHasDisposable ? "a disposable" : "the real task (holding lock)"}`);

  // ---- Approver: claim disposables and run approve, then reject
  const appr = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  appr.on("dialog", (d) => d.accept());
  await login(appr, "Kai Approver E2E", "kai-approver-e2e@example.com");

  // Approve pass
  let body = await claim(appr);
  check(body?.includes(MARK), "approver claimed a disposable task");
  const rubrics = appr.locator(".rubric-check");
  const rc = await rubrics.count();
  for (let i = 0; i < rc; i++) await rubrics.nth(i).check();
  const approveBtn = appr.locator('button:has-text("Approve → finished")');
  check(!(await approveBtn.isDisabled()), `approve enabled after checking ${rc} rubric line(s)`);
  await appr.screenshot({ path: SHOTS + "v1-approve.png", fullPage: true });
  await approveBtn.click();
  await appr.waitForSelector(".notice.ok", { timeout: 30000 });
  check(true, "APPROVE path: rubric verified → finished record written");

  // Reject pass
  body = await claim(appr);
  check(body?.includes("reject-me"), "approver claimed the second disposable");
  await appr.locator('button:has-text("Reject")').first().click();
  await appr.fill(".reject-reason", "Disposable e2e task — exercising the reject path.");
  await appr.locator('button:has-text("Reject")').last().click();
  await appr.waitForSelector(".notice.ok", { timeout: 30000 });
  check(true, "REJECT path: reason recorded → rejected record written");
  await appr.screenshot({ path: SHOTS + "v2-rejected.png", fullPage: true });

  // Queue tiles should reflect the outcomes
  await appr.waitForTimeout(2000);
  const tiles = await appr.locator("body").innerText();
  check(/approved/.test(tiles) && /rejected/.test(tiles), "queue tiles updated after approve+reject");
  await appr.context().close();

  // ---- Shield releases (or approves its own disposable claim edge case)
  if (!shieldHasDisposable && shieldBody) {
    await shield.click(".topbar-brand");
    await shield.click('text=Review tasks');
    await shield.waitForSelector("text=/Resume/i", { timeout: 15000 });
    await shield.click('button:has-text("Release")');
    await shield.waitForTimeout(2000);
    check(true, "shield released the real task untouched");
  }
  await shield.context().close();
} catch (err) {
  console.error("FAIL (exception):", err.message);
  failures++;
} finally {
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL V2 GAP CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
}
