// Close remaining PC gaps on the LIVE site: scrub-panel UI (auto-mask +
// keep-original override), the 3 untested templates, task edit + delete,
// and a genuinely MULTI-PART upload (2,600 long-body emails → >4.5 MB).
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";

const BASE = "https://apollo-pc-site.vercel.app";
const FIX = new URL("./e2e-fixtures/", import.meta.url).pathname;
const SHOTS = new URL("./shots-gaps/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "✓" : "✗ FAIL:"} ${msg}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on("dialog", (d) => d.accept());

try {
  await page.goto(BASE);
  await page.fill('input[placeholder="Your name"]', "Gap E2E");
  await page.fill('input[placeholder="you@example.com"]', "gap-e2e@example.com");
  await page.check(".login-consent-check input");
  await page.click('button:has-text("Start")');
  await page.waitForSelector('h2:has-text("Your contribution")');

  await page.click('button:has-text("Start importing")');
  await page.locator('input[type="file"]').nth(0).setInputFiles(FIX + "gmail-longbodies.mbox");
  await page.waitForSelector('.notice.ok:has-text("email")', { timeout: 300000 });
  console.log(`  → ${await page.locator(".notice span").first().innerText()}`);
  await page.locator('input[type="file"]').nth(1).setInputFiles(FIX + "gcal-takeout.ics");
  await page.waitForSelector('.notice.ok:has-text("calendar")', { timeout: 60000 });

  // ---- Scrub panel: inject credentials via body edit → auto-mask UI appears
  await page.click('button:has-text("Choose what to upload →")');
  await page.locator(".item-row").first().click();
  await page.waitForSelector(".body-edit");
  await page.locator(".body-edit").fill(
    "Quick note. My wifi password: hunter2 — and use card 4111 1111 1111 1111 for the booking. Code 482913 is your verification code."
  );
  await page.click('button:has-text("Save body edit")');
  await page.waitForSelector(".scrub-panel", { timeout: 15000 });
  const panel = await page.locator(".scrub-panel").innerText();
  check(/AUTO-MASKED/.test(panel), "scrub panel appears after editing in credentials");
  check(/password/.test(panel) && /card-number/.test(panel) && /otp/.test(panel), `all three detectors fired (${panel.match(/password|card-number|otp-code/g)?.join(", ")})`);
  // Keep-original override on the card number
  await page.locator(".scrub-row", { hasText: "card-number" }).locator('button:has-text("keep original")').click();
  await page.waitForSelector('.scrub-row .field-error:has-text("unmasked")');
  check(true, "keep-original override shows unmasked warning");
  await page.screenshot({ path: SHOTS + "p1-scrub.png", fullPage: true });

  // ---- Remaining templates: Match the money, Spot the pattern, Get it done
  for (const [tpl, req, step] of [
    ["Match the money", "Check my last Amazon order against the confirmation email and make sure the totals line up with what was charged.", "Find the most recent Amazon order record and its email."],
    ["Spot the pattern", "Look through my calendar and figure out who I meet with most often and on which weekday it usually lands.", "Scan all calendar events and tally attendees by weekday."],
    ["Get it done", "Find a free evening next week that works around my existing events and draft a dinner invite email to Sam.", "Check the calendar for free weekday evenings next week."],
  ]) {
    await page.click('.topnav-link:has-text("Tasks")');
    await page.locator(".mode-row", { hasText: tpl }).locator("button:has-text('Start')").click();
    await page.fill(".task-edit-form textarea >> nth=0", req);
    await page.fill(".guided-steps textarea >> nth=0", step);
    const expected = page.locator('.task-edit-form .field:has-text("EXPECTED ANSWER") textarea');
    if (await expected.count()) await expected.fill("Verified answer for the e2e run.");
    await page.locator(".picker-row").nth(0).click();
    await page.locator(".picker-row").nth(1).click();
    await page.click('button:has-text("Save task")');
    await page.waitForSelector('.notice.ok:has-text("Task saved")');
    check(true, `template "${tpl}" authored and saved`);
  }

  // ---- Edit a saved task, then delete another
  await page.click('.topnav-link:has-text("Tasks")');
  await page.locator(".mode-row", { hasText: "Check my last Amazon order" }).locator('button:has-text("Edit")').click();
  await page.waitForSelector(".task-edit-form");
  await page.fill(".task-edit-form input >> nth=0", "Reconcile my Amazon order (edited)");
  await page.click('button:has-text("Save task")');
  await page.waitForSelector('.notice.ok:has-text("Task saved")');
  check(await page.locator(".mode-row", { hasText: "Reconcile my Amazon order (edited)" }).count() === 1, "saved task re-opened, edited, and re-saved");
  const before = await page.locator('.mode-row button:has-text("Delete")').count();
  await page.locator('.mode-row button:has-text("Delete")').last().click();
  await page.waitForTimeout(600);
  check((await page.locator('.mode-row button:has-text("Delete")').count()) === before - 1, "task deleted");
  await page.screenshot({ path: SHOTS + "p2-tasks.png", fullPage: true });

  // ---- Multi-part submit
  await page.click('.topnav-link:has-text("Submit")');
  await page.waitForSelector('h2:has-text("Review & submit")');
  await page.click(".upload-band button.btn.primary");
  // Catch the "part x of y" busy label mid-upload
  await page.waitForSelector('button:has-text("Uploading part")', { timeout: 60000 }).catch(() => {});
  const busy = await page.locator(".upload-band button.btn.primary").innerText().catch(() => "");
  console.log(`  → mid-upload label: "${busy.trim()}"`);
  await page.waitForSelector('.notice.ok:has-text("Bundle submitted")', { timeout: 300000 });
  check(/part \d+ of ([4-9]|\d\d)/.test(busy), `multi-part upload observed (${busy.trim() || "label raced"})`);
  await page.screenshot({ path: SHOTS + "p3-submitted.png" });
} catch (err) {
  console.error("FAIL (exception):", err.message);
  failures++;
  await page.screenshot({ path: SHOTS + "p9-failure.png", fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PC GAP CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
}
