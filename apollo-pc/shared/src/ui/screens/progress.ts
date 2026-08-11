import { loadUploadLog, type UploadLogEntry } from "../../platform";
import { el, fmtDayYear } from "../components/helpers";
import { participantKey } from "../identity";
import type { Ctx } from "../context";
import { defaultReviewKey } from "../../config";
import { isAdminEmail } from "../../admin-access";
import {
  loadPCAdminDetail,
  loadPCAdminSummary,
  savePCAdminRecord,
  type PCAdminBundle,
  type PCAdminDetail,
  type PCAdminItem,
  type PCAdminKind,
  type PCAdminSummary,
} from "../../admin-client";
import type { EmailPrivacyReview } from "../../types";

const logCache = new Map<string, UploadLogEntry[]>();

export function filterPCAdminBundles(bundles: PCAdminBundle[], participantId: string, query: string): PCAdminBundle[] {
  const normalized = query.trim().toLowerCase();
  return bundles.filter((bundle) => {
    if (participantId && bundle.participant_id !== participantId) return false;
    if (!normalized) return true;
    return [bundle.bundle_id, bundle.participant_name, bundle.participant_email, bundle.participant_id]
      .some((value) => value.toLowerCase().includes(normalized));
  });
}

function countTile(value: number, label: string): HTMLElement {
  return el("div", { class: "pc-admin-count" }, el("strong", { class: "mono" }, value.toLocaleString()), el("span", null, label));
}

function detailTitle(kind: PCAdminKind, item: Record<string, unknown>, index: number): string {
  const record = (item.record && typeof item.record === "object" ? item.record : item) as Record<string, unknown>;
  if (kind === "email") return String(record.subject || record.snippet || `Email ${index + 1}`);
  if (kind === "calendar") return String(record.summary || record.description || `Calendar event ${index + 1}`);
  return String(record.task_title || record.agent_request || `Task ${index + 1}`);
}

function detailSubtitle(kind: PCAdminKind, item: Record<string, unknown>): string {
  const record = (item.record && typeof item.record === "object" ? item.record : item) as Record<string, unknown>;
  if (kind === "email" || kind === "calendar") return "";
  return [record.category, Array.isArray(record.required_sources) ? record.required_sources.join(", ") : ""].filter(Boolean).join(" · ");
}

export function adminPrivacyReviewLabel(item: PCAdminItem): string | null {
  const review = item.privacy_review;
  if (!review) return null;
  if (!review.needs_annotator_review) return `${review.service_label || "Organization/service"} · no personal-sender flag`;
  const reasons: string[] = [];
  if (review.reasons.includes("personal-correspondence")) reasons.push("personal sender");
  if (review.reasons.includes("personal-sender-kept-real")) reasons.push("kept real");
  if (review.reasons.includes("sensitive-content-masked")) reasons.push("sensitive content masked");
  return `PII REVIEW · ${reasons.join(" · ") || "review requested"}`;
}

export function parseAdminFieldValue(raw: string, original: unknown): unknown {
  if (Array.isArray(original) || (original !== null && typeof original === "object")) return JSON.parse(raw);
  if (typeof original === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error("Enter a valid number.");
    return value;
  }
  if (typeof original === "boolean") return raw === "true";
  if (original === null) return raw.trim() ? raw : null;
  return raw;
}

type EmailAddress = { name: string; email: string };

function emailAddress(value: unknown): EmailAddress {
  const address = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { name: String(address.name || "").trim(), email: String(address.email || "").trim() };
}

export function formatAdminEmailAddress(value: unknown): string {
  const address = emailAddress(value);
  if (address.name && address.email) return `${address.name} <${address.email}>`;
  return address.email || address.name;
}

export function parseAdminEmailAddress(raw: string): EmailAddress {
  const value = raw.trim();
  const bracketed = value.match(/^(.*?)\s*<([^<>]+)>$/);
  if (bracketed) return { name: bracketed[1].trim(), email: bracketed[2].trim() };
  return value.includes("@") ? { name: "", email: value } : { name: value, email: "" };
}

