import type { Ctx } from "../context";
import { el } from "../components/helpers";
import {
  clearClaimSnapshot,
  loadClaimSnapshot,
  reviewClaim,
  reviewRelease,
  reviewStatus,
  type ClaimSnapshot,
} from "../../review-client";

export function renderReviewQueue(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const root = el("section", { class: "screen narrow review-queue-screen" });
  root.append(
    el(
      "header",
      { class: "screen-head" },
      el("h2", { class: "display" }, "Review submitted tasks"),
      el(
        "p",
        { class: "screen-sub" },
        "Claim one long-horizon web request. Read it as an agent, repair unclear wording or rubric lines, then approve useful work or reject tasks that cannot be salvaged."
      )
    )
  );

  const body = el("div", { class: "review-queue-body" });
  root.append(body);

  // Leaving mid-review must never strand the lock (~30 min TTL). The claim
  // can survive in two places: state.reviewClaim (in-app navigation away from
  // review-edit — back/Esc/topbar — keeps the app alive) or the stored
  // snapshot (page refresh/close). Whichever exists, ALWAYS surface a resume
  // card here; without it the task just sits "being reviewed" until the TTL
  // expires with no way back. Lives in its own slot so the queue's async
  // redraws can't wipe it.
  const resumeSlot = el("div");
  root.insertBefore(resumeSlot, body);
  let held: ClaimSnapshot | null = null;

  // The claim button must not offer a second task while one is already held —
  // that would strand the first lock. Called from both the resume and queue
  // draw paths since either can finish first.
  const syncClaimButton = () => {
    const btn = body.querySelector<HTMLButtonElement>(".big-claim");
    if (btn && held) {
      btn.disabled = true;
      btn.textContent = "Finish or release your claimed task first";
    }
  };

  const drawResume = () => {
    if (!held) {
      resumeSlot.replaceChildren();
      syncClaimButton();
      return;
    }
    const snap = held;
    const msLeft = snap.claim.lockTtlMs - (Date.now() - snap.claim.claimedAtMs);
    const mins = Math.max(1, Math.floor(msLeft / 60000));
    const releaseBtn = el(
      "button",
      {
        class: "btn ghost",
        type: "button",
        onclick: async () => {
          releaseBtn.disabled = true;
          releaseBtn.textContent = "Releasing…";
          try {
            await reviewRelease(state.reviewKey!, snap.claim);
          } catch {
            // Expired or taken over — either way it is no longer ours, and
            // clearing the local claim is the right outcome.
          }
          held = null;
          ctx.update({ reviewClaim: null, reviewRubrics: null, reviewEdits: null });
          void clearClaimSnapshot(ctx.adapter.storage);
          drawResume();
          ctx.actions.notifyInfo("Task released back to the queue.");
          void refresh();
        },
      },
      "Release it"
    ) as HTMLButtonElement;
    resumeSlot.replaceChildren(
      el(
        "div",
        { class: "card resume-review" },
        el("h3", null, "Resume your claimed review"),
        el(
          "p",
          { class: "muted", style: "margin:4px 0 10px" },
          `“${snap.claim.task.task.task_title}” is locked to you for ~${mins} more min. Your edits are saved — pick it back up, or release it for another reviewer.`
        ),
        el(
          "div",
          { style: "display:flex; gap:10px" },
          el(
            "button",
            {
              class: "btn primary",
              type: "button",
              onclick: () => {
                state.reviewClaim = snap.claim;
                state.reviewRubrics = snap.rubrics;
                state.reviewEdits = snap.edits;
                ctx.actions.goto("review-edit");
              },
            },
            "Resume that review"
          ),
          releaseBtn
        )
      )
    );
    syncClaimButton();
  };

  if (state.reviewClaim) {
    const msLeft = state.reviewClaim.lockTtlMs - (Date.now() - state.reviewClaim.claimedAtMs);
    if (msLeft <= 0) {
      // The lock already lapsed — anyone may claim it now; resuming would
      // just 409 at submit. Drop it quietly.
      ctx.update({ reviewClaim: null, reviewRubrics: null, reviewEdits: null });
      void clearClaimSnapshot(ctx.adapter.storage);
    } else {
      held = { claim: state.reviewClaim, rubrics: state.reviewRubrics, edits: state.reviewEdits };
      drawResume();
    }
  }
  if (!held) {
    // Fresh mount after a refresh/close: the claim lives only in storage
    // (loadClaimSnapshot already filters out expired ones).
    void loadClaimSnapshot(ctx.adapter.storage).then((snap) => {
      if (!snap || held || state.reviewClaim) return;
      held = snap;
      drawResume();
    });
  }

  const draw = () => {
    body.replaceChildren();
    if (!state.reviewKey) {
      // Only possible in a build made without VITE_REVIEW_KEY — never a
      // reviewer-facing state in team builds.
      body.append(el("p", { class: "muted" }, "Reviewing isn't enabled in this build."));
      return;
    }
    body.append(el("p", { class: "muted status-line" }, "Checking the queue…"));
  };

  const refresh = async () => {
    if (!state.reviewKey) return;
    try {
      // Passing our participant id makes the server exclude our own
      // submissions from pending/claimable — you can't review your own task,
      // so the tiles must not advertise it.
      const counts = await reviewStatus(state.reviewKey, ctx.actions.reviewerPid());
      const me = ctx.actions.reviewerName();
      const mine = (counts.reviewers ?? []).find((r) => r.reviewer === me);
      const reviewerLine = (counts.reviewers ?? [])
        .map((r) => `${r.reviewer === me ? "you" : r.reviewer} ${r.approved + r.rejected}`)
        .join(" · ");
      body.replaceChildren(
        el(
          "div",
          { class: "queue-tiles" },
          el("div", { class: "queue-tile" }, el("strong", null, String(counts.claimable)), el("span", null, "waiting for review")),
          el("div", { class: "queue-tile" }, el("strong", null, String(counts.awaiting_live_audit ?? 0)), el("span", null, "waiting for Codex check")),
          el("div", { class: "queue-tile" }, el("strong", null, String(counts.locked)), el("span", null, "being reviewed now")),
          el("div", { class: "queue-tile" }, el("strong", null, String(counts.approved ?? counts.finished - (counts.rejected ?? 0))), el("span", null, "approved")),
          el("div", { class: "queue-tile" }, el("strong", null, String(counts.rejected ?? 0)), el("span", null, "rejected"))
        ),
        ...(counts.own_awaiting_signoff
          ? [
              el(
                "div",
                { class: "card signoff-callout" },
                el("h3", null, "Your tasks are waiting on you"),
                el(
                  "p",
                  { class: "muted", style: "margin:4px 0 10px" },
                  `${counts.own_awaiting_signoff} of your approved task${counts.own_awaiting_signoff === 1 ? " has" : "s have"} been through review and ${counts.own_awaiting_signoff === 1 ? "is" : "are"} waiting for you to sign off. You can accept the reviewer's version or make your own final.`
                ),
                el(
                  "button",
                  {
                    class: "btn primary",
                    type: "button",
                    onclick: () => ctx.actions.goto("my-tasks"),
                  },
                  "Go to My tasks"
                )
              ),
            ]
          : []),
        ...(counts.own_pending
          ? [
              el(
                "p",
                { class: "muted small" },
                `${counts.own_pending} of the waiting tasks ${counts.own_pending === 1 ? "is" : "are"} your own submission${counts.own_pending === 1 ? "" : "s"} — you can't review your own tasks, so ${counts.own_pending === 1 ? "it isn't" : "they aren't"} counted above.`
              ),
            ]
          : []),
        ...(mine
          ? [
              el(
                "p",
                { class: "reviewer-line" },
                el("strong", null, `You: ${mine.approved} approved · ${mine.rejected} rejected`),
                counts.reviewers && counts.reviewers.length > 1 ? el("span", { class: "muted" }, `  —  total: ${reviewerLine}`) : null
              ),
            ]
          : counts.reviewers?.length
            ? [el("p", { class: "reviewer-line muted" }, `Reviews so far: ${reviewerLine}`)]
            : []),
        counts.claimable > 0
          ? el(
              "button",
              {
                class: "btn primary big-claim",
                type: "button",
                onclick: async () => {
                  const btn = body.querySelector<HTMLButtonElement>(".big-claim");
                  if (btn) {
                    btn.disabled = true;
                    btn.textContent = "Claiming…";
                  }
                  try {
                    const claim = await reviewClaim(state.reviewKey!, ctx.actions.reviewerName(), ctx.actions.reviewerPid());
                    if (!claim) {
                      ctx.actions.notifyInfo("Nothing claimable right now — another reviewer got there first, or an upload is still settling. Refresh in a moment.");
                      void refresh();
                      return;
                    }
                    ctx.actions.startReview(claim);
                  } catch (err) {
                    ctx.actions.notifyError(err instanceof Error ? err.message : String(err));
                    void refresh();
                  }
                },
              },
              "Claim the next task"
            )
          : el(
              "p",
              { class: "muted" },
              counts.submitted === 0
                ? "No tasks submitted yet."
                : counts.awaiting_live_audit
                  ? "The next tasks are still being checked by Codex. They will appear here automatically when that live audit finishes."
                  : "Nothing left to claim — check back soon."
            ),
        el(
          "p",
          { class: "muted small" },
          "A task appears here only after its current Codex live audit finishes. A claim then locks it to you for 30 minutes so reviewers never collide. Your own submissions are never offered to you."
        )
      );
      syncClaimButton();
    } catch (err) {
      body.replaceChildren(
        el("p", { class: "muted" }, `Couldn't reach the review queue: ${err instanceof Error ? err.message : String(err)}`),
        el(
          "button",
          {
            class: "btn ghost",
            type: "button",
            onclick: () => {
              draw();
              void refresh();
            },
          },
          "Retry"
        )
      );
    }
  };

  draw();
  if (state.reviewKey) void refresh();

  root.append(
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn ghost", type: "button", onclick: () => ctx.actions.goto("home") }, "Back to home")
    )
  );
  return root;
}
