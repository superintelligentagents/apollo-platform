import { PC_TEMPLATES } from "../../templates";
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
  const root = el("section", { class: "screen" });
  root.append(
    el("p", { class: "step-kicker mono" }, "STEP 3"),
    el("h2", { class: "display" }, "Write tasks"),
    el("p", { class: "screen-sub" }, "Describe work you want a personal assistant to complete. Add records only when they help.")
  );

  const freeForm = PC_TEMPLATES.find((template) => template.id === "free-form-long-horizon")!;
  root.append(
    el(
      "button",
      { class: "task-primary-action", type: "button", onclick: () => ctx.actions.startTask(freeForm) },
      el("span", null, el("strong", null, "Write a task"), el("small", null, "Folders, subscriptions, travel, cross-app work, or anything else")),
      el("span", { "aria-hidden": "true" }, "→")
    )
  );

  if (s.tasks.length) {
    const list = el("div", { class: "mode-rows" });
    for (const task of s.tasks) {
      list.append(
        el(
          "div",
          { class: "mode-row" },
          el(
            "div",
            { class: "mode-row-main" },
            el("p", { class: "mode-row-title" }, task.task_title, chip(CATEGORY_LABEL[task.category] ?? task.category)),
            el(
              "p",
              { class: "mode-row-desc" },
              `${task.referenced_record_ids.length} records attached · ${task.required_sources.join(", ") || "no sources"}${task.expected_answer ? " · has expected answer" : ""}`
            )
          ),
          el("button", { class: "btn small", type: "button", onclick: () => ctx.actions.editTask(task.task_id) }, "Edit"),
          el(
            "button",
            {
              class: "btn small danger-ghost",
              type: "button",
              onclick: () => {
                if (confirm(`Delete "${task.task_title}"?`)) ctx.actions.deleteTask(task.task_id);
              },
            },
            "Delete"
          )
        )
      );
    }
    root.append(el("p", { class: "section-label" }, `Saved tasks · ${s.tasks.length}`), list);
  }

  const grid = el("div", { class: "mode-rows" });
  for (const t of PC_TEMPLATES.filter((template) => template.id !== "free-form-long-horizon")) {
    const disabled = t.minSourceKinds > 0 && !s.records.size;
    grid.append(
      el(
        "div",
        { class: "mode-row" },
        el(
          "div",
          { class: "mode-row-main" },
          el("p", { class: "mode-row-title" }, t.title, chip(CATEGORY_LABEL[t.category] ?? t.category)),
          el("p", { class: "mode-row-desc" }, t.tagline),
          t.suggestedSources.length ? el("p", { class: "mono flow-chain" }, t.suggestedSources.join(" → ")) : el("p", { class: "mono flow-chain" }, "No records required")
        ),
        el(
          "button",
          { class: "btn primary", type: "button", disabled, title: disabled ? "Import some data first" : "", onclick: () => ctx.actions.startTask(t) },
          "Start"
        )
      )
    );
  }
  root.append(
    el(
      "details",
      { class: "template-library" },
      el("summary", null, "Use a guided template"),
      el("p", null, "Optional prompts for tasks grounded in imported records."),
      grid
    )
  );
  return root;
}