function protectedEmailSet(values: string[]): Set<string> {
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

export function isProtectedAdminEmailAddress(value: unknown, protectedEmails: string[]): boolean {
  return protectedEmailSet(protectedEmails).has(emailAddress(value).email.toLowerCase());
}

export function parseAdminEmailRecipients(raw: string): EmailAddress[] {
  return raw.split(/\n|,(?=\s*[^<>]*(?:<|$))/).map(parseAdminEmailAddress).filter((address) => address.name || address.email);
}

function fieldControl(field: string, value: unknown): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  if (typeof value === "boolean") {
    return el("select", { class: "field-input", value: String(value), "aria-label": field }, el("option", { value: "true" }, "True"), el("option", { value: "false" }, "False"));
  }
  const serialized = value !== null && typeof value === "object" ? JSON.stringify(value, null, 2) : String(value ?? "");
  const multiline = serialized.length > 100 || /body|description|snippet|attendees|attachments|labels|from|to|cc|organizer/i.test(field);
  return multiline
    ? el("textarea", { class: `field-input ${typeof value === "object" && value !== null ? "mono" : ""}`, rows: Math.min(10, Math.max(3, serialized.split("\n").length + 1)), "aria-label": field }, serialized)
    : el("input", { class: "field-input", type: typeof value === "number" ? "number" : "text", value: serialized, "aria-label": field });
}

function recordEditor(
  item: PCAdminItem,
  kind: PCAdminKind,
  onSave: (record: Record<string, unknown>, status: HTMLElement, saveButton: HTMLButtonElement) => Promise<void>,
  onCancel: () => void
): HTMLElement {
  const record = item.record ?? {};
  if (kind === "email") return emailRecordEditor(record, onSave, onCancel);
  if (kind === "calendar") return calendarRecordEditor(record, onSave, onCancel);
  const controls = new Map<string, { node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement; original: unknown }>();
  const fields = el("div", { class: "pc-admin-edit-fields" });
  for (const [field, value] of Object.entries(record)) {
    if (["id", "source", "sourceDetail", "searchText"].includes(field)) continue;
    const control = fieldControl(field, value);
    controls.set(field, { node: control, original: value });
    fields.append(el("label", { class: "pc-admin-edit-field" }, el("span", null, field.replaceAll("_", " ")), control));
  }
  const status = el("p", { class: "pc-admin-edit-status", role: "status" });
  const saveButton = el("button", {
    class: "btn primary small",
    type: "button",
    onclick: async () => {
      const updated = { ...record };
      try {
        for (const [field, control] of controls) updated[field] = parseAdminFieldValue(control.node.value, control.original);
      } catch (error) {
        status.className = "pc-admin-edit-status field-error";
        status.textContent = error instanceof Error ? error.message : "One field is invalid.";
        return;
      }
      await onSave(updated, status, saveButton);
    },
  }, "Save changes");
  return el(
    "div",
    { class: "pc-admin-editor" },
    el("div", { class: "pc-admin-edit-note" }, el("strong", null, "Editing the admin copy"), el("span", null, "The participant's submitted file stays unchanged; this revision is stored with your email and timestamp.")),
    fields,
    status,
    el("div", { class: "pc-admin-edit-actions" }, saveButton, el("button", { class: "btn ghost small", type: "button", onclick: onCancel }, "Cancel"))
  );
}

function labeledEmailField(label: string, control: HTMLInputElement | HTMLTextAreaElement, hint = ""): HTMLElement {
  return el("label", { class: "pc-admin-edit-field" }, el("span", null, label), control, ...(hint ? [el("small", null, hint)] : []));
}

function emailRecordEditor(
  record: Record<string, unknown>,
  onSave: (record: Record<string, unknown>, status: HTMLElement, saveButton: HTMLButtonElement) => Promise<void>,
  onCancel: () => void
): HTMLElement {
  const subject = el("input", { class: "field-input", type: "text", value: String(record.subject || ""), "aria-label": "Subject" });
  const contentInput = el("textarea", { class: "field-input pc-admin-email-content-input", rows: 12, "aria-label": "Email content" }, String(record.body_text || ""));
  const status = el("p", { class: "pc-admin-edit-status", role: "status" });
  const fields = el(
    "div",
    { class: "pc-admin-edit-fields pc-admin-email-edit-fields" },
    labeledEmailField("Subject", subject),
    labeledEmailField("Email content", contentInput)
  );
  const saveButton = el("button", {
    class: "btn primary small",
    type: "button",
    onclick: async () => {
      const updated = {
        ...record,
        subject: subject.value,
        body_text: contentInput.value,
      };
      await onSave(updated, status, saveButton);
    },
  }, "Save changes");
  return el(
    "div",
    { class: "pc-admin-editor" },
    el("div", { class: "pc-admin-edit-note" }, el("strong", null, "Subject and content only"), el("span", null, "The submitted original stays unchanged.")),
    fields,
    status,
    el("div", { class: "pc-admin-edit-actions" }, saveButton, el("button", { class: "btn ghost small", type: "button", onclick: onCancel }, "Cancel"))
  );
}

