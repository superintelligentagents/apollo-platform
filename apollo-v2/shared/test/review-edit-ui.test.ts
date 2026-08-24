// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LongTask } from "../src/types";
import type { Ctx } from "../src/ui/context";
import { initialState } from "../src/ui/context";
import { conciseReviewText, plainReviewText, renderReviewEdit } from "../src/ui/screens/review-edit";

function claimedTask(): LongTask {
  return {
    schema_version: "odyssey_long_task_v2",
    task_id: "v2/reviewer/internal/task-ui-test",
    mode: "guided",
    created_at: "2026-07-31T00:00:00.000Z",
    app: { name: "Apollo", version: "0.2.0", platform: "web" },
    participant: {
      kind: "internal",
      participant_id: "author",
      session_id: null,
      name: null,
      email: null,
      consent: { version: "1", accepted_at: "2026-07-31T00:00:00.000Z" },
    },
    task: {
      task_title: "A review task",
      agent_request: "Review this long request with enough detail.",
      task_summary: null,
      difficulty: "high",
      site_scope: [],
      success_criteria: ["A long criterion whose complete content must be available in the editor without truncation."],
      must_visit_or_reach: [],
      required_outputs: [],
      notes: null,
      time_span: { start: null, end: null },
      steps: [{ order: 1, title: "Collect evidence", description: "Open the sources and collect evidence for every material claim." }],
    },
    provenance: { source_journeys: [], theme_suggestion: null, template: null, attached_urls: [] },
  };
}

describe("review rubric editor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("translates older pipeline jargon before showing it to reviewers", () => {
    const text = plainReviewText(
      "The feasibility manager marked this rubric IMPOSSIBLE because the population is not enumerable and compatibility failed."
    );

    expect(text).toBe(
      "This step needs attention because the population is not possible to list completely and the step does not fit the task."
    );
    expect(text).not.toMatch(/rubric|IMPOSSIBLE|enumerable|compatibility|feasibility manager/i);
    expect(plainReviewText(
      "The complete task is not presently feasible. The essential step‑2 impossibility alone requires NOT_FEASIBLE."
    )).toBe(
      "The complete task cannot currently be completed. The problem in step 2 alone means the task cannot be completed as written."
    );
    expect(plainReviewText(
      "The browser escalation could not resolve the verifier-access limitation because Playwright navigation to the supplied targets failed."
    )).toBe(
      "The website check could not resolve the limitation of the automated check because opening the referenced websites failed."
    );
    expect(conciseReviewText("First useful sentence. Second useful sentence. Third unnecessary sentence.", 200))
      .toBe("First useful sentence. Second useful sentence.");
  });

  it("uses the complete task steps as the clickable editable rubric", () => {
    const state = initialState();
    state.reviewKey = "test-key";
    state.reviewClaim = {
      subKey: "submission.json",
      token: "token",
      task: claimedTask(),
      lockTtlMs: 30 * 60 * 1000,
      claimedAtMs: Date.now(),
    };
    const ctx = {
      state,
      adapter: { storage: { set: vi.fn(async () => {}), get: vi.fn(async () => null) } },
      actions: { reviewerName: () => "Reviewer" },
    } as unknown as Ctx;

    const root = renderReviewEdit(ctx);
    const summaries = root.querySelectorAll<HTMLButtonElement>(".rubric-summary");
    const editorPanels = root.querySelectorAll<HTMLElement>(".rubric-editor");
    const editors = root.querySelectorAll<HTMLTextAreaElement>(".rubric-text");
    const request = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Full task request"]');
    const requestColumn = root.querySelector(".review-request-column");

    expect(root.textContent).toContain("Review task");
    expect(root.textContent).toContain("Review the task in two short passes.");
    expect(root.textContent).toContain("Task prompt");
    expect(root.textContent).toContain("live web");
    expect(root.textContent).toContain("Rubrics");
    expect(root.textContent).toContain("Open & edit");
    expect(root.textContent).toContain("Codex not run");
    expect(root.textContent).not.toContain("Task title");
    expect(root.textContent).not.toContain("Rubrics and steps");
    expect(root.textContent).not.toContain("Click to view the full text and edit");
    expect(request?.value).toBe("Review this long request with enough detail.");
    expect(requestColumn?.children[0].querySelector("textarea")).toBe(request);
    expect(requestColumn?.children[1].classList.contains("review-evergreen-check")).toBe(true);
    expect(requestColumn?.children[2].classList.contains("llm-preqc-slot")).toBe(true);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].textContent).toContain("Step 1 · Collect evidence");
    expect(editors[0].getAttribute("aria-label")).toBe("Step 1 text");
    expect(editorPanels[0].hidden).toBe(true);

    summaries[0].click();

    expect(summaries[0].getAttribute("aria-expanded")).toBe("true");
    expect(editorPanels[0].hidden).toBe(false);
    expect(editors[0].value).toBe("Open the sources and collect evidence for every material claim.");
    expect(root.textContent).toContain("Still works later");
    expect(root.textContent).toContain("The task can be completed at any later date");
  });

  it("requires both every step and the evergreen QC confirmation before approval", () => {
    const state = initialState();
    state.reviewKey = "test-key";
    state.reviewClaim = {
      subKey: "submission.json",
      token: "token",
      task: claimedTask(),
      lockTtlMs: 30 * 60 * 1000,
      claimedAtMs: Date.now(),
    };
    const ctx = {
      state,
      adapter: { storage: { set: vi.fn(async () => {}), get: vi.fn(async () => null) } },
      actions: { reviewerName: () => "Reviewer" },
    } as unknown as Ctx;

    const root = renderReviewEdit(ctx);
    const approve = Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Approve"))!;
    const step = root.querySelector<HTMLInputElement>('input[aria-label="Step 1 verified"]')!;
    const evergreen = root.querySelector<HTMLInputElement>('input[aria-label="Task is evergreen and remains feasible when run later"]')!;

    expect(approve.disabled).toBe(true);
    step.checked = true;
    step.dispatchEvent(new Event("change"));
    expect(approve.disabled).toBe(true);
    evergreen.checked = true;
    evergreen.dispatchEvent(new Event("change"));
    expect(approve.disabled).toBe(false);
  });
});

