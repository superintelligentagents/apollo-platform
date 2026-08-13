import type { Ctx } from "../context";
import { el } from "../components/helpers";
import {
  authorEdit,
  myTaskFeedback,
  myTasks,
  type AuthorEditPayload,
  type MyTaskContentSnapshot,
  type MyTaskCurrentContent,
  type MyTaskFeedback,
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

function isEditable(status: MyTaskStatus): boolean {
  return status === "awaiting_codex" || status === "pending" || status === "returned";
}

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

function renderDiff(hr: MyTaskHumanReview): HTMLElement {
  return el(
    "div",
    { class: "admin-snapshots has-final my-task-diff" },
    diffSnapshot(hr.title_edited || hr.request_edited ? "Your original" : "Your submission", hr.original),
    diffSnapshot("Final gold version", hr.final, "final")
  );
}

function readOnlyTask(item: MyTaskItem, fb: MyTaskFeedback): HTMLElement {
  const snap = snapshotFromItem(item, fb);
  if (!snap) return el("p", { class: "muted" }, "No task content available.");
  return diffSnapshot("Your task", snap);
}

function statusNotice(item: MyTaskItem, fb: MyTaskFeedback): HTMLElement | null {
  if (item.status === "rejected" || fb.status === "rejected") {
    return el(
      "div",
      { class: "admin-rejection" },
      el("strong", null, "Rejection reason"),
      el("p", null, fb.rejection_reason ?? item.rejection_reason ?? "The reviewer did not give a reason.")
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

function renderEditForm(
  item: MyTaskItem,
  fb: MyTaskFeedback
): { wrap: HTMLElement; refs: EditFormRefs } {
  const current: MyTaskCurrentContent | null = fb.task ?? null;
  const steps = (current?.steps ?? fb.human_review?.original.steps ?? []).map((s) => ({ ...s }));

  const titleInput = el("input", {
    class: "input",
    type: "text",
    value: current?.title ?? fb.human_review?.original.title ?? item.title,
    "aria-label": "Task title",
  }) as HTMLInputElement;
  const reqArea = el("textarea", {
    class: "textarea",
    rows: "8",
    "aria-label": "Full task request",
  }) as HTMLTextAreaElement;
  reqArea.value = current?.request ?? fb.human_review?.original.request ?? item.request;
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
    success_criteria: current?.criteria ?? fb.human_review?.original.criteria ?? [],
    steps: steps.map((s, i) => ({ order: i + 1, title: s.title, description: s.description.trim() })),
    must_visit_or_reach: current?.must_visit_or_reach ?? [],
    required_outputs: current?.required_outputs ?? [],
    notes: current?.notes ?? null,
    metadata: current?.metadata,
  });

  const submitBtn = el("button", { class: "btn primary", type: "button" }, "Submit edit") as HTMLButtonElement;
  const cancelBtn = el("button", { class: "btn ghost", type: "button" }, "Cancel") as HTMLButtonElement;
  const statusMsg = el("p", { class: "muted small" });

  const wrap = el(
    "div",
    { class: "my-task-edit" },
    el("h4", null, "Edit your task"),
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
      el("p", { class: "field-hint" }, "Rewrite any step the Codex check or reviewer flagged, then submit. Codex will re-audit the new version."),
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
  reloadList: () => void
): HTMLElement {
  const wrap = el("div", { class: "my-task-feedback" });
  let editOpen = false;
  let formRefs: EditFormRefs | null = null;
  let editWrap: HTMLElement | null = null;
  let editBtn: HTMLButtonElement | null = null;

  const draw = () => {
    wrap.replaceChildren();
    if ((fb.status === "approved" || item.status === "approved") && fb.human_review) {
      wrap.append(renderDiff(fb.human_review));
    } else {
      wrap.append(readOnlyTask(item, fb));
    }

    const notice = statusNotice(item, fb);
    if (notice) wrap.append(notice);

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

    if (isEditable(item.status)) {
      if (editOpen && formRefs && editWrap) {
        wrap.append(editWrap);
      } else {
        editBtn = el(
          "button",
          {
            class: "btn primary",
            type: "button",
            onclick: () => {
              editOpen = true;
              const built = renderEditForm(item, fb);
              formRefs = built.refs;
              editWrap = built.wrap;
              wireSubmit(built.refs);
              draw();
            },
          },
          "Edit task"
        ) as HTMLButtonElement;
        wrap.append(el("div", { class: "form-actions" }, editBtn));
      }
    }
  };

  const wireSubmit = (refs: EditFormRefs) => {
    const { submitBtn, cancelBtn, statusMsg } = refs;
    submitBtn.addEventListener("click", async () => {
      if (!ctx.state.reviewKey || !ctx.state.identity) return;
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting…";
      statusMsg.textContent = "";
      try {
        await authorEdit(ctx.state.reviewKey, schemaParticipantId(ctx.state.identity), item.sub_key, refs.payload());
        editOpen = false;
        formRefs = null;
        editWrap = null;
        editBtn = null;
        reloadList();
        ctx.actions.notifyInfo("Re-checking your edit — Codex will re-audit this version.");
      } catch (err) {
        // Keep the form and the reason on screen. Reloading the list here
        // would rebuild every row collapsed and take the message with it —
        // which is exactly the case where the server's reason matters ("a
        // reviewer has claimed this task", "this task is finished").
        statusMsg.textContent = err instanceof Error ? err.message : String(err);
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit edit";
      }
    });
    cancelBtn.addEventListener("click", () => {
      editOpen = false;
      formRefs = null;
      editWrap = null;
      editBtn = null;
      draw();
    });
  };

  draw();
  return wrap;
}

function taskRow(ctx: Ctx, item: MyTaskItem, reloadList: () => void): HTMLElement {
  const when = item.submitted_at ? new Date(item.submitted_at).toLocaleDateString() : "—";
  const reasonLine =
    item.status === "rejected" && item.rejection_reason
      ? item.rejection_reason
      : item.status === "returned" && item.returned_reason
        ? item.returned_reason
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
    void loadFeedback(ctx, item, detailBody, reloadList);
  });
  return detail;
}

async function loadFeedback(
  ctx: Ctx,
  item: MyTaskItem,
  container: HTMLElement,
  reloadList: () => void
): Promise<void> {
  if (!ctx.state.reviewKey || !ctx.state.identity) return;
  container.replaceChildren(el("p", { class: "muted" }, "Loading feedback…"));
  try {
    const fb = await myTaskFeedback(ctx.state.reviewKey, schemaParticipantId(ctx.state.identity), item.sub_key);
    container.replaceChildren(renderFeedback(ctx, item, fb, reloadList));
  } catch (err) {
    container.replaceChildren(
      el("p", { class: "muted" }, `Couldn't load feedback: ${err instanceof Error ? err.message : String(err)}`),
      el(
        "button",
        {
          class: "btn ghost small",
          type: "button",
          onclick: () => void loadFeedback(ctx, item, container, reloadList),
        },
        "Retry"
      )
    );
  }
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
        "Track your submissions, see Codex feedback and reviewer notes, and revise tasks that are still open or were sent back to you."
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

  const reloadList = async () => {
    void refresh();
  };

  const refresh = async () => {
    if (!state.reviewKey || !state.identity) return;
    body.replaceChildren(el("p", { class: "muted status-line" }, "Loading your tasks…"));
    try {
      const items = await myTasks(state.reviewKey, schemaParticipantId(state.identity));
      body.replaceChildren();
      if (!items.length) {
        body.append(el("p", { class: "muted" }, "You haven't submitted any tasks yet."));
        return;
      }
      body.append(...items.map((item) => taskRow(ctx, item, reloadList)));
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
