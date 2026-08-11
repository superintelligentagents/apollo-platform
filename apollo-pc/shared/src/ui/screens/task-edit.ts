import { MIN_STEP_LENGTH, PC_TEMPLATES } from "../../templates";
import type { SourceRecord } from "../../types";
import { el } from "../components/helpers";
import type { Ctx } from "../context";

export function renderTaskEdit(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const draft = s.taskDraft;
  const root = el("section", { class: "screen wide" });
  if (!draft) return root;
  const template = s.activeTemplate ?? PC_TEMPLATES.find((t) => t.id === draft.templateId) ?? null;
  const isFreeForm = template?.id === "free-form-long-horizon";

  root.append(el("h2", { class: "display" }, template ? template.title : "Edit task"));
  if (template) root.append(el("p", { class: "screen-sub" }, template.tagline));

  const layout = el("div", { class: "task-edit-layout" });

  // ---- Left: the authoring form
  const form = el("div", { class: "task-edit-form" });

  const requestCounter = el("span", { class: "char-counter mono" });
  const request = el("textarea", {
    class: "field-input focused-request",
    rows: "4",
    placeholder: isFreeForm
      ? "Describe the goal, important constraints, and the result you want."
      : "Write the full request. Include the goal, constraints, sources to check, decisions to make, and the result you want.",
  }) as HTMLTextAreaElement;
  request.value = draft.request;
  const updateRequestCounter = () => {
    const length = draft.request.trim().length;
    requestCounter.textContent = length < 15 ? `${length} · ${15 - length} more needed` : `${length} · ready`;
    requestCounter.classList.toggle("ok", length >= 15);
    requestCounter.classList.toggle("warn", length > 0 && length < 15);
  };
  request.addEventListener("input", () => {
    draft.request = request.value;
    updateRequestCounter();
    ctx.autosave();
  });
  updateRequestCounter();
  form.append(
    el(
      "div",
      { class: "field request-field" },
      el("div", { class: "field-head" }, el("span", { class: "field-label" }, "The request"), requestCounter),
      request,
      s.formErrors.request ? el("span", { class: "field-error" }, s.formErrors.request) : null
    )
  );

  const stepsWrap = el("div", { class: "guided-steps" });
  const openSteps = new Set<number>();
  let firstEmptyOpened = false;
  draft.steps.forEach((step, index) => {
    if (step.description.trim()) openSteps.add(index);
    else if (!firstEmptyOpened) {
      openSteps.add(index);
      firstEmptyOpened = true;
    }
  });
  const drawSteps = () => {
    draft.steps.forEach((step, index) => {
      step.order = index;
      if (/^(?:Task step|Custom step|Step \d+|Step)$/.test(step.title.trim())) step.title = `Step ${index + 1}`;
    });
    stepsWrap.replaceChildren();
    draft.steps.forEach((step, i) => {
      const definition = template?.steps.find((candidate) => candidate.title === step.title) ?? template?.steps[i];
      const status = el("span", { class: "step-status mono" });
      const updateStatus = () => {
        const length = step.description.trim().length;
        status.textContent = length === 0 ? "Needs detail" : length < MIN_STEP_LENGTH ? "Keep writing" : "Ready";
        status.className = `step-status mono ${length === 0 ? "" : length < MIN_STEP_LENGTH ? "warn" : "ok"}`;
      };
      const textarea = el("textarea", {
        class: "field-input",
        rows: "3",
        placeholder: isFreeForm
          ? `What should happen in “${step.title}”? Include constraints and the result to record.`
          : definition?.placeholder ?? "What exactly should happen in this step?",
        oninput: (e: Event) => {
          step.description = (e.target as HTMLTextAreaElement).value;
          updateStatus();
          ctx.autosave();
        },
      }) as HTMLTextAreaElement;
      textarea.value = step.description;
      updateStatus();
      const titleInput = el("input", {
        class: "guided-step-title",
        value: step.title,
        "aria-label": "Step title",
        oninput: (e: Event) => {
          step.title = (e.target as HTMLInputElement).value;
          ctx.autosave();
        },
      });
      const isOpen = openSteps.has(i);
      const chevron = el("button", {
        class: "step-chevron icon-btn",
        type: "button",
        title: isOpen ? "Collapse" : "Expand",
        "aria-expanded": String(isOpen),
        onclick: (e: Event) => {
          e.stopPropagation();
          if (isOpen) openSteps.delete(i);
          else openSteps.add(i);
          drawSteps();
        },
      }, isOpen ? "▾" : "▸");
      stepsWrap.append(
        el(
          "div",
          {
            class: `guided-step ${isOpen ? "" : "collapsed"}`,
            onclick: () => {
              if (!openSteps.has(i)) {
                openSteps.add(i);
                drawSteps();
              }
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
              el("button", { class: "icon-btn", type: "button", title: "Move up", disabled: i === 0, onclick: (e: Event) => { e.stopPropagation(); const [moved] = draft.steps.splice(i, 1); draft.steps.splice(i - 1, 0, moved); drawSteps(); ctx.autosave(); } }, "↑"),
              el("button", { class: "icon-btn", type: "button", title: "Move down", disabled: i === draft.steps.length - 1, onclick: (e: Event) => { e.stopPropagation(); const [moved] = draft.steps.splice(i, 1); draft.steps.splice(i + 1, 0, moved); drawSteps(); ctx.autosave(); } }, "↓"),
              el("button", { class: "icon-btn danger", type: "button", title: "Remove step", disabled: draft.steps.length === 1, onclick: (e: Event) => { e.stopPropagation(); draft.steps.splice(i, 1); drawSteps(); ctx.autosave(); } }, "✕")
            )
          ),
          textarea
        )
      );
    });
    stepsWrap.append(el("button", { class: "text-button step-add", type: "button", onclick: () => { const index = draft.steps.length; draft.steps.push({ order: index, title: `Step ${index + 1}`, description: "" }); openSteps.add(index); drawSteps(); ctx.autosave(); } }, "+ Add step"));
  };
  drawSteps();
  form.append(
    el(
      "div",
      { class: "field task-steps-field" },
      el("div", { class: "field-head" }, el("span", { class: "field-label" }, "Task steps")),
      el(
        "p",
        { class: "field-hint" },
        isFreeForm
          ? "Break the request into checkable steps. Open a step to add details."
          : "Use one step for each meaningful phase. One complete step is enough."
      ),
      s.formErrors.steps ? el("p", { class: "field-error" }, s.formErrors.steps) : null,
      stepsWrap
    )
  );

  const title = el("input", { class: "field-input", placeholder: "Optional — derived from the request if blank", value: draft.title }) as HTMLInputElement;
  title.addEventListener("input", () => {
    draft.title = title.value;
    ctx.autosave();
  });

  const expected = el("textarea", { class: "field-input", rows: "2", placeholder: "The ground truth — you know it, the agent has to find it." }) as HTMLTextAreaElement;
  expected.value = draft.expectedAnswer;
  expected.addEventListener("input", () => {
    draft.expectedAnswer = expected.value;
    ctx.autosave();
  });
  const notes = el("input", { class: "field-input", placeholder: "Anything a reviewer should know", value: draft.notes }) as HTMLInputElement;
  notes.addEventListener("input", () => {
    draft.notes = notes.value;
    ctx.autosave();
  });
  form.append(
    el(
      "details",
      { class: "task-options", open: !!template?.requiresExpectedAnswer },
      el("summary", null, template?.requiresExpectedAnswer ? "Expected answer" : "More task details"),
      field("TASK TITLE (optional)", title),
      field(template?.requiresExpectedAnswer ? "EXPECTED ANSWER (required)" : "EXPECTED ANSWER (optional)", expected, s.formErrors.expected),
      field("NOTES (optional)", notes)
    )
  );

  const taskActions = el(
      "div",
      { class: "drawer-actions" },
      el("button", { class: "btn primary", type: "button", onclick: () => void ctx.actions.saveTaskDraft() }, "Save task"),
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () => {
            s.taskDraft = null;
            s.activeTemplate = null;
            ctx.actions.goto("tasks");
          },
        },
        "Discard"
      )
    );

  // ---- Right: selected data for inspiration and optional grounding
  const picker = el("aside", { class: "record-picker data-inspiration", "aria-label": "Uploaded data inspiration" });
  picker.append(
    el("div", { class: "inspiration-head" },
      el("p", { class: "step-kicker mono" }, "YOUR DATA"),
      el("h3", null, "Find task inspiration"),
      el("p", { class: "field-hint" }, "Browse selected mail and calendar. Check a record to attach it.")
    ),
    el(
      "div",
      { class: "picker-message" },
      s.formErrors.records ? el("span", { class: "field-error" }, ` ${s.formErrors.records}`) : null
    )
  );

  const selectedRecords = [...s.records.values()].filter((r) =>
    (r.source === "email" || r.source === "calendar") && ctx.actions.isIncluded(r)
  );
  const emailCount = selectedRecords.filter((r) => r.source === "email").length;
  const calendarCount = selectedRecords.length - emailCount;
  const setPickerSource = (source: typeof s.pickerSource) => {
    s.pickerSource = source;
    s.pickerPage = 0;
    s.pickerOpenId = null;
    s.pickerOpenBody = null;
    ctx.rerender();
  };
  picker.append(el("div", { class: "picker-tabs", role: "group", "aria-label": "Filter inspiration by source" },
    pickerTab("All", selectedRecords.length, s.pickerSource === "all", () => setPickerSource("all")),
    pickerTab("Mail", emailCount, s.pickerSource === "email", () => setPickerSource("email")),
    pickerTab("Calendar", calendarCount, s.pickerSource === "calendar", () => setPickerSource("calendar")),
    pickerTab("Selected", draft.referencedRecordIds.length, s.pickerSource === "selected", () => setPickerSource("selected"))
  ));

  const search = el("input", {
    type: "search",
    class: "field-input compact",
    placeholder: "Search subject, content, summary…",
    value: s.pickerQuery,
    oninput: (e: Event) => {
      s.pickerQuery = (e.target as HTMLInputElement).value;
      s.pickerPage = 0;
      s.pickerOpenId = null;
      s.pickerOpenBody = null;
      ctx.rerender();
    },
  });
  picker.append(search);

  const attached = new Set(draft.referencedRecordIds);
  const q = s.pickerQuery.trim().toLowerCase();
  const matches = selectedRecords
    .filter((r) => s.pickerSource === "all" || (s.pickerSource === "selected" ? attached.has(r.id) : r.source === s.pickerSource))
    .filter((r) => !q || pickerSearchText(r).includes(q))
    .sort((a, b) => Number(attached.has(b.id)) - Number(attached.has(a.id)) || (b.timestamp || "").localeCompare(a.timestamp || ""));
  const pickerPageSize = 50;
  const pickerPages = Math.max(1, Math.ceil(matches.length / pickerPageSize));
  const pickerPage = Math.min(s.pickerPage, pickerPages - 1);
  const shownMatches = matches.slice(pickerPage * pickerPageSize, (pickerPage + 1) * pickerPageSize);
  picker.append(el("p", { class: "picker-result mono", role: "status" }, `${matches.length.toLocaleString()} record${matches.length === 1 ? "" : "s"}`));

  const list = el("div", { class: "picker-rows" });
  for (const r of shownMatches) {
    const on = attached.has(r.id);
    const open = s.pickerOpenId === r.id;
    const toggleOpen = () => {
      if (open) {
        s.pickerOpenId = null;
        s.pickerOpenBody = null;
      } else {
        s.pickerOpenId = r.id;
        s.pickerOpenBody = null;
      }
      ctx.rerender();
    };
    const row = el(
      "article",
      { class: `picker-row ${on ? "attached" : ""} ${open ? "open" : ""}` },
      el("label", { class: "picker-attach", title: on ? "Attached to this task" : "Attach to this task" },
        el("input", { type: "checkbox", checked: on, "aria-label": `${on ? "Detach" : "Attach"} ${pickerTitle(r)}`, onchange: () => ctx.actions.toggleTaskRecord(r.id) })
      ),
      el("span", { class: "item-kind mono" }, r.source === "email" ? "MAIL" : "CAL"),
      el(
        "button",
        { class: "picker-open-button", type: "button", "aria-expanded": String(open), onclick: toggleOpen },
        el("span", { class: "item-title" }, pickerTitle(r)),
        el("span", { class: "item-detail picker-preview" }, pickerPreview(r)),
        el("span", { class: "picker-view-cue" }, open ? "Close" : "View")
      )
    );
    if (open) {
      const content = el("div", { class: "picker-record-content" });
      if (r.source === "calendar") {
        content.append(el("p", null, r.description || "No description."));
      } else if (s.pickerOpenBody !== null) {
        content.append(el("p", null, s.pickerOpenBody || "No email content."));
      } else {
        content.append(el("p", { class: "picker-loading", role: "status" }, "Loading email content…"));
        void ctx.store.getBody(r.id).then((body) => {
          if (s.pickerOpenId !== r.id) return;
          const decision = s.decisions.get(r.id);
          s.pickerOpenBody = decision?.bodyEdit ?? body ?? "";
          ctx.rerender();
        }).catch(() => {
          if (s.pickerOpenId !== r.id) return;
          s.pickerOpenBody = r.source === "email" ? r.snippet || "" : "";
          ctx.rerender();
        });
      }
      row.append(content);
    }
    list.append(
      row
    );
  }
  if (!matches.length) list.append(el("p", { class: "empty-note" }, s.pickerSource === "selected" ? "No records attached to this task yet." : selectedRecords.length ? "No records match this filter." : "Select mail or calendar records for upload to see them here."));
  picker.append(list);
  if (pickerPages > 1) picker.append(el("div", { class: "picker-pager" },
    el("button", { class: "btn ghost small", type: "button", disabled: pickerPage === 0, onclick: () => { s.pickerPage = pickerPage - 1; s.pickerOpenId = null; s.pickerOpenBody = null; ctx.rerender(); } }, "← Previous"),
    el("span", { class: "mono" }, `${pickerPage + 1} / ${pickerPages}`),
    el("button", { class: "btn ghost small", type: "button", disabled: pickerPage + 1 >= pickerPages, onclick: () => { s.pickerPage = pickerPage + 1; s.pickerOpenId = null; s.pickerOpenBody = null; ctx.rerender(); } }, "Next →")
  ));
  form.append(taskActions);
  layout.append(form, picker);
  root.append(layout);
  return root;
}

