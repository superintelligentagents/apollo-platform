// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewLongTask } from "../src/types";
import { initialState, type Ctx } from "../src/ui/context";
import { renderTaskReviewQueue } from "../src/ui/screens/task-review-queue";
import { renderTrajectoryQueue } from "../src/ui/screens/trajectory-queue";

const claimedTask = {
  task_id: "task-1",
  task: { task_title: "Claimed task" },
} as unknown as ReviewLongTask;

function response(body: Record<string, unknown>): Response {
  return { ok: true, json: async () => body } as Response;
}

function context(): Ctx {
  const state = initialState();
  state.reviewKey = "review-key";
  const storage = { get: vi.fn(async () => null), set: vi.fn(async () => {}) };
  const ctx = {
    state,
    adapter: { storage },
    update: (patch: Partial<typeof state>) => Object.assign(state, patch),
    rerender: vi.fn(),
    actions: {
      reviewerName: () => "Reviewer",
      reviewerPid: () => "reviewer-pid",
      notifyInfo: vi.fn(),
      notifyError: vi.fn(),
      startReview: vi.fn(),
      startTrajectoryReview: vi.fn(),
      goto: vi.fn(),
    },
  } as unknown as Ctx;
  return ctx;
}

describe("enabled reviewer queues", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("drops an expired task claim and shows Apollo v2 reviewer totals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      submitted: 12,
      finished: 4,
      locked: 1,
      pending: 8,
      claimable: 7,
      awaiting_live_audit: 1,
      approved: 3,
      rejected: 1,
      own_pending: 0,
      reviewers: [{ reviewer: "Reviewer", approved: 2, rejected: 1 }, { reviewer: "Teammate", approved: 1, rejected: 0 }],
    })));
    const ctx = context();
    ctx.state.reviewClaim = { subKey: "sub", token: "token", task: claimedTask, claimedAtMs: Date.now() - 31 * 60_000, lockTtlMs: 30 * 60_000 };

    const root = renderTaskReviewQueue(ctx);
    await vi.waitFor(() => expect(root.textContent).toContain("You: 2 approved · 1 rejected"));
    expect(ctx.state.reviewClaim).toBeNull();
    expect(root.textContent).toContain("total: you 3 · Teammate 1");
    expect(root.querySelector<HTMLButtonElement>(".qc-claim")?.disabled).toBe(false);
  });

  it("drops an expired trajectory claim and explains creator assignment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ submitted: 4, finished: 1, locked: 0, pending: 2, claimable: 2, assigned_to_you: 2, assigned_to_others: 1 })));
    const ctx = context();
    ctx.state.trajectoryClaim = {
      manifestKey: "run/manifest.json",
      token: "token",
      claimedAtMs: Date.now() - 31 * 60_000,
      lockTtlMs: 30 * 60_000,
      run: { task_id: "task-1" },
    } as NonNullable<typeof ctx.state.trajectoryClaim>;
    ctx.state.trajectoryJudgment = { rubrics: [], trajectory: { overall_outcome: "", task_satisfied: "", notes: "" } };

    const root = renderTrajectoryQueue(ctx);
    await vi.waitFor(() => expect(root.textContent).toContain("assigned to the expert who originally created the task"));
    expect(ctx.state.trajectoryClaim).toBeNull();
    expect(root.querySelector<HTMLButtonElement>(".qc-claim")?.disabled).toBe(false);
  });
});
