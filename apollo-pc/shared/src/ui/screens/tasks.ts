import { APP_CATEGORY_LABELS, MYPCBENCH_APPS, recommendApps, type AppCategory, type AppRecommendation, type MyPCBenchApp } from "../../app-catalog";
import { PC_TEMPLATES } from "../../templates";
import type { SourceKind } from "../../types";
import { chip, el } from "../components/helpers";
import type { Ctx } from "../context";

const CATEGORY_LABEL: Record<string, string> = {
  cross_source_reconciliation: "cross-source",
  aggregation_reporting: "aggregation",
  personal_lookup: "lookup",
  pattern_inference: "pattern",
  multi_step_orchestration: "orchestration",
};

export function renderTasks(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const eligible = [...s.records.values()].filter((record) => ctx.actions.isIncluded(record));
  const recommendations = recommendApps(eligible);
  const recommendationByApp = new Map(recommendApps(eligible, MYPCBENCH_APPS.length).map((item) => [item.app.id, item]));
  const root = el("section", { class: "screen discovery-screen" });
  root.append(
    el("p", { class: "step-kicker mono" }, "STEP 3 · DISCOVER"),
    el("h2", { class: "display" }, "Turn your history into a task"),
    el("p", { class: "screen-sub" }, "Apollo groups selected mail, calendar events, and documents by the real-world service they resemble. Open the matching MyPCBench app, try the workflow yourself, then start from a task draft with the relevant records attached."),
    el("div", { class: "discovery-actions" }, el("button", { class: "btn primary", type: "button", onclick: () => ctx.actions.goto("sources") }, "Import more history"), el("button", { class: "btn", type: "button", onclick: () => ctx.actions.goto("import-documents") }, "Add a document"), el("a", { class: "btn ghost", href: "https://mypcbench.com/apps", target: "_blank", rel: "noreferrer" }, "See all live apps ↗"))
  );

  const freeForm = PC_TEMPLATES.find((template) => template.id === "free-form-long-horizon")!;
  root.append(el("button", { class: "task-primary-action", type: "button", onclick: () => ctx.actions.startTask(freeForm) }, el("span", null, el("strong", null, "Write from scratch"), el("small", null, "Start with a blank long-horizon workflow")), el("span", { "aria-hidden": "true" }, "→")));

  if (s.tasks.length) root.append(savedTasks(ctx));

  root.append(el("div", { class: "discovery-section-head" }, el("div", null, el("p", { class: "section-label" }, "RECOMMENDED FROM YOUR HISTORY"), el("h3", null, recommendations.length ? `${recommendations.length} workflows with supporting context` : "Import history to get recommendations")), el("span", { class: "privacy-local-badge mono" }, "ANALYZED LOCALLY")));
  if (recommendations.length) {
    root.append(el("div", { class: "recommendation-grid" }, ...recommendations.map((recommendation, index) => recommendationCard(ctx, recommendation, index + 1))));
  } else {
    root.append(el("section", { class: "recommendation-empty" }, el("strong", null, "No selected history yet"), el("p", null, "Import mail or calendar history, or add a resume, tax form, note, PDF, Word document, or text file. Apollo will suggest supported app workflows without sending that history anywhere."), el("button", { class: "btn primary", type: "button", onclick: () => ctx.actions.goto("sources") }, "Choose a source →")));
  }

  const categories = Object.keys(APP_CATEGORY_LABELS) as AppCategory[];
  const visibleApps = MYPCBENCH_APPS.filter((candidate) => s.discoveryCategory === "all" || candidate.category === s.discoveryCategory);
  root.append(
    el("div", { class: "discovery-section-head app-library-head" }, el("div", null, el("p", { class: "section-label" }, "ALL 17 LIVE APPS"), el("h3", null, "Choose a workflow directly"))),
    el("div", { class: "category-chips app-category-chips", role: "group", "aria-label": "Filter apps by category" }, categoryButton(ctx, "all", "All", MYPCBENCH_APPS.length), ...categories.map((category) => categoryButton(ctx, category, APP_CATEGORY_LABELS[category], MYPCBENCH_APPS.filter((candidate) => candidate.category === category).length))),
    el("div", { class: "app-library" }, ...visibleApps.map((candidate) => appLibraryRow(ctx, candidate, recommendationByApp.get(candidate.id))))
  );

  const guided = el("div", { class: "mode-rows" });
  for (const template of PC_TEMPLATES.filter((candidate) => candidate.id !== "free-form-long-horizon")) {
    const disabled = template.minSourceKinds > 0 && !s.records.size;
    guided.append(el("div", { class: "mode-row" }, el("div", { class: "mode-row-main" }, el("p", { class: "mode-row-title" }, template.title, chip(CATEGORY_LABEL[template.category] ?? template.category)), el("p", { class: "mode-row-desc" }, template.tagline), el("p", { class: "mono flow-chain" }, template.suggestedSources.length ? template.suggestedSources.join(" → ") : "No records required")), el("button", { class: "btn primary", type: "button", disabled, title: disabled ? "Import some data first" : "", onclick: () => ctx.actions.startTask(template) }, "Start")));
  }
  root.append(el("details", { class: "template-library" }, el("summary", null, "Use a general task template"), el("p", null, "These templates work even when no MyPCBench app is a close match."), guided));
  return root;
}

