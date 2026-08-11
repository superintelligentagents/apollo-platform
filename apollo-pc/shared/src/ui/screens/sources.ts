import { fmtBytes, fmtDayYear, el } from "../components/helpers";
import { SOURCE_CARDS } from "../../sources/registry";
import type { EmailRecord, SourceKind } from "../../types";
import type { Ctx } from "../context";

export function renderSources(ctx: Ctx): HTMLElement {
  const email = [...ctx.state.records.values()].filter((record) => record.source === "email" || record.source === "orders").length;
  const calendar = [...ctx.state.records.values()].filter((record) => record.source === "calendar").length;
  return el("section", { class: "screen narrow workflow-hub" }, el("p", { class: "step-kicker mono" }, "STEP 1"), el("h2", { class: "display" }, "Import data"), el("p", { class: "screen-sub" }, "Choose a source. Import stays on this device."), hubLink("Mail", email ? `${email.toLocaleString()} records imported` : "Gmail Takeout or .eml", () => ctx.actions.goto("import-mail")), hubLink("Calendar", calendar ? `${calendar.toLocaleString()} events imported` : ".ics calendar file", () => ctx.actions.goto("import-calendar")));
}

function hubLink(title: string, detail: string, onclick: () => void): HTMLElement {
  return el("button", { class: "workflow-hub-link", type: "button", onclick }, el("span", null, el("strong", null, title), el("small", null, detail)), el("span", { "aria-hidden": "true" }, "→"));
}

export function renderMailImport(ctx: Ctx): HTMLElement {
  return renderImport(ctx, "email");
}

export function renderCalendarImport(ctx: Ctx): HTMLElement {
  return renderImport(ctx, "calendar");
}

function renderImport(ctx: Ctx, onlyKind?: "email" | "calendar"): HTMLElement {
  const s = ctx.state;

  const floorSelect = el(
    "select",
    {
      class: "field-input compact",
      onchange: (e: Event) => {
        s.dateFloorMonths = parseInt((e.target as HTMLSelectElement).value, 10);
        ctx.autosave();
      },
    },
    ...[
      { v: 6, label: "Last 6 months" },
      { v: 12, label: "Last 12 months" },
      { v: 24, label: "Last 2 years" },
      { v: 0, label: "Everything" },
    ].map((o) => el("option", { value: String(o.v), selected: s.dateFloorMonths === o.v }, o.label))
  );

  const pageRecords = [...s.records.values()].filter((record) => !onlyKind || record.source === onlyKind || (onlyKind === "email" && record.source === "orders"));
  const imported = pageRecords.length;
  const selected = imported ? pageRecords.filter((r) => ctx.actions.isIncluded(r)).length : 0;

  return el(
    "section",
    { class: "screen" },
    el("h2", { class: "display" }, onlyKind === "email" ? "Import mail" : onlyKind === "calendar" ? "Import calendar" : "Import data"),
    el(
      "p",
      { class: "screen-sub" },
      onlyKind === "email" ? "Choose a Gmail Takeout .mbox or individual .eml files. Parsing stays in this browser." : onlyKind === "calendar" ? "Choose one or more .ics calendar exports. Parsing stays in this browser." : "Import Mail and Calendar exports here. They are parsed locally in this browser."
    ),
    el("div", { class: "filter-bar" }, el("span", { class: "field-label" }, "Date window"), floorSelect),
    el(
      "div",
      { class: "source-cards" },
      ...SOURCE_CARDS.filter((card) => !onlyKind || card.kind === onlyKind).map((card) => sourceCard(ctx, card.kind))
    ),
    imported
      ? el(
          "div",
          { class: "upload-band" },
          el(
            "div",
            null,
            el("p", { class: "upload-band-title" }, `${imported.toLocaleString()} records imported · ${selected.toLocaleString()} currently selected`),
            el("p", { class: "upload-band-sub" }, "Next: go through them and choose exactly what uploads.")
          ),
          el(
            "div",
            { class: "upload-band-actions" },
            el("button", { class: "btn primary large", type: "button", onclick: () => ctx.actions.goto(onlyKind === "calendar" ? "upload-calendar" : onlyKind === "email" ? "upload-email" : "items") }, onlyKind === "calendar" ? "Choose calendar events →" : onlyKind === "email" ? "Choose email data →" : "Choose what to upload →")
          )
        )
      : null
  );
}

