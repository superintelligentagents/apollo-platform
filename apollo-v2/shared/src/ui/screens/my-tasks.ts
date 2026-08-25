import type { Ctx } from "../context";
import { el } from "../components/helpers";
import {
  authorAmend,
  authorEdit,
  authorSignoff,
  myTaskFeedback,
  myTaskPage,
  type AuthorEditPayload,
  type MyTaskContentSnapshot,
  type MyTaskCurrentContent,
  type MyTaskFeedback,
  type MyTaskHistoryEntry,
  type MyTaskHumanReview,
  type MyTaskItem,
  type MyTaskStatus,
} from "../../review-client";
import {
  renderLlmPanel,
  renderLlmRubricList,
  stepNumberFromRubricId,
  type LlmPanelStatus,
} from "../components/llm-panel";
import { participantId as schemaParticipantId } from "../../schema";
import { diffSummary, diffWords } from "../../textdiff";

// The backend caps this endpoint at 200. Loading the largest supported page
// keeps search and status filters useful for almost every author without
// making them page through a 50-row window first.
const PAGE_SIZE = 200;
const MIN_APPEAL_REASON_LENGTH = 20;

const STATUS_LABEL: Record<MyTaskStatus, string> = {
  awaiting_codex: "Awaiting Codex",
  pending: "Pending",
  in_review: "In review",
  approved: "Approved",
  rejected: "Rejected",
  returned: "Returned",
};

export type MyTaskFilter = "all" | "action" | "in_progress" | "approved" | "rejected" | "returned";
export type MyTaskSort = "newest" | "oldest" | "status";

interface MyTasksViewState {
  offset: number;
  query: string;
  filter: MyTaskFilter;
  sort: MyTaskSort;
  scrollTop: number;
}

// Screen instances can be rebuilt after notifications or route transitions.
// Keep each signed-in author's place in memory so finishing a task on a later
// page never silently drops them back at the beginning.
const myTasksViewByParticipant = new Map<string, MyTasksViewState>();

export function resetMyTasksViewState(participantId?: string): void {
  if (participantId) myTasksViewByParticipant.delete(participantId);
  else myTasksViewByParticipant.clear();
}

export function myTaskNeedsAction(item: MyTaskItem): boolean {
  return Boolean(
    item.needs_signoff
      || item.status === "returned"
      || (item.status === "rejected" && item.can_appeal)
  );
}

