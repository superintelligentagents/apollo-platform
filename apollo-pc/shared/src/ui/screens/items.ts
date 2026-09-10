import { scrubText, type ScrubMatch } from "../../scrub";
import { appIdsForRecord, historyAppCounts, MYPCBENCH_APPS } from "../../app-catalog";
import { CALENDAR_CATEGORIES, EMAIL_CATEGORIES, linkEmailAndCalendar } from "../../organize";
import { emailMatchesActivity, type EmailActivityStat, type EmailActivitySummary, type EmailDirection } from "../../email-activity";
import type { EmailServiceOption } from "../../email-services";
import { SOURCE_CARDS } from "../../sources/registry";
import type { EmailRecord, SourceKind, SourceRecord } from "../../types";
import { chip, el, fmtDay, fmtTime } from "../components/helpers";
import type { Ctx } from "../context";
import { mailboxIndexFor, type DomainCount, type MailboxIndex } from "../mailbox-index";

const PAGE_SIZE = 100;
const FILTER_TYPING_DELAY_MS = 180;
const SOURCE_TABS: (SourceKind | "all")[] = ["all", "email", "calendar", "documents"];

type EditControl = "input" | "textarea" | "boolean" | "json";
export type EditableField = { field: string; label: string; value: string; control?: EditControl; rows?: number; hint?: string };
let linkedCache: { records: Map<string, SourceRecord>; size: number; links: ReturnType<typeof linkEmailAndCalendar> } | null = null;
const pendingFilterRenders = new WeakMap<object, ReturnType<typeof setTimeout>>();

export function renderItems(ctx: Ctx): HTMLElement {
  return renderUpload(ctx);
}

export function renderEmailItems(ctx: Ctx): HTMLElement {
  return renderUpload(ctx, "email");
}

export function renderCalendarItems(ctx: Ctx): HTMLElement {
  return renderUpload(ctx, "calendar");
}

export function renderDocumentItems(ctx: Ctx): HTMLElement {
  return renderUpload(ctx, "documents");
}

