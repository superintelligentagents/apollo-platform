import { APP_CATEGORY_LABELS, MYPCBENCH_APPS, recommendApps, recommendAppsAsync, type AppCategory, type AppRecommendation, type MyPCBenchApp } from "../../app-catalog";
import { PC_TEMPLATES } from "../../templates";
import type { SourceKind } from "../../types";
import { chip, el } from "../components/helpers";
import type { Ctx } from "../context";

const SYNC_RECOMMENDATION_LIMIT = 2_000;

type RecommendationCache = {
  records: Ctx["state"]["records"];
  recordCount: number;
  historyRevision: number;
  recommendations: AppRecommendation[] | null;
  controller?: AbortController;
};

const recommendationCache = new WeakMap<Ctx["state"], RecommendationCache>();

const CATEGORY_LABEL: Record<string, string> = {
  cross_source_reconciliation: "cross-source",
  aggregation_reporting: "aggregation",
  personal_lookup: "lookup",
  pattern_inference: "pattern",
  multi_step_orchestration: "orchestration",
};

export function renderTasks(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const recommendationState = recommendationsFor(ctx);
  const allRecommendations = recommendationState.recommendations ?? [];
  const recommendationsLoading = recommendationState.recommendations === null;
  const recommendations = allRecommendations.slice(0, 6);
  const recommendationByApp = new Map(allRecommendations.map((item) => [item.app.id, item]));
  const root = el("section", { class: "screen discovery-screen" });
  root.append(
    el("p", { class: "step-kicker mono" }, "STEP 2 · WRITE TASKS"),
    el("h2", { class: "display" }, "Write long-horizon tasks from your history"),
    el("p", { class: "screen-sub" }, "Each recommendation turns selected mail, calendar events, and documents into a connected MyPCBench workflow. The draft starts from real personal constraints, checks current logged-in app state, carries the result across related apps, and verifies the final state."),
    el("div", { class: "discovery-actions" }, el("button", { class: "btn primary", type: "button", onclick: () => ctx.actions.goto("items") }, "Upload or import data"), el("a", { class: "btn ghost", href: "https://mypcbench.com/apps", target: "_blank", rel: "noreferrer" }, "See all live apps ↗"))
  );

  const freeForm = PC_TEMPLATES.find((template) => template.id === "free-form-long-horizon")!;
  root.append(el("button", { class: "task-primary-action", type: "button", onclick: () => ctx.actions.startTask(freeForm) }, el("span", null, el("strong", null, "Write from scratch"), el("small", null, "Start with a blank long-horizon workflow")), el("span", { "aria-hidden": "true" }, "→")));

  if (s.tasks.length) root.append(savedTasks(ctx));

  root.append(el("div", { class: "discovery-section-head" }, el("div", null, el("p", { class: "section-label" }, "RECOMMENDED TASK GUIDES FROM YOUR HISTORY"), el("h3", null, recommendationsLoading ? "Analyzing selected history…" : recommendations.length ? `${recommendations.length} workflow${recommendations.length === 1 ? "" : "s"} with supporting context` : "Upload or import data to get recommendations")), el("span", { class: "privacy-local-badge mono" }, "ANALYZED LOCALLY")));
  if (recommendationsLoading) {
    root.append(el("section", { class: "recommendation-empty", role: "status", "aria-live": "polite" }, el("strong", null, "Matching your history to the live apps…"), el("p", null, "You can start writing now. Recommendations will appear here as the local analysis finishes.")));
  } else if (recommendations.length) {
    root.append(el("div", { class: "recommendation-grid" }, ...recommendations.map((recommendation, index) => recommendationCard(ctx, recommendation, index + 1))));
  } else {
    root.append(el("section", { class: "recommendation-empty" }, el("strong", null, "No selected data yet"), el("p", null, "Add mail, calendar history, a resume, tax form, note, PDF, Word document, or text file. Apollo will recommend app-guided tasks without sending that data anywhere."), el("button", { class: "btn primary", type: "button", onclick: () => ctx.actions.goto("items") }, "Upload or import data →")));
  }

  const categories = Object.keys(APP_CATEGORY_LABELS) as AppCategory[];
  const visibleApps = MYPCBENCH_APPS.filter((candidate) => s.discoveryCategory === "all" || candidate.category === s.discoveryCategory);
  root.append(
    el("div", { class: "discovery-section-head app-library-head" }, el("div", null, el("p", { class: "section-label" }, "ALL 17 LIVE APP GUIDES"), el("h3", null, "Choose a guideline and filter directly"))),
    el("div", { class: "category-chips app-category-chips", role: "group", "aria-label": "Filter apps by category" }, categoryButton(ctx, "all", "All", MYPCBENCH_APPS.length), ...categories.map((category) => categoryButton(ctx, category, APP_CATEGORY_LABELS[category], MYPCBENCH_APPS.filter((candidate) => candidate.category === category).length))),
    el("div", { class: "app-library" }, ...visibleApps.map((candidate) => appLibraryRow(ctx, candidate, recommendationByApp.get(candidate.id), recommendationsLoading)))
  );

  const guided = el("div", { class: "mode-rows" });
  for (const template of PC_TEMPLATES.filter((candidate) => candidate.id !== "free-form-long-horizon")) {
    const disabled = template.minSourceKinds > 0 && !s.records.size;
    guided.append(el("div", { class: "mode-row" }, el("div", { class: "mode-row-main" }, el("p", { class: "mode-row-title" }, template.title, chip(CATEGORY_LABEL[template.category] ?? template.category)), el("p", { class: "mode-row-desc" }, template.tagline), el("p", { class: "mono flow-chain" }, template.suggestedSources.length ? template.suggestedSources.join(" → ") : "No records required")), el("button", { class: "btn primary", type: "button", disabled, title: disabled ? "Import some data first" : "", onclick: () => ctx.actions.startTask(template) }, "Start")));
  }
  root.append(el("details", { class: "template-library" }, el("summary", null, "Use a general task template"), el("p", null, "These templates work even when no MyPCBench app is a close match."), guided));
  return root;
}