export function filterAndSortMyTasks(
  items: MyTaskItem[],
  query: string,
  filter: MyTaskFilter,
  sort: MyTaskSort
): MyTaskItem[] {
  const needle = query.trim().toLowerCase();
  const filtered = items.filter((item) => {
    const matchesQuery = !needle || [
      item.title,
      item.request,
      item.rejection_reason,
      item.returned_reason,
      STATUS_LABEL[item.status],
    ].some((value) => String(value ?? "").toLowerCase().includes(needle));
    if (!matchesQuery) return false;
    if (filter === "action") return myTaskNeedsAction(item);
    if (filter === "in_progress") {
      return item.status === "awaiting_codex" || item.status === "pending" || item.status === "in_review";
    }
    return filter === "all" || item.status === filter;
  });
  const submittedAt = (item: MyTaskItem) => {
    const parsed = Date.parse(item.submitted_at ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return filtered.sort((a, b) => {
    if (sort === "oldest") return submittedAt(a) - submittedAt(b) || a.title.localeCompare(b.title);
    if (sort === "status") {
      return Number(myTaskNeedsAction(b)) - Number(myTaskNeedsAction(a))
        || STATUS_LABEL[a.status].localeCompare(STATUS_LABEL[b.status])
        || submittedAt(b) - submittedAt(a);
    }
    return submittedAt(b) - submittedAt(a) || a.title.localeCompare(b.title);
  });
}

function statusBadge(status: MyTaskStatus): HTMLElement {
  const cls =
    status === "approved"
      ? "badge ok"
      : status === "in_review"
        ? "badge warn"
        : status === "returned"
          ? "badge warn"
          : status === "rejected"
            ? "badge danger"
            : "badge";
  return el("span", { class: cls }, STATUS_LABEL[status]);
}

// Which of an author's own actions a row offers. An approved task is amended
// (the edit becomes final gold); a rejected one may be appealed once, which
// puts a revision back in the reviewer queue; anything still open is an
// ordinary revision.
export type EditMode = "revise" | "appeal" | "amend" | null;

export function editModeFor(item: MyTaskItem): EditMode {
  if (item.status === "approved") return "amend";
  if (item.status === "rejected") return item.can_appeal ? "appeal" : null;
  // Once a rejected task's appeal is queued, that revision is the author's
  // one final pass. Do not offer another edit while it waits for Codex/QC.
  // A reviewer may still explicitly return it, which opens the normal
  // return-to-author correction flow.
  if (
    (item.status === "awaiting_codex" || item.status === "pending")
    && (item.rejection_count ?? 0) > 0
  ) {
    return null;
  }
  if (item.status === "awaiting_codex" || item.status === "pending" || item.status === "returned") {
    return "revise";
  }
  return null;
}

const EDIT_BUTTON_LABEL: Record<Exclude<EditMode, null>, string> = {
  revise: "Edit task",
  appeal: "Revise and appeal",
  amend: "Edit and make final",
};

// Map the feedback status (which includes the finished states) onto the
// panel's status set. Only the empty-state copy depends on this; when a review
// is present the panel renders the review regardless.
function panelStatus(fb: MyTaskFeedback): LlmPanelStatus {
  if (fb.stale) return "stale";
  if (fb.review) return "pre_qc_passed";
  return "not_reviewed";
}

function snapshotFromItem(item: MyTaskItem, fb: MyTaskFeedback): MyTaskContentSnapshot | null {
  if (fb.human_review) return fb.human_review.original;
  if (fb.task) {
    return {
      title: fb.task.title,
      request: fb.task.request,
      criteria: fb.task.criteria,
      steps: fb.task.steps,
    };
  }
  // Contract gap fallback: only the truncated request is available.
  return { title: item.title, request: item.request, criteria: [], steps: [] };
}

function diffSnapshot(label: string, snap: MyTaskContentSnapshot, extraClass = ""): HTMLElement {
  const steps = snap.steps.length
    ? el(
        "ol",
        { class: "admin-step-list" },
        ...snap.steps.map((step) => el("li", null, el("strong", null, step.title || `Step ${step.order}`), el("p", null, step.description)))
      )
    : el("p", { class: "muted" }, "No authored steps.");
  return el(
    "section",
    { class: `admin-snapshot ${extraClass}`.trim() },
    el("div", { class: "admin-snapshot-head" }, el("h5", null, label)),
    el("h6", null, snap.title || "Untitled task"),
    el("p", { class: "admin-request" }, snap.request || "No request text."),
    ...(snap.criteria.length ? [el("h6", null, "Success criteria"), el("ol", { class: "admin-rubric-list" }, ...snap.criteria.map((c) => el("li", null, c)))] : []),
    el("h6", null, "Steps"),
    steps
  );
}

export interface ApprovedReviewChange {
  label: string;
  before: string;
  after: string;
}

export function approvedReviewChanges(hr: MyTaskHumanReview): ApprovedReviewChange[] {
  const changes: ApprovedReviewChange[] = [];
  const add = (label: string, before: string | undefined, after: string | undefined) => {
    const prior = String(before ?? "");
    const next = String(after ?? "");
    if (prior !== next) changes.push({ label, before: prior, after: next });
  };
  add("Task title", hr.original.title, hr.final.title);
  add("Task request", hr.original.request, hr.final.request);

  const criterionCount = Math.max(hr.original.criteria.length, hr.final.criteria.length);
  for (let index = 0; index < criterionCount; index += 1) {
    add(`Success criterion ${index + 1}`, hr.original.criteria[index], hr.final.criteria[index]);
  }

  const originalSteps = new Map(hr.original.steps.map((step) => [step.order, step]));
  const finalSteps = new Map(hr.final.steps.map((step) => [step.order, step]));
  const stepOrders = [...new Set([...originalSteps.keys(), ...finalSteps.keys()])].sort((a, b) => a - b);
  for (const order of stepOrders) {
    const original = originalSteps.get(order);
    const final = finalSteps.get(order);
    add(`Step ${order} · title`, original?.title, final?.title);
    add(`Step ${order} · instructions`, original?.description, final?.description);
  }
  return changes;
}

function inlineReviewDiff(change: ApprovedReviewChange): HTMLElement {
  const ops = diffWords(change.before, change.after);
  const copy = el("p", {
    class: "my-task-change-copy inline-diff",
    "aria-label": `${change.label} changed from ${change.before || "empty"} to ${change.after || "empty"}`,
  });
  for (const op of ops) {
    if (op.type === "equal") copy.append(document.createTextNode(op.text));
    else if (op.type === "delete") copy.append(el("del", { class: "diff-del" }, op.text));
    else copy.append(el("ins", { class: "diff-ins" }, op.text));
  }
  return copy;
}

function changedField(change: ApprovedReviewChange): HTMLElement {
  const kind = !change.before ? "Added" : !change.after ? "Removed" : "Edited";
  return el(
    "article",
    { class: "my-task-change-field" },
    el(
      "div",
      { class: "my-task-change-field-head" },
      el("h5", null, change.label),
      el("span", { class: `my-task-change-kind ${kind.toLowerCase()}` }, kind)
    ),
    inlineReviewDiff(change)
  );
}

function renderDiff(hr: MyTaskHumanReview): HTMLElement {
  const finalLabel = hr.amended_by
    ? "Final gold · your amendment"
    : hr.changed === false
      ? "Final gold · unchanged"
      : "Final gold version";
  const changes = approvedReviewChanges(hr);
  if (!changes.length) {
    return el(
      "section",
      { class: "my-task-change-review unchanged" },
      el(
        "div",
        { class: "my-task-change-head" },
        el("div", null, el("p", { class: "eyebrow" }, "Review changes"), el("h4", null, "No text changed")),
        el("span", { class: "chip tag" }, "0 edits")
      ),
      el("p", { class: "field-hint" }, "The title, request, success criteria, and steps match your submission."),
      diffSnapshot(finalLabel, hr.final, "final")
    );
  }

  const totals = changes.reduce(
    (sum, change) => {
      const count = diffSummary(diffWords(change.before, change.after));
      return { inserted: sum.inserted + count.inserted, deleted: sum.deleted + count.deleted };
    },
    { inserted: 0, deleted: 0 }
  );
  const fullVersions = el(
    "details",
    { class: "my-task-full-compare" },
    el("summary", null, "View complete versions side by side"),
    el(
      "div",
      { class: "admin-snapshots has-final my-task-diff" },
      diffSnapshot("Your original", hr.original),
      diffSnapshot(finalLabel, hr.final, "final")
    )
  );
  return el(
    "section",
    { class: "my-task-change-review" },
    el(
      "div",
      { class: "my-task-change-head" },
      el(
        "div",
        null,
        el("p", { class: "eyebrow" }, "Review changes"),
        el("h4", null, `${changes.length} ${changes.length === 1 ? "field" : "fields"} edited`)
      ),
      el("span", { class: "my-task-change-volume mono" }, `+${totals.inserted} / −${totals.deleted} words`)
    ),
    el(
      "div",
      { class: "my-task-diff-legend", "aria-label": "Diff legend" },
      el("span", null, el("i", { class: "diff-key removed", "aria-hidden": "true" }), "Removed"),
      el("span", null, el("i", { class: "diff-key added", "aria-hidden": "true" }), "Added"),
      el("small", null, "Unmarked text stayed the same")
    ),
    el("div", { class: "my-task-change-list" }, ...changes.map(changedField)),
    fullVersions
  );
}

// Show what happened in human QC without exposing who made the decision.
function reviewOutcomeLine(hr: MyTaskHumanReview): HTMLElement {
  return el(
    "p",
    { class: "my-task-reviewer" },
    el("span", { class: "chip tag review-chip" }, "human review"),
    hr.changed === false
      ? el("span", { class: "muted" }, "Approved as you wrote it; nothing changed.")
      : el("span", { class: "muted" }, "Approved with edits; highlighted changes appear first.")
  );
}

function readOnlyTask(item: MyTaskItem, fb: MyTaskFeedback): HTMLElement {
  const snap = snapshotFromItem(item, fb);
  if (!snap) return el("p", { class: "muted" }, "No task content available.");
  return diffSnapshot("Your task", snap);
}

function statusNotice(item: MyTaskItem, fb: MyTaskFeedback): HTMLElement | null {
  if (item.status === "rejected" || fb.status === "rejected") {
    const canAppeal = item.can_appeal === true;
    return el(
      "div",
      { class: "admin-rejection" },
      el("strong", null, "Why this was rejected"),
      el("p", null, fb.rejection_reason ?? item.rejection_reason ?? "The reviewer did not give a reason."),
      el(
        "p",
        { class: "muted small" },
        canAppeal
          ? "If you think this was the wrong call, revise the task and send it back. You get one appeal, and it goes to a different reviewer."
          : item.appeal_unavailable_reason
            ? item.appeal_unavailable_reason
            : "You have already appealed this rejection once, so this task is finished. Use the feedback on your next task."
      )
    );
  }
  if (item.status === "returned" || fb.status === "returned") {
    return el(
      "div",
      { class: "admin-rejection" },
      el("strong", null, "Returned by reviewer for revision."),
      el("p", null, fb.returned_reason ?? item.returned_reason ?? "The reviewer did not give a reason.")
    );
  }
  if (item.status === "in_review") {
    return el("p", { class: "notice info" }, "A reviewer is currently reviewing this task — it's locked.");
  }
  return null;
}

// The reviewer's step-level notes on a rejection. Rendered without any name on
// it: the author gets the substance, not the author of the verdict.
function rejectionFeedback(fb: MyTaskFeedback): HTMLElement | null {
  const rubrics = fb.rejection_feedback?.rubrics ?? [];
  const notes = rubrics.filter((rubric) => rubric.changed || rubric.original !== rubric.final);
  if (!notes.length) return null;
  return el(
    "section",
    { class: "my-task-reject-notes" },
    el("h4", null, "What the reviewer marked up"),
    el("p", { class: "field-hint" }, "The reviewer's notes on individual steps, shown without their name."),
    el(
      "ol",
      { class: "admin-rubric-list" },
      ...notes.map((rubric) =>
        el(
          "li",
          null,
          el("strong", null, rubric.title || `Step ${stepNumberFromRubricId(rubric.rubric_id, 0)}`),
          el("p", null, rubric.final),
          rubric.original && rubric.original !== rubric.final
            ? el("p", { class: "muted small" }, `You wrote: ${rubric.original}`)
            : null
        )
      )
    )
  );
}

const HISTORY_LABEL: Record<MyTaskHistoryEntry["event"], string> = {
  submitted: "You submitted this task",
  revised: "You revised it",
  appealed: "You appealed the rejection",
  returned: "A reviewer sent it back",
  rejected: "A reviewer rejected it",
  approved: "Approved",
  accepted: "You accepted the reviewer's version",
  amended: "You amended the final version",
};

function historyPanel(fb: MyTaskFeedback): HTMLElement | null {
  const entries = fb.history ?? [];
  if (!entries.length) return null;
  const list = el(
    "ol",
    { class: "my-task-history-list" },
    ...entries.map((entry) =>
      el(
        "li",
        null,
        el("span", { class: "mono muted admin-date" }, new Date(entry.at).toLocaleString()),
        el("span", null, HISTORY_LABEL[entry.event] ?? entry.event),
        // Author history never renders `by`, even if a stale or malformed API
        // response includes it. All human-review decisions stay anonymous.
        entry.minutes != null ? el("span", { class: "muted small" }, ` · ${entry.minutes} min`) : null
      )
    )
  );
  const details = el("details", { class: "my-task-history" });
  details.append(el("summary", null, `History (${entries.length})`), list);
  return details;
}

interface EditFormRefs {
  titleInput: HTMLInputElement;
  reqArea: HTMLTextAreaElement;
  diffSelect: HTMLSelectElement;
  stepRows: { titleInput: HTMLInputElement; area: HTMLTextAreaElement }[];
  appealReasonArea: HTMLTextAreaElement | null;
  payload: () => AuthorEditPayload;
  // Handed back directly rather than re-queried off the form: the step list
  // renders its own ghost buttons ("Remove", "+ Add a step") ahead of the
  // actions row, so a `.btn.ghost` lookup finds a step control, not Cancel.
  submitBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  statusMsg: HTMLElement;
}

interface StringListEditor {
  root: HTMLElement;
  values: () => string[];
}

function renderStringListEditor(
  initial: string[],
  singularLabel: string,
  addLabel: string,
  placeholder: string
): StringListEditor {
  const items = initial.map((item) => String(item));
  const root = el("div", { class: "my-task-list-editor" });
  const draw = () => {
    root.replaceChildren();
    items.forEach((item, index) => {
      const area = el("textarea", {
        class: "textarea my-task-list-item",
        rows: "2",
        "aria-label": `${singularLabel} ${index + 1}`,
        placeholder,
      }) as HTMLTextAreaElement;
      area.value = item;
      area.addEventListener("input", () => {
        items[index] = area.value;
      });
      root.append(
        el(
          "div",
          { class: "my-task-list-row" },
          area,
          el(
            "button",
            {
              class: "btn ghost tiny",
              type: "button",
              "aria-label": `Remove ${singularLabel.toLowerCase()} ${index + 1}`,
              onclick: () => {
                items.splice(index, 1);
                draw();
              },
            },
            "Remove"
          )
        )
      );
    });
    root.append(
      el(
        "button",
        {
          class: "btn ghost small my-task-list-add",
          type: "button",
          onclick: () => {
            items.push("");
            draw();
            root.querySelector<HTMLTextAreaElement>(".my-task-list-row:last-of-type textarea")?.focus();
          },
        },
        addLabel
      )
    );
  };
  draw();
  return {
    root,
    values: () => items.map((item) => item.trim()).filter(Boolean),
  };
}

// Which version the form starts from. An amendment seeds from final gold — the
// author is correcting the reviewer's version, not re-editing their own draft —
// so `final_task` is preferred there and nowhere else.
export function editSeed(fb: MyTaskFeedback, mode: EditMode): MyTaskCurrentContent | null {
  if (mode === "amend" && fb.final_task) return fb.final_task;
  return fb.task ?? null;
}

function renderEditForm(
  item: MyTaskItem,
  fb: MyTaskFeedback,
  mode: Exclude<EditMode, null>
): { wrap: HTMLElement; refs: EditFormRefs } {
  const current = editSeed(fb, mode);
  const fallback = mode === "amend" ? fb.human_review?.final : fb.human_review?.original;
  const steps = (current?.steps ?? fallback?.steps ?? []).map((s) => ({ ...s }));

  const titleInput = el("input", {
    class: "input",
    type: "text",
    value: current?.title ?? fallback?.title ?? item.title,
    "aria-label": "Task title",
  }) as HTMLInputElement;
  const reqArea = el("textarea", {
    class: "textarea",
    rows: "8",
    "aria-label": "Full task request",
  }) as HTMLTextAreaElement;
  reqArea.value = current?.request ?? fallback?.request ?? item.request;
  const diffSelect = el(
    "select",
    { class: "input", "aria-label": "Difficulty" },
    el("option", { value: "low" }, "low"),
    el("option", { value: "medium" }, "medium"),
    el("option", { value: "high" }, "high")
  ) as HTMLSelectElement;
  diffSelect.value = current?.difficulty ?? "high";

  const appealReasonArea = mode === "appeal"
    ? el("textarea", {
        class: "textarea",
        rows: "4",
        maxLength: "2000",
        minLength: String(MIN_APPEAL_REASON_LENGTH),
        required: true,
        "aria-label": "Why should this rejection be reviewed again?",
        placeholder: "Explain what the rejection missed or why the task is valid as written.",
      }) as HTMLTextAreaElement
    : null;

  const criteriaEditor = renderStringListEditor(
    current?.criteria ?? fallback?.criteria ?? [],
    "Success criterion",
    "+ Add success criterion",
    "Describe one condition the completed task must satisfy."
  );
  const outputsEditor = renderStringListEditor(
    current?.required_outputs ?? [],
    "Required output",
    "+ Add required output",
    "Describe one artifact or result the task must produce."
  );
  const urlsEditor = renderStringListEditor(
    current?.must_visit_or_reach ?? [],
    "Required URL or destination",
    "+ Add required URL",
    "https://example.com/path or a named destination"
  );
  const notesArea = el("textarea", {
    class: "textarea",
    rows: "4",
    "aria-label": "Notes",
    placeholder: "Optional context, constraints, or caveats for the task.",
  }) as HTMLTextAreaElement;
  notesArea.value = current?.notes ?? "";

  const stepRows: { titleInput: HTMLInputElement; area: HTMLTextAreaElement }[] = [];
  const stepList = el("div", { class: "rubric-list" });
  const drawSteps = () => {
    stepList.replaceChildren();
    stepRows.length = 0;
    steps.forEach((step, i) => {
      const kindLine = el(
        "p",
        { class: "rubric-kind" },
        `Step ${i + 1}${step.title ? ` · ${step.title}` : ""}`
      );
      const stepTitleInput = el("input", {
        class: "input my-task-step-title",
        type: "text",
        value: step.title,
        placeholder: `Title for step ${i + 1}`,
        "aria-label": `Step ${i + 1} title`,
      }) as HTMLInputElement;
      stepTitleInput.addEventListener("input", () => {
        step.title = stepTitleInput.value;
        kindLine.textContent = `Step ${i + 1}${step.title.trim() ? ` · ${step.title.trim()}` : ""}`;
      });
      const area = el("textarea", {
        class: "rubric-text",
        rows: "2",
        "aria-label": `Step ${i + 1} description`,
      }) as HTMLTextAreaElement;
      area.value = step.description;
      area.addEventListener("input", () => {
        step.description = area.value;
        area.style.height = "auto";
        area.style.height = `${Math.max(60, area.scrollHeight + 2)}px`;
      });
      requestAnimationFrame(() => {
        area.style.height = "auto";
        area.style.height = `${Math.max(60, area.scrollHeight + 2)}px`;
      });
      stepRows.push({ titleInput: stepTitleInput, area });
      stepList.append(
        el(
          "div",
          { class: "rubric-row" },
          el("span", { class: "rubric-num mono" }, `S${i + 1}`),
          el(
            "div",
            { class: "rubric-content" },
            kindLine,
            el(
              "label",
              { class: "my-task-step-title-field" },
              el("span", { class: "field-label" }, "Step title"),
              stepTitleInput
            ),
            el("span", { class: "field-label" }, "Step description"),
            area,
            el(
              "button",
              {
                class: "btn ghost tiny",
                type: "button",
                onclick: () => {
                  steps.splice(i, 1);
                  drawSteps();
                },
              },
              "Remove"
            )
          )
        )
      );
    });
    stepList.append(
      el(
        "button",
        {
          class: "btn ghost small",
          type: "button",
          onclick: () => {
            steps.push({ order: steps.length + 1, title: "", description: "" });
            drawSteps();
          },
        },
        "+ Add a step"
      )
    );
  };
  drawSteps();

  const payload = (): AuthorEditPayload => ({
    task_title: titleInput.value.trim(),
    agent_request: reqArea.value.trim(),
    difficulty: diffSelect.value,
    success_criteria: criteriaEditor.values(),
    steps: steps.map((s, i) => ({ order: i + 1, title: s.title, description: s.description.trim() })),
    must_visit_or_reach: urlsEditor.values(),
    required_outputs: outputsEditor.values(),
    notes: notesArea.value.trim() || null,
    metadata: current?.metadata,
  });

  const submitLabel =
    mode === "amend" ? "Save as the final version" : mode === "appeal" ? "Send back for another review" : "Submit edit";
  const submitBtn = el("button", { class: "btn primary", type: "button" }, submitLabel) as HTMLButtonElement;
  const cancelBtn = el("button", { class: "btn ghost", type: "button" }, "Cancel") as HTMLButtonElement;
  const statusMsg = el("p", { class: "muted small" });

  const heading =
    mode === "amend" ? "Edit the final version" : mode === "appeal" ? "Revise and appeal" : "Edit your task";
  const hint =
    mode === "amend"
      ? "You're editing the reviewer's approved version. What you save here becomes the final version of this task — it does not go back through review."
      : mode === "appeal"
        ? "This is your one appeal. Address the rejection, then send it back — a different reviewer will look at it, and Codex will re-audit first."
        : "Rewrite any step the Codex check or reviewer flagged, then submit. Codex will re-audit the new version.";

  const wrap = el(
    "div",
    { class: "my-task-edit" },
    el("h4", null, heading),
    ...(appealReasonArea
      ? [
          el(
            "div",
            { class: "field" },
            el("span", { class: "field-label" }, "Why should this be reviewed again?"),
            el(
              "p",
              { class: "field-hint" },
              `This goes to the fresh reviewer. Explain what the first decision missed (${MIN_APPEAL_REASON_LENGTH} characters minimum).`
            ),
            appealReasonArea
          ),
        ]
      : []),
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-label" }, "Task title"),
      titleInput
    ),
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-label" }, "Full task request"),
      reqArea
    ),
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-label" }, "Difficulty"),
      diffSelect
    ),
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-label" }, "Success criteria"),
      el("p", { class: "field-hint" }, "Add, remove, or rewrite the conditions that define a successful result."),
      criteriaEditor.root
    ),
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-label" }, "Steps"),
      el("p", { class: "field-hint" }, hint),
      stepList
    ),
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-label" }, "Required outputs"),
      el("p", { class: "field-hint" }, "List the concrete artifacts or results the task must produce."),
      outputsEditor.root
    ),
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-label" }, "Required URLs or destinations"),
      el("p", { class: "field-hint" }, "List any exact pages, URLs, or destinations the task must reach."),
      urlsEditor.root
    ),
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-label" }, "Notes"),
      el("p", { class: "field-hint" }, "Optional context, constraints, or caveats that should travel with the task."),
      notesArea
    ),
    el("div", { class: "form-actions" }, cancelBtn, submitBtn),
    statusMsg
  );

  return {
    wrap,
    refs: { titleInput, reqArea, diffSelect, stepRows, appealReasonArea, payload, submitBtn, cancelBtn, statusMsg },
  };
}