function renderUpload(ctx: Ctx, onlySource?: "email" | "calendar" | "documents"): HTMLElement {
  const s = ctx.state;
  const f = s.filters;
  const index = mailboxIndexFor(s.records, s.identity?.email ?? "");
  const hasCachedLinks = linkedCache?.records === s.records && linkedCache.size === s.records.size;
  const links = hasCachedLinks
    ? linkedCache!.links
    : f.linked !== "all"
      ? calculateLinks(s.records)
      : [];
  const linkedEmailIds = new Set(links.map((link) => link.emailId));
  const linkedCalendarIds = new Set(links.map((link) => link.calendarId));
  const linkedIds = new Set([...linkedEmailIds, ...linkedCalendarIds]);

  const filtered = filterRecords(ctx, index, linkedIds);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(f.page, pages - 1);
  const shown = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const allRecords = onlySource === "email" ? index.emailData : onlySource === "calendar" ? index.calendars : onlySource === "documents" ? index.bySource.get("documents") ?? [] : index.orderedRecords;
  const selectionSources = onlySource === "email"
    ? (["email", "orders"] as SourceKind[])
    : onlySource === "calendar"
      ? (["calendar"] as SourceKind[])
      : onlySource === "documents"
        ? (["documents"] as SourceKind[])
      : [...index.counts.keys()];
  const selectedCount = allRecords.filter((r) => ctx.actions.isIncluded(r)).length;
  const rerenderWith = (patch: Partial<typeof f>) => {
    Object.assign(f, patch, { page: patch.page ?? 0 });
    ctx.rerender();
  };
  const rerenderAfterTyping = (patch: Partial<typeof f>) => {
    Object.assign(f, patch, { page: 0 });
    const pending = pendingFilterRenders.get(s);
    if (pending !== undefined) clearTimeout(pending);
    pendingFilterRenders.set(s, setTimeout(() => {
      pendingFilterRenders.delete(s);
      ctx.rerender();
    }, FILTER_TYPING_DELAY_MS));
  };

  const root = el("section", { class: "screen wide" });
  if (!onlySource) root.append(el("p", { class: "step-kicker mono" }, "STEP 1 · DATA"));
  root.append(
    el("h2", { class: "display" }, onlySource === "email" ? "Mail data" : onlySource === "calendar" ? "Calendar data" : onlySource === "documents" ? "Document data" : "Upload & import data"),
    el(
      "p",
      { class: "screen-sub" },
      onlySource === "email" ? "Add mail files, then choose the messages you want to share." : onlySource === "calendar" ? "Add calendar files, then choose the events you want to share." : onlySource === "documents" ? "Add documents, review their locally extracted text, and choose what you want to share." : "Add files, inspect the imported records, and choose what can upload—all in one workspace. Nothing leaves this browser until final review."
    ),
    dataImportPanel(ctx, onlySource)
  );
  if (allRecords.length) {
    root.append(
      el(
        "section",
        { class: "selection-summary", "aria-label": "Upload selection summary" },
        el("div", null, el("strong", { class: "selection-count mono" }, selectedCount.toLocaleString()), el("span", null, ` of ${allRecords.length.toLocaleString()} records selected`)),
        el(
          "div",
          { class: "selection-summary-actions" },
          el("button", { class: "btn primary", type: "button", "data-testid": "select-all-imported", onclick: () => ctx.actions.bulkIncludeSources(selectionSources, true) }, `Select all ${allRecords.length.toLocaleString()} for upload`),
          el("button", { class: "btn danger-ghost", type: "button", "data-testid": "keep-all-imported-private", onclick: () => ctx.actions.bulkIncludeSources(selectionSources, false) }, `Keep all ${allRecords.length.toLocaleString()} private`),
          el("button", { class: "btn", type: "button", onclick: () => rerenderWith({ status: "included" }) }, "Show selected")
        )
      )
    );
  }

  if (onlySource && !allRecords.length) {
    root.append(el("section", { class: "simple-empty" }, el("h3", null, "Choose files above to begin"), el("p", null, onlySource === "email" ? "Imported mail will appear here with search, categories, parsed purchases, and privacy controls." : onlySource === "calendar" ? "Imported events will appear here with search, repeating-event controls, and privacy controls." : "Extracted document text will appear here with editing and privacy controls.")));
    return root;
  }

  if (!onlySource && !allRecords.length) {
    root.append(el("section", { class: "simple-empty data-empty" }, el("h3", null, "Add your first source"), el("p", null, "Choose mail, calendar, or document files above. Imported records and app-guided filters will appear here.")));
    return root;
  }

  if (!onlySource) root.append(
    el("section", { class: "upload-workflows", "aria-label": "Choose an upload workflow" },
      uploadWorkflowCard(ctx, "email", "Upload email data", "Search every message by text, date, or sender. Use persona categories aligned to shopping, food, travel, finance, work, and other MyPCBench domains.", index.emailData.length),
      uploadWorkflowCard(ctx, "calendar", "Upload calendar data", "Search every event, choose repeating events, use automatic categories, or select events linked to email.", index.calendars.length),
      uploadWorkflowCard(ctx, "documents", "Upload document text", "Inspect text extracted locally from resumes, tax forms, notes, and other documents before sharing it.", index.counts.get("documents") ?? 0)
    )
  );

  // Filters narrow the working set; bulk actions explicitly change selection.
  root.append(
    el(
      "section",
      { class: "selection-tools card" },
      !onlySource ? el(
        "div",
        { class: "selection-tools-head" },
        el("div", null, el("p", { class: "step-kicker mono" }, "FILTER LOCALLY"), el("h3", null, f.source === "email" ? "Choose email data" : f.source === "calendar" ? "Choose calendar data" : f.source === "documents" ? "Choose document text" : "Choose a data type")),
        el("p", null, "Filters change what you see. They never upload or deselect records by themselves.")
      ) : null,
      !onlySource ? el(
        "div",
        { class: "seg-control source-filter", "aria-label": "Filter by source" },
        ...SOURCE_TABS.filter((tab) => tab === "all" || (tab === "email" ? index.emailData.length : index.counts.get(tab) ?? 0) > 0).map((tab) =>
          el(
            "button",
            { class: `seg ${f.source === tab ? "active" : ""}`, type: "button", onclick: () => rerenderWith({ source: tab, category: "all", app: "", direction: "all", correspondent: "", service: "", domain: "", sender: "", recurrence: "all", linked: "all" }) },
            tab === "all" ? `All (${s.records.size.toLocaleString()})` : `${sourceLabel(tab)} (${(tab === "email" ? index.emailData.length : index.counts.get(tab) ?? 0).toLocaleString()})`
          )
        )
      ) : null,
      f.source === "email" ? categoryFilters(ctx, EMAIL_CATEGORIES, index.emailData.length, index.emailCategoryCounts, rerenderWith) : null,
      f.source === "calendar" ? categoryFilters(ctx, CALENDAR_CATEGORIES, index.calendars.length, index.calendarCategoryCounts, rerenderWith) : null,
      f.source === "email" || f.source === "calendar" || f.source === "documents" || f.source === "all" ? historyAppFilter(index, f.source, f.app, rerenderWith) : null,
      f.source === "email" ? inlinePrivacyPanel(ctx) : null,
      f.source === "email" ? emailActivityFilter(index.activity, f.direction, f.correspondent, rerenderWith) : null,
      f.source === "email" ? serviceFilter(index.serviceOptions, f.service, rerenderWith) : null,
      f.source === "email" ? domainFilter(index.domainCounts, index.emails.length, f.domain, rerenderWith) : null,
      el(
        "div",
        { class: "primary-search-row" },
        el("label", { class: "field filter-search primary-search" }, el("span", { class: "field-label" }, "Search"), el("input", {
          type: "search", class: "field-input", "data-testid": "record-search-filter", placeholder: f.source === "calendar" ? "Summary or description…" : f.source === "documents" ? "Filename, title, or extracted text…" : "Enter an email, sender, subject, or service…", value: f.query,
          oninput: (e: Event) => rerenderAfterTyping({ query: (e.target as HTMLInputElement).value }),
        })),
        f.source === "email" ? el("label", { class: "field search-scope" }, el("span", { class: "field-label" }, "Search in"), el("select", { class: "field-input", "data-testid": "record-search-scope", onchange: (event: Event) => rerenderWith({ queryScope: (event.target as HTMLSelectElement).value as typeof f.queryScope }) }, ...([ ["all", "Everything"], ["email", "Email addresses"], ["sender", "Sender"], ["subject", "Subject"] ] as const).map(([value, label]) => el("option", { value, selected: f.queryScope === value }, label)))) : null
      ),
      el(
        "details",
        { class: "advanced-filters" },
        el("summary", null, "More filters"),
        el(
          "div",
          { class: "filter-fields" },
          f.source === "email" ? el("label", { class: "field" }, el("span", { class: "field-label" }, "Sender name or address"), el("input", { type: "search", class: "field-input", "data-testid": "email-sender-filter", placeholder: "Jane or receipts@", value: f.sender, oninput: (e: Event) => rerenderAfterTyping({ sender: (e.target as HTMLInputElement).value }) })) : null,
          el("label", { class: "field" }, el("span", { class: "field-label" }, "From"), el("input", { type: "date", class: "field-input", value: f.from, onchange: (e: Event) => rerenderWith({ from: (e.target as HTMLInputElement).value }) })),
          el("label", { class: "field" }, el("span", { class: "field-label" }, "To"), el("input", { type: "date", class: "field-input", value: f.to, onchange: (e: Event) => rerenderWith({ to: (e.target as HTMLInputElement).value }) })),
          el("label", { class: "field" }, el("span", { class: "field-label" }, "Status"), el("select", { class: "field-input", onchange: (e: Event) => rerenderWith({ status: (e.target as HTMLSelectElement).value as typeof f.status }) }, ...([["all", "All records"], ["included", "Selected"], ["excluded", "Private"], ["edited", "Edited"]] as const).map(([v, label]) => el("option", { value: v, selected: f.status === v }, label)))),
          f.source === "calendar" ? el("label", { class: "field" }, el("span", { class: "field-label" }, "Repeating"), el("select", { class: "field-input", onchange: (e: Event) => rerenderWith({ recurrence: (e.target as HTMLSelectElement).value as typeof f.recurrence }) }, el("option", { value: "all", selected: f.recurrence === "all" }, "All events"), el("option", { value: "recurring", selected: f.recurrence === "recurring" }, "Repeating only"), el("option", { value: "one-off", selected: f.recurrence === "one-off" }, "One-time only"))) : null,
          (f.source === "calendar" || f.source === "email") ? el("label", { class: "field" }, el("span", { class: "field-label" }, "Mail + Calendar link"), el("select", { class: "field-input", onchange: (e: Event) => rerenderWith({ linked: (e.target as HTMLSelectElement).value as typeof f.linked }) }, el("option", { value: "all", selected: f.linked === "all" }, "All records"), el("option", { value: "linked", selected: f.linked === "linked" }, hasCachedLinks || f.linked !== "all" ? `Linked only (${f.source === "email" ? linkedEmailIds.size : linkedCalendarIds.size})` : "Linked only (calculate once)"), el("option", { value: "unlinked", selected: f.linked === "unlinked" }, "Not linked"))) : null
        )
      ),
      f.source === "calendar" ? el("div", { class: "smart-actions" }, el("div", null, el("strong", null, "Automatic choices"), el("p", null, "These buttons only select records. You can review and edit them before final submit.")), el("button", { class: "btn large", type: "button", onclick: () => ctx.actions.bulkInclude(index.recurringCalendars.map((record) => record.id), true) }, `Select all repeating events (${index.recurringCalendars.length.toLocaleString()})`), el("button", { class: "btn large", type: "button", disabled: !index.emails.length || !index.calendars.length, onclick: () => { const found = calculateLinks(s.records); ctx.actions.bulkInclude(found.flatMap((link) => [link.emailId, link.calendarId]), true); } }, hasCachedLinks || f.linked !== "all" ? `Select linked mail + events (${links.length.toLocaleString()} links)` : "Find & select linked mail + events")) : null,
      el(
        "div",
        { class: "bulk-bar" },
        el("div", { class: "bulk-copy" }, el("strong", null, `${filtered.length.toLocaleString()} matching record${filtered.length === 1 ? "" : "s"}`)),
        el("div", { class: "bulk-actions" },
          el("button", { class: "btn primary large", type: "button", disabled: !filtered.length, onclick: () => ctx.actions.bulkInclude(filtered.map((r) => r.id), true) }, `Select ${filtered.length.toLocaleString()} matching filters`),
          el("button", { class: "btn large danger-ghost", type: "button", disabled: !filtered.length, onclick: () => ctx.actions.bulkInclude(filtered.map((r) => r.id), false) }, `Keep ${filtered.length.toLocaleString()} matching private`)
        )
      )
    )
  );

  if (!s.records.size) {
    root.append(el("p", { class: "empty-note" }, "Nothing imported yet — start on the Import screen."));
    return root;
  }

  const layout = el("div", { class: `items-layout ${s.openItemId ? "with-drawer" : ""}` });
  const list = el("div", { class: "item-rows" });
  for (const record of shown) list.append(itemRow(ctx, record));
  layout.append(list);
  if (s.openItemId) {
    const open = s.records.get(s.openItemId);
    if (open) layout.append(detailDrawer(ctx, open));
  }
  root.append(layout);

  if (pages > 1) {
    root.append(
      el(
        "div",
        { class: "pager" },
        el("button", { class: "btn small", type: "button", disabled: page === 0, onclick: () => rerenderWith({ page: page - 1 }) }, "← Prev"),
        el("span", { class: "mono" }, `Page ${page + 1} of ${pages}`),
        el("button", { class: "btn small", type: "button", disabled: page >= pages - 1, onclick: () => rerenderWith({ page: page + 1 }) }, "Next →")
      )
    );
  }
  root.append(
    el(
      "div",
      { class: "data-workspace-footer" },
      el("div", null, el("strong", null, `${selectedCount.toLocaleString()} selected for upload`), el("p", null, "Review privacy masks and the exact bundle before anything is sent.")),
      el("button", { class: "btn", type: "button", onclick: () => ctx.actions.goto("entities") }, "Privacy & aliases"),
      el("button", { class: "btn primary", type: "button", disabled: selectedCount === 0, onclick: () => ctx.actions.goto("review") }, "Review & submit →")
    )
  );
  return root;
}

