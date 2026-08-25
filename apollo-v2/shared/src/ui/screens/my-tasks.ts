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
import { alignCriteria, alignSteps, summarizeChanges, type StepDiffRow } from "../../diff";
import { redlineBlock, redlineNodes } from "../components/redline";

const PAGE_SIZE = 50;

// Unified redline or the old two-column view. Module-scoped on purpose: an
// author works down a queue of approvals, so the choice should hold across rows
// for the session. Nothing in shared/src uses localStorage and this is not the
// place to start.
type DiffView = "unified" | "split";
let diffView: DiffView = "unified";

/** Reset hook: the view is module state, so tests must not inherit it. */
export function setDiffView(view: DiffView): void {
  diffView = view;
}

const STATUS_LABEL: Record<MyTaskStatus, string> = {
  awaiting_codex: "Awaiting Codex",
  pending: "Pending",
  in_review: "In review",
  approved: "Approved",
  rejected: "Rejected",
  returned: "Returned",
};

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

// The original two-column view. Named for what it actually does — it renders
// two whole snapshots and diffs nothing — now that a real diff sits beside it.
function renderSplitSnapshots(hr: MyTaskHumanReview): HTMLElement {
  const finalLabel = hr.amended_by
    ? "Final gold · your amendment"
    : hr.changed === false
      ? "Final gold · unchanged"
      : "Final gold version";
  return el(
    "div",
    { class: "admin-snapshots has-final my-task-diff" },
    diffSnapshot(hr.title_edited || hr.request_edited ? "Your original" : "Your submission", hr.original),
    diffSnapshot(finalLabel, hr.final, "final")
  );
}

const ROW_CHIP: Record<Exclude<StepDiffRow["status"], "unchanged">, string> = {
  changed: "edited",
  added: "added",
  removed: "removed",
};

function redlineRow(row: StepDiffRow, index: number): HTMLElement {
  // Untouched rows fold away. On the common approval — one step edited out of
  // ten — this is the difference between a screenful and a scroll.
  if (row.status === "unchanged") {
    return el(
      "li",
      { class: "my-task-redline-row is-unchanged" },
      el(
        "details",
        { class: "redline-unchanged" },
        el(
          "summary",
          null,
          el("span", { class: "rubric-num mono" }, String(index + 1)),
          el("strong", null, row.title),
          el("span", { class: "muted small" }, "unchanged")
        ),
        el("p", { class: "redline-text" }, row.after ?? "")
      )
    );
  }

  const body: (HTMLElement | string)[] =
    row.status === "removed"
      ? [el("del", { class: "redline-del" }, row.before ?? "")]
      : row.status === "added"
        ? [el("ins", { class: "redline-ins" }, row.after ?? "")]
        : redlineNodes(row.before ?? "", row.after ?? "");

  return el(
    "li",
    { class: `my-task-redline-row is-${row.status}` },
    el(
      "div",
      { class: "my-task-redline-head" },
      el("span", { class: "rubric-num mono" }, String(index + 1)),
      el("strong", null, row.title),
      el("span", { class: `chip tag redline-chip is-${row.status}` }, ROW_CHIP[row.status])
    ),
    el("p", { class: "redline-text" }, ...body)
  );
}

function redlineSection(heading: string, rows: StepDiffRow[]): HTMLElement | null {
  if (!rows.length) return null;
  return el(
    "div",
    { class: "my-task-redline-section" },
    el("h6", null, heading),
    el("ol", { class: "my-task-redline-list" }, ...rows.map(redlineRow))
  );
}