function recommendationCard(ctx: Ctx, recommendation: AppRecommendation, rank: number): HTMLElement {
  const { app } = recommendation;
  return el(
    "article",
    { class: `recommendation-card app-${app.category}`, "data-app-id": app.id },
    el("div", { class: "recommendation-rank mono" }, String(rank).padStart(2, "0")),
    el("div", { class: "recommendation-heading" }, el("div", null, el("span", { class: "app-analogue mono" }, `${app.name.toUpperCase()} · LIKE ${app.analogue.toUpperCase()}`), el("h3", null, app.task.title)), chip(APP_CATEGORY_LABELS[app.category])),
    el("p", { class: "recommendation-reason" }, recommendation.reason),
    el("p", { class: "recommendation-description" }, app.description),
    el("div", { class: "recommendation-evidence" }, el("span", { class: "mono" }, `${recommendation.recordIds.length.toLocaleString()} relevant record${recommendation.recordIds.length === 1 ? "" : "s"} ready to attach`), el("button", { class: "text-button", type: "button", onclick: () => openMatchingHistory(ctx, recommendation) }, "Review matches")),
    el("div", { class: "recommendation-steps", "aria-label": "Workflow actions" }, el("a", { class: "btn", href: app.url, target: "_blank", rel: "noreferrer", "data-testid": `open-app-${app.id}` }, `1. Open ${app.name} ↗`), el("button", { class: "btn primary", type: "button", "data-testid": `write-task-${app.id}`, onclick: () => ctx.actions.startRecommendedTask(recommendation) }, "2. Write this task →"))
  );
}

function appLibraryRow(ctx: Ctx, candidate: MyPCBenchApp, recommendation?: AppRecommendation): HTMLElement {
  const draft: AppRecommendation = recommendation ?? { app: candidate, score: 0, recordIds: [], reason: `Open the ${candidate.analogue}-style clone and turn a real workflow into a task.` };
  return el("article", { class: "app-library-row", "data-app-id": candidate.id }, el("div", { class: "app-library-copy" }, el("span", { class: "app-analogue mono" }, APP_CATEGORY_LABELS[candidate.category].toUpperCase()), el("strong", null, candidate.name), el("p", null, `${candidate.description} Based on ${candidate.analogue}.`)), el("span", { class: `app-history-count mono ${recommendation ? "matched" : ""}` }, recommendation ? `${recommendation.recordIds.length} matches` : "No matches yet"), el("div", { class: "app-library-actions" }, el("a", { class: "btn ghost small", href: candidate.url, target: "_blank", rel: "noreferrer" }, "Open app ↗"), el("button", { class: "btn small", type: "button", onclick: () => ctx.actions.startRecommendedTask(draft) }, "Write task")));
}

function categoryButton(ctx: Ctx, category: AppCategory | "all", label: string, count: number): HTMLElement {
  return el("button", { class: `category-chip ${ctx.state.discoveryCategory === category ? "active" : ""}`, type: "button", "aria-pressed": String(ctx.state.discoveryCategory === category), onclick: () => { ctx.state.discoveryCategory = category; ctx.rerender(); } }, `${label} ${count}`);
}

function openMatchingHistory(ctx: Ctx, recommendation: AppRecommendation): void {
  const sources = new Set<SourceKind>();
  for (const id of recommendation.recordIds) {
    const source = ctx.state.records.get(id)?.source;
    if (source) sources.add(source);
  }
  ctx.state.filters.source = sources.size === 1 ? [...sources][0] : "all";
  ctx.state.filters.app = recommendation.app.id;
  ctx.state.filters.status = "included";
  ctx.state.filters.page = 0;
  ctx.actions.goto("items");
}

function savedTasks(ctx: Ctx): HTMLElement {
  const list = el("div", { class: "mode-rows" });
  for (const task of ctx.state.tasks) {
    list.append(el("div", { class: "mode-row" }, el("div", { class: "mode-row-main" }, el("p", { class: "mode-row-title" }, task.task_title, chip(CATEGORY_LABEL[task.category] ?? task.category)), el("p", { class: "mode-row-desc" }, `${task.referenced_record_ids.length} records attached · ${task.required_sources.join(", ") || "no sources"}${task.expected_answer ? " · has expected answer" : ""}`)), el("button", { class: "btn small", type: "button", onclick: () => ctx.actions.editTask(task.task_id) }, "Edit"), el("button", { class: "btn small danger-ghost", type: "button", onclick: () => { if (confirm(`Delete "${task.task_title}"?`)) ctx.actions.deleteTask(task.task_id); } }, "Delete")));
  }
  return el("section", { class: "saved-task-section" }, el("p", { class: "section-label" }, `SAVED TASKS · ${ctx.state.tasks.length}`), list);
}
