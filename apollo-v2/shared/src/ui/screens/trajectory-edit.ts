import type { Ctx } from "../context";
import { el } from "../components/helpers";
import {
  rememberTrajectorySkip,
  saveTrajectoryClaimSnapshot,
  seedTrajectoryJudgment,
  trajectoryRelease,
  trajectorySubmit,
  type HumanRubricVerdict,
  type OverallTrajectoryOutcome,
  type PriorTrajectoryGrade,
  type TaskLineage,
  type TaskLineageRubric,
  type TrajectoryJudgmentDraft,
  type TrajectoryRubric,
} from "../../review-client";
import { diffSummary, diffWords } from "../../textdiff";

type Choice<T extends string> = { value: T; label: string; key?: string };

function migrateOverallOutcome(trajectory: TrajectoryJudgmentDraft["trajectory"] | undefined): OverallTrajectoryOutcome {
  if (trajectory?.overall_outcome) return trajectory.overall_outcome;
  if (trajectory?.task_satisfied === "SUCCESS") return "YES";
  if (trajectory?.task_satisfied === "FAILURE") return "NO";
  if (trajectory?.task_satisfied === "UNJUDGEABLE") return "NEEDS_RERUN";
  if (trajectory?.outcome === "MODEL_SUCCEEDED") return "YES";
  if (trajectory?.outcome === "REAL_MODEL_FAILURE") return "NO";
  if (trajectory?.outcome === "TASK_OR_RUBRIC_BROKEN") return "EDIT_NEEDED";
  if (trajectory?.outcome === "TRAJECTORY_INSUFFICIENT") return "NEEDS_RERUN";
  return "";
}

function normalizeDraft(ctx: Ctx): TrajectoryJudgmentDraft {
  const run = ctx.state.trajectoryClaim!.run;
  const seed = seedTrajectoryJudgment(run);
  const previous = ctx.state.trajectoryJudgment as TrajectoryJudgmentDraft | null;
  if (!previous) return seed;
  const priorById = new Map(previous.rubrics?.map((rubric) => [rubric.rubric_id, rubric]) ?? []);
  const priorTrajectory = previous.trajectory as TrajectoryJudgmentDraft["trajectory"];
  return {
    rubrics: seed.rubrics.map((rubric) => {
      const prior = priorById.get(rubric.rubric_id);
      return {
        rubric_id: rubric.rubric_id,
        human_verdict: prior?.human_verdict ?? "",
        notes: prior?.notes ?? "",
      };
    }),
    trajectory: {
      overall_outcome: migrateOverallOutcome(priorTrajectory),
      notes: priorTrajectory?.notes ?? "",
    },
  };
}

// Inline word diff: struck = what the trainer wrote, highlighted = what ran.
export function inlineDiff(before: string, after: string, className = "inline-diff"): HTMLElement {
  const ops = diffWords(before, after);
  return el(
    "span",
    { class: className },
    ...ops.map((op) => op.type === "equal"
      ? document.createTextNode(op.text)
      : el(op.type === "insert" ? "ins" : "del", { class: op.type === "insert" ? "diff-ins" : "diff-del" }, op.text))
  );
}

// The run's rubric ids come from the OSWorld export (usually rubric-N, but
// older packages used R1/R2…). Match by id, then exact text, then position.
export function lineageRubricFor(lineage: TaskLineage | null | undefined, rubric: TrajectoryRubric, index: number, total: number): TaskLineageRubric | null {
  if (!lineage?.rubrics?.length) return null;
  const byId = lineage.rubrics.find((candidate) => candidate.rubric_id === rubric.rubric_id);
  if (byId) return byId;
  const byText = lineage.rubrics.find((candidate) => candidate.final.trim() === rubric.requirement.trim());
  if (byText) return byText;
  if (lineage.rubrics.length === total) return lineage.rubrics[index] ?? null;
  return null;
}

const OUTCOME_LABEL: Record<string, string> = { YES: "Yes — completed", NO: "No — agent failed", EDIT_NEEDED: "Edit needed", NEEDS_RERUN: "Needs rerun" };
const VERDICT_LABEL: Record<string, string> = { SUCCESS: "Pass", FAILURE: "Fail", UNJUDGEABLE: "Unclear" };

