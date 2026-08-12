import type { Ctx } from "../context";
import { derivePrimaryDomains, MIN_REQUEST_LENGTH } from "../../schema";
import { hasUnfilledSlots } from "../../drafts";
import { sanitizeAttachedUrl } from "../pending";
import { el, stepper } from "../components/helpers";
import { metadataFields } from "../components/metadata";

export function renderForm(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const d = state.draft;

  // Re-derive the site chips on each visit to this screen until the author
  // edits them by hand: the journey basket and the attached URLs can both
  // change after the first pass through here.
  if (!state.domainsDirty) {
    d.primary_domains = derivePrimaryDomains({
      siteScope: d.site_scope,
      keyUrls: state.keyUrls,
      attachedUrls: state.attachedUrls
        .map(sanitizeAttachedUrl)
        .filter((u): u is string => u !== null),
    });
  }

  const root = el("section", { class: "screen form-screen" });
  const errors: Record<string, string> = { ...state.formErrors };

  root.append(
    el(
      "header",
      { class: "screen-head" },
      stepper(authoringStep(state.mode), stepperLabels(state.mode), (n) =>
        ctx.actions.goto(
          n === 2 ? "guided" : state.mode === "compose" || state.mode === "theme" ? "compose" : "guided"
        )
      ),
      el("h2", { class: "display" }, "Write the request"),
      el(
        "p",
        { class: "screen-sub" },
        "Describe a realistic web project that takes about an hour or longer. Include the goal, constraints, sources or sites to use, decisions to make, and the final result so an agent can work without follow-up questions."
      )
    )
  );

  const fieldError = (key: string) =>
    el("p", { class: "field-error", dataset: { field: key } }, errors[key] ?? "");

  const form = el("form", {
    class: "task-form focused-task-form",
    onsubmit: (e: Event) => {
      e.preventDefault();
      if (!ctx.actions.continueToReview()) {
        ctx.rerender();
        document
          .querySelector(".field-error:not(:empty)")
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    },
  });

  const needsJourneys = (state.mode === "compose" || state.mode === "theme") && !state.basket.length;
  if (needsJourneys) {
    form.append(
      el(
        "div",
        { class: "notice info form-banner" },
        el("span", null, "Reload your history and re-select the journeys for this task."),
        el(
          "button",
          {
            class: "btn primary small",
            type: "button",
            onclick: () => {
              ctx.update({ afterHistory: state.mode === "theme" ? "themes" : "compose" });
              ctx.actions.goto("history");
            },
          },
          "Reload history"
        )
      ),
      fieldError("source_journeys"),
      fieldError("theme_suggestion")
    );
  }

  const counter = el("span", { class: "char-counter mono" });
  const updateCounter = () => {
    const len = d.agent_request.trim().length;
    const short = MIN_REQUEST_LENGTH - len;
    const slots = hasUnfilledSlots(d.agent_request);
    counter.textContent =
      short > 0
        ? `${d.agent_request.length} · ${short} more needed`
        : slots
          ? `${d.agent_request.length} · finish the bracketed text`
          : `${d.agent_request.length} · ready`;
    counter.classList.toggle("ok", short <= 0 && !slots);
    counter.classList.toggle("warn", (short > 0 && d.agent_request.length > 0) || (short <= 0 && slots));
  };

  const autosize = (ta: HTMLTextAreaElement) => {
    ta.style.height = "auto";
    ta.style.height = `${Math.max(ta.scrollHeight + 2, 160)}px`;
  };

  const request = el("textarea", {
    class: "field-input textarea focused-request",
    rows: "7",
    placeholder: "Describe the complete long-horizon request: the goal, constraints, websites or sources, research and decisions required, and the final result that should exist at the end.",
    oninput: (e: Event) => {
      d.agent_request = (e.target as HTMLTextAreaElement).value;
      state.requestDirty = true;
      autosize(e.target as HTMLTextAreaElement);
      updateCounter();
      ctx.autosave();
    },
  });
  request.value = d.agent_request;
  updateCounter();
  queueMicrotask(() => autosize(request));

  form.append(
    el(
      "div",
      { class: "field" },
      el(
        "div",
        { class: "field-head" },
        el("span", { class: "field-label" }, "The request"),
        counter
      ),
      request,
      fieldError("agent_request")
    ),
    metadataFields(ctx, fieldError),
    fieldError("metadata"),
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn ghost", type: "button", onclick: () => ctx.actions.goto("guided") }, "Back"),
      el("button", { class: "btn primary", type: "submit" }, "Review task")
    )
  );

  root.append(form);
  return root;
}

export function stepperLabels(mode: string | null): string[] {
  return mode === "compose" || mode === "theme"
    ? ["Select journeys", "Write task", "Review & submit"]
    : ["Write task", "Review & submit"];
}

export function authoringStep(mode: string | null): number {
  return mode === "compose" || mode === "theme" ? 2 : 1;
}