function renderFeedback(
  ctx: Ctx,
  item: MyTaskItem,
  fb: MyTaskFeedback,
  reloadList: () => void,
  openedAt: string
): HTMLElement {
  const wrap = el("div", { class: "my-task-feedback" });
  const mode = editModeFor(item);
  let editOpen = false;
  let formRefs: EditFormRefs | null = null;
  let editWrap: HTMLElement | null = null;
  // When the author opened the form, so the server can record how long the
  // revision took. Separate from openedAt, which times the whole sign-off.
  let editStartedAt = "";

  const draw = () => {
    wrap.replaceChildren();
    const approved = fb.status === "approved" || item.status === "approved";
    if (approved && fb.human_review) {
      wrap.append(reviewOutcomeLine(fb.human_review));
      wrap.append(renderDiff(fb.human_review));
    } else {
      wrap.append(readOnlyTask(item, fb));
    }

    const notice = statusNotice(item, fb);
    if (notice) wrap.append(notice);

    const rejectNotes = rejectionFeedback(fb);
    if (rejectNotes) wrap.append(rejectNotes);

    const onApplyTask = editOpen && formRefs ? (text: string) => {
      const refs = formRefs!;
      refs.reqArea.value = text;
      refs.reqArea.style.height = "auto";
      refs.reqArea.style.height = `${Math.max(120, refs.reqArea.scrollHeight + 2)}px`;
    } : undefined;
    wrap.append(
      renderLlmPanel({
        review: fb.review,
        status: panelStatus(fb),
        onApplyTaskSuggestion: onApplyTask,
      })
    );

    if (fb.review) {
      // Resolve by rubric id, not array position: the review's rubric list is
      // neither dense nor ordered, so `rubrics[i]` is not step i.
      const onApplyRubric = editOpen && formRefs ? (rubricId: string, text: string) => {
        const row = formRefs!.stepRows[stepNumberFromRubricId(rubricId, -1) - 1];
        if (!row) return;
        row.area.value = text;
        row.area.dispatchEvent(new Event("input"));
      } : undefined;
      wrap.append(renderLlmRubricList(fb.review, onApplyRubric));
    }

    const history = historyPanel(fb);
    if (history) wrap.append(history);

    if (editOpen && formRefs && editWrap) {
      wrap.append(editWrap);
      return;
    }

    const actions: HTMLElement[] = [];
    // An approved task the author hasn't acknowledged yet: accept the
    // reviewer's version, or take it over and make their own version final.
    if (approved && item.needs_signoff) {
      const acceptBtn = el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: async () => {
            if (!ctx.state.reviewKey || !ctx.state.identity) return;
            acceptBtn.disabled = true;
            acceptBtn.textContent = "Saving…";
            try {
              await authorSignoff(
                ctx.state.reviewKey,
                schemaParticipantId(ctx.state.identity),
                item.sub_key,
                openedAt
              );
              ctx.actions.notifyInfo("Signed off — thanks. That task is done.");
              reloadList();
            } catch (err) {
              acceptBtn.disabled = false;
              acceptBtn.textContent = "Looks good — accept";
              ctx.actions.notifyError(err instanceof Error ? err.message : String(err));
            }
          },
        },
        "Looks good — accept"
      ) as HTMLButtonElement;
      actions.push(acceptBtn);
    }
    if (mode) {
      actions.push(
        el(
          "button",
          {
            class: approved && item.needs_signoff ? "btn ghost" : "btn primary",
            type: "button",
            onclick: () => {
              editOpen = true;
              editStartedAt = new Date().toISOString();
              const built = renderEditForm(item, fb, mode);
              formRefs = built.refs;
              editWrap = built.wrap;
              wireSubmit(built.refs, mode);
              draw();
            },
          },
          EDIT_BUTTON_LABEL[mode]
        )
      );
    }
    if (actions.length) wrap.append(el("div", { class: "form-actions" }, ...actions));
  };

  const wireSubmit = (refs: EditFormRefs, editMode: Exclude<EditMode, null>) => {
    const { submitBtn, cancelBtn, statusMsg } = refs;
    const originalLabel = submitBtn.textContent ?? "Submit";
    submitBtn.addEventListener("click", async () => {
      if (!ctx.state.reviewKey || !ctx.state.identity) return;
      const appealReason = refs.appealReasonArea?.value.trim() ?? "";
      if (editMode === "appeal" && appealReason.length < MIN_APPEAL_REASON_LENGTH) {
        statusMsg.textContent = `Explain why this should be reviewed again (${MIN_APPEAL_REASON_LENGTH} characters minimum).`;
        refs.appealReasonArea?.focus();
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting…";
      statusMsg.textContent = "";
      try {
        const pid = schemaParticipantId(ctx.state.identity);
        if (editMode === "amend") {
          await authorAmend(ctx.state.reviewKey, pid, item.sub_key, refs.payload(), openedAt);
          ctx.actions.notifyInfo("Saved — your version is now the final one.");
        } else {
          await authorEdit(
            ctx.state.reviewKey,
            pid,
            item.sub_key,
            refs.payload(),
            editStartedAt,
            editMode === "appeal" ? appealReason : null
          );
          ctx.actions.notifyInfo(
            editMode === "appeal"
              ? "Appeal sent — a different reviewer will take a fresh look once Codex re-audits it."
              : "Re-checking your edit — Codex will re-audit this version."
          );
        }
        editOpen = false;
        formRefs = null;
        editWrap = null;
        reloadList();
      } catch (err) {
        // Keep the form and the reason on screen. Reloading the list here
        // would rebuild every row collapsed and take the message with it —
        // which is exactly the case where the server's reason matters ("a
        // reviewer has claimed this task", "this task is finished").
        statusMsg.textContent = err instanceof Error ? err.message : String(err);
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      }
    });
    cancelBtn.addEventListener("click", () => {
      editOpen = false;
      formRefs = null;
      editWrap = null;
      draw();
    });
  };

  draw();
  return wrap;
}

