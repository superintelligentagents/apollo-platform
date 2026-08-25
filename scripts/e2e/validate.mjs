// FULL validation of the import-everything → choose-what-uploads flow.
// Covers: login · import both sources · selection banner + bulk select/deselect ·
// filters (tab/search/status) · per-field + body editing with revert · entity
// alias editing + keepReal · task authoring · export preview (privacy + edits +
// selection honored) · submit · refresh-resume · progress · erase-local-data.
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";

const BASE = process.env.E2E_BASE || "http://localhost:5181";
const FIX = new URL("./e2e-fixtures/", import.meta.url).pathname;
const SHOTS = new URL("./shots-validate/", import.meta.url).pathname;
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

async function login() {
  await page.fill('input[placeholder="Your name"]', "E2E Test");
  await page.fill('input[placeholder="you@example.com"]', "lj-e2e-test@example.com");
  await page.check(".login-consent-check input");
  await page.click('button:has-text("Start")');
  await page.waitForSelector('h2:has-text("Your contribution")');
}

try {
  await page.goto(BASE);
  await login();
  check(true, "login with consent gate");

  // ---- 1. Import everything
  await page.click('button:has-text("Start importing")');
  await page.waitForSelector('h2:has-text("Import everything first")');
  check(true, "sources screen framed as 'Import everything first'");
  await page.locator('input[type="file"]').nth(0).setInputFiles(FIX + "all-mail.mbox");
  await page.waitForSelector('.notice.ok:has-text("email")', { timeout: 30000 });
  await page.locator('input[type="file"]').nth(1).setInputFiles(FIX + "calendar.ics");
  await page.waitForSelector('.notice.ok:has-text("calendar")', { timeout: 30000 });
  await page.waitForSelector('button:has-text("Choose what to upload →")');
  check(true, "post-import CTA 'Choose what to upload →' appears");
  await page.screenshot({ path: SHOTS + "v1-sources.png", fullPage: true });

  // ---- 2. Choose what to upload
  await page.click('button:has-text("Choose what to upload →")');
  await page.waitForSelector('h2:has-text("Choose what to upload")');
  let banner = await page.locator(".selection-banner").innerText();
  check(/5 of 6/.test(banner), `smart defaults: newsletter auto-deselected, receipt email kept (${banner.trim()})`);
  await page.screenshot({ path: SHOTS + "v2-choose.png", fullPage: true });

  // Bulk: deselect everything shown, banner drops to 0
  await page.click('button:has-text("Deselect all")');
  banner = await page.locator(".selection-banner").innerText();
  check(/^0 of 6/.test(banner.trim()), `bulk deselect works (${banner.trim()})`);
  // Bulk: select all back
  await page.click('button:has-text("Select all")');
  banner = await page.locator(".selection-banner").innerText();
  check(/^6 of 6/.test(banner.trim()), `bulk select works (${banner.trim()})`);

  // Filters: tab to calendar only
  await page.click('.seg-control .seg:has-text("calendar")');
  const calRows = await page.locator(".item-row").count();
  check(calRows === 2, `calendar tab filters to ${calRows} rows`);
  // Search
  await page.click('.seg-control .seg:has-text("All")');
  await page.fill('input[type="search"]', "coffee");
  const searchRows = await page.locator(".item-row").count();
  check(searchRows === 1, `search 'coffee' narrows to ${searchRows} row`);
  await page.fill('input[type="search"]', "");
  // Status filter: Not selected
  await page.locator(".filter-bar select").selectOption("excluded");
  const notSel = await page.locator(".item-row").count();
  check(notSel === 0, "status filter 'Not selected' shows 0 after select-all");
  await page.locator(".filter-bar select").selectOption("all");

  // Per-row deselect via checkbox, then via drawer toggle
  const promoRow = page.locator(".item-row", { hasText: "Amazon" }).first();
  await promoRow.locator(".item-check input").click();
  banner = await page.locator(".selection-banner").innerText();
  check(/^5 of 6/.test(banner.trim()), "row checkbox deselects (5 of 6)");

  // ---- 3. Edit within the app
  await page.locator(".item-row", { hasText: "Trip plans" }).first().click();
  await page.waitForSelector(".body-edit");
  check(await page.locator('.item-drawer button:has-text("Selected ✓")').count() === 1, "drawer shows selection toggle at top");
  const subj = page.locator('.item-drawer .field:has-text("SUBJECT") input');
  await subj.fill("Trip plans (edited in validation)");
  await subj.blur();
  await page.waitForSelector('.item-drawer .chip:has-text("edited")');
  // Body edit + save
  const body = page.locator(".body-edit");
  await body.fill("Rewritten body for validation. Confirmation ABC123.");
  await page.click('button:has-text("Save body edit")');
  await page.waitForSelector('.item-drawer .field-label:has-text("BODY (edited)")');
  check(true, "subject + body edited in-app");
  // Revert subject, re-edit
  await page.click('.item-drawer .field:has-text("SUBJECT") button:has-text("revert")');
  check((await subj.inputValue()) === "Trip plans ✈", "field revert restores original");
  await subj.fill("Trip plans (edited in validation)");
  await subj.blur();
  await page.screenshot({ path: SHOTS + "v3-edit.png", fullPage: true });
  // Calendar record editable too
  await page.locator(".item-row", { hasText: "Coffee with Jane" }).first().click();
  const loc = page.locator('.item-drawer .field:has-text("LOCATION") input');
  await loc.fill("A cafe (redacted)");
  await loc.blur();
  check(true, "calendar location edited in-app");

  // ---- 4. People: alias edit + keepReal
  await page.click('.topnav-link:has-text("People")');
  const janeRow = page.locator(".entity-row", { hasText: "Jane Doe" }).first();
  const aliasInput = janeRow.locator(".entity-alias input");
  await aliasInput.fill("Maya Persona");
  await aliasInput.blur();
  check((await aliasInput.inputValue()) === "Maya Persona", "alias hand-editable");
  const amazonRow = page.locator(".entity-row", { hasText: "Amazon" }).first();
  check(await amazonRow.locator(".keep-real input").isChecked(), "merchant defaults to keep-real");
  await page.screenshot({ path: SHOTS + "v4-people.png", fullPage: true });

  // ---- 5. Task
  await page.click('.topnav-link:has-text("Tasks")');
  await page.locator(".mode-row", { hasText: "Find the detail" }).locator("button:has-text('Start')").click();
  await page.fill(".task-edit-form textarea >> nth=0", "Find the flight confirmation code for my July trip with Jane — it was emailed to me around July 20.");
  await page.fill(".guided-steps textarea >> nth=0", "Search my email for the July trip conversation.");
  await page.fill('.task-edit-form .field:has-text("EXPECTED ANSWER") textarea', "ABC123");
  await page.locator(".picker-row").nth(0).click();
  await page.locator(".picker-row").nth(1).click();
  await page.click('button:has-text("Save task")');
  await page.waitForSelector('.notice.ok:has-text("Task saved")');
  check(true, "task authored with attached records + ground truth");

  // ---- 6. Export preview honors selection + edits + aliases
  await page.click('.topnav-link:has-text("Submit")');
  await page.waitForSelector('h2:has-text("Review & submit")');
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click('button:has-text("Export a copy")'),
  ]);
  const previewPath = SHOTS + "preview.json";
  await download.saveAs(previewPath);
  const preview = readFileSync(previewPath, "utf8");
  check(!/Jane Doe|jane\.doe@example\.com|Lawrence Jang/.test(preview), "export preview: zero real names");
  check(preview.includes("Maya Persona"), "export preview: hand-edited alias applied everywhere");
  check(preview.includes("Trip plans (edited in validation)"), "export preview: edited subject shipped");
  check(preview.includes("Rewritten body for validation"), "export preview: edited body shipped");
  check(preview.includes("A cafe (redacted)"), "export preview: calendar edit shipped");
  const previewObj = JSON.parse(preview);
  const emailPart = previewObj.files["records_email.json"];
  check(emailPart.records.length === 2, `export preview: deselected email excluded (${emailPart.records.length} of 3 emails ship)`);
  await page.screenshot({ path: SHOTS + "v6-review.png", fullPage: true });

  // ---- 7. Submit + refresh resume + progress + erase
  await page.click(".upload-band button.btn.primary");
  await page.waitForSelector('.notice.ok:has-text("Bundle submitted")', { timeout: 90000 });
  check(true, "submitted to production S3");
  await page.reload();
  await login();
  const step1 = await page.locator(".mode-row").first().innerText();
  check(/records imported locally/.test(step1), "refresh-resume: imports survive reload");
  await page.click(".progress-pill");
  await page.waitForSelector('h2:has-text("Your submissions")');
  const prog = await page.locator("body").innerText();
  check(/1 bundle|bundles submitted/.test(prog), "progress screen lists the submission");
  await page.screenshot({ path: SHOTS + "v7-progress.png", fullPage: true });
  await page.click('button:has-text("Erase all local data")');
  await page.waitForSelector(".notice.ok");
  await page.click('.topnav-link:has-text("Choose data")');
  const empty = await page.locator("body").innerText();
  check(/Nothing imported yet/.test(empty), "erase-local-data wipes records");
} catch (err) {
  console.error("FAIL (exception):", err.message);
  failures++;
  await page.screenshot({ path: SHOTS + "v9-failure.png", fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
}
