// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../src/ui/context";
import { initialState } from "../src/ui/context";
import { renderMyTasks } from "../src/ui/screens/my-tasks";
import {
  authorEdit,
  myTaskFeedback,
  myTasks,
  type LlmReviewForHuman,
  type LlmRubricReviewForHuman,
  type MyTaskCurrentContent,
  type MyTaskFeedback,
  type MyTaskItem,
} from "../src/review-client";

vi.mock("../src/review-client", () => ({
  myTasks: vi.fn(),
  myTaskFeedback: vi.fn(),
  authorEdit: vi.fn(),
}));

const mockMyTasks = vi.mocked(myTasks);
const mockMyTaskFeedback = vi.mocked(myTaskFeedback);
const mockAuthorEdit = vi.mocked(authorEdit);

function identity() {
  return {
    kind: "internal" as const,
    participantId: "author",
    name: "Author",
    email: "author@example.com",
    consent: { version: "1", accepted_at: "2026-08-01T00:00:00.000Z" },
  };
}

function ctx(): Ctx {
  return {
    state: { ...initialState(), identity: identity(), reviewKey: "review-key" },
    adapter: { storage: { set: vi.fn(async () => {}), get: vi.fn(async () => null) } },
    actions: { goto: vi.fn(), notifyInfo: vi.fn(), notifyError: vi.fn() },
  } as unknown as Ctx;
}

function item(over: Partial<MyTaskItem> = {}): MyTaskItem {
  return {
    task_id: "t1",
    sub_key: "s1",
    title: "Task A",
    request: "Do something substantial on the live web.",
    status: "pending",
    submitted_at: "2026-08-01T00:00:00.000Z",
    content_hash: null,
    ...over,
  };
}

function feedback(over: Partial<MyTaskFeedback> = {}): MyTaskFeedback {
  return { status: "not_reviewed", stale: false, task_content_hash: null, review: null, ...over };
}

function currentTask(): MyTaskCurrentContent {
  return {
    title: "Task A",
    request: "Do something substantial on the live web.",
    difficulty: "high",
    criteria: [],
    steps: [
      { order: 1, title: "One", description: "first" },
      { order: 2, title: "Two", description: "second" },
      { order: 3, title: "Three", description: "third" },
    ],
    must_visit_or_reach: [],
    required_outputs: [],
    notes: null,
  };
}

function rubric(rubricId: string, suggestion?: string): LlmRubricReviewForHuman {
  return {
    rubric_id: rubricId,
    verdict: "IMPOSSIBLE",
    summary: null,
    feedback: null,
    quality_verdict: null,
    quality_summary: null,
    quality_issues: [],
    blockers: [],
    evidence: [],
    repair: suggestion
      ? {
          repair_kind: "rubric",
          quality_verdict: null,
          reason: null,
          suggested_rubric_text: suggestion,
          verified_possible: true,
        }
      : null,
  };
}