// What the author did about the review, once they have done it. Without this
// the row looks identical before and after signing off.
export function signoffSuffix(item: MyTaskItem): string {
  if (!item.signed_off_at) return "";
  const when = new Date(item.signed_off_at).toLocaleDateString();
  return item.signoff_action === "amended"
    ? ` · you made your own version final on ${when}`
    : ` · you accepted it on ${when}`;
}

function taskRow(
  ctx: Ctx,
  item: MyTaskItem,
  reloadList: () => void,
  openTask: () => void
): HTMLElement {
  const when = item.submitted_at ? new Date(item.submitted_at).toLocaleDateString() : "—";
  const reasonLine =
    item.status === "rejected" && item.rejection_reason
      ? item.rejection_reason
      : item.status === "returned" && item.returned_reason
        ? item.returned_reason
        : item.status === "approved"
          ? `Approved${item.reviewer_changed === false ? " · unchanged" : ""}${signoffSuffix(item)}`
          : null;
  const detail = el("details", { class: "admin-submission my-task-row" });
  detail.append(
    el(
      "summary",
      {
        class: "admin-submission-summary",
        onclick: (event: MouseEvent) => {
          // A task gets the whole screen. Prevent the native details toggle so
          // a long editor never expands inside a high-volume worklist.
          event.preventDefault();
          openTask();
        },
      },
      el(
        "span",
        { class: "admin-summary-main" },
        el("strong", null, item.title || "Untitled task"),
        el("small", null, reasonLine ?? STATUS_LABEL[item.status])
      ),
      statusBadge(item.status),
      el("span", { class: "muted mono admin-date" }, when),
      el("span", { class: "admin-chevron my-task-open-arrow", "aria-hidden": "true" }, "→")
    )
  );
  const detailBody = el("div", { class: "admin-submission-detail" });
  detail.append(detailBody);
  let loaded = false;
  detail.addEventListener("toggle", () => {
    if (!detail.open || loaded) return;
    loaded = true;
    // Stamped when the author opens the task, and sent with whatever they do
    // next. The server pairs it with its own completion stamp; a duration is
    // never taken from the client.
    void loadFeedback(ctx, item, detailBody, reloadList, new Date().toISOString());
  });
  return detail;
}

