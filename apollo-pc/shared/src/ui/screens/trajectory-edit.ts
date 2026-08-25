import { normalizeTrajectoryJudgment, saveTrajectoryClaimSnapshot, seedTrajectoryJudgment, setTrajectoryOverallOutcome, trajectoryRelease, trajectorySubmit, type HumanRubricVerdict, type TrajectoryOverallOutcome } from "../../review-client";
import { el } from "../components/helpers";
import type { Ctx } from "../context";

export function renderTrajectoryEdit(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const claim = state.trajectoryClaim;
  const root = el("section", { class: "screen pc-trajectory-edit", tabindex: "-1" });
  if (!claim) return el("section", { class: "screen" }, el("p", { class: "muted" }, "No trajectory claimed."));
  const run = claim.run;
  const judgment = normalizeTrajectoryJudgment(state.trajectoryJudgment ?? seedTrajectoryJudgment(run));
  state.trajectoryJudgment = judgment;
  let stepIndex = Math.max(0, run.steps.findIndex((step) => step.screenshot_url));
  let rubricIndex = 0;
  const persist = () => void saveTrajectoryClaimSnapshot(ctx.adapter.storage, { claim, judgment });

  const rail = el("nav", { class: "pc-trajectory-rubric-rail", "aria-label": "Rubrics" });
  const rubricPosition = el("span", { class: "mono" });
  const rubricTrack = el("div", { class: "pc-trajectory-rubric-track" });
  const rubricJudge = el("section", { class: "pc-trajectory-rubric-judge" });
  const overallJudge = el("section", { class: "pc-trajectory-overall" });
  const image = el("img", { class: "pc-trajectory-shot", alt: "Recorded browser state" }) as HTMLImageElement;
  const noImage = el("div", { class: "pc-trajectory-no-shot" }, "No screenshot recorded for this step");
  const stepLabel = el("span", { class: "mono" });
  const action = el("pre", { class: "pc-trajectory-action" });
  const response = el("div", { class: "pc-trajectory-response" });
  const stepTrack = el("div", { class: "pc-trajectory-step-track" });
  const submit = el("button", { class: "btn primary", type: "button", disabled: true }, "Submit grade") as HTMLButtonElement;

  const choices = (current: () => HumanRubricVerdict, set: (value: Exclude<HumanRubricVerdict, "">) => void) => el("div", { class: "pc-judge-options" }, ...([[
    "SUCCESS", "Pass", "P"], ["FAILURE", "Fail", "O"], ["UNJUDGEABLE", "Unclear", "U"]] as const).map(([value, label, key]) => el("button", { class: `pc-judge-option ${current() === value ? "selected" : ""}`, type: "button", title: `${key} shortcut`, onclick: () => { set(value); persist(); drawAll(); } }, label)));
  const notes = (value: string, update: (value: string) => void) => { const area = el("textarea", { class: "field-input pc-judge-notes", rows: "2", placeholder: "Optional evidence or explanation…" }) as HTMLTextAreaElement; area.value = value; area.oninput = () => { update(area.value); persist(); }; return area; };
  const outcomeNeedsNote = () => judgment.trajectory.overall_outcome === "EDIT_NEEDED" || judgment.trajectory.overall_outcome === "NEEDS_RERUN";
  const complete = () => Boolean(judgment.trajectory.overall_outcome && judgment.rubrics.every((rubric) => rubric.human_verdict) && (!outcomeNeedsNote() || judgment.trajectory.notes.trim().length >= 10));

  const drawRail = () => {
    rubricPosition.textContent = `Rubric ${rubricIndex + 1} / ${run.rubrics.length}`;
    rubricTrack.replaceChildren(...run.rubrics.map((rubric, index) => { const verdict = judgment.rubrics[index].human_verdict; return el("button", { class: `pc-trajectory-rubric-chip ${index === rubricIndex ? "active" : ""} ${verdict ? "complete" : ""}`, type: "button", title: rubric.requirement, onclick: () => { rubricIndex = index; drawAll(); } }, rubric.rubric_id, verdict ? el("span", null, verdict === "SUCCESS" ? "✓" : verdict === "FAILURE" ? "×" : "?") : null); }));
  };
  const drawRubric = () => {
    const rubric = run.rubrics[rubricIndex];
    const human = judgment.rubrics[rubricIndex];
    rubricJudge.replaceChildren(el("div", { class: "pc-judge-head" }, el("h3", null, rubric.rubric_id), el("span", { class: "muted small" }, "Recorded run only")), el("p", { class: "pc-rubric-requirement" }, rubric.requirement), ...(rubric.verification ? [el("details", { class: "pc-rubric-verification" }, el("summary", null, "How to verify"), el("p", null, rubric.verification))] : []), el("span", { class: "field-label" }, "Was this rubric satisfied?"), choices(() => human.human_verdict, (value) => { human.human_verdict = value; }), notes(human.notes, (value) => { human.notes = value; }));
  };
  const drawOverall = () => {
    const outcomeChoices: readonly [Exclude<TrajectoryOverallOutcome, "">, string, string][] = [
      ["YES", "Yes", "The trajectory satisfies the task."],
      ["NO", "No", "The agent did not satisfy the task."],
      ["EDIT_NEEDED", "Edit needed", "The task or rubric blocks fair grading."],
      ["NEEDS_RERUN", "Needs rerun", "The run or its evidence is incomplete."],
    ];
    const selected = judgment.trajectory.overall_outcome;
    const conditionalNote = outcomeNeedsNote()
      ? notes(judgment.trajectory.notes, (value) => { judgment.trajectory.notes = value; submit.disabled = !complete(); })
      : null;
    if (conditionalNote) {
      conditionalNote.classList.add("pc-outcome-notes");
      conditionalNote.placeholder = selected === "EDIT_NEEDED"
        ? "What is wrong or missing, and what should be edited?"
        : "Why is a rerun needed, and what should change for the rerun?";
    }
    const content = [
      el("h3", null, "Final grade"),
      el("p", { class: "muted small" }, "Choose what should happen to this run."),
      el("div", { class: "pc-overall-options" }, ...outcomeChoices.map(([value, label, description]) => el("button", {
        class: `pc-judge-option pc-overall-option ${selected === value ? "selected" : ""}`,
        type: "button",
        onclick: () => { setTrajectoryOverallOutcome(judgment, value); persist(); drawAll(); },
      }, el("strong", null, label), el("span", null, description)))),
    ];
    if (conditionalNote) content.push(el("div", { class: "pc-outcome-note-wrap" }, el("span", { class: "field-label" }, "Brief explanation required"), conditionalNote, el("span", { class: "field-hint" }, "At least 10 characters so the next reviewer knows what must change.")));
    overallJudge.replaceChildren(...content);
  };
  const drawStep = () => {
    const step = run.steps[stepIndex];
    stepLabel.textContent = `${stepIndex + 1} / ${run.steps.length}`;
    image.hidden = !step.screenshot_url; noImage.hidden = Boolean(step.screenshot_url); if (step.screenshot_url) image.src = step.screenshot_url;
    action.textContent = step.action || "No action recorded."; response.textContent = step.response || "No response recorded.";
    stepTrack.replaceChildren(...run.steps.map((candidate, index) => el("button", { class: `pc-trajectory-step-chip ${index === stepIndex ? "active" : ""}`, type: "button", title: candidate.action, onclick: () => { stepIndex = index; drawStep(); } }, String(index + 1))));
  };
  const drawAll = () => { drawRail(); drawRubric(); drawOverall(); submit.disabled = !complete(); };
  const moveStep = (delta: number) => { stepIndex = Math.max(0, Math.min(run.steps.length - 1, stepIndex + delta)); drawStep(); };
  const moveRubric = (delta: number) => { rubricIndex = Math.max(0, Math.min(run.rubrics.length - 1, rubricIndex + delta)); drawAll(); };
  const setVerdict = (value: Exclude<HumanRubricVerdict, "">) => { judgment.rubrics[rubricIndex].human_verdict = value; persist(); drawAll(); };

  rail.append(el("div", { class: "pc-rubric-cycle" }, el("button", { class: "icon-btn", type: "button", title: "Previous rubric (W)", onclick: () => moveRubric(-1) }, "↑"), rubricPosition, el("button", { class: "icon-btn", type: "button", title: "Next rubric (S)", onclick: () => moveRubric(1) }, "↓")), rubricTrack);
  const evidence = el("main", { class: "pc-trajectory-evidence" }, el("div", { class: "pc-pane-head" }, el("strong", null, "Recorded browser path"), el("span", { class: "pc-step-controls" }, el("button", { class: "icon-btn", type: "button", onclick: () => moveStep(-1) }, "←"), stepLabel, el("button", { class: "icon-btn", type: "button", onclick: () => moveStep(1) }, "→"))), el("div", { class: "pc-trajectory-shot-stage" }, image, noImage), el("details", { class: "pc-step-detail" }, el("summary", null, "Action and agent response"), el("span", { class: "field-label" }, "Action"), action, el("span", { class: "field-label" }, "Response"), response), stepTrack);
  const skip = el("button", { class: "btn ghost", type: "button", onclick: async () => { (skip as HTMLButtonElement).disabled = true; await trajectoryRelease(state.reviewKey!, claim).catch(() => {}); ctx.actions.endTrajectoryReview("Run released back to the queue."); } }, "Skip & release") as HTMLButtonElement;
  const judge = el("aside", { class: "pc-trajectory-judge" }, el("div", { class: "pc-pane-head" }, el("strong", null, "Your grade"), el("span", { class: "muted small" }, "Independent review")), rubricJudge, overallJudge, el("div", { class: "pc-trajectory-actions" }, skip, submit));
  submit.onclick = async () => {
    if (!complete()) return;
    submit.disabled = true;
    submit.textContent = "Submitting…";
    try {
      await trajectorySubmit(state.reviewKey!, ctx.actions.reviewerName(), ctx.actions.reviewerPid(), claim, judgment);
      const message = judgment.trajectory.overall_outcome === "EDIT_NEEDED"
        ? "Grade saved. A linked revision is waiting for its Codex check, then returns to Review."
        : judgment.trajectory.overall_outcome === "NEEDS_RERUN"
          ? "Grade saved. Upload the replacement run when ready; it will return to Grade."
          : "Trajectory grade saved. Claim another run?";
      ctx.actions.endTrajectoryReview(message);
    } catch (error) {
      submit.textContent = "Submit grade";
      submit.disabled = !complete();
      ctx.actions.notifyError(error instanceof Error ? error.message : String(error));
    }
  };
  root.onkeydown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && event.shiftKey && complete()) { event.preventDefault(); submit.click(); return; }
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const key = event.key.toLowerCase();
    if (event.key === "ArrowRight") moveStep(1);
    else if (event.key === "ArrowLeft") moveStep(-1);
    else if (key === "w") moveRubric(-1);
    else if (key === "s") moveRubric(1);
    else if (key === "p") setVerdict("SUCCESS");
    else if (key === "o") setVerdict("FAILURE");
    else if (key === "u") setVerdict("UNJUDGEABLE");
    else return;
    event.preventDefault();
  };
  drawStep(); drawAll();
  root.append(el("header", { class: "pc-trajectory-head" }, el("div", null, el("p", { class: "eyebrow mono" }, "HUMAN TRAJECTORY GRADE"), el("h2", { class: "display" }, "Grade agent trajectory"), el("p", { class: "muted small mono" }, run.task_id)), el("div", { class: "pc-trajectory-meta" }, run.source.agent ? el("span", { class: "badge" }, run.source.agent) : null, run.source.model ? el("span", { class: "badge" }, run.source.model) : null, el("span", { class: "badge" }, `${run.steps.length} steps`))), el("div", { class: "pc-shortcuts" }, shortcut("← / →", "steps"), shortcut("W / S", "rubrics"), shortcut("P / O", "pass / fail"), shortcut("U", "unclear"), shortcut("⇧ Enter", "submit")), el("details", { class: "pc-task-reference" }, el("summary", null, el("strong", null, "Task prompt"), el("span", { class: "muted small" }, "Reference only — do not grade the prompt")), el("p", null, run.task_prompt)), rail, el("div", { class: "pc-trajectory-workbench" }, evidence, judge));
  requestAnimationFrame(() => root.focus({ preventScroll: true }));
  return root;
}

function shortcut(key: string, label: string): HTMLElement { return el("span", null, el("kbd", null, key), ` ${label}`); }