function calendarRecordEditor(
  record: Record<string, unknown>,
  onSave: (record: Record<string, unknown>, status: HTMLElement, saveButton: HTMLButtonElement) => Promise<void>,
  onCancel: () => void
): HTMLElement {
  const summary = el("input", { class: "field-input", type: "text", value: String(record.summary || ""), "aria-label": "Summary" });
  const description = el("textarea", { class: "field-input pc-admin-email-content-input", rows: 12, "aria-label": "Description" }, String(record.description || ""));
  const status = el("p", { class: "pc-admin-edit-status", role: "status" });
  const saveButton = el("button", {
    class: "btn primary small",
    type: "button",
    onclick: async () => onSave({ ...record, summary: summary.value, description: description.value }, status, saveButton),
  }, "Save changes");
  return el(
    "div",
    { class: "pc-admin-editor" },
    el("div", { class: "pc-admin-edit-note" }, el("strong", null, "Summary and description only"), el("span", null, "The submitted original stays unchanged.")),
    el("div", { class: "pc-admin-edit-fields pc-admin-email-edit-fields" },
      labeledEmailField("Summary", summary),
      labeledEmailField("Description", description)
    ),
    status,
    el("div", { class: "pc-admin-edit-actions" }, saveButton, el("button", { class: "btn ghost small", type: "button", onclick: onCancel }, "Cancel"))
  );
}

function emailPreview(record: Record<string, unknown>, privacyReview?: EmailPrivacyReview): HTMLElement {
  const privacy = privacyReview
    ? el(
        "div",
        { class: `pc-admin-privacy-flag ${privacyReview.needs_annotator_review ? "warn" : "ok"}` },
        el("strong", null, privacyReview.needs_annotator_review ? "Privacy review" : "Organization/service sender"),
        el(
          "span",
          null,
          privacyReview.needs_annotator_review
            ? privacyReview.reasons.includes("personal-correspondence")
              ? "Personal correspondence is pseudonymized; verify that the remaining content is appropriate."
              : "A high-sensitivity value was masked; verify that the surrounding content is appropriate."
            : `${privacyReview.service_label || "This sender"} is not treated as a person and does not receive a personal-PII flag.`
        )
      )
    : null;
  return el(
    "div",
    { class: "pc-admin-email-preview" },
    privacy,
    el("dl", { class: "pc-admin-email-meta" },
      el("div", null, el("dt", null, "Subject"), el("dd", null, String(record.subject || "—")))
    ),
    el("div", { class: "pc-admin-email-content" }, el("strong", null, "Content"), el("p", null, String(record.body_text || "No content.")))
  );
}

function calendarPreview(record: Record<string, unknown>): HTMLElement {
  return el(
    "div",
    { class: "pc-admin-email-preview" },
    el("dl", { class: "pc-admin-email-meta" },
      el("div", null, el("dt", null, "Summary"), el("dd", null, String(record.summary || "—")))
    ),
    el("div", { class: "pc-admin-email-content" }, el("strong", null, "Description"), el("p", null, String(record.description || "No description.")))
  );
}

function recordReadout(kind: PCAdminKind, record: Record<string, unknown>, _protectedEmails: string[], privacyReview?: EmailPrivacyReview): HTMLElement {
  if (kind === "email") return emailPreview(record, privacyReview);
  if (kind === "calendar") return calendarPreview(record);
  return el("pre", { class: "pc-admin-json" }, JSON.stringify(record, null, 2));
}