async function loadFeedback(
  ctx: Ctx,
  item: MyTaskItem,
  container: HTMLElement,
  reloadList: () => void,
  openedAt: string
): Promise<void> {
  if (!ctx.state.reviewKey || !ctx.state.identity) return;
  container.replaceChildren(el("p", { class: "muted" }, "Loading feedback…"));
  try {
    const fb = await myTaskFeedback(ctx.state.reviewKey, schemaParticipantId(ctx.state.identity), item.sub_key);
    container.replaceChildren(renderFeedback(ctx, item, fb, reloadList, openedAt));
  } catch (err) {
    container.replaceChildren(
      el("p", { class: "muted" }, `Couldn't load feedback: ${err instanceof Error ? err.message : String(err)}`),
      el(
        "button",
        {
          class: "btn ghost small",
          type: "button",
          onclick: () => void loadFeedback(ctx, item, container, reloadList, openedAt),
        },
        "Retry"
      )
    );
  }
}

function sectionHead(title: string, count: number, sub: string): HTMLElement {
  return el(
    "header",
    { class: "my-tasks-section-head" },
    el("h3", null, title, el("span", { class: "muted mono" }, ` ${count}`)),
    el("p", { class: "field-hint" }, sub)
  );
}

// How far through the sign-off backlog the author is. Counted over all their
// tasks, not the page on screen, so paging doesn't move the number around.
export function signoffProgress(approvedTotal: number, awaiting: number): string {
  const done = Math.max(0, approvedTotal - awaiting);
  return `${done} of ${approvedTotal} signed off`;
}