function sourceCard(ctx: Ctx, kind: SourceKind): HTMLElement {
  const s = ctx.state;
  const card = ctx.state.imports[kind];
  const meta = SOURCE_CARDS.find((c) => c.kind === kind)!;
  const records = [...s.records.values()].filter((r) => r.source === kind);
  const included = records.filter((r) => ctx.actions.isIncluded(r));
  const importing = s.importing?.kind === kind ? s.importing.progress : null;

  const body = el("article", { class: `source-card card source-card-${kind}` });
  body.append(
    el(
      "div",
      { class: "source-card-head" },
      el("h3", null, meta.title),
      records.length
        ? el("span", { class: "chip ok" }, `${records.length.toLocaleString()} records · ${included.length.toLocaleString()} included`)
        : el("span", { class: "chip" }, meta.parser ? "Not imported" : "Automatic")
    )
  );

  if (importing) {
    const pct = importing.bytesTotal ? Math.round((importing.bytesRead / importing.bytesTotal) * 100) : 0;
    body.append(
      el(
        "div",
        { class: "import-progress" },
        el("progress", { max: "100", value: String(pct) }),
        el(
          "p",
          { class: "mono import-progress-line" },
          `${fmtBytes(importing.bytesRead)} of ${fmtBytes(importing.bytesTotal)} · ${importing.recordsEmitted.toLocaleString()} records`
        )
      )
    );
    return body;
  }

  if (meta.derived) {
    body.append(el("p", { class: "source-derived" }, meta.derived));
    if (card?.stats.dateRange) {
      body.append(el("p", { class: "mono source-range" }, `${fmtDayYear(card.stats.dateRange.min)} – ${fmtDayYear(card.stats.dateRange.max)}`));
    }
    if (records.length) {
      body.append(
        el(
          "div",
          { class: "source-card-actions" },
          el(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: () => {
                s.filters.source = kind;
                s.filters.status = "all";
                s.filters.page = 0;
                ctx.actions.goto(kind === "calendar" ? "upload-calendar" : "upload-email");
              },
            },
            `Choose from these ${records.length.toLocaleString()} →`
          )
        )
      );
    }
    return body;
  }

  body.append(
    el(
      "details",
      { class: "import-help" },
      el("summary", null, "How to export this file"),
      el("ol", { class: "howto" }, ...meta.howTo.map((step) => el("li", null, step)))
    )
  );

  if (kind === "messages") {
    body.append(
      el(
        "label",
        { class: "field inline" },
        el("span", { class: "field-label" }, "Dates read as"),
        el(
          "select",
          {
            class: "field-input compact",
            onchange: (e: Event) => {
              s.waDateOrder = (e.target as HTMLSelectElement).value as "auto" | "dmy" | "mdy";
            },
          },
          el("option", { value: "auto", selected: s.waDateOrder === "auto" }, "Detect automatically"),
          el("option", { value: "dmy", selected: s.waDateOrder === "dmy" }, "day/month/year"),
          el("option", { value: "mdy", selected: s.waDateOrder === "mdy" }, "month/day/year")
        )
      )
    );
  }

  const input = el("input", {
    type: "file",
    multiple: true,
    accept: meta.parser!.accept.join(","),
    style: "display:none",
    onchange: (e: Event) => {
      const files = [...((e.target as HTMLInputElement).files ?? [])];
      if (files.length) void ctx.actions.importFiles(kind, files);
    },
  }) as HTMLInputElement;

  body.append(
    input,
    el(
      "div",
      { class: "source-card-actions" },
      el(
        "button",
        { class: `btn ${records.length ? "" : "primary"}`, type: "button", disabled: !!s.importing, onclick: () => input.click() },
        records.length ? "Import more files" : `Import ${meta.parser!.accept.join(" / ")}`
      ),
      records.length
        ? el(
            "button",
            {
              class: "btn primary",
              type: "button",
              onclick: () => {
                s.filters.source = kind;
                s.filters.status = "all";
                s.filters.page = 0;
                ctx.actions.goto(kind === "calendar" ? "upload-calendar" : "upload-email");
              },
            },
            `Choose from these ${records.length.toLocaleString()} →`
          )
        : null
    )
  );

  if (card) {
    const bits: string[] = [];
    if (card.stats.dateRange) bits.push(`${fmtDayYear(card.stats.dateRange.min)} – ${fmtDayYear(card.stats.dateRange.max)}`);
    if (card.stats.itemsSkipped) bits.push(`${card.stats.itemsSkipped.toLocaleString()} outside window`);
    if (card.stats.attachmentsStripped) bits.push(`${card.stats.attachmentsStripped.toLocaleString()} attachments stripped (metadata kept)`);
    if (bits.length) body.append(el("p", { class: "mono source-range" }, bits.join(" · ")));
    for (const issue of card.issues.slice(0, 3)) {
      body.append(el("p", { class: "field-error" }, `${issue.message}${issue.count > 1 ? ` (×${issue.count})` : ""}`));
    }
  }
  return body;
}

export function emailBreakdown(records: EmailRecord[]): {
  categories: { label: string; count: number }[];
  domains: { label: string; count: number }[];
} {
  const categories = new Map<string, number>();
  const domains = new Map<string, number>();
  for (const record of records) {
    for (const raw of record.labels) {
      const match = raw.match(/^Category\s+(.+)$/i);
      if (!match) continue;
      const label = match[1].trim();
      categories.set(label, (categories.get(label) ?? 0) + 1);
    }
    const domain = record.from.email.split("@")[1]?.trim().toLowerCase();
    if (domain) domains.set(domain, (domains.get(domain) ?? 0) + 1);
  }
  const ranked = (counts: Map<string, number>) => [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { categories: ranked(categories), domains: ranked(domains) };
}
