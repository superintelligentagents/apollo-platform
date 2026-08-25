// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { canAccessAdminDashboard } from "../src/ui/app";
import { initialState, type Ctx } from "../src/ui/context";
import { renderHome } from "../src/ui/screens/home";
import { renderReviewQueue } from "../src/ui/screens/review-queue";

const reviewStatusMock = vi.hoisted(() => vi.fn());
vi.mock("../src/review-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/review-client")>()),
  reviewStatus: reviewStatusMock,
}));

function trainerContext(): Ctx {
  const state = initialState();
  state.reviewKey = "test-review-key";
  state.uploadedCount = 27;
  state.identity = {
    kind: "internal",
    participantId: "",
    name: "Trainer",
    email: "trainer@example.com",
    consent: { version: "test", accepted_at: "2026-08-25T00:00:00.000Z" },
  };
  return {
    state,
    adapter: {
      storage: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => {}),
      },
    },
    update: (patch: Partial<typeof state>) => Object.assign(state, patch),
    actions: {
      reviewerPid: () => "trainer-example-com",
      reviewerName: () => "Trainer",
      goto: vi.fn(),
      notifyInfo: vi.fn(),
      notifyError: vi.fn(),
    },
  } as unknown as Ctx;
}

describe("trainer metric visibility", () => {
  it("keeps the aggregate dashboard admin-only", () => {
    expect(canAccessAdminDashboard("trainer@example.com")).toBe(false);
    expect(canAccessAdminDashboard("kyle.waters@turing.com")).toBe(true);
  });

  it("does not put a submission counter on the trainer home screen", () => {
    const root = renderHome(trainerContext());
    expect(root.textContent).toContain("Create a new task");
    expect(root.textContent).not.toContain("27 submitted");
  });

  it("shows operational queue state without approval totals or reviewer rankings", async () => {
    reviewStatusMock.mockResolvedValue({
      submitted: 1900,
      finished: 1818,
      locked: 2,
      pending: 5,
      claimable: 3,
      awaiting_live_audit: 77,
      approved: 1388,
      rejected: 430,
      own_pending: 0,
      own_awaiting_signoff: 0,
      reviewers: [
        { reviewer: "Trainer", approved: 10, rejected: 2 },
        { reviewer: "Another Reviewer", approved: 200, rejected: 25 },
      ],
    });

    const root = renderReviewQueue(trainerContext());
    await vi.waitFor(() => expect(root.textContent).toContain("3waiting for review"));

    expect(root.querySelectorAll(".queue-tile")).toHaveLength(3);
    expect(root.textContent).toContain("77waiting for Codex check");
    expect(root.textContent).toContain("2being reviewed now");
    expect(root.textContent).not.toContain("1388");
    expect(root.textContent).not.toContain("430");
    expect(root.textContent).not.toContain("Another Reviewer");
    expect(root.textContent).not.toContain("Reviews so far");
    expect(root.textContent).not.toContain("You:");
  });
});
