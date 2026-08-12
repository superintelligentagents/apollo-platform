import type { Ctx } from "../context";
import { BLANK_TEMPLATE, DELIVERABLE_OPTIONS, MIN_STEP_LENGTH } from "../../templates";
import { derivePrimaryDomains, MIN_REQUEST_LENGTH } from "../../schema";
import { hasUnfilledSlots } from "../../drafts";
import { sanitizeAttachedUrl } from "../pending";
import { el, stepper } from "../components/helpers";
import { metadataFields } from "../components/metadata";
import { authoringStep, stepperLabels } from "./form";
import { itinerary } from "../components/itinerary";

export function renderGuided(ctx: Ctx): HTMLElement {
  if (!ctx.state.activeTemplate) {
    ctx.state.activeTemplate = BLANK_TEMPLATE;
    ctx.state.guidedSteps = BLANK_TEMPLATE.steps.map((s, i) => ({ order: i, title: s.title, description: "" }));
  }
  return renderStepEditor(ctx);
}

function renderStepEditor(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const template = state.activeTemplate!;
  const isBlank = template.id === "blank";
  const defaultStepTitle = /^(?:Task step|Custom step|Step \d+)$/;
  const normalizeDefaultSteps = () => {
    state.guidedSteps.forEach((step, index) => {
      step.order = index;
      if (defaultStepTitle.test(step.title.trim())) step.title = `Step ${index + 1}`;
    });
  };
  normalizeDefaultSteps();
  const root = el("section", { class: "screen guided-screen" });

  root.append(
    el(
      "header",
      { class: "screen-head" },
      stepper(authoringStep(state.mode), stepperLabels(state.mode), () => {
        if (state.mode === "compose" || state.mode === "theme") {
          ctx.actions.goto("compose");
        } else {
          ctx.actions.goto(state.identity?.kind === "internal" ? "submit" : "home");
        }
      }),
      el(
        "span",
        { class: "eyebrow mono" },
        state.mode === "theme" ? "FROM A THEME" : state.mode === "compose" ? "FROM YOUR JOURNEYS" : "WRITE A TASK"
      ),
      el("h2", { class: "display" }, "Write the task"),
      el("p", { class: "screen-sub" }, "Describe realistic web work that could take a person an hour, an afternoon, or several days. Name the goal, constraints, sources to check, and the result to deliver; then split the work into clear phases."),
      el(
        "div",
        { class: "notice info evergreen-guidance" },
        el("strong", null, "Make it work later."),
        " Someone should still be able to do this task weeks or months from now. Use timing like “next week” or “30 days from when the task starts.” Do not include a fixed date, price, schedule, availability, ranking, or answer that will go out of date."
      )
    )
  );

  const form = el("div", { class: "guided-form" });

  const requestCounter = el("span", { class: "char-counter mono" });
  const requestError = el("p", { class: "field-error", dataset: { field: "agent_request" } }, state.formErrors.agent_request ?? "");
  const updateRequestCounter = () => {
    const len = state.draft.agent_request.trim().length;
    const short = MIN_REQUEST_LENGTH - len;
    const slots = hasUnfilledSlots(state.draft.agent_request);
    requestCounter.textContent =
      short > 0
        ? `${state.draft.agent_request.length} · ${short} more needed`
        : slots
          ? `${state.draft.agent_request.length} · finish the bracketed text`
          : `${state.draft.agent_request.length} · ready`;
    requestCounter.classList.toggle("ok", short <= 0 && !slots);
    requestCounter.classList.toggle("warn", (short > 0 && len > 0) || (short <= 0 && slots));
  };
  const request = el("textarea", {
    class: "field-input textarea focused-request",
    rows: "6",
    placeholder: isBlank
      ? `Example: ${template.intro_placeholder}`
      : "Write the full web request. Include the goal, important constraints, sites or sources to use, decisions to make, and the final document, booking, shortlist, or other result.",
    oninput: (e: Event) => {
      state.draft.agent_request = (e.target as HTMLTextAreaElement).value;
      state.requestDirty = true;
      requestError.textContent = "";
      updateRequestCounter();
      ctx.autosave();
    },
  });
  request.value = state.draft.agent_request;
  updateRequestCounter();
  form.append(
    el(
      "div",
      { class: "field request-field" },
      el("div", { class: "field-head" }, el("span", { class: "field-label" }, "The request"), requestCounter),
      request,
      requestError
    )
  );

  // Steps — vertically stacked, collapsible. Open: any step with text, plus
  // the first empty one (write here next). The rest stay folded until clicked.
  const stepsWrap = el("div", { class: "guided-steps" });
  const openSteps = new Set<number>();
  {
    let firstEmptyOpened = false;
    state.guidedSteps.forEach((st, i) => {
      if (st.description.trim()) openSteps.add(i);
      else if (!firstEmptyOpened) {
        openSteps.add(i);
        firstEmptyOpened = true;
      }
    });
  }
  const drawSteps = () => {
    normalizeDefaultSteps();
    stepsWrap.replaceChildren();
    state.guidedSteps.forEach((step, i) => {
      const def = template.steps.find((s) => s.title === step.title);
      const status = el("span", { class: "step-status mono" });
      const updateStatus = () => {
        const len = step.description.trim().length;
        if (len === 0) {
          status.textContent = "required";
          status.className = "step-status mono";
        } else if (len < MIN_STEP_LENGTH) {
          status.textContent = "+ a few words";
          status.className = "step-status mono warn";
        } else {
          status.textContent = "✓ counts";
          status.className = "step-status mono ok";
        }
      };
      const textarea = el("textarea", {
        class: "field-input textarea",
        rows: "3",
        placeholder: def?.placeholder ?? "What exactly should happen in this step?",
        oninput: (e: Event) => {
          step.description = (e.target as HTMLTextAreaElement).value;
          updateStatus();
          ctx.autosave();
        },
      });
      textarea.value = step.description;
      updateStatus();

      const titleInput = el("input", {
        class: "guided-step-title",
        value: step.title,
        "aria-label": "Step title",
        oninput: (e: Event) => (step.title = (e.target as HTMLInputElement).value),
      });

      const isOpen = openSteps.has(i);
      const chevron = el(
        "button",
        {
          class: "step-chevron icon-btn plain",
          type: "button",
          title: isOpen ? "Collapse" : "Expand",
          "aria-expanded": String(isOpen),
          onclick: (e: Event) => {
            e.stopPropagation();
            if (openSteps.has(i)) openSteps.delete(i);
            else openSteps.add(i);
            drawSteps();
          },
        },
        isOpen ? "▾" : "▸"
      );
      stepsWrap.append(
        el(
          "div",
          {
            class: `guided-step card ${isOpen ? "" : "collapsed"}`,
            onclick: (e: Event) => {
              // A folded card opens on any click (the title input passes
              // clicks through while collapsed); an open card folds only via
              // its chevron so typing is never interrupted.
              if (openSteps.has(i)) return;
              const t = e.target as HTMLElement;
              if (t.closest(".icon-btn:not(.step-chevron)")) return;
              openSteps.add(i);
              drawSteps();
            },
          },
          el(
            "div",
            { class: "guided-step-head" },
            chevron,
            el("span", { class: "guided-step-num mono" }, String(i + 1).padStart(2, "0")),
            titleInput,
            status,
            el(
              "div",
              { class: "guided-step-controls" },
              el("button", {
                class: "icon-btn",
                type: "button",
                title: "Move up",
                disabled: i === 0,
                onclick: () => {
                  const [s] = state.guidedSteps.splice(i, 1);
                  state.guidedSteps.splice(i - 1, 0, s);
                  drawSteps();
                  ctx.autosave();
                },
              }, "↑"),
              el("button", {
                class: "icon-btn",
                type: "button",
                title: "Move down",
                disabled: i === state.guidedSteps.length - 1,
                onclick: () => {
                  const [s] = state.guidedSteps.splice(i, 1);
                  state.guidedSteps.splice(i + 1, 0, s);
                  drawSteps();
                  ctx.autosave();
                },
              }, "↓"),
              el("button", {
                class: "icon-btn danger",
                type: "button",
                title: "Remove step",
                disabled: state.guidedSteps.length === 1,
                onclick: () => {
                  state.guidedSteps.splice(i, 1);
                  drawSteps();
                  ctx.autosave();
                },
              }, "✕")
            )
          ),
          textarea
        )
      );
    });
    stepsWrap.append(
      el("button", {
        class: "btn ghost small",
        type: "button",
        onclick: () => {
          state.guidedSteps.push({ order: state.guidedSteps.length, title: `Step ${state.guidedSteps.length + 1}`, description: "" });
          drawSteps();
          ctx.autosave();
        },
      }, "+ Add another step")
    );
  };
  drawSteps();
  form.append(
    el(
      "div",
      { class: "field" },
      el("div", { class: "field-head" }, el("span", { class: "field-label" }, "Task steps")),
      el(
        "p",
        { class: "field-hint" },
        isBlank
          ? "The MLB trip shows how one request becomes checkable steps. Replace the examples, rename, reorder, or remove any step."
          : "Use one step for each meaningful phase of the web work. Steps should explain progress, not repeat the full request."
      ),
      el("p", { class: "field-error", dataset: { field: "steps" } }, state.formErrors.steps ?? ""),
      stepsWrap
    )
  );

  // Deliverable — four common shapes plus "Something else…" free text.
  const deliverableRow = el("div", { class: "segmented wrap", role: "radiogroup" });
  const customInput = el("input", {
    class: "input custom-deliverable",
    type: "text",
    placeholder: "e.g. a confirmed reservation for 4, an email draft, a filled-out application",
    value: state.guidedCustomDeliverable,
    oninput: (e: Event) => {
      state.guidedCustomDeliverable = (e.target as HTMLInputElement).value;
      ctx.autosave();
    },
  }) as HTMLInputElement;
  const customWrap = el("div", { class: "custom-deliverable-wrap" }, customInput);
  const syncCustom = () => {
    customWrap.style.display = state.guidedDeliverable === "custom" ? "" : "none";
    if (state.guidedDeliverable === "custom") customInput.focus();
  };
  const buttons = new Map<string, HTMLButtonElement>();
  for (const opt of DELIVERABLE_OPTIONS) {
    const btn = el(
      "button",
      {
        class: `segment ${state.guidedDeliverable === opt.value ? "active" : ""}`,
        type: "button",
        role: "radio",
        "aria-checked": String(state.guidedDeliverable === opt.value),
        onclick: () => {
          state.guidedDeliverable = opt.value;
          buttons.forEach((b, v) => {
            b.classList.toggle("active", v === opt.value);
            b.setAttribute("aria-checked", String(v === opt.value));
          });
          syncCustom();
          ctx.autosave();
        },
      },
      opt.label
    );
    buttons.set(opt.value, btn);
    deliverableRow.append(btn);
  }
  customWrap.style.display = state.guidedDeliverable === "custom" ? "" : "none";
  form.append(
    el(
      "div",
      { class: "field" },
      el("div", { class: "field-head" }, el("span", { class: "field-label" }, "What should exist at the end?")),
      deliverableRow,
      customWrap
    )
  );

  // This screen — not `form` — is where guided and freeform authors finish, so
  // the distribution fields have to live here too or validation blocks the
  // Review step with nothing on screen to fix.
  if (!state.domainsDirty) {
    state.draft.primary_domains = derivePrimaryDomains({
      siteScope: state.draft.site_scope,
      keyUrls: state.keyUrls,
      attachedUrls: state.attachedUrls
        .map(sanitizeAttachedUrl)
        .filter((u): u is string => u !== null),
    });
  }
  form.append(
    metadataFields(ctx, (key) =>
      el("p", { class: "field-error", dataset: { field: key } }, state.formErrors[key] ?? "")
    )
  );

  form.append(
    el(
      "div",
      { class: "form-actions" },
      el("button", {
        class: "btn ghost",
        type: "button",
        onclick: () => {
          if (state.mode === "compose" || state.mode === "theme") {
            ctx.actions.goto("compose");
            return;
          }
          ctx.actions.goto(state.identity?.kind === "internal" ? "submit" : "home");
        },
      }, state.mode === "compose" || state.mode === "theme" ? "Back to journeys" : "Back"),
      el("button", { class: "btn primary", type: "button", onclick: () => ctx.actions.finishGuided() }, "Review task")
    )
  );

  // Journey-backed tasks: the selected journeys ride along as a scrollable
  // reference rail — look at what you actually did while writing the steps.
  if ((state.mode === "compose" || state.mode === "theme") && state.basket.length) {
    root.append(
      el(
        "div",
        { class: "guided-layout" },
        form,
        el(
          "aside",
          { class: "guided-journeys" },
          itinerary(state.basket, { title: "Your journeys — for reference", readOnly: true })
        )
      )
    );
  } else {
    root.append(form);
  }
  return root;
}