function dataImportPanel(ctx: Ctx, onlySource?: "email" | "calendar" | "documents"): HTMLElement {
  const kinds = (["email", "calendar", "documents"] as const).filter((kind) => !onlySource || kind === onlySource);
  const panel = el(
    "section",
    { class: "data-import-panel", "aria-label": "Add data files" },
    el(
      "div",
      { class: "data-import-head" },
      el("div", null, el("p", { class: "section-label" }, "ADD FILES"), el("h3", null, "Import locally, then choose what uploads")),
      onlySource === "documents" ? null : dateWindowControl(ctx)
    )
  );
  const controls = el("div", { class: "data-import-grid" });
  for (const kind of kinds) controls.append(dataImportControl(ctx, kind));
  panel.append(controls);
  return panel;
}

function dateWindowControl(ctx: Ctx): HTMLElement {
  return el(
    "label",
    { class: "field data-date-window" },
    el("span", { class: "field-label" }, "Mail & calendar window"),
    el(
      "select",
      { class: "field-input compact", onchange: (event: Event) => { ctx.state.dateFloorMonths = Number((event.target as HTMLSelectElement).value); ctx.autosave(); } },
      ...([[6, "Last 6 months"], [12, "Last 12 months"], [24, "Last 2 years"], [0, "Everything"]] as const).map(([value, label]) => el("option", { value: String(value), selected: ctx.state.dateFloorMonths === value }, label))
    )
  );
}