function recommendationsFor(ctx: Ctx): RecommendationCache {
  const s = ctx.state;
  const cached = recommendationCache.get(s);
  if (cached && cached.records === s.records && cached.recordCount === s.records.size && cached.historyRevision === s.historyRevision) return cached;
  cached?.controller?.abort();

  const eligible = [...s.records.values()].filter((record) => ctx.actions.isIncluded(record));
  const next: RecommendationCache = {
    records: s.records,
    recordCount: s.records.size,
    historyRevision: s.historyRevision,
    recommendations: eligible.length <= SYNC_RECOMMENDATION_LIMIT ? recommendApps(eligible, MYPCBENCH_APPS.length) : null,
  };
  recommendationCache.set(s, next);
  if (next.recommendations !== null) return next;

  next.controller = new AbortController();
  void recommendAppsAsync(eligible, MYPCBENCH_APPS.length, 2_000, next.controller.signal).then((recommendations) => {
    if (recommendationCache.get(s) !== next) return;
    next.recommendations = recommendations;
    if (s.screen === "tasks") ctx.rerender();
  }).catch(() => {
    if (recommendationCache.get(s) !== next) return;
    next.recommendations = [];
    if (s.screen === "tasks") ctx.rerender();
  });
  return next;
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
    el("p", { class: "recommendation-path mono" }, `SUGGESTED APP PATH · ${workflowPath(app)}`),
    el("div", { class: "recommendation-evidence" }, el("span", { class: "mono" }, `${recommendation.recordIds.length.toLocaleString()} relevant record${recommendation.recordIds.length === 1 ? "" : "s"} ready to attach`), el("button", { class: "text-button", type: "button", onclick: () => openMatchingHistory(ctx, recommendation) }, "Review matches")),
    el("div", { class: "recommendation-steps", "aria-label": "Workflow actions" }, el("a", { class: "btn", href: app.url, target: "_blank", rel: "noreferrer", "data-testid": `open-app-${app.id}` }, `1. Open ${app.name} ↗`), el("button", { class: "btn primary", type: "button", "data-testid": `write-task-${app.id}`, onclick: () => ctx.actions.startRecommendedTask(recommendation) }, "2. Write this task →"))
  );
}

function appLibraryRow(ctx: Ctx, candidate: MyPCBenchApp, recommendation?: AppRecommendation, recommendationsLoading = false): HTMLElement {
  const draft: AppRecommendation = recommendation ?? { app: candidate, score: 0, recordIds: [], reason: `Open the ${candidate.analogue}-style clone and turn a real workflow into a task.` };
  return el("article", { class: "app-library-row", "data-app-id": candidate.id }, el("div", { class: "app-library-copy" }, el("span", { class: "app-analogue mono" }, APP_CATEGORY_LABELS[candidate.category].toUpperCase()), el("strong", null, candidate.name), el("p", null, `${candidate.description} Use the ${candidate.analogue} analogue as the guideline.`), el("small", { class: "app-library-path mono" }, workflowPath(candidate))), el("span", { class: `app-history-count mono ${recommendation ? "matched" : ""}` }, recommendation ? `${recommendation.recordIds.length} matching record${recommendation.recordIds.length === 1 ? "" : "s"}` : recommendationsLoading ? "Matching…" : "No matches yet"), el("div", { class: "app-library-actions" }, el("a", { class: "btn ghost small", href: candidate.url, target: "_blank", rel: "noreferrer" }, "Open app ↗"), el("button", { class: "btn small", type: "button", disabled: recommendationsLoading && !recommendation, onclick: () => ctx.actions.startRecommendedTask(draft) }, recommendationsLoading && !recommendation ? "Matching…" : "Use guide")));
}

function workflowPath(app: MyPCBenchApp): string {
  return app.workflowAppIds
    .map((id) => MYPCBENCH_APPS.find((candidate) => candidate.id === id)?.name ?? id)
    .join(" → ");
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