function recordRows(
  detail: PCAdminDetail,
  saveRecord: (item: PCAdminItem, finalRecord: Record<string, unknown>, status: HTMLElement, saveButton: HTMLButtonElement) => Promise<void>
): HTMLElement[] {
  return detail.items.map((item, index) =>
    (() => {
      const content = el("div", { class: "pc-admin-record-content" });
      const privacyLabel = detail.kind === "email" ? adminPrivacyReviewLabel(item) : null;
      const needsPrivacyReview = Boolean(item.privacy_review?.needs_annotator_review);
      const row = el(
        "details",
        { class: `pc-admin-record ${item.admin_edit ? "edited" : ""} ${needsPrivacyReview ? "privacy-review" : ""}` },
        el(
        "summary",
        null,
        el("span", null, el("strong", null, detailTitle(detail.kind, item, index)), ...(detailSubtitle(detail.kind, item) ? [el("small", null, detailSubtitle(detail.kind, item))] : []), ...(privacyLabel ? [el("small", { class: needsPrivacyReview ? "privacy-review-label" : "service-sender-label" }, privacyLabel)] : [])),
        el("span", { class: "pc-admin-record-number mono" }, item.admin_edit ? `EDITED · ${detail.page * detail.page_size + index + 1}` : String(detail.page * detail.page_size + index + 1))
        ),
        content
      );
      let hydrated = false;
      row.addEventListener("toggle", () => {
        if (!row.open || hydrated) return;
        hydrated = true;
        const readView = el(
          "div",
          { class: "pc-admin-record-read" },
          el(
            "div",
            { class: "pc-admin-record-tools" },
            ...(detail.kind !== "tasks"
              ? [el("button", { class: "btn small", type: "button", onclick: () => {
                  readView.hidden = true;
                  const editor = recordEditor(item, detail.kind, (record, status, saveButton) => saveRecord(item, record, status, saveButton), () => {
                    editor.remove();
                    readView.hidden = false;
                  });
                  content.append(editor);
                } }, "Edit record")]
              : []),
            ...(item.admin_edit ? [el("span", { class: "chip ok" }, `Edited · revision ${item.admin_edit.revision_count}`)] : [])
          ),
          recordReadout(detail.kind, item.record ?? item, detail.protected_emails || [], item.privacy_review),
          ...(item.admin_edit
            ? [el("details", { class: "pc-admin-original" }, el("summary", null, "View submitted original"), recordReadout(detail.kind, item.admin_edit.original_record, detail.protected_emails || [], item.privacy_review))]
            : [])
        );
        content.append(readView);
      });
      return row;
    })()
  );
}

function adminViewer(reviewKey: string, adminEmail: string): HTMLElement {
  const panel = el(
    "section",
    { class: "pc-admin-panel", "aria-labelledby": "pc-admin-heading" },
    el(
      "div",
      { class: "pc-admin-head" },
      el("div", null, el("p", { class: "step-kicker mono" }, "ALLOWLISTED ADMIN"), el("h3", { id: "pc-admin-heading" }, "Uploaded data viewer")),
      el("p", null, "Review submitted mail, calendar events, and tasks by participant.")
    ),
    el("p", { class: "empty-note pc-admin-loading" }, "Loading completed bundles…")
  );
  void loadPCAdminSummary(reviewKey, adminEmail)
    .then((summary) => hydrateAdmin(panel, summary, reviewKey, adminEmail))
    .catch((error: unknown) => panel.querySelector(".pc-admin-loading")?.replaceWith(el("p", { class: "field-error" }, error instanceof Error ? error.message : "Couldn't load uploaded data.")));
  return panel;
}

