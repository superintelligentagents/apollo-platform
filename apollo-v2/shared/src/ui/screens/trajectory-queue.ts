import type { Ctx } from "../context";
import { el } from "../components/helpers";
import {
  clearTrajectoryClaimSnapshot,
  loadTrajectoryClaimSnapshot,
  trajectoryClaim,
  trajectoryRelease,
  trajectoryStatus,
  type TrajectoryClaimSnapshot,
} from "../../review-client";

export function renderTrajectoryQueue(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const root = el("section", { class: "screen narrow trajectory-queue-screen" });
  root.append(
    el(
      "header",
      { class: "screen-head" },
      el("p", { class: "eyebrow mono" }, "HUMAN TRAJECTORY QC"),
      el("h2", { class: "display" }, "Grade model runs"),
      el(
        "p",
        { class: "screen-sub" },
        "Review the recorded browser path. Mark whether each rubric was satisfied, then decide whether the complete run satisfied the task."
      )
    )
  );
  const resumeSlot = el("div");
  const body = el("div", { class: "review-queue-body" }, el("p", { class: "muted" }, "Checking the trajectory queue…"));
  root.append(resumeSlot, body);
  let held: TrajectoryClaimSnapshot | null = null;

  const drawResume = () => {
    if (!held) {
      resumeSlot.replaceChildren();
      return;
    }
    const snapshot = held;
    const minutes = Math.max(1, Math.floor((snapshot.claim.lockTtlMs - (Date.now() - snapshot.claim.claimedAtMs)) / 60_000));
    resumeSlot.replaceChildren(
      el(
        "div",
        { class: "resume-review trajectory-resume" },
        el("div", null, el("strong", null, "Run in progress"), el("p", { class: "muted small" }, `${snapshot.claim.run.task_id} · about ${minutes} min left on your lock`)),
        el(
          "div",
          { class: "resume-actions" },
          el("button", {
            class: "btn primary small",
            type: "button",
            onclick: () => {
              ctx.update({ trajectoryClaim: snapshot.claim, trajectoryJudgment: snapshot.judgment });
              ctx.actions.goto("trajectory-edit");
            },
          }, "Resume"),
          el("button", {
            class: "btn ghost small",
            type: "button",
            onclick: async () => {
              await trajectoryRelease(state.reviewKey!, snapshot.claim).catch(() => {});
              held = null;
              ctx.update({ trajectoryClaim: null, trajectoryJudgment: null });
              await clearTrajectoryClaimSnapshot(ctx.adapter.storage);
              drawResume();
              void refresh();
            },
          }, "Release")
        )
      )
    );
  };

  if (state.trajectoryClaim && state.trajectoryJudgment) {
    const fresh = Date.now() - state.trajectoryClaim.claimedAtMs < state.trajectoryClaim.lockTtlMs;
    if (fresh) held = { claim: state.trajectoryClaim, judgment: state.trajectoryJudgment };
    else ctx.update({ trajectoryClaim: null, trajectoryJudgment: null });
    drawResume();
  } else {
    void loadTrajectoryClaimSnapshot(ctx.adapter.storage).then((snapshot) => {
      if (!snapshot || held || state.trajectoryClaim) return;
      held = snapshot;
      drawResume();
    });
  }

  const refresh = async () => {
    if (!state.reviewKey) {
      body.replaceChildren(el("p", { class: "muted" }, "Trajectory reviewing is not enabled in this build."));
      return;
    }
    try {
      const counts = await trajectoryStatus(state.reviewKey, ctx.actions.reviewerPid());
      const claimButton = el("button", {
        class: "btn primary big-claim",
        type: "button",
        disabled: Boolean(held) || counts.claimable < 1,
        onclick: async () => {
          (claimButton as HTMLButtonElement).disabled = true;
          claimButton.textContent = "Claiming…";
          try {
            const claim = await trajectoryClaim(state.reviewKey!, ctx.actions.reviewerName(), ctx.actions.reviewerPid());
            if (!claim) {
              ctx.actions.notifyInfo("Nothing claimable right now. Another reviewer may have just taken the next run.");
              void refresh();
              return;
            }
            ctx.actions.startTrajectoryReview(claim);
          } catch (error) {
            ctx.actions.notifyError(error instanceof Error ? error.message : String(error));
            void refresh();
          }
        },
      }, held ? "Finish your claimed run first" : counts.claimable ? "Claim the next run" : "No run ready to claim") as HTMLButtonElement;
      body.replaceChildren(
        el(
          "div",
          { class: "queue-tiles" },
          el("div", { class: "queue-tile" }, el("strong", null, String(counts.claimable)), el("span", null, "ready for judgment")),
          el("div", { class: "queue-tile" }, el("strong", null, String(counts.locked)), el("span", null, "being judged")),
          el("div", { class: "queue-tile" }, el("strong", null, String(counts.finished)), el("span", null, "human-reviewed"))
        ),
        el("p", { class: "muted small" }, "Runs here are assigned to the expert who originally created the task, not the person who reviewed it."),
        claimButton,
        el("p", { class: "muted small queue-explainer" }, "One reviewer holds a run for 30 minutes. Your grade is saved separately from the original task and trajectory.")
      );
    } catch (error) {
      body.replaceChildren(
        el("p", { class: "muted" }, `Couldn't reach the trajectory queue: ${error instanceof Error ? error.message : String(error)}`),
        el("button", { class: "btn ghost", type: "button", onclick: () => void refresh() }, "Retry")
      );
    }
  };
  void refresh();
  return root;
}