export function renderMyTasks(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const root = el("section", { class: "screen my-tasks-screen" });
  root.append(
    el(
      "header",
      { class: "screen-head" },
      el("h2", { class: "display" }, "My tasks"),
      el(
        "p",
        { class: "screen-sub" },
        "Track your submissions, see Codex feedback and reviewer notes, sign off on approved tasks, and revise anything still open."
      )
    )
  );

  const body = el("div", { class: "my-tasks-body" });
  root.append(body);

  if (!state.identity || !state.reviewKey) {
    body.append(el("p", { class: "muted" }, state.identity ? "Reviewing isn't enabled in this build." : "Sign in to see your tasks."));
    root.append(backHome(ctx));
    return root;
  }

  const authorPid = schemaParticipantId(state.identity);
  const remembered = myTasksViewByParticipant.get(authorPid) ?? {
    offset: 0,
    query: "",
    filter: "all" as MyTaskFilter,
    sort: "newest" as MyTaskSort,
    scrollTop: 0,
  };
  let offset = remembered.offset;
  let query = remembered.query;
  let filter: MyTaskFilter = remembered.filter;
  let sort: MyTaskSort = remembered.sort;
  let scrollTop = remembered.scrollTop;

  const rememberView = () => {
    myTasksViewByParticipant.set(authorPid, { offset, query, filter, sort, scrollTop });
  };

  const rememberScroll = () => {
    scrollTop = Math.max(document.documentElement.scrollTop, document.body.scrollTop, window.scrollY || 0);
    rememberView();
  };

  const restoreScroll = () => {
    if (!scrollTop) return;
    requestAnimationFrame(() => {
      document.documentElement.scrollTop = scrollTop;
      document.body.scrollTop = scrollTop;
    });
  };

  const reloadList = () => {
    rememberScroll();
    void refresh(true);
  };

  const openTask = (item: MyTaskItem) => {
    rememberScroll();
    state.myTaskSelection = item;
    ctx.actions.goto("my-task");
  };

  const refresh = async (quiet = false) => {
    if (!state.reviewKey || !state.identity) return;
    if (!quiet) body.replaceChildren(el("p", { class: "muted status-line" }, "Loading your tasks…"));
    try {
      const page = await myTaskPage(
        state.reviewKey,
        authorPid,
        offset,
        PAGE_SIZE
      );
      if (page.source_total > 0 && page.items.length === 0 && offset > 0) {
        offset = Math.floor((page.source_total - 1) / PAGE_SIZE) * PAGE_SIZE;
        scrollTop = 0;
        rememberView();
        await refresh(quiet);
        return;
      }
      if (!page.source_total) {
        body.replaceChildren(el("p", { class: "muted" }, "You haven't submitted any tasks yet."));
        return;
      }

      const searchInput = el("input", {
        class: "input my-tasks-search",
        type: "search",
        value: query,
        placeholder: "Search titles, requests, or feedback",
        "aria-label": "Search my tasks",
      }) as HTMLInputElement;
      const filterSelect = el(
        "select",
        { class: "input", "aria-label": "Filter tasks" },
        el("option", { value: "all" }, "All statuses"),
        el("option", { value: "action" }, "Needs my action"),
        el("option", { value: "in_progress" }, "In progress"),
        el("option", { value: "approved" }, "Approved"),
        el("option", { value: "rejected" }, "Rejected"),
        el("option", { value: "returned" }, "Returned")
      ) as HTMLSelectElement;
      filterSelect.value = filter;
      const sortSelect = el(
        "select",
        { class: "input", "aria-label": "Sort tasks" },
        el("option", { value: "newest" }, "Newest first"),
        el("option", { value: "oldest" }, "Oldest first"),
        el("option", { value: "status" }, "Action and status")
      ) as HTMLSelectElement;
      sortSelect.value = sort;
      const clearFilters = el("button", { class: "btn ghost small", type: "button" }, "Clear filters") as HTMLButtonElement;
      const controls = el(
        "section",
        { class: "my-tasks-controls", "aria-label": "Find and filter tasks" },
        el(
          "label",
          { class: "my-tasks-search-field" },
          el("span", { class: "field-label" }, "Find a task"),
          searchInput
        ),
        el("label", null, el("span", { class: "field-label" }, "Status"), filterSelect),
        el("label", null, el("span", { class: "field-label" }, "Sort"), sortSelect),
        clearFilters
      );
      const results = el("div", { class: "my-tasks-results" });
      body.replaceChildren(controls, results);

      const filtersActive = () => Boolean(query.trim() || filter !== "all" || sort !== "newest");
      const clear = () => {
        query = "";
        filter = "all";
        sort = "newest";
        searchInput.value = "";
        filterSelect.value = filter;
        sortSelect.value = sort;
        rememberView();
        drawResults();
        searchInput.focus();
      };
      const drawResults = () => {
        results.replaceChildren();
        clearFilters.hidden = !filtersActive();
        const visible = filterAndSortMyTasks(page.items, query, filter, sort);
        if (!visible.length) {
          results.append(
            el(
              "div",
              { class: "my-tasks-empty" },
              el("h3", null, "No tasks match"),
              el("p", { class: "muted" }, "Try a different search or clear the filters to see your submissions."),
              el("button", { class: "btn ghost", type: "button", onclick: clear }, "Clear filters")
            )
          );
          return;
        }

        const awaiting = visible.filter((item) => item.needs_signoff);
        const rest = visible.filter((item) => !item.needs_signoff);
        const active = filtersActive();
        if (awaiting.length || (!active && page.awaiting_signoff_total > 0)) {
          const section = el("section", { class: "my-tasks-section needs-signoff" });
          section.append(
            sectionHead(
              "Needs your sign-off",
              active ? awaiting.length : page.awaiting_signoff_total,
              "A reviewer approved these. Check what changed, then accept it or make your own version final."
            ),
            el("p", { class: "my-tasks-progress mono" }, signoffProgress(page.approved_total, page.awaiting_signoff_total))
          );
          if (awaiting.length) {
            section.append(...awaiting.map((item) => taskRow(ctx, item, reloadList, () => openTask(item))));
          } else {
            section.append(
              el(
                "p",
                { class: "muted" },
                `None on this page. Your ${page.awaiting_signoff_total} outstanding ${page.awaiting_signoff_total === 1 ? "task is" : "tasks are"} on another page — use Newer and Older below to reach them.`
              )
            );
          }
          results.append(section);
        }

        if (rest.length || !active) {
          const restSection = el("section", { class: "my-tasks-section" });
          restSection.append(
            sectionHead(
              "All submissions",
              active ? rest.length : page.source_total - page.awaiting_signoff_total,
              active
                ? "Submissions matching your current search, status, and sort choices."
                : page.awaiting_signoff_total
                  ? "Everything else you've submitted — the ones waiting on you are listed above."
                  : "Everything you've submitted."
            ),
            ...rest.map((item) => taskRow(ctx, item, reloadList, () => openTask(item)))
          );
          results.append(restSection);
        }

        const lastPage = offset + page.limit >= page.source_total;
        if (offset > 0 || !lastPage) {
          const shownTo = Math.min(offset + page.limit, page.source_total);
          results.append(
            el(
              "div",
              { class: "form-actions my-tasks-pager" },
              el(
                "button",
                {
                  class: "btn ghost",
                  type: "button",
                  disabled: offset === 0,
                  onclick: () => {
                    offset = Math.max(0, offset - PAGE_SIZE);
                    scrollTop = 0;
                    rememberView();
                    void refresh();
                  },
                },
                "← Newer"
              ),
              el("span", { class: "muted mono" }, `${offset + 1}–${shownTo} of ${page.source_total}`),
              el(
                "button",
                {
                  class: "btn ghost",
                  type: "button",
                  disabled: lastPage,
                  onclick: () => {
                    offset += PAGE_SIZE;
                    scrollTop = 0;
                    rememberView();
                    void refresh();
                  },
                },
                "Older →"
              )
            )
          );
        }
      };

      searchInput.addEventListener("input", () => {
        query = searchInput.value;
        rememberView();
        drawResults();
      });
      filterSelect.addEventListener("change", () => {
        filter = filterSelect.value as MyTaskFilter;
        rememberView();
        drawResults();
      });
      sortSelect.addEventListener("change", () => {
        sort = sortSelect.value as MyTaskSort;
        rememberView();
        drawResults();
      });
      clearFilters.addEventListener("click", clear);
      drawResults();
      rememberView();
      restoreScroll();
    } catch (err) {
      body.replaceChildren(
        el("p", { class: "muted" }, `Couldn't load your tasks: ${err instanceof Error ? err.message : String(err)}`),
        el(
          "button",
          {
            class: "btn ghost",
            type: "button",
            onclick: () => void refresh(),
          },
          "Retry"
        )
      );
    }
  };

  void refresh();

  root.append(backHome(ctx));
  return root;
}

