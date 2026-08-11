import type { Ctx } from "../context";
import { el } from "../components/helpers";
import {
  saveTrajectoryClaimSnapshot,
  seedTrajectoryJudgment,
  trajectoryRelease,
  trajectorySubmit,
  type HumanRubricVerdict,
  type OverallTrajectoryOutcome,
  type TrajectoryJudgmentDraft,
} from "../../review-client";

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

  const taskReference = el(
    "details",
    { class: "trajectory-task-reference" },
    el("summary", null, el("strong", null, "Task prompt"), el("span", { class: "muted small" }, "Reference only — do not grade the prompt")),
    el("p", { class: "trajectory-prompt-text" }, run.task_prompt)
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
      return el("button", {
        class: `trajectory-rubric-chip ${index === rubricIndex ? "active" : ""} ${verdict ? "complete" : ""}`,
        type: "button",
        title: rubric.requirement,
        "aria-label": `${rubric.rubric_id}${verdict ? ` graded ${verdict.toLowerCase()}` : " not graded"}`,
        onclick: () => { rubricIndex = index; drawRubricRail(); drawRubricJudge(); },
      }, rubric.rubric_id, verdict ? el("span", { "aria-hidden": "true" }, verdict === "SUCCESS" ? "✓" : verdict === "FAILURE" ? "×" : "?") : null);
    }));
  }

  function drawRubricJudge() {
    const rubric = run.rubrics[rubricIndex];
    const human = judgment.rubrics[rubricIndex];
    rubricJudge.replaceChildren(
      el("div", { class: "judge-section-head" }, el("h3", null, rubric.rubric_id), el("span", { class: "muted small" }, "Based only on the recorded run")),
      el("p", { class: "rubric-requirement-full" }, rubric.requirement),
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
      await trajectorySubmit(state.reviewKey!, ctx.actions.reviewerName(), claim, judgment);
      ctx.actions.endTrajectoryReview("Trajectory grade saved. Claim another run?");
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
  root.append(header, shortcuts, taskReference, rubricRail, el("div", { class: "trajectory-workbench" }, evidencePane, judgePane));
  requestAnimationFrame(() => root.focus({ preventScroll: true }));
  return root;
}
