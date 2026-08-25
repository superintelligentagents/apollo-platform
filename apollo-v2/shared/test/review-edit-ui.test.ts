// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LongTask } from "../src/types";
import type { Ctx } from "../src/ui/context";
import { initialState } from "../src/ui/context";
import { conciseReviewText, plainReviewText, renderReviewEdit } from "../src/ui/screens/review-edit";

const llmFeedbackMock = vi.hoisted(() => vi.fn(async () => ({ status: "not_reviewed", stale: false, review: null })));
vi.mock("../src/review-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/review-client")>()),
  reviewLlmFeedback: llmFeedbackMock,
}));

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

  it("shows the original author's rationale on an appeal without naming the first reviewer", () => {
    const task = claimedTask();
    task.appeal_of_sub_key = "prolific/journeys/author/rejected.json";
    task.appeal_number = 1;
    task.appeal_reason = "The prompt already specifies the market and current first-party sources.";
    const state = initialState();
    state.reviewKey = "test-key";
    state.reviewClaim = {
      subKey: "appeal.json",
      token: "token",
      task,
      lockTtlMs: 30 * 60 * 1000,
      claimedAtMs: Date.now(),
    };
    const root = renderReviewEdit({
      state,
      adapter: { storage: { set: vi.fn(async () => {}), get: vi.fn(async () => null) } },
      actions: { reviewerName: () => "Fresh Reviewer" },
    } as unknown as Ctx);

    const context = root.querySelector<HTMLElement>('[aria-label="Author appeal"]')!;
    expect(context.textContent).toContain("Author appeal · fresh review required");
    expect(context.textContent).toContain(task.appeal_reason);
    expect(context.textContent).toContain("reviewer who rejected it is excluded");
    expect(context.textContent).not.toMatch(/reviewed by/i);
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

  it("requires a clear rejection reason before confirming rejection", () => {
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
    const reject = Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Reject task")!;
    const reason = root.querySelector<HTMLTextAreaElement>("#review-rejection-reason")!;
    const confirm = Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Confirm reject")!;
    const rejectRow = root.querySelector<HTMLElement>(".reject-row")!;

    expect(rejectRow.style.display).toBe("none");
    expect(reason.maxLength).toBe(500);
    expect(confirm.disabled).toBe(true);

    reject.click();
    expect(rejectRow.style.display).toBe("");
    expect(root.textContent).toContain("Reason for rejection");
    expect(root.textContent).toContain("cannot be repaired without replacing its core goal");

    reason.value = "No";
    reason.dispatchEvent(new Event("input"));
    expect(confirm.disabled).toBe(true);

    reason.value = "The core task requires private account access.";
    reason.dispatchEvent(new Event("input"));
    expect(confirm.disabled).toBe(false);
    expect(root.textContent).toContain(`${reason.value.length} / 500`);
  });

  function threeStepTask(): LongTask {
    const base = claimedTask();
    base.task.steps = [
      { order: 1, title: "Find", description: "Find the three candidate hotels." },
      { order: 2, title: "Compare", description: "Compare their prices and locations." },
      { order: 3, title: "Decide", description: "Pick one and justify the choice." },
    ];
    return base;
  }

  function ctxFor(taskValue: LongTask) {
    const state = initialState();
    state.reviewKey = "test-key";
    state.reviewClaim = { subKey: "submission.json", token: "token", task: taskValue, lockTtlMs: 30 * 60 * 1000, claimedAtMs: Date.now() };
    return {
      state,
      adapter: { storage: { set: vi.fn(async () => {}), get: vi.fn(async () => null) } },
      actions: { reviewerName: () => "Reviewer" },
    } as unknown as Ctx;
  }

  const rowTexts = (root: HTMLElement) => [...root.querySelectorAll<HTMLTextAreaElement>(".rubric-text")].map((t) => t.value);

  it("lists every removed step and restores each one in its original order", () => {
    const root = renderReviewEdit(ctxFor(threeStepTask()));
    let rows = root.querySelectorAll(".rubric-row");
    const secondCheck = rows[1].querySelector<HTMLInputElement>(".rubric-check")!;
    secondCheck.checked = true;
    secondCheck.dispatchEvent(new Event("change"));

    (rows[1].querySelector(".rubric-summary") as HTMLButtonElement).click();
    (rows[1].querySelector(".rubric-remove") as HTMLButtonElement).click();

    rows = root.querySelectorAll(".rubric-row");
    (rows[1].querySelector(".rubric-summary") as HTMLButtonElement).click();
    (rows[1].querySelector(".rubric-remove") as HTMLButtonElement).click();

    expect(rowTexts(root)).toEqual(["Find the three candidate hotels."]);
    const removedSection = root.querySelector<HTMLElement>(".removed-rubrics")!;
    expect(removedSection.hidden).toBe(false);
    expect(removedSection.textContent).toContain("Removed rubrics");
    expect(removedSection.textContent).toContain("Compare their prices and locations.");
    expect(removedSection.textContent).toContain("Pick one and justify the choice.");

    const undoButtons = removedSection.querySelectorAll<HTMLButtonElement>(".removed-rubric-undo");
    expect(undoButtons).toHaveLength(2);
    undoButtons[1].click();
    expect(rowTexts(root)).toEqual(["Find the three candidate hotels.", "Pick one and justify the choice."]);

    (removedSection.querySelector(".removed-rubric-undo") as HTMLButtonElement).click();

    rows = root.querySelectorAll(".rubric-row");
    expect(rowTexts(root)).toEqual([
      "Find the three candidate hotels.",
      "Compare their prices and locations.",
      "Pick one and justify the choice.",
    ]);
    expect(rows[1].querySelector<HTMLInputElement>(".rubric-check")?.checked).toBe(true);
    expect(rows[1].classList.contains("expanded")).toBe(true);
    expect(removedSection.hidden).toBe(true);
  });

  it("persists removed rubrics in the claim snapshot for refresh-resume recovery", () => {
    const ctx = ctxFor(threeStepTask());
    const root = renderReviewEdit(ctx);
    const rows = root.querySelectorAll(".rubric-row");
    (rows[1].querySelector(".rubric-summary") as HTMLButtonElement).click();
    (rows[1].querySelector(".rubric-remove") as HTMLButtonElement).click();

    const storageSet = vi.mocked(ctx.adapter.storage.set);
    const saved = JSON.parse(String(storageSet.mock.calls.at(-1)?.[1]));
    expect(saved.removedRubrics).toHaveLength(1);
    expect(saved.removedRubrics[0]).toMatchObject({
      index: 1,
      row: { text: "Compare their prices and locations.", checked: false, sourceIndex: 1 },
    });

    const resumedState = initialState();
    resumedState.reviewKey = "test-key";
    resumedState.reviewClaim = saved.claim;
    resumedState.reviewRubrics = saved.rubrics;
    resumedState.reviewRemovedRubrics = saved.removedRubrics;
    resumedState.reviewEdits = saved.edits;
    const resumedCtx = {
      state: resumedState,
      adapter: { storage: { set: vi.fn(async () => {}), get: vi.fn(async () => null) } },
      actions: { reviewerName: () => "Reviewer" },
    } as unknown as Ctx;
    const resumedRoot = renderReviewEdit(resumedCtx);
    expect(rowTexts(resumedRoot)).toEqual(["Find the three candidate hotels.", "Pick one and justify the choice."]);
    (resumedRoot.querySelector(".removed-rubric-undo") as HTMLButtonElement).click();
    expect(rowTexts(resumedRoot)).toEqual([
      "Find the three candidate hotels.",
      "Compare their prices and locations.",
      "Pick one and justify the choice.",
    ]);
  });

  it("keeps Codex results bound to their own step when another step is deleted", async () => {
    llmFeedbackMock.mockResolvedValueOnce({
      status: "pre_qc_attention",
      stale: false,
      review: {
        status: "NEEDS_HUMAN_REVIEW",
        manager_disposition: "FEASIBLE",
        manager_summary: "",
        task_feedback: null,
        task_repair: null,
        quality: null,
        rubrics: [
          { rubric_id: "rubric-1", verdict: "POSSIBLE", quality_verdict: "PASS", summary: "Step one checks out.", feedback: null, quality_summary: null, quality_issues: [], blockers: [], evidence: [], repair: null },
          { rubric_id: "rubric-2", verdict: "SHORTFALL", quality_verdict: "PASS", summary: "The comparison source is missing.", feedback: null, quality_summary: null, quality_issues: [], blockers: [], evidence: [], repair: null },
          { rubric_id: "rubric-3", verdict: "POSSIBLE", quality_verdict: "PASS", summary: "The decision is checkable.", feedback: null, quality_summary: null, quality_issues: [], blockers: [], evidence: [], repair: null },
        ],
      },
    } as never);
    const root = renderReviewEdit(ctxFor(threeStepTask()));
    await vi.waitFor(() => expect(root.querySelectorAll(".llm-rubric-badges").length).toBe(3));
    let rows = root.querySelectorAll(".rubric-row");
    expect(rows[1].textContent).toContain("Feasibility: review");
    // Delete step 2 (the one Codex flagged).
    (rows[1].querySelector(".rubric-summary") as HTMLButtonElement).click();
    (rows[1].querySelector(".rubric-remove") as HTMLButtonElement).click();
    rows = root.querySelectorAll(".rubric-row");
    expect(rows).toHaveLength(2);
    expect(rowTexts(root)).toEqual(["Find the three candidate hotels.", "Pick one and justify the choice."]);
    // The bug: old step 3 used to inherit rubric-2's "Feasibility: review".
    expect(rows[1].textContent).not.toContain("Feasibility: review");
    expect(rows[1].textContent).toContain("Feasible");
    // Positional renumbering: the surviving rows read S1 / S2.
    expect([...root.querySelectorAll(".rubric-num")].map((n) => n.textContent)).toEqual(["S1", "S2"]);
    // Open old step 3 and confirm its own Codex summary rode along.
    (rows[1].querySelector(".rubric-summary") as HTMLButtonElement).click();
    expect(rows[1].textContent).toContain("The decision is checkable.");
    expect(rows[1].textContent).not.toContain("The comparison source is missing.");
  });

  it("inserts a step at any position and reorders with move buttons", () => {
    const root = renderReviewEdit(ctxFor(threeStepTask()));
    // Insert between step 1 and step 2.
    const dividers = root.querySelectorAll<HTMLButtonElement>(".rubric-insert");
    expect(dividers).toHaveLength(3);
    dividers[1].click();
    let texts = rowTexts(root);
    expect(texts).toEqual(["Find the three candidate hotels.", "", "Compare their prices and locations.", "Pick one and justify the choice."]);
    // The inserted row has no Codex result of its own.
    const rows = root.querySelectorAll(".rubric-row");
    expect(rows[1].textContent).toContain("Codex not run");
    expect(rows[1].textContent).toContain("Added during review");
    // Fill it in, then move it down one place.
    const editor = rows[1].querySelector(".rubric-text") as HTMLTextAreaElement;
    editor.value = "Check the cancellation policies.";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    (root.querySelectorAll(".rubric-row")[1].querySelectorAll<HTMLButtonElement>(".rubric-move")[1]).click();
    texts = rowTexts(root);
    expect(texts).toEqual(["Find the three candidate hotels.", "Compare their prices and locations.", "Check the cancellation policies.", "Pick one and justify the choice."]);
    // First row's up arrow and last row's down arrow are disabled.
    const allRows = root.querySelectorAll(".rubric-row");
    expect(allRows[0].querySelectorAll<HTMLButtonElement>(".rubric-move")[0].disabled).toBe(true);
    expect(allRows[3].querySelectorAll<HTMLButtonElement>(".rubric-move")[1].disabled).toBe(true);
  });
});
