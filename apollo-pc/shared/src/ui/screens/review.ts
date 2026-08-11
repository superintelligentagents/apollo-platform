import { assembleBundle } from "../../bundle";
import { buildRedactContext, serializeRecord } from "../../redact";
import { buildBundleId, participantId, participantUploadIdentity, splitRecordsIntoParts, utf8Bytes } from "../../schema";
import type { PrivacyAudit, SerializedRecord, SourceKind, SourceRecord } from "../../types";
import { el, fmtBytes } from "../components/helpers";
import type { Ctx } from "../context";

export function renderReview(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const root = el("section", { class: "screen review-screen" });
  root.append(
    el("h2", { class: "display" }, "Review & submit"),
    el("p", { class: "screen-sub" }, "Confirm the selection, review or edit any record, then inspect an exact local copy before you upload.")
  );

  const included = [...s.records.values()].filter((r) => ctx.actions.isIncluded(r));
  const byKind = new Map<SourceKind, SourceRecord[]>();
  for (const r of included) {
    const list = byKind.get(r.source) || [];
    list.push(r);
    byKind.set(r.source, list);
  }

  root.append(
    el(
      "section",
      { class: "review-upload-summary" },
      el("div", null, el("p", { class: "step-kicker mono" }, "READY TO REVIEW"), el("strong", { class: "mono" }, included.length.toLocaleString()), el("span", null, ` record${included.length === 1 ? "" : "s"} will upload`)),
      el("p", null, `${(s.records.size - included.length).toLocaleString()} record${s.records.size - included.length === 1 ? "" : "s"} will stay private. Nothing uploads until you press the final Submit button.`),
      el("button", { class: "btn large", type: "button", onclick: () => { s.filters.source = "all"; s.filters.status = "included"; s.filters.page = 0; ctx.actions.goto("items"); } }, "Review or edit selected records")
    )
  );

  // Per-source table
  const table = el("div", { class: "review-table card" });
  const kinds: SourceKind[] = ["email", "calendar", "contacts", "messages", "orders", "transactions"];
  for (const kind of kinds) {
    const total = [...s.records.values()].filter((r) => r.source === kind).length;
    if (!total) continue;
    const inc = byKind.get(kind)?.length ?? 0;
    table.append(
      el(
        "div",
        { class: "review-row" },
        el("span", { class: "review-kind" }, kind === "orders" ? "purchases from email" : kind),
        el("span", { class: "mono" }, `${inc.toLocaleString()} of ${total.toLocaleString()} included`),
        el(
          "button",
          {
            class: "as-link small",
            type: "button",
            onclick: () => {
              s.filters.source = kind;
              s.filters.status = "all";
              s.filters.page = 0;
              ctx.actions.goto("items");
            },
          },
          "change selection"
        )
      )
    );
  }
  if (!included.length) table.append(el("p", { class: "empty-note" }, "Nothing selected yet."));
  root.append(el("p", { class: "field-label" }, "WHAT YOU SELECTED"), table);

  // Redaction summary
  const edited = [...s.decisions.values()].filter((d) => Object.keys(d.edits).length || d.bodyEdit !== null).length;
  const aliased = s.entities.filter((e) => !e.keepReal && (e.category === "person" || e.category === "self")).length;
  const keptReal = s.entities.filter((e) => e.keepReal).length;
  root.append(
    el("p", { class: "field-label" }, "REDACTION"),
    el(
      "div",
      { class: "review-table card" },
      summaryRow(`${aliased} people pseudonymized (consistent aliases across sources)`, () => ctx.actions.goto("entities")),
      summaryRow(`${keptReal} entities kept real (merchants/orgs)`, () => ctx.actions.goto("entities")),
      summaryRow(`${edited} records hand-edited`, () => {
        s.filters.status = "edited";
        s.filters.source = "all";
        ctx.actions.goto("items");
      }),
      el("div", { class: "review-row" }, el("span", null, `${s.rules.length} replace-everywhere rules · direct identifiers, credentials, government IDs, financial IDs, device IDs, and precise locations scanned before upload`))
    )
  );

  root.append(
    el("p", { class: "field-label" }, "PRIVACY GATE"),
    privacyAuditPanel(ctx)
  );

  // Tasks
  root.append(
    el("p", { class: "field-label" }, `TASKS (${s.tasks.length})`),
    el(
      "div",
      { class: "review-table card" },
      ...(s.tasks.length
        ? s.tasks.map((t) => el("div", { class: "review-row" }, el("span", null, t.task_title), el("span", { class: "mono" }, `${t.referenced_record_ids.length} records`)))
        : [el("p", { class: "empty-note" }, "No tasks yet — at least one is required.")]),
      s.formErrors.tasks ? el("p", { class: "field-error" }, s.formErrors.tasks) : null
    )
  );

  // Size estimate (serialization dry-run over a sample for speed).
  const estimate = estimateUpload(ctx, included);
  root.append(
    el(
      "section",
      { class: "history-consent card" },
      el("p", { class: "login-consent-kicker mono" }, "FINAL CHECK — WHAT UPLOADS"),
      el(
        "p",
        { class: "review-consent-detail" },
        `${included.length.toLocaleString()} records across ${byKind.size} source${byKind.size === 1 ? "" : "s"}, your ${s.tasks.length} task${s.tasks.length === 1 ? "" : "s"}, and an alias table (fake names only). ` +
          `Estimated ${fmtBytes(estimate.bytes)} in ${estimate.parts + 1} file${estimate.parts ? "s" : ""}. ` +
          "Your real name→alias mapping, excluded records, and original values of edited fields stay on this device."
      )
    ),
    el(
      "div",
      { class: "upload-band review-upload-band" },
      el("div", { class: "upload-band-copy" }, el("strong", null, "Inspect first, then submit"), el("span", null, "Export and Submit both rebuild the files and run the independent privacy gate. A blocking finding prevents any network upload.")),
      el("div", { class: "upload-band-actions" },
      el(
        "button",
        {
          class: "btn large",
          type: "button",
          disabled: !!s.busy || !included.length,
          title: "Builds the exact files that would upload and saves them as one JSON to your device — nothing is sent.",
          onclick: () => void downloadPreview(ctx),
        },
        "1. Export exact upload copy"
      ),
      el(
        "button",
        {
          class: "btn primary large",
          type: "button",
          disabled: !!s.busy || !included.length || !s.tasks.length,
          onclick: () => void ctx.actions.submitBundle(),
        },
        s.busy ? s.busy : `2. Privacy-check & submit ${included.length.toLocaleString()} records + ${s.tasks.length} task${s.tasks.length === 1 ? "" : "s"}`
      ),
      ),
      s.formErrors.sources ? el("p", { class: "field-error" }, s.formErrors.sources) : null
    )
  );
  return root;
}

