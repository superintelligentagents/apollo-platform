import { metadataFields } from "../components/metadata";
import { appIdsForRecord, MYPCBENCH_APPS, type MyPCBenchApp } from "../../app-catalog";
import { MIN_STEP_LENGTH, PC_TEMPLATES } from "../../templates";
import type { SourceRecord } from "../../types";
import { el } from "../components/helpers";
import type { Ctx } from "../context";

type PickerHistoryCache = {
  records: Ctx["state"]["records"];
  recordCount: number;
  historyRevision: number;
  guideId: string;
  attachmentKey: string;
  selectedRecordCount: number;
  guidedRecords: SourceRecord[];
  emailCount: number;
  calendarCount: number;
  documentCount: number;
};

const pickerHistoryCache = new WeakMap<Ctx["state"], PickerHistoryCache>();
const pickerSearchCache = new WeakMap<SourceRecord, string>();

export function renderTaskEdit(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const draft = s.taskDraft;
  const root = el("section", { class: "screen wide" });
  if (!draft) return root;
  const template = s.activeTemplate ?? PC_TEMPLATES.find((t) => t.id === draft.templateId) ?? null;
  const isFreeForm = template?.id === "free-form-long-horizon";
  const savedGuideId = draft.templateId.startsWith("mypcbench-") ? draft.templateId.slice("mypcbench-".length) : "";
  const guideId = s.pickerApp === "__all__" ? "" : s.pickerApp || savedGuideId;
  const guide = MYPCBENCH_APPS.find((app) => app.id === guideId) ?? null;
  const guidePath = guide?.workflowAppIds
    .map((id) => MYPCBENCH_APPS.find((candidate) => candidate.id === id)?.name ?? id)
    .join(" → ") ?? "";

  root.append(el("p", { class: "step-kicker mono" }, "WRITE TASK"), el("h2", { class: "display" }, guide ? guide.task.title : template ? template.title : "Edit task"));
  if (guide) root.append(
    el("p", { class: "screen-sub" }, `${guide.name} follows the ${guide.analogue} workflow. Use the attached records as evidence, confirm current state in the live apps, and keep each phase dependent on what you found before it.`),
    el(
      "div",
      { class: "task-horizon-summary", role: "status" },
      el("strong", null, "LONG-HORIZON DRAFT"),
      el("span", { class: "mono" }, `${draft.steps.length} dependent phases`),
      el("span", { class: "mono" }, `${guide.workflowAppIds.length} connected apps`),
      el("span", { class: "mono" }, `${draft.referencedRecordIds.length} attached record${draft.referencedRecordIds.length === 1 ? "" : "s"}`),
      el("small", null, guidePath),
    ),
  );
  else if (template) root.append(el("p", { class: "screen-sub" }, template.tagline));

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
    const minimum = guide ? 120 : 15;
    requestCounter.textContent = length < minimum ? `${length} · ${minimum - length} more needed` : `${length} · ready`;
    requestCounter.classList.toggle("ok", length >= minimum);
    requestCounter.classList.toggle("warn", length > 0 && length < minimum);
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
          : guide
            ? "Keep at least four dependent phases: establish constraints, inspect current state, act across the connected apps, and verify the result."
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
  const difficulty = el(
    "select",
    { class: "field-input", "aria-label": "Task difficulty" },
    el("option", { value: "low" }, "Low"),
    el("option", { value: "medium" }, "Medium"),
    el("option", { value: "high" }, "High")
  ) as HTMLSelectElement;
  difficulty.value = draft.difficulty;
  difficulty.addEventListener("change", () => {
    draft.difficulty = difficulty.value as typeof draft.difficulty;
    ctx.autosave();
  });
  const requiredOutputs = el("textarea", {
    class: "field-input",
    rows: "3",
    placeholder: "One required result per line",
    "aria-label": "Required outputs",
  }) as HTMLTextAreaElement;
  requiredOutputs.value = draft.requiredOutputs.join("\n");
  requiredOutputs.addEventListener("input", () => {
    draft.requiredOutputs = requiredOutputs.value.split("\n").map((value) => value.trim()).filter(Boolean);
    ctx.autosave();
  });
  form.append(
    el(
      "details",
      { class: "task-options", open: !!template?.requiresExpectedAnswer },
      el("summary", null, template?.requiresExpectedAnswer ? "Expected answer" : "More task details"),
      field("TASK TITLE (optional)", title),
      field("DIFFICULTY", difficulty),
      field("REQUIRED OUTPUTS (optional)", requiredOutputs),
      field(template?.requiresExpectedAnswer ? "EXPECTED ANSWER (required)" : "EXPECTED ANSWER (optional)", expected, s.formErrors.expected),
      field("NOTES (optional)", notes),
      metadataFields(ctx, (key) => el("p", { class: "field-error" }, s.formErrors[key] || ""))
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
      ),
      el(
        "span",
        { class: "task-save-status mono", role: "status", "aria-live": "polite", "data-save-status": "", "data-state": ctx.state.saveStatus },
        ctx.state.saveStatus === "error" ? "Save failed — keep this tab open" : ctx.state.saveStatus === "saving" ? "Saving…" : "Saved locally",
      )
    );

  // ---- Right: selected data for inspiration and optional grounding
  const picker = el("aside", { class: "record-picker data-inspiration", "aria-label": "Uploaded data inspiration" });
  const documentInput = el("input", {
    type: "file",
    multiple: true,
    accept: ".pdf,.docx,.txt,.md,.csv,.json,.html,.htm",
    style: "display:none",
    "data-testid": "task-document-upload",
    onchange: (event: Event) => {
      const input = event.target as HTMLInputElement;
      const files = [...(input.files ?? [])];
      input.value = "";
      if (files.length) void importTaskDocuments(ctx, draft.taskId, files);
    },
  }) as HTMLInputElement;
  picker.append(
    el("div", { class: "inspiration-head" },
      el("div", null, el("p", { class: "step-kicker mono" }, "YOUR DATA"), el("h3", null, "Find task inspiration"), el("p", { class: "field-hint" }, "Browse selected mail, calendar events, and document text. Check a record to attach it.")),
      documentInput,
      el("button", { class: "btn primary small", type: "button", disabled: !!s.importing, "data-testid": "task-add-document", onclick: () => documentInput.click() }, s.importing?.kind === "documents" ? "Reading document…" : "+ Upload document")
    ),
    el(
      "div",
      { class: "picker-message" },
      s.formErrors.records ? el("span", { class: "field-error" }, ` ${s.formErrors.records}`) : null
    )
  );

  picker.append(appGuideControl(ctx, draft, guideId, guide));

  const attached = new Set(draft.referencedRecordIds);
  const history = pickerHistoryFor(ctx, guideId, attached, draft.referencedRecordIds.join("\u0000"));
  const { guidedRecords, emailCount, calendarCount, documentCount, selectedRecordCount } = history;
  const setPickerSource = (source: typeof s.pickerSource) => {
    s.pickerSource = source;
    s.pickerPage = 0;
    s.pickerOpenId = null;
    s.pickerOpenBody = null;
    ctx.rerender();
  };
  picker.append(el("div", { class: "picker-tabs", role: "group", "aria-label": "Filter inspiration by source" },
    pickerTab("All", guidedRecords.length, s.pickerSource === "all", () => setPickerSource("all")),
    pickerTab("Mail", emailCount, s.pickerSource === "email", () => setPickerSource("email")),
    pickerTab("Calendar", calendarCount, s.pickerSource === "calendar", () => setPickerSource("calendar")),
    pickerTab("Documents", documentCount, s.pickerSource === "documents", () => setPickerSource("documents")),
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

  const q = s.pickerQuery.trim().toLowerCase();
  const matches = guidedRecords
    .filter((r) => s.pickerSource === "all" || (s.pickerSource === "selected" ? attached.has(r.id) : r.source === s.pickerSource))
    .filter((r) => !q || pickerSearchText(r).includes(q));
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
      el("span", { class: "item-kind mono" }, r.source === "email" ? "MAIL" : r.source === "calendar" ? "CAL" : "DOC"),
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
      } else if (r.source === "documents") {
        content.append(el("p", null, r.text || "No extracted text."));
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
  if (!matches.length) list.append(el("p", { class: "empty-note" }, s.pickerSource === "selected" ? "No records attached to this task yet. Upload a document here or check a record in another tab." : selectedRecordCount ? "No records match this app guide and filter." : "Upload a document here, or add mail and calendar data in the data workspace."));
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

function pickerHistoryFor(ctx: Ctx, guideId: string, attached: Set<string>, attachmentKey: string): PickerHistoryCache {
  const s = ctx.state;
  const cached = pickerHistoryCache.get(s);
  if (
    cached &&
    cached.records === s.records &&
    cached.recordCount === s.records.size &&
    cached.historyRevision === s.historyRevision &&
    cached.guideId === guideId &&
    cached.attachmentKey === attachmentKey
  ) return cached;

  const guidedRecords: SourceRecord[] = [];
  let selectedRecordCount = 0;
  let emailCount = 0;
  let calendarCount = 0;
  let documentCount = 0;
  for (const record of s.records.values()) {
    if (record.source !== "email" && record.source !== "calendar" && record.source !== "documents") continue;
    if (!ctx.actions.isIncluded(record)) continue;
    selectedRecordCount++;
    if (guideId && !attached.has(record.id) && !appIdsForRecord(record).includes(guideId)) continue;
    guidedRecords.push(record);
    if (record.source === "email") emailCount++;
    else if (record.source === "calendar") calendarCount++;
    else documentCount++;
  }
  guidedRecords.sort((a, b) => Number(attached.has(b.id)) - Number(attached.has(a.id)) || (b.timestamp || "").localeCompare(a.timestamp || ""));
  const next: PickerHistoryCache = {
    records: s.records,
    recordCount: s.records.size,
    historyRevision: s.historyRevision,
    guideId,
    attachmentKey,
    selectedRecordCount,
    guidedRecords,
    emailCount,
    calendarCount,
    documentCount,
  };
  pickerHistoryCache.set(s, next);
  return next;
}

function appGuideControl(ctx: Ctx, draft: NonNullable<Ctx["state"]["taskDraft"]>, guideId: string, guide: MyPCBenchApp | null): HTMLElement {
  const select = el(
    "select",
    {
      class: "field-input compact",
      "data-testid": "task-app-guide",
      onchange: (event: Event) => {
        ctx.state.pickerApp = (event.target as HTMLSelectElement).value || "__all__";
        ctx.state.pickerPage = 0;
        ctx.state.pickerOpenId = null;
        ctx.state.pickerOpenBody = null;
        ctx.rerender();
      },
    },
    el("option", { value: "", selected: !guideId }, "All data · no app filter"),
    ...MYPCBENCH_APPS.map((app) => el("option", { value: app.id, selected: guideId === app.id }, `${app.name} · like ${app.analogue}`))
  );
  const root = el("section", { class: `task-app-guide ${guide ? "active" : ""}` }, el("label", { class: "field" }, el("span", { class: "field-label" }, "MyPCBench app guide & data filter"), select));
  if (!guide) {
    root.append(el("p", { class: "field-hint" }, "Choose any of the 17 apps to filter your data and use its workflow as a writing guideline."));
    return root;
  }
  const alreadyApplied = draft.templateId === `mypcbench-${guide.id}`;
  root.append(
    el("div", { class: "task-app-guide-copy" }, el("span", { class: "app-analogue mono" }, `${guide.name.toUpperCase()} · LIKE ${guide.analogue.toUpperCase()}`), el("strong", null, guide.task.title), el("p", null, guide.description), el("p", { class: "mono app-guide-steps" }, guide.task.steps.map((step, index) => `${index + 1}. ${step.title}`).join("  ·  "))),
    el("div", { class: "task-app-guide-actions" }, el("a", { class: "btn ghost small", href: guide.url, target: "_blank", rel: "noreferrer" }, `Open ${guide.name} ↗`), alreadyApplied ? el("span", { class: "chip ok" }, "Guide applied") : el("button", { class: "btn small", type: "button", "data-testid": "apply-app-guide", onclick: () => applyAppGuide(ctx, draft, guide) }, "Use as task starting point"))
  );
  return root;
}

function applyAppGuide(ctx: Ctx, draft: NonNullable<Ctx["state"]["taskDraft"]>, guide: MyPCBenchApp): void {
  if (draft.request.trim() && !window.confirm("Replace the current task wording with this app guide? Attached records will stay selected.")) return;
  const source = guide.task;
  Object.assign(draft, {
    templateId: `mypcbench-${guide.id}`,
    category: source.category,
    title: source.title,
    request: source.request,
    steps: source.steps.map((step, index) => ({ ...step, order: index })),
    successCriteria: [...source.successCriteria],
    requiredOutputs: [...source.requiredOutputs],
    subjects: [...source.subjects],
    notes: `MyPCBench app: ${guide.name}`,
  });
  ctx.state.pickerApp = guide.id;
  ctx.autosave();
  ctx.rerender();
}

async function importTaskDocuments(ctx: Ctx, taskId: string, files: File[]): Promise<void> {
  const before = new Set([...ctx.state.records.values()].filter((record) => record.source === "documents").map((record) => record.id));
  await ctx.actions.importFiles("documents", files);
  const draft = ctx.state.taskDraft;
  if (!draft || draft.taskId !== taskId) return;
  for (const record of ctx.state.records.values()) {
    if (record.source !== "documents" || !ctx.actions.isIncluded(record)) continue;
    const matchesChosenFile = files.some((file) => record.filename === file.name && record.size === file.size);
    if (before.has(record.id) && !matchesChosenFile) continue;
    if (!draft.referencedRecordIds.includes(record.id)) draft.referencedRecordIds.push(record.id);
  }
  ctx.state.pickerSource = "documents";
  ctx.state.pickerPage = 0;
  ctx.autosave();
  ctx.rerender();
}

function pickerTab(label: string, count: number, active: boolean, onclick: () => void): HTMLElement {
  return el("button", { class: `picker-tab ${active ? "active" : ""}`, type: "button", "aria-label": `${label}, ${count.toLocaleString()} records`, "aria-pressed": String(active), title: `${count.toLocaleString()} records`, onclick }, label);
}

function pickerSearchText(r: SourceRecord): string {
  const cached = pickerSearchCache.get(r);
  if (cached !== undefined) return cached;
  let text = "";
  if (r.source === "email") text = `${r.searchText} ${r.snippet.toLowerCase()}`;
  else if (r.source === "calendar") text = `${r.searchText} ${r.description.toLowerCase()}`;
  else if (r.source === "documents") text = r.searchText;
  pickerSearchCache.set(r, text);
  return text;
}

function pickerPreview(r: SourceRecord): string {
  if (r.source === "email") return r.snippet.slice(0, 180) || "No email content preview";
  if (r.source === "calendar") return r.description.slice(0, 180) || "No description";
  if (r.source === "documents") return r.text.slice(0, 180) || "No extracted text";
  return "";
}

function pickerTitle(r: SourceRecord): string {
  switch (r.source) {
    case "email":
      return r.subject || "(no subject)";
    case "calendar":
      return r.summary || "(untitled event)";
    case "documents":
      return r.title || r.filename;
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