function dataImportControl(ctx: Ctx, kind: "email" | "calendar" | "documents"): HTMLElement {
  const meta = SOURCE_CARDS.find((card) => card.kind === kind)!;
  const records = [...ctx.state.records.values()].filter((record) => record.source === kind || (kind === "email" && record.source === "orders"));
  const selected = records.filter((record) => ctx.actions.isIncluded(record)).length;
  const guideCount = new Set(records.flatMap((record) => appIdsForRecord(record))).size;
  const importing = ctx.state.importing?.kind === kind ? ctx.state.importing.progress : null;
  const input = el("input", {
    type: "file",
    multiple: true,
    accept: meta.parser!.accept.join(","),
    style: "display:none",
    "data-testid": `data-file-input-${kind}`,
    onchange: (event: Event) => {
      const element = event.target as HTMLInputElement;
      const files = [...(element.files ?? [])];
      element.value = "";
      if (files.length) void ctx.actions.importFiles(kind, files);
    },
  }) as HTMLInputElement;
  const label = kind === "email" ? "Mail" : kind === "calendar" ? "Calendar" : "Documents";
  const hint = kind === "email" ? ".mbox or .eml" : kind === "calendar" ? ".ics files" : "PDF, Word, or text";
  return el(
    "article",
    { class: `data-import-card data-import-${kind}` },
    input,
    el("span", { class: "item-kind mono" }, label.toUpperCase()),
    el("strong", null, label),
    el("p", null, importing ? `${importing.recordsEmitted.toLocaleString()} read so far` : records.length ? `${records.length.toLocaleString()} imported · ${selected.toLocaleString()} selected` : hint),
    records.length ? el("small", { class: "mono" }, `${guideCount.toLocaleString()} MyPCBench guide${guideCount === 1 ? "" : "s"} matched`) : null,
    el(
      "div",
      { class: "data-import-actions" },
      el("button", { class: `btn ${records.length ? "ghost" : "primary"}`, type: "button", disabled: !!ctx.state.importing, "data-testid": `data-import-${kind}`, onclick: () => input.click() }, importing ? "Reading…" : records.length ? "Add more" : "Choose files"),
      records.length ? el("button", { class: "text-button", type: "button", onclick: () => { Object.assign(ctx.state.filters, { source: kind, app: "", category: "all", status: "all", page: 0 }); ctx.rerender(); } }, "Review") : null
    )
  );
}

function calculateLinks(records: Map<string, SourceRecord>): ReturnType<typeof linkEmailAndCalendar> {
  if (linkedCache?.records === records && linkedCache.size === records.size) return linkedCache.links;
  const links = linkEmailAndCalendar(records.values());
  linkedCache = { records, size: records.size, links };
  return links;
}

function sourceLabel(kind: SourceKind): string {
  return kind === "email" ? "email data" : kind === "orders" ? "parsed purchases" : kind === "documents" ? "documents" : kind;
}

export function filterRecords(ctx: Ctx, index: MailboxIndex, linkedIds: Set<string>): SourceRecord[] {
  const s = ctx.state;
  const f = s.filters;
  const q = f.query.trim().toLowerCase();
  const senderQuery = f.sender.trim().toLowerCase();
  const out: SourceRecord[] = [];
  for (const r of index.orderedRecords) {
    if (f.source !== "all" && r.source !== f.source && !(f.source === "email" && r.source === "orders")) continue;
    if (f.category !== "all" && index.categoryById.get(r.id) !== f.category) continue;
    if (f.app && !appIdsForRecord(r).includes(f.app)) continue;
    if ((f.direction !== "all" || f.correspondent) && (r.source !== "email" || !emailMatchesActivity(r, s.identity?.email ?? "", f.direction, f.correspondent))) continue;
    if (f.service && (r.source !== "email" || index.serviceById.get(r.id) !== f.service)) continue;
    if (f.domain && (r.source !== "email" || index.domainById.get(r.id) !== f.domain)) continue;
    if (senderQuery && (r.source !== "email" || !containsSender(r, senderQuery))) continue;
    if (f.recurrence !== "all" && (r.source !== "calendar" || (!!(r.rrule || r.recurrenceId)) !== (f.recurrence === "recurring"))) continue;
    if (f.linked !== "all" && linkedIds.has(r.id) !== (f.linked === "linked")) continue;
    if (f.from && (!r.timestamp || r.timestamp.slice(0, 10) < f.from)) continue;
    if (f.to && (!r.timestamp || r.timestamp.slice(0, 10) > f.to)) continue;
    if (q && !matchesSearch(r, f.queryScope, q, index.serviceLabelById.get(r.id) ?? "")) continue;
    if (f.status !== "all") {
      const included = ctx.actions.isIncluded(r);
      const d = s.decisions.get(r.id);
      const edited = !!d && (Object.keys(d.edits).length > 0 || d.bodyEdit !== null);
      if (f.status === "included" && !included) continue;
      if (f.status === "excluded" && included) continue;
      if (f.status === "edited" && !edited) continue;
    }
    out.push(r);
  }
  return out;
}

function containsSender(record: EmailRecord, query: string): boolean {
  return record.from.name.toLowerCase().includes(query) || record.from.email.toLowerCase().includes(query);
}

function matchesSearch(record: SourceRecord, scope: Ctx["state"]["filters"]["queryScope"], query: string, serviceLabel: string): boolean {
  if (record.source === "email") {
    if (scope === "email") {
      if (record.from.email.toLowerCase().includes(query)) return true;
      return [...record.to, ...record.cc].some((address) => address.email.toLowerCase().includes(query));
    }
    if (scope === "sender") return containsSender(record, query);
    if (scope === "subject") return record.subject.toLowerCase().includes(query);
    if (record.searchText.includes(query) || serviceLabel.includes(query) || record.snippet.toLowerCase().includes(query)) return true;
    // Older persisted MBOX indexes did not include CC fields, and an edited
    // in-memory header may be newer than its parser-built searchText.
    for (const address of record.to) if (address.name.toLowerCase().includes(query) || address.email.toLowerCase().includes(query)) return true;
    for (const address of record.cc) if (address.name.toLowerCase().includes(query) || address.email.toLowerCase().includes(query)) return true;
    return false;
  }
  if (record.source === "calendar") return record.searchText.includes(query) || record.description.toLowerCase().includes(query);
  if (record.source === "documents") return record.searchText.includes(query) || record.text.toLowerCase().includes(query);
  if (record.source === "orders") return record.searchText.includes(query) || record.items.some((item) => item.title.toLowerCase().includes(query));
  return record.searchText.includes(query);
}