export function priorRubricFor(prior: PriorTrajectoryGrade | null | undefined, rubric: TrajectoryRubric, index: number, total: number): PriorTrajectoryGrade["rubrics"][number] | null {
  if (!prior?.rubrics?.length) return null;
  const byId = prior.rubrics.find((candidate) => candidate.rubric_id === rubric.rubric_id);
  if (byId) return byId;
  const byText = prior.rubrics.find((candidate) => candidate.requirement.trim() === rubric.requirement.trim());
  if (byText) return byText;
  if (prior.rubrics.length === total) return prior.rubrics[index] ?? null;
  return null;
}

function priorRubricBlock(prior: PriorTrajectoryGrade, priorRubric: PriorTrajectoryGrade["rubrics"][number], rubric: TrajectoryRubric): HTMLElement {
  const reworded = priorRubric.requirement.trim() !== rubric.requirement.trim();
  const verdict = priorRubric.human_verdict;
  return el(
    "div",
    { class: `rubric-prior verdict-${verdict.toLowerCase() || "none"}` },
    el("div", { class: "rubric-prior-head" },
      el("span", { class: "eyebrow mono" }, "PREVIOUS RUN"),
      el("span", { class: "rubric-prior-verdict" }, verdict ? VERDICT_LABEL[verdict] ?? verdict : "Not graded"),
      el("span", { class: "muted small" }, `${prior.graded_at ? formatReviewedAt(prior.graded_at) : ""}${prior.agent ? ` · ${prior.agent}` : ""}`)),
    ...(priorRubric.notes ? [el("p", { class: "rubric-prior-note" }, `“${priorRubric.notes}”`)] : []),
    ...(reworded
      ? [el("p", { class: "rubric-prior-reword muted small" }, "Rubric was reworded since: "), el("p", { class: "rubric-prior-diff" }, inlineDiff(priorRubric.requirement, rubric.requirement))]
      : [el("p", { class: "muted small" }, "Same rubric wording as this run.")])
  );
}

function rubricLineageBlock(lineageRubric: TaskLineageRubric, rubric: TrajectoryRubric): HTMLElement {
  const before = lineageRubric.original ?? "";
  // Diff against the requirement the agent was judged on, so the highlighted
  // side always matches the text shown above it.
  const after = rubric.requirement;
  const summary = diffSummary(diffWords(before, after));
  return el(
    "div",
    { class: "rubric-lineage" },
    el("div", { class: "rubric-lineage-head" },
      el("span", { class: "eyebrow mono" }, before ? "EDITED IN REVIEW" : "ADDED IN REVIEW"),
      el("span", { class: "muted small" }, before ? `+${summary.inserted} / −${summary.deleted} words vs. what you wrote` : "This rubric was not in your submission")),
    el("p", { class: "rubric-lineage-diff" }, before ? inlineDiff(before, after) : el("ins", { class: "diff-ins" }, after))
  );
}