// One sentence naming what moved, so the author knows what to look for before
// they start reading.
function changeSummaryLine(hr: MyTaskHumanReview): string {
  const summary = summarizeChanges(hr);
  const parts: string[] = [];
  if (summary.titleChanged) parts.push("the title");
  if (summary.requestChanged) parts.push("the request");
  if (summary.stepsChanged) {
    parts.push(`${summary.stepsChanged} of ${summary.stepsTotal} ${summary.stepsTotal === 1 ? "step" : "steps"}`);
  }
  if (summary.criteriaChanged) {
    parts.push(`${summary.criteriaChanged} success ${summary.criteriaChanged === 1 ? "criterion" : "criteria"}`);
  }
  if (!parts.length) return "Nothing changed.";
  const listed = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Changed: ${listed}.`;
}

function renderUnifiedRedline(hr: MyTaskHumanReview): HTMLElement {
  const summary = summarizeChanges(hr);

  // An untouched approval used to render two identical columns. There is
  // nothing to compare, so show the task once and say so.
  if (!summary.anyChange) {
    return el(
      "div",
      { class: "my-task-redline-wrap" },
      el("p", { class: "notice ok my-task-redline-none" }, "Approved as you wrote it — the reviewer changed nothing."),
      diffSnapshot("Final gold · unchanged", hr.final, "final")
    );
  }

  // After an amendment this is no longer purely the reviewer's doing: the
  // frozen review block is never rewritten, so original → final now spans the
  // author's own edit too. Say that rather than implying the reviewer did it.
  const heading = hr.amended_by ? "Your original vs the current final gold" : "What the reviewer changed";
  const note = hr.amended_by
    ? "This includes your own amendment, not just the reviewer's edits."
    : null;

  return el(
    "div",
    { class: "my-task-redline-wrap" },
    el(
      "section",
      { class: "admin-snapshot my-task-redline" },
      el("div", { class: "admin-snapshot-head" }, el("h5", null, heading)),
      el("p", { class: "field-hint" }, changeSummaryLine(hr)),
      note ? el("p", { class: "muted small" }, note) : null,
      redlineBlock("Title", hr.original.title || "", hr.final.title || ""),
      redlineBlock("Request", hr.original.request || "", hr.final.request || ""),
      redlineSection("Success criteria", alignCriteria(hr)),
      redlineSection("Steps", alignSteps(hr))
    )
  );
}

function diffViewToggle(onPick: () => void): HTMLElement {
  const button = (view: DiffView, label: string) =>
    el(
      "button",
      {
        class: `btn ghost tiny ${diffView === view ? "active" : ""}`.trim(),
        type: "button",
        "aria-pressed": diffView === view ? "true" : "false",
        onclick: () => {
          if (diffView === view) return;
          diffView = view;
          onPick();
        },
      },
      label
    );
  return el(
    "div",
    { class: "my-task-diff-toggle" },
    el("span", { class: "muted small" }, "View"),
    button("unified", "Redline"),
    button("split", "Side-by-side")
  );
}

export function renderVersionPanel(hr: MyTaskHumanReview, onToggle: () => void): HTMLElement {
  return el(
    "div",
    { class: "my-task-versions" },
    diffViewToggle(onToggle),
    diffView === "unified" ? renderUnifiedRedline(hr) : renderSplitSnapshots(hr)
  );
}

// Who reviewed an approved task. Named on purpose: the author should be able to
// go and ask them about the edit. Rejections never reach this path — that
// feedback stays anonymous.
function reviewerLine(hr: MyTaskHumanReview): HTMLElement | null {
  if (!hr.reviewed_by) return null;
  return el(
    "p",
    { class: "my-task-reviewer" },
    el("span", { class: "chip tag review-chip" }, "reviewed by"),
    el("strong", null, hr.reviewed_by),
    hr.changed === false
      ? el("span", { class: "muted" }, " — approved as you wrote it, nothing changed.")
      : el("span", { class: "muted" }, " — reach out to them if you disagree with an edit.")
  );
}

function readOnlyTask(item: MyTaskItem, fb: MyTaskFeedback): HTMLElement {
  const snap = snapshotFromItem(item, fb);
  if (!snap) return el("p", { class: "muted" }, "No task content available.");
  return diffSnapshot("Your task", snap);
}

function statusNotice(item: MyTaskItem, fb: MyTaskFeedback): HTMLElement | null {
  if (item.status === "rejected" || fb.status === "rejected") {
    const canAppeal = item.can_appeal !== false;
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
        entry.by ? el("strong", null, ` ${entry.by}`) : null,
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
  stepRows: { title: string; area: HTMLTextAreaElement }[];
  payload: () => AuthorEditPayload;
  // Handed back directly rather than re-queried off the form: the step list
  // renders its own ghost buttons ("Remove", "+ Add a step") ahead of the
  // actions row, so a `.btn.ghost` lookup finds a step control, not Cancel.
  submitBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  statusMsg: HTMLElement;
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

  const stepRows: { title: string; area: HTMLTextAreaElement }[] = [];
  const stepList = el("div", { class: "rubric-list" });
  const drawSteps = () => {
    stepList.replaceChildren();
    stepRows.length = 0;
    steps.forEach((step, i) => {
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
      stepRows.push({ title: step.title, area });
      stepList.append(
        el(
          "div",
          { class: "rubric-row" },
          el("span", { class: "rubric-num mono" }, `S${i + 1}`),
          el(
            "div",
            { class: "rubric-content" },
            el("p", { class: "rubric-kind" }, `Step ${i + 1}${step.title ? ` · ${step.title}` : ""}`),
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
            steps.push({ order: steps.length + 1, title: `Step ${steps.length + 1}`, description: "" });
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
    success_criteria: current?.criteria ?? fallback?.criteria ?? [],
    steps: steps.map((s, i) => ({ order: i + 1, title: s.title, description: s.description.trim() })),
    must_visit_or_reach: current?.must_visit_or_reach ?? [],
    required_outputs: current?.required_outputs ?? [],
    notes: current?.notes ?? null,
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
      el("span", { class: "field-label" }, "Steps"),
      el("p", { class: "field-hint" }, hint),
      stepList
    ),
    el("div", { class: "form-actions" }, cancelBtn, submitBtn),
    statusMsg
  );

  return {
    wrap,
    refs: { titleInput, reqArea, diffSelect, stepRows, payload, submitBtn, cancelBtn, statusMsg },
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
      const line = reviewerLine(fb.human_review);
      if (line) wrap.append(line);
      wrap.append(renderVersionPanel(fb.human_review, draw));
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
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting…";
      statusMsg.textContent = "";
      try {
        const pid = schemaParticipantId(ctx.state.identity);
        if (editMode === "amend") {
          await authorAmend(ctx.state.reviewKey, pid, item.sub_key, refs.payload(), openedAt);
          ctx.actions.notifyInfo("Saved — your version is now the final one.");
        } else {
          await authorEdit(ctx.state.reviewKey, pid, item.sub_key, refs.payload(), editStartedAt);
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

function taskRow(ctx: Ctx, item: MyTaskItem, reloadList: () => void): HTMLElement {
  const when = item.submitted_at ? new Date(item.submitted_at).toLocaleDateString() : "—";
  const reasonLine =
    item.status === "rejected" && item.rejection_reason
      ? item.rejection_reason
      : item.status === "returned" && item.returned_reason
        ? item.returned_reason
        : item.status === "approved" && item.reviewed_by
          ? `Reviewed by ${item.reviewed_by}${item.reviewer_changed === false ? " · unchanged" : ""}${signoffSuffix(item)}`
          : null;
  const detail = el("details", { class: "admin-submission my-task-row" });
  detail.append(
    el(
      "summary",
      { class: "admin-submission-summary" },
      el(
        "span",
        { class: "admin-summary-main" },
        el("strong", null, item.title || "Untitled task"),
        el("small", null, reasonLine ?? STATUS_LABEL[item.status])
      ),
      statusBadge(item.status),
      el("span", { class: "muted mono admin-date" }, when),
      el("span", { class: "admin-chevron", "aria-hidden": "true" }, "▾")
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
  const root = el("section", { class: "screen narrow my-tasks-screen" });
  root.append(
    el(
      "header",
      { class: "screen-head" },
      el("h2", { class: "display" }, "My tasks"),
      el(
        "p",
        { class: "screen-sub" },
        "Track your submissions, see Codex feedback and reviewer notes, sign off on the tasks a reviewer edited, and revise anything still open."
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

  let offset = 0;

  const reloadList = () => {
    void refresh();
  };

  const refresh = async () => {
    if (!state.reviewKey || !state.identity) return;
    body.replaceChildren(el("p", { class: "muted status-line" }, "Loading your tasks…"));
    try {
      const page = await myTaskPage(
        state.reviewKey,
        schemaParticipantId(state.identity),
        offset,
        PAGE_SIZE
      );
      body.replaceChildren();
      if (!page.source_total) {
        body.append(el("p", { class: "muted" }, "You haven't submitted any tasks yet."));
        return;
      }

      const awaiting = page.items.filter((item) => item.needs_signoff);
      const rest = page.items.filter((item) => !item.needs_signoff);

      if (page.awaiting_signoff_total > 0) {
        const section = el("section", { class: "my-tasks-section needs-signoff" });
        section.append(
          sectionHead(
            "Needs your sign-off",
            page.awaiting_signoff_total,
            "A reviewer approved these. Check what changed, then accept it or make your own version final."
          ),
          el("p", { class: "my-tasks-progress mono" }, signoffProgress(page.approved_total, page.awaiting_signoff_total))
        );
        if (awaiting.length) {
          section.append(...awaiting.map((item) => taskRow(ctx, item, reloadList)));
        } else {
          section.append(
            el(
              "p",
              { class: "muted" },
              `None on this page. Your ${page.awaiting_signoff_total} outstanding ${page.awaiting_signoff_total === 1 ? "task is" : "tasks are"} on another page — use Newer and Older below to reach them.`
            )
          );
        }
        body.append(section);
      }

      const restSection = el("section", { class: "my-tasks-section" });
      restSection.append(
        sectionHead(
          "All submissions",
          // Counts what this section actually lists across every page: the
          // sign-off queue above is not repeated here, so source_total would
          // never match the rows underneath it.
          page.source_total - page.awaiting_signoff_total,
          page.awaiting_signoff_total
            ? "Everything else you've submitted, newest first — the ones waiting on you are listed above."
            : "Everything you've submitted, newest first."
        ),
        ...rest.map((item) => taskRow(ctx, item, reloadList))
      );
      body.append(restSection);

      const lastPage = offset + page.limit >= page.source_total;
      if (offset > 0 || !lastPage) {
        const shownTo = Math.min(offset + page.limit, page.source_total);
        body.append(
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
                  void refresh();
                },
              },
              "Older →"
            )
          )
        );
      }
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

function backHome(ctx: Ctx): HTMLElement {
  return el(
    "div",
    { class: "form-actions" },
    el("button", { class: "btn ghost", type: "button", onclick: () => ctx.actions.goto("home") }, "Back to home")
  );
}