// Assembles the REAL upload (same code path as submit) and saves it locally as
// one JSON file — the participant can read, keep, or diff exactly what would
// leave the browser. Nothing is transmitted.
async function downloadPreview(ctx: Ctx): Promise<void> {
  const s = ctx.state;
  const identity = s.identity;
  if (!identity) return;
  const uploadIdentity = participantUploadIdentity(identity, s.entities);
  const uploadParticipantId = participantId(uploadIdentity);
  // Reuse (or mint) the same bundle id submit will use, so the preview matches
  // the eventual upload byte for byte.
  if (!s.bundleId || !s.bundleId.startsWith(`pc/${uploadParticipantId}/internal/`)) {
    s.bundleCreatedAt = new Date().toISOString();
    s.bundleId = buildBundleId(uploadIdentity, s.bundleCreatedAt);
    ctx.autosave();
  }
  s.busy = "Assembling preview…";
  ctx.rerender();
  try {
    const { uploads, manifestBody, privacyAudit } = await assembleBundle(
      s,
      ctx.store,
      identity,
      s.bundleId,
      s.bundleCreatedAt!,
      (r) => ctx.actions.isIncluded(r)
    );
    s.privacyAudit = privacyAudit;
    if (privacyAudit.status === "blocked") {
      downloadPrivacyAudit(privacyAudit);
      ctx.actions.notifyError(`Exact preview blocked: ${privacyAudit.blocking_findings} PII finding${privacyAudit.blocking_findings === 1 ? "" : "s"}. A safe privacy audit was downloaded instead.`);
      return;
    }
    const files: Record<string, unknown> = {};
    for (const u of uploads) files[u.filename] = JSON.parse(u.body);
    files["manifest.json"] = JSON.parse(manifestBody);
    downloadJson("apollo-pc-upload-preview.json", {
      note: "The files object is the exact would-be submission. The privacy_audit object is a local report and contains no matched values.",
      privacy_audit: privacyAudit,
      files,
    });
    ctx.actions.notifyInfo(`Preview saved. Privacy gate ${privacyAudit.status === "pass" ? "passed" : `passed with ${privacyAudit.warnings} warning${privacyAudit.warnings === 1 ? "" : "s"}`}.`);
  } finally {
    s.busy = null;
    ctx.rerender();
  }
}