function historyAppFilter(index: MailboxIndex, source: SourceKind | "all", selected: string, rerenderWith: (patch: { app: string }) => void): HTMLElement {
  const records = source === "email" ? index.emailData : source === "all" ? index.orderedRecords : index.bySource.get(source) ?? [];
  const counts = historyAppCounts(records);
  const options = MYPCBENCH_APPS.filter((candidate) => (counts.get(candidate.id) ?? 0) > 0);
  return el(
    "div",
    { class: "domain-filter app-analogue-filter" },
    el("div", { class: "domain-filter-head" }, el("strong", null, "Related app"), el("span", null, "Partition history by the real-world service and its MyPCBench clone.")),
    el(
      "select",
      { class: "field-input", "data-testid": "history-app-filter", "aria-label": "Filter by related MyPCBench app", onchange: (event: Event) => rerenderWith({ app: (event.target as HTMLSelectElement).value }) },
      el("option", { value: "", selected: !selected }, "All related apps"),
      ...options.map((candidate) => el("option", { value: candidate.id, selected: selected === candidate.id }, `${candidate.name} · like ${candidate.analogue} · ${(counts.get(candidate.id) ?? 0).toLocaleString()}`))
    )
  );
}

function inlinePrivacyPanel(ctx: Ctx): HTMLElement {
  const people = ctx.state.entities.filter((entity) => entity.category === "self" || entity.category === "person");
  const protectedPeople = people.filter((entity) => !entity.keepReal).length;
  const visible = people.slice(0, 6);
  return el(
    "section",
    { class: "inline-privacy", "data-testid": "inline-privacy-panel" },
    el(
      "div",
      { class: "inline-privacy-head" },
      el("div", null, el("strong", null, "Privacy protection"), el("p", null, "Names, personal emails, and phone numbers use consistent aliases. Public organizations and services such as news publishers stay recognizable and are not counted as people. Credentials, cards, SSNs, email addresses, phone numbers, addresses, DOBs, and one-time codes are masked in the upload copy.")),
      el("span", { class: "privacy-count mono" }, `${protectedPeople.toLocaleString()} of ${people.length.toLocaleString()} people protected`)
    ),
    visible.length ? el("div", { class: "inline-privacy-people" }, ...visible.map((entity) => {
      const real = entity.realNames[0] || entity.realEmails[0] || entity.realPhones[0] || "Unnamed person";
      return el(
        "label",
        { class: `inline-privacy-person ${entity.keepReal ? "kept-real" : ""}` },
        el("span", { class: "privacy-person-copy" }, el("strong", null, real), el("small", { class: "mono" }, entity.keepReal ? "uploads as real" : `uploads as ${entity.alias}`)),
        el("span", { class: "privacy-toggle" }, el("input", { type: "checkbox", checked: !entity.keepReal, "data-testid": `protect-entity-${entity.entityId}`, onchange: (event: Event) => ctx.actions.updateEntity(entity.entityId, { keepReal: !(event.target as HTMLInputElement).checked }) }), el("span", null, "Protect"))
      );
    })) : el("p", { class: "empty-note compact" }, "People will appear here after email addresses are detected."),
    el("div", { class: "inline-privacy-actions" }, el("span", null, `${ctx.state.rules.length.toLocaleString()} replace-everywhere rule${ctx.state.rules.length === 1 ? "" : "s"}`), el("button", { class: "btn small", type: "button", onclick: () => ctx.actions.goto("entities") }, people.length > visible.length ? `Review all ${people.length.toLocaleString()} people and PII` : "Review PII and replacements"))
  );
}

function uploadWorkflowCard(ctx: Ctx, source: "email" | "calendar" | "documents", title: string, detail: string, count: number): HTMLElement {
  const active = ctx.state.filters.source === source;
  return el("button", { class: `upload-workflow-card ${active ? "active" : ""}`, type: "button", disabled: !count, onclick: () => { Object.assign(ctx.state.filters, { source, category: "all", app: "", direction: "all", correspondent: "", service: "", domain: "", sender: "", recurrence: "all", linked: "all", status: "all", page: 0 }); ctx.rerender(); } }, el("span", { class: "upload-workflow-number mono" }, source === "email" ? "01" : source === "calendar" ? "02" : "03"), el("span", { class: "upload-workflow-copy" }, el("strong", null, title), el("span", null, detail)), el("span", { class: "upload-workflow-count mono" }, count ? `${count.toLocaleString()} imported →` : "Import first"));
}

function emailActivityFilter(summary: EmailActivitySummary, selectedDirection: EmailDirection | "all", selectedCorrespondent: string, rerenderWith: (patch: Partial<Ctx["state"]["filters"]>) => void): HTMLElement {
  const setDirection = (direction: EmailDirection | "all") => rerenderWith({ direction, correspondent: "" });
  const statChip = (stat: EmailActivityStat, direction: EmailDirection, kind: "email" | "domain") => {
    const key = `${kind}:${stat.key}`;
    const active = selectedDirection === direction && selectedCorrespondent === key;
    return el("button", { class: `activity-chip ${active ? "active" : ""}`, type: "button", onclick: () => rerenderWith(active ? { direction: "all", correspondent: "" } : { direction, correspondent: key }) }, el("span", null, stat.label), el("strong", { class: "mono" }, stat.count.toLocaleString()));
  };
  const column = (direction: EmailDirection, title: string) => {
    const bucket = summary[direction];
    return el(
      "section",
      { class: "activity-column" },
      el("div", { class: "activity-column-head" }, el("strong", null, title), el("span", { class: "mono" }, `${bucket.messages.toLocaleString()} messages`)),
      el("span", { class: "activity-label mono" }, direction === "received" ? "TOP SENDERS" : "TOP RECIPIENTS"),
      el("div", { class: "activity-chips" }, ...bucket.people.map((stat) => statChip(stat, direction, "email"))),
      el("span", { class: "activity-label mono" }, "TOP DOMAINS"),
      el("div", { class: "activity-chips" }, ...bucket.domains.map((stat) => statChip(stat, direction, "domain")))
    );
  };
  return el(
    "section",
    { class: "email-activity" },
    el("div", { class: "email-activity-head" }, el("div", null, el("strong", null, "Email activity"), el("p", null, "Click a sender, recipient, or domain to filter. Counts stay in this browser.")), el("div", { class: "activity-direction" }, ...([ ["all", "All"], ["received", "Received"], ["sent", "Sent"] ] as const).map(([value, label]) => el("button", { class: `category-chip ${selectedDirection === value && !selectedCorrespondent ? "active" : ""}`, type: "button", onclick: () => setDirection(value) }, label)))),
    el("div", { class: "activity-grid" }, column("received", "Most received from"), column("sent", "Most sent to"))
  );
}

