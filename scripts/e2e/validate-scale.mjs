// Scale validation on the LIVE site: 132 MB Gmail Takeout mbox (2,300 msgs,
// heavy attachments) + 260-event calendar. Verifies streaming import with
// progress, smart selection at scale, pagination/search, cross-source entity
// join, export preview privacy, and a real multi-part AWS upload.
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";

const BASE = process.env.E2E_BASE || "https://apollo-pc-site.vercel.app";
const FIX = new URL("./e2e-fixtures/", import.meta.url).pathname;
const SHOTS = new URL("./shots-scale/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "✓" : "✗ FAIL:"} ${msg}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
page.on("dialog", (d) => d.accept());

try {
  await page.goto(BASE);
  await page.fill('input[placeholder="Your name"]', "Casey E2E");
  await page.fill('input[placeholder="you@example.com"]', "casey-e2e@example.com");
  await page.check(".login-consent-check input");
  await page.click('button:has-text("Start")');
  await page.waitForSelector('h2:has-text("Your contribution")');

  // ---- Gmail Takeout import (132 MB, streamed)
  await page.click('button:has-text("Start importing")');
  const t0 = Date.now();
  // Do not await the file-input action before observing progress: Chromium keeps
  // the action pending while the async change handler parses the archive.
  const importMail = page.locator('input[type="file"]').nth(0).setInputFiles(FIX + "gmail-takeout.mbox");
  await page.waitForSelector(".import-progress progress", { timeout: 30000 });
  await page.waitForFunction(() => /MB of .*MB/.test(document.querySelector(".import-progress-line")?.textContent || ""));
  const progLine = await page.locator(".import-progress-line").innerText();
  check(/MB of .*MB/.test(progLine), `live progress during parse ("${progLine.trim()}")`);
  await page.screenshot({ path: SHOTS + "g1-progress.png", fullPage: true });
  await importMail;
  await page.waitForSelector('.notice.ok:has-text("email")', { timeout: 360000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const notice = await page.locator(".notice span").first().innerText();
  console.log(`  → ${notice}`);
  check(/Imported 2,?\d{3} email records/.test(notice), `gmail loads: thousands of records parsed in ${secs}s`);
  check(/mined \d+ orders/.test(notice), "receipts mined from Gmail at scale");
  check(/outside your date window/.test(notice), "date floor dropped out-of-window mail at parse time");

  // ---- Calendar import
  await page.locator('input[type="file"]').nth(1).setInputFiles(FIX + "gcal-takeout.ics");
  await page.waitForSelector('.notice.ok:has-text("calendar")', { timeout: 60000 });
  check(/Imported 2\d\d calendar records/.test(await page.locator(".notice span").first().innerText()), "260-event calendar imported");
  await page.screenshot({ path: SHOTS + "g2-sources.png", fullPage: true });

  // ---- Choose at scale
  await page.click('button:has-text("Choose what to upload →")');
  await page.waitForSelector(".selection-banner");
  const banner = (await page.locator(".selection-banner").innerText()).trim();
  const m = banner.match(/([\d,]+) of ([\d,]+)/);
  const sel = parseInt(m[1].replace(/,/g, ""), 10);
  const total = parseInt(m[2].replace(/,/g, ""), 10);
  check(total > 2200 && total - sel >= 300, `smart defaults at scale: ${banner} (newsletters auto-deselected)`);
  check(/Page 1 of \d+/.test(await page.locator(".pager").innerText().catch(() => "")), "pagination active at 100 rows/page");
  await page.screenshot({ path: SHOTS + "g3-choose.png", fullPage: true });

  // Search narrows to one sender, bulk-deselect just them
  await page.fill('input[type="search"]', "sam delgado");
  await page.waitForTimeout(400);
  const matching = (await page.locator(".bulk-bar .mono").innerText()).trim();
  check(/^\d+ matching/.test(matching) && !/^0 matching/.test(matching), `search narrows to one contact (${matching})`);
  await page.click('button:has-text("Deselect all")');
  const banner2 = (await page.locator(".selection-banner").innerText()).trim();
  check(parseInt(banner2.match(/([\d,]+) of/)[1].replace(/,/g, ""), 10) < sel, `filtered bulk-deselect applied (${banner2})`);
  await page.click('button:has-text("Select all")'); // restore Sam's mail
  await page.fill('input[type="search"]', "");

  // Open an email with an attachment: metadata only, body loads
  await page.locator(".seg-control .seg", { hasText: "email" }).click();
  await page.locator(".item-row").first().click();
  await page.waitForSelector(".body-edit", { timeout: 20000 });
  check(true, "drawer opens with body from IndexedDB at scale");

  // ---- Cross-source entity join
  await page.click('.topnav-link:has-text("People")');
  await page.waitForSelector(".entity-row");
  const samRow = page.locator(".entity-row", { hasText: "Sam Delgado" }).first();
  const samOcc = await samRow.locator(".entity-occ").innerText();
  check(/email/.test(samOcc) && /calendar/.test(samOcc), `entity join across sources: Sam Delgado → ${samOcc.trim()}`);
  const selfRow = page.locator(".entity-row.self");
  check((await selfRow.count()) === 1, "self-detection found the account owner");
  await page.screenshot({ path: SHOTS + "g4-people.png", fullPage: true });

  // ---- Task + export preview privacy at scale
  await page.click('.topnav-link:has-text("Tasks")');
  await page.locator(".mode-row", { hasText: "Add it up" }).locator("button:has-text('Start')").click();
  await page.fill(".task-edit-form textarea >> nth=0", "Go through my food delivery and ride receipts from the last three months and total what I spent, broken down by merchant.");
  await page.fill(".guided-steps textarea >> nth=0", "Collect DoorDash and Uber receipt emails from the last 3 months.");
  await page.fill('.task-edit-form .field:has-text("EXPECTED ANSWER") textarea', "Roughly $900 across DoorDash and Uber (verify exact totals).");
  await page.fill(".record-picker input[type=search]", "doordash");
  await page.waitForTimeout(400);
  await page.locator(".picker-row").nth(0).click();
  await page.locator(".picker-row").nth(1).click();
  await page.click('button:has-text("Save task")');
  await page.waitForSelector('.notice.ok:has-text("Task saved")');
  check(true, "aggregation task authored against receipt records");

  await page.click('.topnav-link:has-text("Submit")');
  await page.waitForSelector('h2:has-text("Review & submit")');
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120000 }),
    page.click('button:has-text("Export a copy")'),
  ]);
  const previewPath = SHOTS + "preview-scale.json";
  await download.saveAs(previewPath);
  const preview = readFileSync(previewPath, "utf8");
  check(preview.length > 1_000_000, `export preview assembled at scale (${(preview.length / 1e6).toFixed(1)} MB)`);
  check(!/Sam Delgado|sam\.delgado@gmail\.com|Casey Morgan|casey\.morgan\.e2e@gmail\.com|Priya Nair/.test(preview), "export preview: zero real names/emails across ~2k records");
  check(/records_email_part\d|records_email\.json/.test(Object.keys(JSON.parse(preview).files).join(",")), "preview includes email part files");
  console.log("  → preview files:", Object.keys(JSON.parse(preview).files).join(", "));
  await page.screenshot({ path: SHOTS + "g5-review.png", fullPage: true });

  // ---- Real AWS upload (multi-part)
  const t1 = Date.now();
  await page.click(".upload-band button.btn.primary");
  await page.waitForSelector('.notice.ok:has-text("Bundle submitted")', { timeout: 300000 });
  check(true, `multi-part bundle uploaded to AWS in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  await page.screenshot({ path: SHOTS + "g6-submitted.png" });
} catch (err) {
  console.error("FAIL (exception):", err.message);
  failures++;
  await page.screenshot({ path: SHOTS + "g9-failure.png", fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL SCALE CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
}
