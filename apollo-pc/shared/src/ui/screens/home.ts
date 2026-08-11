import { el } from "../components/helpers";
import type { Ctx, Screen } from "../context";

export function renderHome(ctx: Ctx): HTMLElement {
  const records = [...ctx.state.records.values()];
  const importedEmail = records.filter((record) => record.source === "email" || record.source === "orders").length;
  const importedCalendar = records.filter((record) => record.source === "calendar").length;
  const selectedEmail = records.filter((record) => (record.source === "email" || record.source === "orders") && ctx.actions.isIncluded(record)).length;
  const selectedCalendar = records.filter((record) => record.source === "calendar" && ctx.actions.isIncluded(record)).length;
  const uploaded = ctx.state.uploadedBySource;

  return el(
    "section",
    { class: "screen dashboard-screen" },
    el("h2", { class: "display" }, "Dashboard"),
    el("p", { class: "screen-sub" }, `Your private workspace. Counts stay in this browser.`),
    el(
      "section",
      { class: "dashboard-counts", "aria-label": "Data counts" },
      dashboardRow("Mail", importedEmail, uploaded.knownBundles || !ctx.state.uploadedCount ? uploaded.email : "—"),
      dashboardRow("Calendar", importedCalendar, uploaded.knownBundles || !ctx.state.uploadedCount ? uploaded.calendar : "—")
    ),
    uploaded.knownBundles < ctx.state.uploadedCount
      ? el("p", { class: "dashboard-note" }, `${ctx.state.uploadedCount - uploaded.knownBundles} earlier submission${ctx.state.uploadedCount - uploaded.knownBundles === 1 ? "" : "s"} contained ${uploaded.legacyRecords.toLocaleString()} records total. Its email/calendar split was not recorded, so it is not guessed above. New submissions will appear exactly.`)
      : null,
    el(
      "section",
      { class: "dashboard-workflows major-workflows" },
      majorWorkflow("1", "Import data", `${(importedEmail + importedCalendar).toLocaleString()} records`, "sources", ctx),
      majorWorkflow("2", "Upload data", `${(selectedEmail + selectedCalendar).toLocaleString()} selected`, "items", ctx),
      majorWorkflow("3", "Write tasks", `${ctx.state.tasks.length.toLocaleString()} saved`, "tasks", ctx)
    )
  );
}

function majorWorkflow(number: string, title: string, detail: string, target: Screen, ctx: Ctx): HTMLElement {
  return el(
    "button",
    { class: "major-workflow", type: "button", onclick: () => ctx.actions.goto(target) },
    el("span", { class: "major-workflow-number mono" }, number),
    el("strong", null, title),
    el("small", null, detail),
    el("span", { "aria-hidden": "true" }, "→")
  );
}

function dashboardRow(label: string, imported: number, uploaded: number | string): HTMLElement {
  return el("div", { class: "dashboard-count-row" }, el("strong", null, label), metric(imported, "Imported"), metric(uploaded, "Uploaded"));
}

function metric(value: number | string, label: string): HTMLElement {
  return el("div", { class: "dashboard-metric" }, el("span", { class: "mono" }, typeof value === "number" ? value.toLocaleString() : value), el("small", null, label));
}
