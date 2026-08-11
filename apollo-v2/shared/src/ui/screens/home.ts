import type { Ctx } from "../context";
import { el } from "../components/helpers";

// Offered on home right after login — never on the login screen.
function resumeBanner(ctx: Ctx): HTMLElement | null {
  if (!ctx.state.hasResumableDraft) return null;
  return el(
    "div",
    { class: "notice info resume-banner" },
    el("span", null, "You have an unfinished task from last time."),
    el(
      "div",
      { class: "resume-actions" },
      el("button", { class: "btn primary small", type: "button", onclick: () => void ctx.actions.resumeDraft() }, "Resume it"),
      el("button", { class: "btn ghost small", type: "button", onclick: () => void ctx.actions.discardDraft() }, "Discard")
    )
  );
}

export function renderHome(ctx: Ctx): HTMLElement {
  const root = el("section", { class: "screen workspace-home" });
  const rb = resumeBanner(ctx);
  if (rb) root.append(rb);
  root.append(
    el(
      "header",
      { class: "workspace-head" },
      el("p", { class: "eyebrow mono" }, "WORKSPACE"),
      el("h2", { class: "display" }, `Good to see you, ${ctx.state.identity?.name || "annotator"}.`),
      el(
        "p",
        { class: "screen-sub" },
        "Create long-horizon web requests, review another annotator’s work, or study examples before you begin."
      )
    )
  );

  const choice = (opts: { index: string; title: string; body: string; meta: string; onpick: () => void }) =>
    el(
      "button",
      { class: "choice-card", type: "button", onclick: opts.onpick },
      el("span", { class: "choice-index mono" }, opts.index),
      el("span", { class: "choice-title" }, opts.title),
      el("span", { class: "choice-body" }, opts.body),
      el("span", { class: "choice-foot" }, el("span", { class: "choice-meta" }, opts.meta), el("span", { class: "choice-cta" }, "Open →"))
    );

  root.append(
    el(
      "div",
      { class: "choice-grid" },
      choice({
        index: "01",
        title: "Submit tasks",
        body: "Describe a realistic web project with enough research, comparison, verification, and output work to take an hour or longer.",
        meta: `${ctx.state.uploadedCount} submitted`,
        onpick: () => ctx.actions.goto("submit"),
      }),
      choice({
        index: "02",
        title: "Review tasks & runs",
        body: "QC another annotator’s prompt and rubrics, or judge a model trajectory against the task and verifier evidence.",
        meta: "Human QC workspace",
        onpick: () => ctx.actions.goto("review-queue"),
      }),
      choice({
        index: "03",
        title: "Reference tasks",
        body: "See hour-long, afternoon-long, and multi-day web requests at Easy, Medium, and Hard levels.",
        meta: "Examples and accepted work",
        onpick: () => ctx.actions.goto("examples"),
      })
    )
  );
  return root;
}

export function renderSubmitHub(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const root = el("section", { class: "screen home-screen submit-screen" });
  const rb = resumeBanner(ctx);
  if (rb) root.append(rb);

  const historyBadge = state.historyLoaded
    ? el("span", { class: "badge ok" }, `${state.journeys.length} journeys ready`)
    : el("span", { class: "badge" }, "History not loaded");

  root.append(
    el(
      "header",
      { class: "home-head" },
      el(
        "div",
        null,
        el("h2", { class: "display" }, "Submit a task"),
        el("p", { class: "mission-line" }, "Start from an idea or from Chrome history. A strong task describes substantial web work—research, comparison, coordination, or creation—that would take a person at least an hour.")
      ),
      el(
        "div",
        { class: "history-line" },
        historyBadge,
        el(
          "button",
          { class: "btn ghost", type: "button", onclick: () => ctx.actions.goto("history") },
          state.historyLoaded ? "Reload history" : "Load my history"
        )
      )
    )
  );

  const row = (opts: {
    mode: "compose" | "theme" | "freeform" | "guided";
    title: string;
    body: string;
    badge: string;
    badgeOk: boolean;
    cta: string;
    needsHistory: boolean;
  }) => {
    const needsLoad = opts.needsHistory && !state.historyLoaded;
    return el(
      "button",
      {
        class: "mode-row card",
        type: "button",
        onclick: () => ctx.actions.startMode(opts.mode),
      },
      el(
        "div",
        { class: "mode-row-main" },
        el(
          "div",
          { class: "mode-row-head" },
          el("h3", null, opts.title),
          el("span", { class: `badge ${opts.badgeOk ? "ok" : ""}` }, opts.badge)
        ),
        el("p", { class: "mode-row-body" }, opts.body)
      ),
      el(
        "span",
        { class: "btn primary mode-row-cta" },
        needsLoad ? `${opts.cta} — load history` : opts.cta
      )
    );
  };

  root.append(
    el(
      "div",
      { class: "mode-rows" },
      row({
        mode: "guided",
        title: "Write a task",
        body: "Start from an idea. Explain the web goal, constraints, sources, and final result, then outline the phases of work.",
        badge: "No history needed",
        badgeOk: true,
        cta: "Write the task",
        needsHistory: false,
      }),
      row({
        mode: "compose",
        title: "Pick your journeys",
        body: "Use your Chrome history to reconstruct one real web project that unfolded across an hour, an afternoon, or multiple days.",
        badge: state.historyLoaded ? `${state.journeys.length} journeys ready` : "Uses your history",
        badgeOk: state.historyLoaded,
        cta: "Browse my journeys",
        needsHistory: true,
      })
    )
  );

  return root;
}