function formatReviewedAt(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function renderTrajectoryEdit(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const claim = state.trajectoryClaim;
  const root = el("section", { class: "screen trajectory-edit-screen", tabindex: "-1" });
  if (!claim) {
    root.append(el("p", { class: "muted" }, "No trajectory claimed."));
    return root;
  }

  const run = claim.run;
  const judgment = normalizeDraft(ctx);
  state.trajectoryJudgment = judgment;
  let stepIndex = Math.max(0, run.steps.findIndex((step) => step.screenshot_url));
  let rubricIndex = 0;
  const persist = () => void saveTrajectoryClaimSnapshot(ctx.adapter.storage, { claim, judgment });

  const header = el(
    "header",
    { class: "trajectory-review-head" },
    el(
      "div",
      null,
      el("p", { class: "eyebrow mono" }, "HUMAN TRAJECTORY GRADE"),
      el("h2", { class: "display" }, "Grade agent trajectory"),
      el("p", { class: "trajectory-run-id mono" }, run.task_id)
    ),
    el(
      "div",
      { class: "trajectory-head-meta" },
      ...(run.source.agent ? [el("span", { class: "badge" }, run.source.agent)] : []),
      ...(run.source.model ? [el("span", { class: "badge" }, run.source.model)] : []),
      el("span", { class: "badge" }, `${run.steps.length} steps`)
    )
  );

  const shortcuts = el(
    "div",
    { class: "trajectory-shortcuts", "aria-label": "Keyboard shortcuts" },
    el("span", null, el("kbd", null, "← / →"), " steps"),
    el("span", null, el("kbd", null, "W / S"), " rubrics"),
    el("span", null, el("kbd", null, "P / O"), " pass / fail"),
    el("span", null, el("kbd", null, "U"), " unclear"),
    el("span", null, el("kbd", null, "⇧ Enter"), " submit")
  );

  const lineage = claim.taskLineage ?? null;
  const editedRubricCount = run.rubrics.filter((rubric, index) => lineageRubricFor(lineage, rubric, index, run.rubrics.length)?.changed).length;
  const lineageChanged = Boolean(lineage && (lineage.title.changed || lineage.request.changed || editedRubricCount > 0));
  // Prefer the lineage's final request (the reviewed gold) only when it is
  // what actually ran; otherwise diff against the manifest prompt so the
  // highlighted side is always the text the agent saw.
  const ranRequest = run.task_prompt;
  const requestChanged = Boolean(lineage && lineage.request.original.trim() !== ranRequest.trim());

  const lineageNote = (() => {
    if (!lineage) return null;
    if (!lineageChanged && !requestChanged) {
      return el("p", { class: "trajectory-lineage-note unchanged" },
        el("strong", null, "Ran exactly as you wrote it."),
        " No reviewer edits to the title, request, or rubrics before this run.");
    }
    const parts: string[] = [];
    if (lineage.title.changed) parts.push("title");
    if (requestChanged) parts.push("request");
    if (editedRubricCount) parts.push(`${editedRubricCount} rubric${editedRubricCount === 1 ? "" : "s"}`);
    const who = lineage.reviewer ? ` by ${lineage.reviewer}` : "";
    const when = formatReviewedAt(lineage.reviewed_at);
    return el("p", { class: "trajectory-lineage-note changed" },
      el("strong", null, `Edited in review${who}${when ? ` (${when})` : ""}: ${parts.join(" · ")}.`),
      " Changes are shown inline — ",
      el("del", { class: "diff-del" }, "struck"),
      " is what you wrote, ",
      el("ins", { class: "diff-ins" }, "highlighted"),
      " is what the agent ran. Grade against the version that ran.",
      ...(lineage.revision_of_task_id ? [el("span", { class: "muted" }, ` This task is a revision of ${lineage.revision_of_task_id}.`)] : []));
  })();

  const priorGrades = claim.priorGrades ?? [];
  const prior = priorGrades[0] ?? null;
  const priorNote = prior
    ? (() => {
        const reworded = run.rubrics.filter((rubric, index) => {
          const match = priorRubricFor(prior, rubric, index, run.rubrics.length);
          return match && match.requirement.trim() !== rubric.requirement.trim();
        }).length;
        const added = run.rubrics.filter((rubric, index) => !priorRubricFor(prior, rubric, index, run.rubrics.length)).length;
        const verdicts = prior.rubrics.map((rubric) => rubric.human_verdict);
        const passes = verdicts.filter((verdict) => verdict === "SUCCESS").length;
        const summary = el("summary", null,
          el("strong", null, `Previous run graded ${OUTCOME_LABEL[prior.overall_outcome] ?? (prior.overall_outcome || "—")}`),
          el("span", { class: "muted small" }, ` · ${passes}/${verdicts.length} rubrics passed${prior.graded_at ? ` · ${formatReviewedAt(prior.graded_at)}` : ""}${prior.graded_by ? ` by ${prior.graded_by}` : ""}${reworded ? ` · ${reworded} rubric${reworded === 1 ? "" : "s"} reworded since` : ""}${added ? ` · ${added} new` : ""}${priorGrades.length > 1 ? ` · ${priorGrades.length} earlier runs` : ""}`),
          el("span", { class: "muted small trajectory-prior-hint" }, "Each rubric below shows its previous verdict. Grade this run on its own evidence."));
        const table = el("table", { class: "trajectory-prior-table" },
          el("thead", null, el("tr", null, el("th", null, "Rubric"), el("th", null, "Previous verdict"), el("th", null, "Wording then → now"))),
          el("tbody", null, ...run.rubrics.map((rubric, index) => {
            const match = priorRubricFor(prior, rubric, index, run.rubrics.length);
            const verdict = match?.human_verdict ?? "";
            return el("tr", null,
              el("td", { class: "mono" }, rubric.rubric_id),
              el("td", { class: `verdict-${verdict.toLowerCase() || "none"}` }, match ? (VERDICT_LABEL[verdict] ?? (verdict || "—")) : "new rubric", match?.notes ? el("small", { class: "muted" }, ` — ${match.notes}`) : null),
              el("td", null, match ? (match.requirement.trim() === rubric.requirement.trim() ? el("span", { class: "muted small" }, "unchanged") : inlineDiff(match.requirement, rubric.requirement)) : el("span", { class: "diff-ins" }, rubric.requirement)));
          })));
        return el("details", { class: "trajectory-prior-note" }, summary,
          ...(prior.notes ? [el("p", { class: "trajectory-prior-reason" }, el("strong", null, "Previous note: "), prior.notes)] : []),
          el("div", { class: "trajectory-prior-table-wrap" }, table));
      })()
    : null;

  let showPromptDiff = requestChanged;
  const promptText = el("p", { class: "trajectory-prompt-text" });
  const promptToggle = el("button", { class: "link-btn small trajectory-prompt-toggle", type: "button" }) as HTMLButtonElement;
  const drawPrompt = () => {
    promptText.replaceChildren(showPromptDiff && lineage ? inlineDiff(lineage.request.original, ranRequest) : document.createTextNode(ranRequest));
    promptToggle.textContent = showPromptDiff ? "Show as run" : "Show my edits";
    promptToggle.hidden = !requestChanged;
  };
  promptToggle.onclick = (event) => { event.preventDefault(); showPromptDiff = !showPromptDiff; drawPrompt(); };
  drawPrompt();
  const titleLine = lineage?.title.changed
    ? el("p", { class: "trajectory-prompt-title" }, el("span", { class: "detail-label" }, "Title "), inlineDiff(lineage.title.original, lineage.title.final))
    : null;
  const taskReference = el(
    "details",
    { class: "trajectory-task-reference", ...(requestChanged || lineage?.title.changed ? { open: "" } : {}) },
    el("summary", null,
      el("strong", null, "Task prompt"),
      ...(requestChanged ? [el("span", { class: "badge edited-badge" }, "edited in review")] : []),
      el("span", { class: "muted small" }, "Reference only — do not grade the prompt"),
      promptToggle),
    titleLine,
    promptText
  );

  const rubricRail = el("nav", { class: "trajectory-rubric-rail", "aria-label": "Rubrics" });
  const rubricPosition = el("span", { class: "mono rubric-position" });
  const rubricTrack = el("div", { class: "trajectory-rubric-track" });
  const previousRubric = el("button", { class: "icon-btn", type: "button", title: "Previous rubric (W)", onclick: () => moveRubric(-1) }, "↑") as HTMLButtonElement;
  const nextRubric = el("button", { class: "icon-btn", type: "button", title: "Next rubric (S)", onclick: () => moveRubric(1) }, "↓") as HTMLButtonElement;
  rubricRail.append(el("div", { class: "rubric-cycle" }, previousRubric, rubricPosition, nextRubric), rubricTrack);

  const image = el("img", { class: "trajectory-screenshot", alt: "Recorded browser state" }) as HTMLImageElement;
  const noImage = el("div", { class: "trajectory-no-image" }, "No screenshot recorded for this step");
  const stepLabel = el("span", { class: "mono" });
  const stepAction = el("pre", { class: "trajectory-action" });
  const stepResponse = el("div", { class: "trajectory-response" });
  const stepStrip = el("div", { class: "trajectory-step-strip", role: "list", "aria-label": "Trajectory steps" });
  const previousStep = el("button", { class: "icon-btn trajectory-prev-step", type: "button", title: "Previous step (Left arrow)", onclick: () => moveStep(-1) }, "←") as HTMLButtonElement;
  const nextStep = el("button", { class: "icon-btn trajectory-next-step", type: "button", title: "Next step (Right arrow)", onclick: () => moveStep(1) }, "→") as HTMLButtonElement;
  const evidencePane = el(
    "main",
    { class: "trajectory-evidence-pane" },
    el("div", { class: "pane-title" }, el("span", null, "Recorded browser path"), el("span", { class: "step-controls" }, previousStep, stepLabel, nextStep)),
    el("div", { class: "trajectory-shot-stage" }, image, noImage),
    el(
      "details",
      { class: "trajectory-step-detail" },
      el("summary", null, "Action and agent response"),
      el("div", { class: "trajectory-step-detail-grid" }, el("span", { class: "detail-label" }, "Action"), stepAction, el("span", { class: "detail-label" }, "Response"), stepResponse)
    ),
    stepStrip
  );

  const rubricJudge = el("div", { class: "judge-block rubric-judge" });
  const overallJudge = el("div", { class: "judge-block overall-judge" });
  const submitButton = el("button", { class: "btn primary trajectory-submit", type: "button", disabled: true }, "Submit grade") as HTMLButtonElement;
  const skipButton = el("button", {
    class: "btn ghost",
    type: "button",
    onclick: async () => {
      skipButton.disabled = true;
      // Remember the skip BEFORE releasing so the next claim in this session
      // prefers a different run (falling back to this one only when it's the
      // only run assigned to you).
      rememberTrajectorySkip(claim.manifestKey);
      await trajectoryRelease(state.reviewKey!, claim).catch(() => {});
      ctx.actions.endTrajectoryReview("Run released back to the trajectory queue.");
    },
  }, "Skip & release") as HTMLButtonElement;
  const judgePane = el(
    "aside",
    { class: "trajectory-judge-pane" },
    el("div", { class: "pane-title" }, el("span", null, "Your grade"), el("span", { class: "mono" }, "Independent review")),
    rubricJudge,
    overallJudge,
    el("div", { class: "trajectory-actions" }, skipButton, submitButton)
  );

  function segmented<T extends string>(
    label: string,
    choices: Choice<T>[],
    get: () => T | "",
    set: (value: T) => void,
    afterSet?: () => void
  ): HTMLElement {
    const row = el("div", { class: "judge-field" }, el("span", { class: "judge-label" }, label));
    const buttons = el("div", { class: "judge-options" });
    const draw = () => {
      buttons.replaceChildren(...choices.map((choice) => el("button", {
        class: `judge-option ${get() === choice.value ? "selected" : ""}`,
        type: "button",
        title: choice.key ? `Shortcut: ${choice.key}` : undefined,
        onclick: () => {
          set(choice.value);
          persist();
          draw();
          drawRubricRail();
          syncSubmit();
          afterSet?.();
        },
      }, choice.label)));
    };
    draw();
    row.append(buttons);
    return row;
  }

  function noteArea(value: string, placeholder: string, oninput: (value: string) => void): HTMLTextAreaElement {
    const area = el("textarea", { class: "textarea judge-notes", rows: "2", placeholder }) as HTMLTextAreaElement;
    area.value = value;
    area.oninput = () => { oninput(area.value); persist(); syncSubmit(); };
    return area;
  }

  function verdictChoices(): Choice<Exclude<HumanRubricVerdict, "">>[] {
    return [
      { value: "SUCCESS", label: "Pass", key: "P" },
      { value: "FAILURE", label: "Fail", key: "O" },
      { value: "UNJUDGEABLE", label: "Unclear", key: "U" },
    ];
  }

  function overallChoices(): Choice<Exclude<OverallTrajectoryOutcome, "">>[] {
    return [
      { value: "YES", label: "Yes" },
      { value: "NO", label: "No" },
      { value: "EDIT_NEEDED", label: "Edit needed" },
      { value: "NEEDS_RERUN", label: "Needs rerun" },
    ];
  }

  function drawRubricRail() {
    rubricPosition.textContent = `Rubric ${rubricIndex + 1} / ${run.rubrics.length}`;
    previousRubric.disabled = rubricIndex === 0;
    nextRubric.disabled = rubricIndex === run.rubrics.length - 1;
    rubricTrack.replaceChildren(...run.rubrics.map((rubric, index) => {
      const verdict = judgment.rubrics[index].human_verdict;
      const edited = Boolean(lineageRubricFor(lineage, rubric, index, run.rubrics.length)?.changed);
      return el("button", {
        class: `trajectory-rubric-chip ${index === rubricIndex ? "active" : ""} ${verdict ? "complete" : ""} ${edited ? "edited" : ""}`,
        type: "button",
        title: edited ? `${rubric.requirement}\n(edited in review)` : rubric.requirement,
        "aria-label": `${rubric.rubric_id}${verdict ? ` graded ${verdict.toLowerCase()}` : " not graded"}`,
        onclick: () => { rubricIndex = index; drawRubricRail(); drawRubricJudge(); },
      }, rubric.rubric_id, verdict ? el("span", { "aria-hidden": "true" }, verdict === "SUCCESS" ? "✓" : verdict === "FAILURE" ? "×" : "?") : null);
    }));
  }

  function drawRubricJudge() {
    const rubric = run.rubrics[rubricIndex];
    const human = judgment.rubrics[rubricIndex];
    const rubricLineage = lineageRubricFor(lineage, rubric, rubricIndex, run.rubrics.length);
    const priorRubric = priorRubricFor(prior, rubric, rubricIndex, run.rubrics.length);
    rubricJudge.replaceChildren(
      el("div", { class: "judge-section-head" }, el("h3", null, rubric.rubric_id), el("span", { class: "muted small" }, "Based only on the recorded run")),
      el("p", { class: "rubric-requirement-full" }, rubric.requirement),
      ...(rubricLineage?.changed ? [rubricLineageBlock(rubricLineage, rubric)] : []),
      ...(priorRubric && prior ? [priorRubricBlock(prior, priorRubric, rubric)] : []),
      ...(rubric.verification ? [el("details", { class: "rubric-verification" }, el("summary", null, "How to verify"), el("p", null, rubric.verification))] : []),
      segmented("Was this rubric satisfied?", verdictChoices(), () => human.human_verdict, (value) => { human.human_verdict = value; }),
      noteArea(human.notes, "Optional: cite the decisive step or explain why it is unclear…", (value) => { human.notes = value; })
    );
  }

  function drawOverallJudge() {
    const needsFollowUp = ["EDIT_NEEDED", "NEEDS_RERUN"].includes(judgment.trajectory.overall_outcome);
    const followUpLabel = judgment.trajectory.overall_outcome === "EDIT_NEEDED"
      ? "What is wrong or missing, and what should be edited?"
      : "What was missing, and what should the rerun do differently?";
    overallJudge.replaceChildren(
      el("h3", null, "Final grade"),
      el("p", { class: "judge-help" }, "Judge the agent run, not the task wording."),
      segmented(
        "Overall result",
        overallChoices(),
        () => judgment.trajectory.overall_outcome,
        (value) => { judgment.trajectory.overall_outcome = value; },
        drawOverallJudge
      ),
      el("p", { class: "judge-help final-grade-hint" }, "Yes: completed · No: agent failed · Edit needed: task/rubric issue · Needs rerun: run or evidence issue"),
      ...(needsFollowUp ? [
        el("label", { class: "judge-follow-up-label" }, followUpLabel),
        noteArea(
          judgment.trajectory.notes,
          judgment.trajectory.overall_outcome === "EDIT_NEEDED"
            ? "Required: explain the task or rubric edit needed…"
            : "Required: explain what must be captured in the rerun…",
          (value) => { judgment.trajectory.notes = value; }
        ),
        el("p", { class: "judge-help judge-follow-up-help" }, "Required — at least 10 characters."),
      ] : [
        noteArea(judgment.trajectory.notes, "Optional overall evidence…", (value) => { judgment.trajectory.notes = value; }),
      ])
    );
  }

  function drawStep() {
    const step = run.steps[stepIndex];
    stepLabel.textContent = `${stepIndex + 1} / ${run.steps.length}`;
    image.hidden = !step.screenshot_url;
    noImage.hidden = Boolean(step.screenshot_url);
    if (step.screenshot_url) image.src = step.screenshot_url;
    image.alt = `Trajectory step ${stepIndex + 1} browser state`;
    stepAction.textContent = step.action || "No non-screenshot action recorded.";
    stepResponse.textContent = step.response || "No agent response recorded.";
    previousStep.disabled = stepIndex === 0;
    nextStep.disabled = stepIndex === run.steps.length - 1;
    stepStrip.replaceChildren(...run.steps.map((candidate, index) => el("button", {
      class: `trajectory-step-chip ${index === stepIndex ? "active" : ""} ${candidate.screenshot_url ? "has-shot" : ""}`,
      type: "button",
      title: candidate.action || `Step ${index + 1}`,
      onclick: () => { stepIndex = index; drawStep(); },
    }, String(index + 1))));
  }

  function moveStep(delta: number) {
    stepIndex = Math.max(0, Math.min(run.steps.length - 1, stepIndex + delta));
    drawStep();
  }

  function moveRubric(delta: number) {
    rubricIndex = Math.max(0, Math.min(run.rubrics.length - 1, rubricIndex + delta));
    drawRubricRail();
    drawRubricJudge();
  }

  function setCurrentVerdict(value: Exclude<HumanRubricVerdict, "">) {
    judgment.rubrics[rubricIndex].human_verdict = value;
    persist();
    drawRubricRail();
    drawRubricJudge();
    syncSubmit();
  }

  function complete(): boolean {
    if (!judgment.trajectory.overall_outcome || !judgment.rubrics.every((rubric) => rubric.human_verdict)) return false;
    if (["EDIT_NEEDED", "NEEDS_RERUN"].includes(judgment.trajectory.overall_outcome)) {
      return judgment.trajectory.notes.trim().length >= 10;
    }
    return true;
  }

  function syncSubmit() {
    submitButton.disabled = !complete();
    submitButton.title = submitButton.disabled
      ? "Grade every rubric and the overall trajectory; explain edits or reruns"
      : "Submit (Shift+Enter)";
  }

  submitButton.onclick = async () => {
    if (!complete()) return;
    submitButton.disabled = true;
    submitButton.textContent = "Submitting…";
    try {
      await trajectorySubmit(state.reviewKey!, ctx.actions.reviewerName(), ctx.actions.reviewerPid(), claim, judgment);
      const message = judgment.trajectory.overall_outcome === "EDIT_NEEDED"
        ? "Grade saved. A linked revision is waiting for its Codex check, then returns to Review."
        : judgment.trajectory.overall_outcome === "NEEDS_RERUN"
          ? "Grade saved. Upload the replacement run when ready; it will return to Grade."
          : "Trajectory grade saved. Claim another run?";
      ctx.actions.endTrajectoryReview(message);
    } catch (error) {
      ctx.actions.notifyError(error instanceof Error ? error.message : String(error));
      submitButton.textContent = "Submit grade";
      syncSubmit();
    }
  };

  root.onkeydown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (event.key === "Enter" && event.shiftKey && complete()) {
      event.preventDefault();
      submitButton.click();
      return;
    }
    if (typing) return;
    const key = event.key.toLowerCase();
    if (event.key === "ArrowRight") { moveStep(1); event.preventDefault(); }
    else if (event.key === "ArrowLeft") { moveStep(-1); event.preventDefault(); }
    else if (key === "w") { moveRubric(-1); event.preventDefault(); }
    else if (key === "s") { moveRubric(1); event.preventDefault(); }
    else if (key === "p") { setCurrentVerdict("SUCCESS"); event.preventDefault(); }
    else if (key === "o") { setCurrentVerdict("FAILURE"); event.preventDefault(); }
    else if (key === "u") { setCurrentVerdict("UNJUDGEABLE"); event.preventDefault(); }
  };

  drawRubricRail();
  drawRubricJudge();
  drawOverallJudge();
  drawStep();
  syncSubmit();
  root.append(header, shortcuts, ...(lineageNote ? [lineageNote] : []), ...(priorNote ? [priorNote] : []), taskReference, rubricRail, el("div", { class: "trajectory-workbench" }, evidencePane, judgePane));
  requestAnimationFrame(() => root.focus({ preventScroll: true }));
  return root;
}