// A single author task gets a dedicated page. The list row intentionally
// carries only compact status metadata; the complete authored task, human
// diff, anonymous feedback, history, and editor load here on demand.
export function renderMyTask(ctx: Ctx): HTMLElement {
  const item = ctx.state.myTaskSelection;
  const root = el("section", { class: "screen my-task-detail-screen" });
  const back = el(
    "button",
    { class: "btn ghost small my-task-detail-back", type: "button", onclick: () => ctx.actions.goto("my-tasks") },
    "← Back to My Tasks"
  );
  root.append(back);

  if (!item || !ctx.state.identity || !ctx.state.reviewKey) {
    root.append(
      el("h2", { class: "display" }, "Task unavailable"),
      el("p", { class: "muted" }, "Return to My Tasks and choose a submission to open.")
    );
    return root;
  }

  const when = item.submitted_at ? new Date(item.submitted_at).toLocaleDateString() : "—";
  root.append(
    el(
      "header",
      { class: "my-task-detail-head" },
      el(
        "div",
        { class: "my-task-detail-title" },
        el("p", { class: "eyebrow" }, "My task"),
        el("h2", { class: "display" }, item.title || "Untitled task"),
        el("p", { class: "screen-sub" }, item.request || "Open the task below to review its complete content and feedback.")
      ),
      el(
        "div",
        { class: "my-task-detail-meta" },
        statusBadge(item.status),
        el("span", { class: "muted mono" }, `Submitted ${when}`)
      )
    )
  );

  const body = el(
    "div",
    { class: "my-task-detail-body" },
    el("p", { class: "muted status-line" }, "Loading task and feedback…")
  );
  root.append(body);
  const finishAndReturn = () => {
    ctx.state.myTaskSelection = null;
    ctx.actions.goto("my-tasks");
  };
  void loadFeedback(ctx, item, body, finishAndReturn, new Date().toISOString());
  return root;
}

function backHome(ctx: Ctx): HTMLElement {
  return el(
    "div",
    { class: "form-actions" },
    el("button", { class: "btn ghost", type: "button", onclick: () => ctx.actions.goto("home") }, "Back to home")
  );
}