function serviceFilter(services: EmailServiceOption[], selected: string, rerenderWith: (patch: { service: string }) => void): HTMLElement {
  const matched = services.reduce((total, service) => total + service.count, 0);
  return el(
    "div",
    { class: "domain-filter service-filter" },
    el(
      "div",
      { class: "domain-filter-head" },
      el("strong", null, "Recognized sender service"),
      el("span", null, `${services.length.toLocaleString()} supported services · ${matched.toLocaleString()} matching messages`)
    ),
    el(
      "select",
      {
        class: "field-input",
        "data-testid": "email-service-filter",
        "aria-label": "Filter by recognized sender service",
        onchange: (event: Event) => rerenderWith({ service: (event.target as HTMLSelectElement).value }),
      },
      el("option", { value: "", selected: !selected }, "All recognized services"),
      ...services.map((service) => el("option", { value: service.id, selected: selected === service.id, disabled: !service.count }, `${service.label} · ${service.count.toLocaleString()}`))
    )
  );
}

export function senderDomain(record: EmailRecord): string {
  const address = record.from.email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  return at > 0 && at < address.length - 1 ? address.slice(at + 1).replace(/\.$/, "") : "";
}

export function emailDomainCounts(records: EmailRecord[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const domain = senderDomain(record);
    if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function domainFilter(domains: DomainCount[], emailCount: number, selected: string, rerenderWith: (patch: { domain: string }) => void): HTMLElement {
  return el(
    "div",
    { class: "domain-filter" },
    el(
      "div",
      { class: "domain-filter-head" },
      el("strong", null, "Actual sender domain"),
      el("span", null, `${domains.length.toLocaleString()} found in the imported From addresses`)
    ),
    el(
      "select",
      {
        class: "field-input",
        "data-testid": "email-domain-filter",
        "aria-label": "Filter by actual sender domain",
        onchange: (event: Event) => rerenderWith({ domain: (event.target as HTMLSelectElement).value }),
      },
      el("option", { value: "", selected: !selected }, `All sender domains (${emailCount.toLocaleString()} messages)`),
      ...domains.map(({ label, count }) => el("option", { value: label, selected: selected === label }, `${label} · ${count.toLocaleString()}`))
    )
  );
}

function categoryFilters(ctx: Ctx, categories: { id: string; label: string }[], total: number, counts: Map<string, number>, rerenderWith: (patch: Partial<typeof ctx.state.filters>) => void): HTMLElement {
  return el("div", { class: "category-filter" }, el("div", { class: "category-filter-head" }, el("strong", null, "Automatic persona categories"), el("span", null, "Website and message signals group local records into MyPCBench-style domains; categories never upload data by themselves.")), el("div", { class: "category-chips" }, el("button", { class: `category-chip ${ctx.state.filters.category === "all" ? "active" : ""}`, type: "button", onclick: () => rerenderWith({ category: "all" }) }, `All ${total.toLocaleString()}`), ...categories.map((category) => el("button", { class: `category-chip ${ctx.state.filters.category === category.id ? "active" : ""}`, type: "button", disabled: !(counts.get(category.id) ?? 0), onclick: () => rerenderWith({ category: category.id }) }, `${category.label} ${(counts.get(category.id) ?? 0).toLocaleString()}`))));
}

function rowTitle(r: SourceRecord): string {
  switch (r.source) {
    case "email":
      return r.subject || "(no subject)";
    case "calendar":
      return r.summary || "(untitled event)";
    case "documents":
      return r.title || r.filename;
    case "contacts":
      return r.fullName || r.emails[0] || "(contact)";
    case "messages":
      return `${r.chatName} — ${r.sender}`;
    case "orders":
      return `${r.merchant}${r.total !== null ? ` · $${r.total.toFixed(2)}` : ""}`;
    case "transactions":
      return `${r.description} · ${r.amount.toFixed(2)} ${r.currency}`;
  }
}

function rowDetail(r: SourceRecord): string {
  switch (r.source) {
    case "email":
      return r.snippet || "No email content preview";
    case "calendar":
      return r.description || "No description";
    case "documents":
      return `${r.filename} · ${r.pageCount ? `${r.pageCount} page${r.pageCount === 1 ? "" : "s"} · ` : ""}${r.text.slice(0, 120)}`;
    case "contacts":
      return [r.emails[0], r.phones[0], r.org].filter(Boolean).join(" · ");
    case "messages":
      return r.isMedia ? "(media omitted)" : r.text.slice(0, 90);
    case "orders":
      return [r.orderId, r.items.length ? `${r.items.length} items` : "", "from email"].filter(Boolean).join(" · ");
    case "transactions":
      return r.account || "";
  }
}

function itemRow(ctx: Ctx, r: SourceRecord): HTMLElement {
  const s = ctx.state;
  const included = ctx.actions.isIncluded(r);
  const d = s.decisions.get(r.id);
  const edited = !!d && (Object.keys(d.edits).length > 0 || d.bodyEdit !== null);
  const excludedByDefault = !ctx.actions.defaultIncluded(r) && !d;

  const checkbox = el("input", {
    type: "checkbox",
    checked: included,
    onclick: (e: Event) => {
      e.stopPropagation();
      ctx.actions.toggleInclude(r.id);
    },
  });

  return el(
    "div",
    {
      class: `item-row ${r.source === "email" || r.source === "calendar" || r.source === "documents" ? "simple-record" : ""} ${included ? "" : "excluded"} ${s.openItemId === r.id ? "open" : ""}`,
      onclick: () => ctx.actions.openItem(s.openItemId === r.id ? null : r.id),
    },
    el("label", { class: "item-check", title: included ? "Selected to upload" : "Kept private", onclick: (e: Event) => e.stopPropagation() }, checkbox),
    el("span", { class: "item-kind mono" }, r.source.slice(0, 3).toUpperCase()),
    el(
      "div",
      { class: "item-main" },
      el("p", { class: "item-title" }, rowTitle(r)),
      el("p", { class: "item-detail" }, rowDetail(r))
    ),
    el(
      "div",
      { class: "item-chips" },
      chip(included ? "uploads" : "private", included ? "ok" : undefined),
      edited ? chip("edited", "warn") : null,
      excludedByDefault && !included ? chip(excludedReason(r)) : null,
      r.source === "email" && s.receiptEmailIds.has(r.id) ? chip("receipt", "ok") : null
    ),
    r.source === "email" || r.source === "calendar" ? null : el("span", { class: "item-time mono" }, r.timestamp ? `${fmtDay(r.timestamp)} ${fmtTime(r.timestamp)}` : "—"),
    el(
      "button",
      {
        class: "item-edit-cue",
        type: "button",
        onclick: (event: Event) => {
          event.stopPropagation();
          ctx.actions.openItem(s.openItemId === r.id ? null : r.id);
        },
      },
      s.openItemId === r.id ? "Close editor" : "Open & edit →"
    )
  );
}

function excludedReason(r: SourceRecord): string {
  if (r.source === "email") {
    if (r.labels.some((l) => /spam|trash/i.test(l))) return "auto-deselected: spam/trash";
    return "auto-deselected: promotional";
  }
  if (r.source === "messages" && r.isSystem) return "auto-deselected: system";
  return "not selected";
}

// ---------------------------------------------------------------------------

function detailDrawer(ctx: Ctx, r: SourceRecord): HTMLElement {
  const s = ctx.state;
  const d = ctx.actions.decisionFor(r.id);
  const drawer = el("aside", { class: "item-drawer card" });

  drawer.append(
    el(
      "div",
      { class: "drawer-head" },
      el("h3", null, rowTitle(r)),
      el(
        "button",
        {
          class: `btn small ${d.included ? "" : "primary"}`,
          type: "button",
          title: d.included ? "This record will upload — click to keep it private" : "This record stays private — click to select it for upload",
          onclick: () => ctx.actions.toggleInclude(r.id),
        },
        d.included ? "Selected ✓ — deselect?" : "Not selected — select?"
      ),
      el("button", { class: "icon-btn", type: "button", title: "Close (Esc)", onclick: () => ctx.actions.openItem(null) }, "✕")
    ),
    el(
      "p",
      { class: "drawer-promise" },
      r.source === "email"
        ? "You can change the subject and email content. Your imported copy stays unchanged."
        : r.source === "calendar"
          ? "You can change the summary and description. Your imported copy stays unchanged."
          : r.source === "documents"
            ? "You can change the title or extracted text. The original document stays on this device."
          : "Change only what you want to share. Your imported copy stays unchanged."
    )
  );

  for (const field of editableFields(r)) {
    drawer.append(fieldRow(ctx, r.id, field, d.edits[field.field]));
  }

  // Body (emails/messages)
  if (r.source === "email" || r.source === "messages") {
    const body = s.openItemBody;
    if (body === null) {
      drawer.append(el("p", { class: "mono" }, "Loading body…"));
    } else {
      const matches = scrubText(r.id, "body", d.bodyEdit ?? body);
      if (matches.length) drawer.append(scrubPanel(ctx, r.id, matches, d.maskOverrides));
      const ta = el("textarea", { class: "field-input body-edit", rows: "12" }) as HTMLTextAreaElement;
      ta.value = d.bodyEdit ?? body;
      const contentLabel = r.source === "email" ? "EMAIL CONTENT" : "MESSAGE CONTENT";
      drawer.append(
        el("label", { class: "field" }, el("span", { class: "field-label" }, d.bodyEdit !== null ? `${contentLabel} (edited)` : contentLabel), ta),
        el(
          "div",
          { class: "drawer-actions" },
          el("button", { class: "btn small", type: "button", onclick: () => ctx.actions.setBodyEdit(r.id, ta.value) }, "Save content change"),
          el("button", { class: "btn small danger-ghost", type: "button", onclick: () => ctx.actions.setBodyEdit(r.id, "") }, "Clear content before upload"),
          d.bodyEdit !== null
            ? el("button", { class: "btn small", type: "button", onclick: () => ctx.actions.setBodyEdit(r.id, null) }, "Revert to original")
            : null
        )
      );
    }
  }

  drawer.append(
    el(
      "div",
      { class: "drawer-actions bottom" },
      el(
        "button",
        { class: `btn small ${d.included ? "danger-ghost" : "primary"}`, type: "button", onclick: () => ctx.actions.toggleInclude(r.id) },
        d.included ? "Deselect — keep this private" : "Select for upload"
      )
    ),
    el(
      "p",
      { class: "privacy-note" },
      "Names, emails, and phone numbers of people you know are pseudonymized automatically at submit — check the People screen to see or adjust the mapping."
    )
  );
  return drawer;
}

export function editableFields(r: SourceRecord): EditableField[] {
  const common: EditableField[] = [
    { field: "source_detail", label: "Source detail", value: r.sourceDetail },
    { field: "timestamp", label: "Timestamp", value: r.timestamp ?? "", hint: "ISO date/time; leave blank for none" },
  ];
  switch (r.source) {
    case "email":
      return [{ field: "subject", label: "Subject", value: r.subject }];
    case "calendar":
      return [
        { field: "summary", label: "Summary", value: r.summary },
        { field: "description", label: "Description", value: r.description, control: "textarea", rows: 6 },
      ];
    case "documents":
      return [
        { field: "title", label: "Title", value: r.title },
        { field: "text", label: "Extracted text", value: r.text, control: "textarea", rows: 18, hint: "This redacted text, not the original file, is included in the bundle." },
      ];
    case "contacts":
      return [...common,
        { field: "full_name", label: "Full name", value: r.fullName },
        { field: "emails", label: "Emails", value: r.emails.join("\n"), control: "textarea", rows: 3, hint: "One email per line" },
        { field: "phones", label: "Phones", value: r.phones.join("\n"), control: "textarea", rows: 3, hint: "One phone per line" },
        { field: "org", label: "Organization", value: r.org ?? "" },
        { field: "addresses", label: "Addresses", value: r.addresses.join("\n"), control: "textarea", rows: 4, hint: "One address per line" },
        { field: "notes", label: "Notes", value: r.notes ?? "", control: "textarea", rows: 6 },
      ];
    case "messages":
      return [...common,
        { field: "chat_id", label: "Chat ID", value: r.chatId },
        { field: "chat_name", label: "Chat name", value: r.chatName },
        { field: "sender", label: "Sender", value: r.sender },
        { field: "is_system", label: "System message", value: String(r.isSystem), control: "boolean" },
        { field: "is_media", label: "Media marker", value: String(r.isMedia), control: "boolean" },
      ];
    case "orders":
      return [...common,
        { field: "merchant", label: "Merchant", value: r.merchant },
        { field: "order_id", label: "Order ID", value: r.orderId ?? "" },
        { field: "total", label: "Total", value: r.total !== null ? String(r.total) : "" },
        { field: "currency", label: "Currency", value: r.currency },
        { field: "items", label: "Items", value: prettyJson(r.items), control: "json", rows: 9, hint: "JSON list of title, quantity, and price" },
        { field: "shipping_address", label: "Shipping address", value: r.shippingAddress ?? "", control: "textarea", rows: 3 },
        { field: "related_record_ids", label: "Related record IDs", value: r.relatedRecordIds.join("\n"), control: "textarea", rows: 3, hint: "One ID per line" },
      ];
    case "transactions":
      return [...common,
        { field: "description", label: "Description", value: r.description },
        { field: "amount", label: "Amount", value: String(r.amount) },
        { field: "currency", label: "Currency", value: r.currency },
        { field: "account", label: "Account", value: r.account ?? "" },
        { field: "category", label: "Category", value: r.category ?? "" },
        { field: "related_record_ids", label: "Related record IDs", value: r.relatedRecordIds.join("\n"), control: "textarea", rows: 3, hint: "One ID per line" },
      ];
  }
}

function fieldRow(ctx: Ctx, id: string, descriptor: EditableField, edit: string | undefined): HTMLElement {
  const { field, label, value: original, control = "input" } = descriptor;
  const inputId = `record-edit-${id}-${field}`;
  const input = control === "textarea" || control === "json"
    ? el("textarea", { id: inputId, class: `field-input record-field ${control === "json" ? "json-edit" : ""}`, rows: String(descriptor.rows ?? 4) }) as HTMLTextAreaElement
    : control === "boolean"
      ? el("select", { id: inputId, class: "field-input record-field" }, el("option", { value: "false" }, "False"), el("option", { value: "true" }, "True")) as HTMLSelectElement
      : el("input", { id: inputId, class: "field-input record-field" }) as HTMLInputElement;
  input.value = edit ?? original;
  const error = el("span", { class: "field-error record-edit-error", hidden: true }, "Enter a valid JSON array before leaving this field.");
  input.addEventListener("input", () => { input.classList.remove("invalid"); error.hidden = true; });
  const save = () => {
    if (control === "json") {
      try {
        if (!Array.isArray(JSON.parse(input.value))) throw new Error("not an array");
      } catch {
        input.classList.add("invalid");
        error.hidden = false;
        return;
      }
    }
    ctx.actions.setFieldEdit(id, field, input.value === original ? null : input.value);
  };
  const clear = () => {
    const cleared = control === "json" ? "[]" : control === "boolean" ? "false" : "";
    ctx.actions.setFieldEdit(id, field, cleared === original ? null : cleared);
  };
  return el(
    "div",
    { class: "field record-edit-field" },
    el("label", { class: "field-label", for: inputId }, label, edit !== undefined ? chip("edited", "warn") : null),
    descriptor.hint ? el("span", { class: "field-hint" }, descriptor.hint) : null,
    input,
    error,
    el(
      "span",
      { class: "record-field-actions" },
      el("button", { class: "btn small", type: "button", onclick: (event: Event) => { event.preventDefault(); save(); } }, `Save ${label.toLowerCase()} change`),
      el("button", { class: "btn small danger-ghost", type: "button", onclick: (event: Event) => { event.preventDefault(); clear(); } }, "Clear before upload"),
      edit !== undefined ? el("button", { class: "as-link small", type: "button", onclick: (event: Event) => { event.preventDefault(); ctx.actions.setFieldEdit(id, field, null); } }, "Revert to imported value") : null
    )
  );
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function scrubPanel(ctx: Ctx, id: string, matches: ScrubMatch[], overrides: Record<string, boolean>): HTMLElement {
  const masks = matches.filter((m) => m.tier === "mask");
  const flags = matches.filter((m) => m.tier === "flag");
  const panel = el("div", { class: "scrub-panel" });
  if (masks.length) {
    panel.append(el("p", { class: "field-label" }, "AUTO-MASKED ON SUBMIT"));
    for (const m of masks) {
      const kept = overrides[m.matchId];
      panel.append(
        el(
          "div",
          { class: "scrub-row" },
          chip(m.detector, kept ? "warn" : "ok"),
          el("span", { class: "mono scrub-excerpt" }, kept ? m.excerpt : m.replacement),
          el(
            "button",
            {
              class: "as-link small",
              type: "button",
              onclick: () => {
                const d = ctx.actions.decisionFor(id);
                if (kept) delete d.maskOverrides[m.matchId];
                else d.maskOverrides[m.matchId] = true;
                ctx.actions.invalidatePrivacyAudit();
                ctx.autosave();
                ctx.rerender();
              },
            },
            kept ? "mask it" : "keep original"
          ),
          kept ? el("span", { class: "field-error inline" }, "final privacy gate may block upload") : null
        )
      );
    }
  }
  if (flags.length) {
    panel.append(
      el("p", { class: "field-label" }, "WORTH A LOOK"),
      el("p", { class: "scrub-flags" }, flags.map((m) => `${m.detector}: “${m.excerpt}”`).join(" · "))
    );
  }
  return panel;
}