function privacyAuditPanel(ctx: Ctx): HTMLElement {
  const audit = ctx.state.privacyAudit;
  if (!audit) return el(
    "section",
    { class: "privacy-gate pending", "data-testid": "privacy-gate" },
    el("div", null, el("strong", null, "Not run for this exact bundle yet"), el("p", null, "Export or Submit runs a final scan over records, tasks, and manifest metadata. The scan report never includes the matched values.")),
    el("span", { class: "privacy-status mono" }, "PENDING")
  );
  const status = audit.status === "blocked" ? "BLOCKED" : audit.status === "review" ? "PASS + REVIEW" : "PASS";
  return el(
    "section",
    { class: `privacy-gate ${audit.status}`, "data-testid": "privacy-gate" },
    el(
      "div",
      { class: "privacy-gate-copy" },
      el("strong", null, audit.status === "blocked" ? "Upload is blocked" : audit.status === "review" ? "No blocking PII; residual risk needs review" : "No blocking PII detected"),
      el("p", null, `${audit.scanned_values.toLocaleString()} values across ${audit.scanned_files.toLocaleString()} files · ${audit.blocking_findings.toLocaleString()} blocking · ${audit.warnings.toLocaleString()} warning${audit.warnings === 1 ? "" : "s"}`),
      audit.findings.length ? el("ul", { class: "privacy-findings" }, ...audit.findings.slice(0, 6).map((finding) => el("li", null, `${finding.message} (${finding.count.toLocaleString()})`))) : null,
      el("button", { class: "btn small", type: "button", onclick: () => downloadPrivacyAudit(audit) }, "Download privacy audit")
    ),
    el("span", { class: "privacy-status mono" }, status)
  );
}

function downloadPrivacyAudit(audit: PrivacyAudit): void {
  downloadJson("apollo-pc-privacy-audit.json", {
    note: "This report contains detector names and field paths only. Matched personal values are intentionally omitted.",
    privacy_audit: audit,
  });
}

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function summaryRow(text: string, onclick: () => void): HTMLElement {
  return el(
    "div",
    { class: "review-row" },
    el("span", null, text),
    el("button", { class: "as-link small", type: "button", onclick }, "view")
  );
}

// Rough size estimate: serialize a sample of records per kind and extrapolate.
// Exact sizing happens at submit; this just powers the label.
function estimateUpload(ctx: Ctx, included: SourceRecord[]): { bytes: number; parts: number } {
  const s = ctx.state;
  const redactCtx = buildRedactContext(s.entities, s.rules);
  const byKind = new Map<SourceKind, SourceRecord[]>();
  for (const r of included) {
    const list = byKind.get(r.source) || [];
    list.push(r);
    byKind.set(r.source, list);
  }
  let bytes = 0;
  let parts = 0;
  for (const [kind, records] of byKind) {
    const sample = records.slice(0, 25);
    const serialized: SerializedRecord[] = sample.map((r) =>
      serializeRecord(r, s.decisions.get(r.id), redactCtx, r.source === "email" ? "x".repeat(1200) : null)
    );
    const sampleBytes = serialized.reduce((a, rec) => a + utf8Bytes(JSON.stringify(rec)), 0);
    const avg = sample.length ? sampleBytes / sample.length : 400;
    const kindBytes = Math.round(avg * records.length);
    bytes += kindBytes;
    parts += Math.max(1, splitRecordsIntoParts("est", kind, [], undefined).length, Math.ceil(kindBytes / 4_500_000));
  }
  return { bytes, parts };
}
