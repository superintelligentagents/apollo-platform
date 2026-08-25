import { clearTrajectoryClaimSnapshot, loadTrajectoryClaimSnapshot, trajectoryClaim, trajectoryRelease, trajectoryStatus, type TrajectoryClaimSnapshot } from "../../review-client";
import { el } from "../components/helpers";
import type { Ctx } from "../context";

export function renderTrajectoryQueue(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const root = el("section", { class: "screen narrow qc-queue-screen" });
  root.append(el("header", { class: "screen-head" }, el("p", { class: "eyebrow mono" }, "APOLLO PC · HUMAN TRAJECTORY QC"), el("h2", { class: "display" }, "Grade PC agent trajectories"), el("p", { class: "screen-sub" }, "This PC-only queue receives Gemini-judged run packages from the pc-review trajectory folder. Independently grade the recorded browser path and every rubric.")));
  const resume = el("div");
  const body = el("div", { class: "qc-queue-body" }, el("p", { class: "muted" }, "Checking the trajectory queue…"));
  root.append(resume, body);
  let held: TrajectoryClaimSnapshot | null = null;
  if (state.trajectoryClaim && state.trajectoryJudgment) {
    const fresh = Date.now() - state.trajectoryClaim.claimedAtMs < state.trajectoryClaim.lockTtlMs;
    if (fresh) held = { claim: state.trajectoryClaim, judgment: state.trajectoryJudgment };
    else {
      ctx.update({ trajectoryClaim: null, trajectoryJudgment: null });
      void clearTrajectoryClaimSnapshot(ctx.adapter.storage);
    }
  }
  const drawResume = () => {
    if (!held) { resume.replaceChildren(); return; }
    const snapshot = held;
    resume.replaceChildren(el("section", { class: "qc-resume" }, el("div", null, el("strong", null, "Trajectory grade in progress"), el("p", { class: "muted small" }, snapshot.claim.run.task_id)), el("div", { class: "qc-resume-actions" }, el("button", { class: "btn primary small", type: "button", onclick: () => { ctx.update({ trajectoryClaim: snapshot.claim, trajectoryJudgment: snapshot.judgment }); ctx.actions.goto("trajectory-edit"); } }, "Resume"), el("button", { class: "btn ghost small", type: "button", onclick: async () => { await trajectoryRelease(state.reviewKey!, snapshot.claim).catch(() => {}); held = null; ctx.update({ trajectoryClaim: null, trajectoryJudgment: null }); await clearTrajectoryClaimSnapshot(ctx.adapter.storage); drawResume(); void refresh(); } }, "Release"))));
  };
  drawResume();
  if (!held) void loadTrajectoryClaimSnapshot(ctx.adapter.storage).then((snapshot) => { if (!snapshot || held) return; held = snapshot; drawResume(); });
  const refresh = async () => {
    if (!state.reviewKey) { body.replaceChildren(el("p", { class: "muted" }, "Trajectory grading is not enabled in this build.")); return; }
    try {
      const counts = await trajectoryStatus(state.reviewKey, ctx.actions.reviewerPid());
      const claimButton = el("button", { class: "btn primary large qc-claim", type: "button", disabled: Boolean(held) || counts.claimable < 1, onclick: async () => { (claimButton as HTMLButtonElement).disabled = true; claimButton.textContent = "Claiming…"; try { const claim = await trajectoryClaim(state.reviewKey!, ctx.actions.reviewerName(), ctx.actions.reviewerPid()); if (!claim) { ctx.actions.notifyInfo("Nothing claimable right now."); void refresh(); return; } ctx.actions.startTrajectoryReview(claim); } catch (error) { ctx.actions.notifyError(error instanceof Error ? error.message : String(error)); void refresh(); } } }, held ? "Finish your claimed run first" : counts.claimable ? "Claim the next run" : "No run ready") as HTMLButtonElement;
      body.replaceChildren(
        el("div", { class: "qc-queue-tiles three" }, tile(counts.claimable, "ready"), tile(counts.locked, "being graded"), tile(counts.finished, "human-reviewed")),
        el("p", { class: "muted small" }, "Runs are assigned to the expert who originally created the task, not the person who reviewed it."),
        claimButton,
        el("p", { class: "muted small qc-queue-note" }, "Gemini's judgment is intentionally hidden during human grading. Your independent grade is saved in the PC trajectory queue, separately from the original task and run.")
      );
    } catch (error) { body.replaceChildren(el("p", { class: "muted" }, `Couldn't reach the trajectory queue: ${error instanceof Error ? error.message : String(error)}`), el("button", { class: "btn ghost", type: "button", onclick: () => void refresh() }, "Retry")); }
  };
  void refresh();
  return root;
}

function tile(value: number, label: string): HTMLElement { return el("div", { class: "qc-queue-tile" }, el("strong", { class: "mono" }, String(value)), el("span", null, label)); }