function pickerTab(label: string, count: number, active: boolean, onclick: () => void): HTMLElement {
  return el("button", { class: `picker-tab ${active ? "active" : ""}`, type: "button", "aria-label": `${label}, ${count.toLocaleString()} records`, "aria-pressed": String(active), title: `${count.toLocaleString()} records`, onclick }, label);
}

function pickerSearchText(r: SourceRecord): string {
  if (r.source === "email") return `${r.subject} ${r.snippet}`.toLowerCase();
  if (r.source === "calendar") return `${r.summary} ${r.description}`.toLowerCase();
  return "";
}

function pickerPreview(r: SourceRecord): string {
  if (r.source === "email") return r.snippet || "No email content preview";
  if (r.source === "calendar") return r.description || "No description";
  return "";
}

function pickerTitle(r: SourceRecord): string {
  switch (r.source) {
    case "email":
      return r.subject || "(no subject)";
    case "calendar":
      return r.summary || "(untitled event)";
    case "contacts":
      return r.fullName || r.emails[0] || "(contact)";
    case "messages":
      return `${r.chatName}: ${r.text.slice(0, 40)}`;
    case "orders":
      return `${r.merchant}${r.total !== null ? ` · $${r.total.toFixed(2)}` : ""}`;
    case "transactions":
      return r.description;
  }
}

function field(label: string, input: HTMLElement, error?: string) {
  return el(
    "label",
    { class: "field" },
    el("span", { class: "field-label" }, label),
    input,
    error ? el("span", { class: "field-error" }, error) : null
  );
}