function hydrateAdmin(panel: HTMLElement, summary: PCAdminSummary, reviewKey: string, adminEmail: string): void {
  panel.querySelector(".pc-admin-loading")?.remove();
  const counts = el(
    "div",
    { class: "pc-admin-counts" },
    countTile(summary.totals.bundles, "bundles"),
    countTile(summary.totals.email, "emails"),
    countTile(summary.totals.calendar, "calendar events"),
    countTile(summary.totals.tasks, "tasks")
  );
  const users = el("div", { class: "pc-admin-users" });
  for (const user of summary.users) {
    users.append(
      el(
        "button",
        { class: "pc-admin-user", type: "button", dataset: { participantId: user.participant_id } },
        el("strong", null, user.name),
        el("small", null, user.email || user.participant_id),
        el("span", { class: "mono" }, `${user.email_count} mail · ${user.calendar_count} calendar · ${user.task_count} tasks`)
      )
    );
  }
  const search = el("input", { class: "field-input", type: "search", placeholder: "Search user, email, or bundle ID…", "aria-label": "Search uploaded bundles" });
  const userSelect = el("select", { class: "field-input", "aria-label": "Filter uploaded bundles by user" }, el("option", { value: "" }, "All users"));
  for (const user of summary.users) userSelect.append(el("option", { value: user.participant_id }, user.email ? `${user.name} · ${user.email}` : user.name));
  const result = el("p", { class: "pc-admin-result mono", role: "status" });
  const bundles = el("div", { class: "pc-admin-bundles" });
  const viewer = el("section", { class: "pc-admin-viewer", hidden: true });
  let active: { bundle: PCAdminBundle; kind: PCAdminKind; page: number; query: string } | null = null;

  const openDetail = async (bundle: PCAdminBundle, kind: PCAdminKind, page = 0, query = "") => {
    active = { bundle, kind, page, query };
    viewer.hidden = false;
    viewer.replaceChildren(el("p", { class: "empty-note" }, `Loading ${kind}…`));
    try {
      const detail = await loadPCAdminDetail(reviewKey, adminEmail, bundle.bundle_id, kind, page, query);
      const kindLabel = kind === "email" ? "emails" : kind === "calendar" ? "calendar events" : "tasks";
      const queryInput = el("input", { class: "field-input", type: "search", value: query, placeholder: `Search this bundle's ${kindLabel}…`, "aria-label": `Search ${kindLabel}` });
      const searchButton = el("button", { class: "btn small", type: "button", onclick: () => void openDetail(bundle, kind, 0, queryInput.value) }, "Search");
      const closeButton = el("button", { class: "btn ghost small", type: "button", onclick: () => { viewer.hidden = true; viewer.replaceChildren(); active = null; } }, "Close viewer");
      const pages = Math.max(1, Math.ceil(detail.total / detail.page_size));
      viewer.replaceChildren(
        el("div", { class: "pc-admin-viewer-head" }, el("div", null, el("p", { class: "step-kicker mono" }, kindLabel.toUpperCase()), el("h4", null, `${bundle.participant_name} · ${fmtDayYear(bundle.created_at)}`)), closeButton),
        el("div", { class: "pc-admin-viewer-search" }, queryInput, searchButton),
        el("p", { class: "pc-admin-result mono" }, `${detail.total.toLocaleString()} ${kindLabel} · page ${detail.page + 1} of ${pages}`),
        ...(detail.items.length ? recordRows(detail, async (item, finalRecord, status, saveButton) => {
          const itemId = String(item.record?.id || "");
          if (!itemId || detail.kind === "tasks") return;
          saveButton.disabled = true;
          saveButton.textContent = "Saving…";
          status.className = "pc-admin-edit-status";
          status.textContent = "";
          try {
            await savePCAdminRecord(
              reviewKey,
              adminEmail,
              bundle.bundle_id,
              detail.kind,
              itemId,
              finalRecord,
              item.admin_edit?.revision_count ?? 0
            );
            status.textContent = "Saved. Reloading the audited revision…";
            await openDetail(bundle, detail.kind, detail.page, query);
          } catch (error) {
            status.className = "pc-admin-edit-status field-error";
            status.textContent = error instanceof Error ? error.message : "Couldn't save this record.";
            saveButton.disabled = false;
            saveButton.textContent = "Save changes";
          }
        }) : [el("p", { class: "empty-note" }, "No records match this search.")]),
        el("div", { class: "pc-admin-pager" },
          el("button", { class: "btn ghost small", type: "button", disabled: detail.page === 0, onclick: () => void openDetail(bundle, kind, detail.page - 1, query) }, "← Previous"),
          el("button", { class: "btn ghost small", type: "button", disabled: detail.page + 1 >= pages, onclick: () => void openDetail(bundle, kind, detail.page + 1, query) }, "Next →")
        )
      );
      viewer.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      viewer.replaceChildren(el("p", { class: "field-error" }, error instanceof Error ? error.message : "Couldn't load records."));
    }
  };

  const draw = () => {
    const filtered = filterPCAdminBundles(summary.bundles, userSelect.value, search.value);
    result.textContent = `${filtered.length} of ${summary.bundles.length} completed bundles`;
    bundles.replaceChildren(...(filtered.length ? filtered.map((bundle) =>
      el(
        "article",
        { class: "pc-admin-bundle" },
        el("div", { class: "pc-admin-bundle-main" }, el("strong", null, bundle.participant_name), el("small", null, bundle.participant_email || bundle.participant_id), el("span", { class: "mono" }, fmtDayYear(bundle.created_at))),
        el("div", { class: "pc-admin-bundle-counts mono" }, el("span", null, `${bundle.email_count} mail`), el("span", null, `${bundle.calendar_count} calendar`), el("span", null, `${bundle.task_count} tasks`)),
        el("div", { class: "pc-admin-bundle-actions" },
          el("button", { class: "btn ghost small", type: "button", disabled: !bundle.email_count, onclick: () => void openDetail(bundle, "email") }, "View mail"),
          el("button", { class: "btn ghost small", type: "button", disabled: !bundle.calendar_count, onclick: () => void openDetail(bundle, "calendar") }, "View calendar"),
          el("button", { class: "btn ghost small", type: "button", disabled: !bundle.task_count, onclick: () => void openDetail(bundle, "tasks") }, "View tasks")
        )
      )
    ) : [el("p", { class: "empty-note" }, "No completed bundles match these filters.")]));
    for (const card of users.querySelectorAll<HTMLButtonElement>(".pc-admin-user")) card.classList.toggle("active", card.dataset.participantId === userSelect.value);
    if (active && !filtered.some((bundle) => bundle.bundle_id === active?.bundle.bundle_id)) { viewer.hidden = true; active = null; }
  };
  search.addEventListener("input", draw);
  userSelect.addEventListener("change", draw);
  users.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>(".pc-admin-user");
    if (!card) return;
    userSelect.value = userSelect.value === card.dataset.participantId ? "" : card.dataset.participantId || "";
    draw();
  });
  panel.append(counts, users, el("div", { class: "pc-admin-filters" }, search, userSelect), result, bundles, viewer);
  draw();
}