describe("return to author", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reveals a reason row and sends the task back to the author on confirm", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, returned_key: "rk" }) })));
    const state = initialState();
    state.reviewKey = "test-key";
    state.reviewClaim = {
      subKey: "s1",
      token: "tok",
      task: claimedTask(),
      lockTtlMs: 30 * 60 * 1000,
      claimedAtMs: Date.now(),
    };
    const endReview = vi.fn();
    const notifyError = vi.fn();
    const ctx = {
      state,
      adapter: { storage: { set: vi.fn(async () => {}), get: vi.fn(async () => null) } },
      actions: { reviewerName: () => "Reviewer", endReview, notifyError },
    } as unknown as Ctx;

    const root = renderReviewEdit(ctx);
    const returnBtn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.includes("Return to author")
    )!;
    expect(returnBtn).toBeTruthy();
    returnBtn.click();
    const rows = root.querySelectorAll<HTMLElement>(".reject-row");
    const returnRow = rows[rows.length - 1];
    expect(returnRow.style.display).not.toBe("none");

    const reason = returnRow.querySelector<HTMLInputElement>("input.reject-reason")!;
    reason.value = "Step 1 needs a verifiable source.";
    reason.dispatchEvent(new Event("input"));
    const confirm = returnRow.querySelector<HTMLButtonElement>("button.btn.primary")!;
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(endReview).toHaveBeenCalledWith("Sent back to the author for revision.");
    expect(notifyError).not.toHaveBeenCalled();
  });
  it("holds a rejection until the reason is long enough to act on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, rejected_key: "rk" }) })));
    const state = initialState();
    state.reviewKey = "test-key";
    state.reviewClaim = {
      subKey: "s1",
      token: "tok",
      task: claimedTask(),
      lockTtlMs: 30 * 60 * 1000,
      claimedAtMs: Date.now(),
    };
    const ctx = {
      state,
      adapter: { storage: { set: vi.fn(async () => {}), get: vi.fn(async () => null) } },
      actions: {
        reviewerName: () => "Reviewer",
        reviewerPid: () => "reviewer",
        endReview: vi.fn(),
        notifyError: vi.fn(),
      },
    } as unknown as Ctx;

    const root = renderReviewEdit(ctx);
    Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((b) => b.textContent?.includes("Reject task"))!
      .click();
    const rejectRow = root.querySelector<HTMLElement>(".reject-row")!;
    const reason = rejectRow.querySelector<HTMLInputElement>("input.reject-reason")!;
    const confirm = rejectRow.querySelector<HTMLButtonElement>("button.btn.danger")!;

    // The kind of verdict that used to get through, and that an author cannot
    // do anything with.
    reason.value = "spam";
    reason.dispatchEvent(new Event("input"));
    expect(confirm.disabled).toBe(true);

    reason.value = "The core objective depends on live prices that go stale within a week.";
    reason.dispatchEvent(new Event("input"));
    expect(confirm.disabled).toBe(false);
  });

  it("sends the reviewer's step notes to the author with a rejection", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ ok: true, rejected_key: "rk" }) })
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = initialState();
    state.reviewKey = "test-key";
    state.reviewClaim = {
      subKey: "s1",
      token: "tok",
      task: claimedTask(),
      lockTtlMs: 30 * 60 * 1000,
      claimedAtMs: Date.now(),
    };
    const ctx = {
      state,
      adapter: { storage: { set: vi.fn(async () => {}), get: vi.fn(async () => null) } },
      actions: {
        reviewerName: () => "Reviewer",
        reviewerPid: () => "reviewer",
        endReview: vi.fn(),
        notifyError: vi.fn(),
      },
    } as unknown as Ctx;

    const root = renderReviewEdit(ctx);
    Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((b) => b.textContent?.includes("Reject task"))!
      .click();
    const rejectRow = root.querySelector<HTMLElement>(".reject-row")!;
    const reason = rejectRow.querySelector<HTMLInputElement>("input.reject-reason")!;
    reason.value = "The core objective depends on live prices that go stale within a week.";
    reason.dispatchEvent(new Event("input"));
    rejectRow.querySelector<HTMLButtonElement>("button.btn.danger")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rejectCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/review/reject"))!;
    const body = JSON.parse(String(rejectCall[1]?.body));
    expect(body.review.rubrics.length).toBeGreaterThan(0);
    expect(body.reviewer_pid).toBe("reviewer");
    // The author gets the substance without the name attached to it.
    expect(body.review.rubrics[0]).not.toHaveProperty("reviewer");
  });
});