function llmReview(rubrics: LlmRubricReviewForHuman[]): LlmReviewForHuman {
  return {
    schema_version: "apollo-llm-review-for-human-v1",
    advisory_only: true,
    task_id: "t1",
    task_content_hash: null,
    pipeline_version: null,
    reviewed_at_utc: null,
    status: "LLM_FAIL",
    manager_disposition: null,
    manager_summary: null,
    task_feedback: null,
    quality: null,
    evergreen: null,
    projected_task_status: null,
    task_repair: null,
    rubrics,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function btn(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.includes(text));
}

async function openEditor(root: HTMLElement): Promise<void> {
  const row = root.querySelector<HTMLDetailsElement>(".admin-submission")!;
  row.open = true;
  row.dispatchEvent(new Event("toggle"));
  await flush();
  btn(root, "Edit task")!.click();
  await flush();
}

describe("my tasks screen", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    mockMyTasks.mockReset();
    mockMyTaskFeedback.mockReset();
    mockAuthorEdit.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading state then the author's task list", async () => {
    mockMyTasks.mockResolvedValue([
      item({ task_id: "t1", title: "Task A", status: "pending" }),
      item({ task_id: "t2", sub_key: "s2", title: "Task B", status: "approved" }),
    ]);
    const root = renderMyTasks(ctx());
    expect(root.textContent).toContain("Loading your tasks…");

    await flush();

    expect(root.textContent).toContain("Task A");
    expect(root.textContent).toContain("Task B");
    expect(root.querySelectorAll(".admin-submission")).toHaveLength(2);
    expect(root.textContent).toContain("Back to home");
  });

  it("shows an empty state when the author has no tasks", async () => {
    mockMyTasks.mockResolvedValue([]);
    const root = renderMyTasks(ctx());
    await flush();
    expect(root.textContent).toContain("You haven't submitted any tasks yet.");
  });

  it("shows a retry button when the list fails to load", async () => {
    mockMyTasks.mockRejectedValue(new Error("boom"));
    const root = renderMyTasks(ctx());
    await flush();
    expect(root.textContent).toContain("Couldn't load your tasks: boom");
    expect(root.querySelector("button")?.textContent).toContain("Retry");
  });

  it("shows a rejected reason line and a danger badge", async () => {
    mockMyTasks.mockResolvedValue([
      item({ status: "rejected", rejection_reason: "Unsalvageable as written." }),
    ]);
    const root = renderMyTasks(ctx());
    await flush();
    expect(root.textContent).toContain("Unsalvageable as written.");
    const badge = root.querySelector(".badge.danger");
    expect(badge?.textContent).toBe("Rejected");
  });

  it("fetches feedback on expand and offers an edit button for a pending task", async () => {
    mockMyTasks.mockResolvedValue([item({ status: "pending" })]);
    mockMyTaskFeedback.mockResolvedValue(feedback());
    const root = renderMyTasks(ctx());
    await flush();

    const row = root.querySelector<HTMLDetailsElement>(".admin-submission")!;
    row.open = true;
    row.dispatchEvent(new Event("toggle"));
    await flush();

    expect(mockMyTaskFeedback).toHaveBeenCalledWith("review-key", "author", "s1");
    expect(root.textContent).toContain("Your task");
    const editBtn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Edit task")
    );
    expect(editBtn).toBeTruthy();
  });

  it("locks an in-review task with no edit button", async () => {
    mockMyTasks.mockResolvedValue([item({ status: "in_review" })]);
    mockMyTaskFeedback.mockResolvedValue(feedback({ status: "not_reviewed" }));
    const root = renderMyTasks(ctx());
    await flush();

    const row = root.querySelector<HTMLDetailsElement>(".admin-submission")!;
    row.open = true;
    row.dispatchEvent(new Event("toggle"));
    await flush();

    expect(root.textContent).toContain("A reviewer is currently reviewing this task — it's locked.");
    const editBtn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Edit task")
    );
    expect(editBtn).toBeFalsy();
  });

  it("shows the reviewer diff for an approved task without exposing the reviewer identity", async () => {
    mockMyTasks.mockResolvedValue([item({ status: "approved" })]);
    mockMyTaskFeedback.mockResolvedValue(
      feedback({
        status: "approved",
        human_review: {
          original: {
            title: "Original title",
            request: "Original request.",
            criteria: ["A criterion"],
            steps: [{ order: 1, title: "Step 1", description: "Original step." }],
          },
          final: {
            title: "Final title",
            request: "Final request.",
            criteria: ["A criterion"],
            steps: [{ order: 1, title: "Step 1", description: "Final step." }],
          },
          rubrics: [],
          title_edited: true,
          request_edited: true,
          evergreen_verified: true,
        },
      })
    );
    const root = renderMyTasks(ctx());
    await flush();

    const row = root.querySelector<HTMLDetailsElement>(".admin-submission")!;
    row.open = true;
    row.dispatchEvent(new Event("toggle"));
    await flush();

    expect(root.textContent).toContain("Your original");
    expect(root.textContent).toContain("Final gold version");
    expect(root.textContent).toContain("Original title");
    expect(root.textContent).toContain("Final title");
    expect(root.textContent).not.toMatch(/reviewed by/i);
  });

  it("closes the edit form on Cancel, while Remove only drops a step", async () => {
    mockMyTasks.mockResolvedValue([item({ status: "returned", returned_reason: "Please revise." })]);
    mockMyTaskFeedback.mockResolvedValue(feedback({ status: "returned", task: currentTask() }));
    const root = renderMyTasks(ctx());
    await flush();
    await openEditor(root);

    expect(root.textContent).toContain("Edit your task");
    expect(root.querySelectorAll("textarea.rubric-text")).toHaveLength(3);

    // Removing a step must not tear the form down with it: the step list
    // renders its own ghost buttons ahead of the actions row, so a positional
    // lookup for Cancel lands on a step's Remove.
    btn(root, "Remove")!.click();
    await flush();
    expect(root.textContent).toContain("Edit your task");
    expect(root.querySelectorAll("textarea.rubric-text")).toHaveLength(2);

    btn(root, "Cancel")!.click();
    await flush();
    expect(root.textContent).not.toContain("Edit your task");
    expect(btn(root, "Edit task")).toBeTruthy();
  });

  it("applies a suggested fix to the step its rubric id names, not its list position", async () => {
    mockMyTasks.mockResolvedValue([item({ status: "pending" })]);
    // A sparse, unordered rubric list is normal: the server unions the
    // pipeline's outcome, assessment, and feedback lists and drops the rest.
    mockMyTaskFeedback.mockResolvedValue(
      feedback({ task: currentTask(), review: llmReview([rubric("rubric-3", "rewritten third step")]) })
    );
    const root = renderMyTasks(ctx());
    await flush();
    await openEditor(root);

    expect(root.textContent).toContain("STEP 3");
    btn(root, "Use this suggestion")!.click();
    await flush();

    const areas = Array.from(root.querySelectorAll<HTMLTextAreaElement>("textarea.rubric-text"));
    expect(areas.map((a) => a.value)).toEqual(["first", "second", "rewritten third step"]);
  });

  it("keeps the form and the server's reason when an edit is refused", async () => {
    mockMyTasks.mockResolvedValue([item({ status: "pending" })]);
    mockMyTaskFeedback.mockResolvedValue(feedback({ task: currentTask() }));
    mockAuthorEdit.mockRejectedValue(new Error("A reviewer has claimed this task — it's locked for review."));
    const root = renderMyTasks(ctx());
    await flush();
    await openEditor(root);

    btn(root, "Submit edit")!.click();
    await flush();

    expect(root.textContent).toContain("A reviewer has claimed this task");
    expect(root.textContent).toContain("Edit your task");
    expect(btn(root, "Submit edit")?.disabled).toBe(false);
    // Reloading the list here would rebuild every row collapsed and take the
    // message with it — the one case where the reason matters most.
    expect(mockMyTasks).toHaveBeenCalledTimes(1);
  });
});
