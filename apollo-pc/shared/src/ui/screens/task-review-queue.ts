import { renderReviewAccess } from "../components/review-access";
import { clearClaimSnapshot, loadClaimSnapshot, reviewClaim, reviewRelease, reviewStatus, type ClaimSnapshot } from "../../review-client";
import { el } from "../components/helpers";
import type { Ctx } from "../context";

export function renderTaskReviewQueue(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const root = el("section", { class: "screen narrow qc-queue-screen" });
  root.append(
    el("header", { class: "screen-head" },
      el("p", { class: "eyebrow mono" }, "APOLLO PC · HUMAN TASK QC"),
      el("h2", { class: "display" }, "Review PC-written tasks"),
      el("p", { class: "screen-sub" }, "This PC-only queue is populated from privacy-safe task files produced by Write tasks. Check the complete request first, then verify every rubric on the live web.")
    )
  );
  const resume = el("div");
  const body = el("div", { class: "qc-queue-body" }, el("p", { class: "muted" }, "Checking the task queue…"));
  root.append(resume, body);
  let held: ClaimSnapshot | null = null;
  if (state.reviewClaim) {
    const fresh = Date.now() - state.reviewClaim.claimedAtMs < state.reviewClaim.lockTtlMs;
    if (fresh) held = { claim: state.reviewClaim, rubrics: state.reviewRubrics, removedRubrics: state.reviewRemovedRubrics, edits: state.reviewEdits };
    else {
      ctx.update({ reviewClaim: null, reviewRubrics: null, reviewRemovedRubrics: null, reviewEdits: null });
      void clearClaimSnapshot(ctx.adapter.storage);
    }
  }

  const drawResume = () => {
    if (!held) { resume.replaceChildren(); return; }
    const snapshot = held;
    const minutes = Math.max(1, Math.floor((snapshot.claim.lockTtlMs - (Date.now() - snapshot.claim.claimedAtMs)) / 60_000));
    resume.replaceChildren(el("section", { class: "qc-resume" },
      el("div", null, el("strong", null, "Task review in progress"), el("p", { class: "muted small" }, `${minutes} min left on your lock`)),
      el("div", { class: "qc-resume-actions" },
        el("button", { class: "btn primary small", type: "button", onclick: () => { ctx.update({ reviewClaim: snapshot.claim, reviewRubrics: snapshot.rubrics, reviewRemovedRubrics: snapshot.removedRubrics ?? null, reviewEdits: snapshot.edits }); ctx.actions.goto("task-review-edit"); } }, "Resume"),
        el("button", { class: "btn ghost small", type: "button", onclick: async () => { await reviewRelease(state.reviewKey!, snapshot.claim).catch(() => {}); held = null; ctx.update({ reviewClaim: null, reviewRubrics: null, reviewRemovedRubrics: null, reviewEdits: null }); await clearClaimSnapshot(ctx.adapter.storage); drawResume(); void refresh(); } }, "Release")
      )
    ));
  };
  drawResume();
  if (!held) void loadClaimSnapshot(ctx.adapter.storage).then((snapshot) => { if (!snapshot || held) return; held = snapshot; drawResume(); });

  const refresh = async () => {
    if (!state.reviewKey) { body.replaceChildren(renderReviewAccess(ctx)); return; }
    try {
      const counts = await reviewStatus(state.reviewKey, ctx.actions.reviewerPid());
      const claimButton = el("button", {
        class: "btn primary large qc-claim",
        type: "button",
        disabled: Boolean(held) || counts.claimable < 1,
        onclick: async () => {
          (claimButton as HTMLButtonElement).disabled = true;
          claimButton.textContent = "Claiming…";
          try {
            const claim = await reviewClaim(state.reviewKey!, ctx.actions.reviewerName(), ctx.actions.reviewerPid());
            if (!claim) { ctx.actions.notifyInfo("Nothing claimable right now."); void refresh(); return; }
            ctx.actions.startReview(claim);
          } catch (error) { ctx.actions.notifyError(error instanceof Error ? error.message : String(error)); void refresh(); }
        },
      }, held ? "Finish your claimed task first" : counts.claimable ? "Claim the next task" : "No task ready") as HTMLButtonElement;
      body.replaceChildren(
        el("div", { class: "qc-queue-tiles" },
          tile(counts.claimable, "ready"), tile(counts.awaiting_live_audit ?? 0, "waiting for Codex check"), tile(counts.locked, "being reviewed")
        ),
        ...(counts.own_pending ? [el("p", { class: "muted small" }, `${counts.own_pending} of your own submissions are excluded.`)] : []),
        ...(counts.own_awaiting_signoff ? [el("button", { class: "btn ghost", type: "button", onclick: () => ctx.actions.goto("my-tasks") }, `${counts.own_awaiting_signoff} approved tasks need your sign-off`)] : []),
        claimButton,
        el("p", { class: "muted small qc-queue-note" }, "Only Apollo PC task sidecars enter this queue. A task becomes ready after its current version completes the Codex live-web check; a claim is private for 30 minutes.")
      );
    } catch (error) {
      body.replaceChildren(el("p", { class: "muted" }, `Couldn't reach the task queue: ${error instanceof Error ? error.message : String(error)}`), el("button", { class: "btn ghost", type: "button", onclick: () => void refresh() }, "Retry"));
    }
  };
  void refresh();
  return root;
}

function tile(value: number, label: string): HTMLElement {
  return el("div", { class: "qc-queue-tile" }, el("strong", { class: "mono" }, String(value)), el("span", null, label));
}