export function renderProgress(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const admin = Boolean(s.identity && isAdminEmail(s.identity.email) && defaultReviewKey());
  const root = el("section", { class: `screen ${admin ? "wide pc-admin-screen" : "narrow"}` });
  root.append(
    el("h2", { class: "display" }, "Your submissions"),
    el("p", { class: "screen-sub" }, `${s.uploadedCount} bundle${s.uploadedCount === 1 ? "" : "s"} submitted from this browser.`)
  );

  if (s.identity) {
    const owner = participantKey(s.identity);
    const cached = logCache.get(owner);
    if (!cached) {
      void loadUploadLog(ctx.adapter.storage, owner).then((log) => {
        logCache.set(owner, log.reverse());
        ctx.rerender();
      });
      root.append(el("p", { class: "mono" }, "Loading…"));
    } else if (!cached.length) {
      root.append(el("p", { class: "empty-note" }, "No submissions yet."));
    } else {
      const list = el("div", { class: "review-table card" });
      for (const entry of cached) {
        list.append(
          el(
            "div",
            { class: "review-row" },
            el("span", { class: "mono" }, fmtDayYear(entry.at)),
            el("span", null, entry.source_counts ? `${(entry.source_counts.email ?? 0).toLocaleString()} email · ${(entry.source_counts.calendar ?? 0).toLocaleString()} calendar · ${entry.task_count} tasks` : `${entry.record_count.toLocaleString()} records · ${entry.task_count} tasks`),
            el("span", { class: "mono" }, entry.sources.join(", "))
          )
        );
      }
      root.append(list);
      if (cached.length !== s.uploadedCount) logCache.delete(owner); // stale after a new submit
    }
  }

  const reviewKey = defaultReviewKey();
  if (s.identity && isAdminEmail(s.identity.email) && reviewKey) root.append(adminViewer(reviewKey, s.identity.email));

  root.append(
    el(
      "p",
      { class: "privacy-note" },
      "Done contributing on this machine? ",
      el(
        "button",
        {
          class: "as-link",
          type: "button",
          onclick: () => {
            if (confirm("Erase all imported data, decisions, and drafts from this browser?")) void ctx.actions.eraseAll();
          },
        },
        "Erase all local data"
      )
    )
  );
  return root;
}
