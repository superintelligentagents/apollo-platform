import type { Ctx } from "../context";
import { buildPendingTask } from "../pending";
import { estimatePayloadBytes, truncateForUpload } from "../../schema";
import { MAX_UPLOAD_BYTES } from "../../config";
import { chip, el, fmtBytes, stepper } from "../components/helpers";
import { regionLabel } from "../../taxonomy";
import { stepperLabels } from "./form";
import { itinerary } from "../components/itinerary";

export function renderReview(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const root = el("section", { class: "screen review-screen" });
  const task = buildPendingTask(ctx);
  if (task && !ctx.state.basket.length) root.classList.add("narrow");
  if (!task) {
    root.append(el("p", { class: "field-error" }, "Nothing to review yet."));
    return root;
  }

  const { task: uploadable, truncated } = truncateForUpload(task);
  const bytes = estimatePayloadBytes(uploadable);

  root.append(
    el(
      "header",
      { class: "screen-head" },
      stepper(stepperLabels(state.mode).length, stepperLabels(state.mode), (n) => {
        const historyBacked = state.mode === "compose" || state.mode === "theme";
        ctx.actions.goto(historyBacked && n === 1 ? "compose" : "guided");
      }),
      el("h2", { class: "display" }, "Read it like a stranger"),
      el("p", { class: "screen-sub" }, "Read the request as a web agent would. It should explain enough research, comparison, verification, and output work to run for an hour or longer without follow-up questions.")
    )
  );

  const t = task.task;
  const card = el(
    "article",
    { class: "task-preview card" },
    el("span", { class: "eyebrow mono" }, `${task.mode.toUpperCase()} · ${t.difficulty.toUpperCase()}`),
    el("h3", { class: "display" }, t.task_title),
    el("p", { class: "preview-request" }, t.agent_request),
    t.task_summary ? el("p", { class: "muted" }, t.task_summary) : null,
    t.steps?.length
      ? section(
          "The plan",
          el(
            "ol",
            { class: "preview-list preview-steps" },
            ...t.steps.map((s) =>
              el("li", null, el("strong", null, `${s.title}: `), s.description)
            )
          )
        )
      : null,
    // When criteria were auto-seeded from the steps, "Done when" would just
    // repeat "The plan" — show it only when the author wrote their own.
    t.success_criteria.filter(Boolean).length &&
    !(t.steps?.length && !state.draft.success_criteria.some((c) => c.trim()))
      ? section("Done when", el("ul", { class: "preview-list" }, ...t.success_criteria.filter(Boolean).map((s) => el("li", null, s))))
      : null,
    t.required_outputs.filter(Boolean).length
      ? section("Required outputs", el("ul", { class: "preview-list" }, ...t.required_outputs.filter(Boolean).map((s) => el("li", null, s))))
      : null,
    t.site_scope.length ? section("Sites", el("div", { class: "preview-chips" }, ...t.site_scope.map((s) => chip(s)))) : null,
    t.must_visit_or_reach.filter(Boolean).length
      ? section(
          "Key URLs",
          el("ul", { class: "preview-list mono small" }, ...t.must_visit_or_reach.filter(Boolean).map((u) => el("li", null, u)))
        )
      : null,
    t.notes ? section("Notes", el("p", null, t.notes)) : null,
    t.metadata
      ? section(
          "About this task",
          el(
            "div",
            { class: "preview-chips" },
            chip(regionLabel(t.metadata.region)),
            ...t.metadata.subjects.map((s) => chip(s)),
            ...t.metadata.primary_domains.map((s) => chip(s, "tag"))
          )
        )
      : null
  );

  const layout = el("div", { class: "review-layout" });
  layout.append(card);

  if (state.basket.length) {
    layout.append(itinerary(state.basket, { title: "The journeys behind it", readOnly: true, estimatedBytes: bytes }));
  }
  root.append(layout);

  const hasHistory = state.basket.length > 0;
  if (hasHistory) {
    const visitCount = state.basket.reduce((sum, journey) => sum + journey.visits.length, 0);
    root.append(
      el(
        "section",
        { class: "history-consent" },
        el("p", { class: "history-consent-kicker mono" }, "CONSENT ACKNOWLEDGED AT SIGN-IN"),
        el(
          "p",
          { class: "history-consent-summary" },
          `This submission includes ${state.basket.length} selected journey${state.basket.length === 1 ? "" : "s"} containing ${visitCount} visit${visitCount === 1 ? "" : "s"}.`
        ),
        el(
          "p",
          { class: "history-consent-detail" },
          "The upload includes page URLs, titles, visit times, search terms, and navigation links from those journeys. It is used internally to validate the task. Raw history is not published, licensed, or sold. ",
          el("a", { href: "/privacy.html", target: "_blank", rel: "noreferrer" }, "Read the privacy policy")
        )
      )
    );
  } else {
    root.append(
      el(
        "p",
        { class: "muted small consent-line" },
        "Submitting contributes this authored task to a research dataset used to build and evaluate AI agents."
      )
    );
  }

  if (truncated) {
    root.append(
      el("p", { class: "muted" }, "Some very long journeys were trimmed (keeping their first and last visits) to fit the size limit — the task itself is unchanged.")
    );
  }

  const uploadBtn = el(
    "button",
    {
      class: "btn primary large",
      type: "button",
      disabled: true,
      onclick: () => void ctx.actions.uploadTask(),
    },
    state.busy ? state.busy : `Submit task (${fmtBytes(bytes)})`
  ) as HTMLButtonElement;

  const evergreenCheck = el("input", {
    type: "checkbox",
    "aria-label": "My task is evergreen and remains feasible when run later",
    onchange: (event: Event) => {
      const checked = (event.target as HTMLInputElement).checked;
      uploadBtn.disabled = !checked || !!state.busy || bytes > MAX_UPLOAD_BYTES;
      uploadBtn.title = checked ? "" : "Confirm the task is evergreen before submitting";
    },
  }) as HTMLInputElement;
  uploadBtn.title = "Confirm the task is evergreen before submitting";

  const overLimit = bytes > MAX_UPLOAD_BYTES;
  root.append(
    el(
      "section",
      { class: "history-consent evergreen-confirmation" },
      el("p", { class: "history-consent-kicker mono" }, "FINAL QUALITY CHECK"),
      el(
        "label",
        { class: "history-consent-check" },
        evergreenCheck,
        el("span", null, "I confirm this task will still work weeks or months from now. It does not include a fixed date, price, schedule, availability, ranking, or answer that will go out of date.")
      ),
      el("p", { class: "history-consent-detail" }, "Use timing like “next week” or “30 days from when the task starts.” The agent should look up current information when it does the task.")
    ),
    el(
      "div",
      { class: "upload-band" },
      el(
        "div",
        { class: "upload-band-copy" },
        el("p", { class: "upload-band-title" }, overLimit ? "Almost — trim it down first" : "This is the version that ships"),
        overLimit
          ? el("p", { class: "upload-band-sub muted" }, "Remove a journey to get under the size limit.")
          : null
      ),
      el(
        "div",
        { class: "upload-band-actions" },
        el("button", { class: "btn ghost", type: "button", disabled: !!state.busy, onclick: () => ctx.actions.goto("guided") }, "Back to edit"),
        uploadBtn
      )
    )
  );

  if (bytes > MAX_UPLOAD_BYTES) {
    root.append(
      el("p", { class: "field-error" }, `This task is ${fmtBytes(bytes)} — over the ${fmtBytes(MAX_UPLOAD_BYTES)} size limit even after trimming. Remove a journey or two.`)
    );
  }

  return root;
}

function section(label: string, node: HTMLElement): HTMLElement {
  return el("div", { class: "preview-section" }, el("h4", { class: "preview-label mono" }, label.toUpperCase()), node);
}
