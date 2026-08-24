// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../src/ui/context";
import { initialState } from "../src/ui/context";
import { editModeFor, editSeed, renderMyTasks, signoffProgress } from "../src/ui/screens/my-tasks";
import {
  authorAmend,
  authorEdit,
  authorSignoff,
  myTaskFeedback,
  myTaskPage,
  type LlmReviewForHuman,
  type LlmRubricReviewForHuman,
  type MyTaskCurrentContent,
  type MyTaskFeedback,
  type MyTaskHumanReview,
  type MyTaskItem,
} from "../src/review-client";

vi.mock("../src/review-client", () => ({
  myTaskPage: vi.fn(),
  myTaskFeedback: vi.fn(),
  authorEdit: vi.fn(),
  authorAmend: vi.fn(),
  authorSignoff: vi.fn(),
}));

const mockMyTaskPage = vi.mocked(myTaskPage);
const mockMyTaskFeedback = vi.mocked(myTaskFeedback);
const mockAuthorEdit = vi.mocked(authorEdit);
const mockAuthorAmend = vi.mocked(authorAmend);
const mockAuthorSignoff = vi.mocked(authorSignoff);

// The screen pages; every test that sets up a list goes through this so the
// totals stay consistent with the rows.
function page(items: MyTaskItem[], over: Partial<Awaited<ReturnType<typeof myTaskPage>>> = {}) {
  const approved = items.filter((i) => i.status === "approved");
  return {
    items,
    offset: 0,
    limit: 50,
    source_total: items.length,
    approved_total: approved.length,
    awaiting_signoff_total: approved.filter((i) => i.needs_signoff).length,
    ...over,
  };
}

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

// Expand the first row and let its lazy feedback fetch settle.
async function openRow(root: HTMLElement): Promise<void> {
  const row = root.querySelector<HTMLDetailsElement>(".admin-submission")!;
  row.open = true;
  row.dispatchEvent(new Event("toggle"));
  await flush();
}

function humanReview(over: Partial<MyTaskHumanReview> = {}): MyTaskHumanReview {
  return {
    original: {
      title: "Original title",
      request: "Original request.",
      criteria: [],
      steps: [{ order: 1, title: "Step 1", description: "Original step." }],
    },
    final: {
      title: "Final title",
      request: "Final request.",
      criteria: [],
      steps: [{ order: 1, title: "Step 1", description: "Final step." }],
    },
    rubrics: [],
    title_edited: true,
    request_edited: true,
    evergreen_verified: true,
    changed: true,
    ...over,
  };
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
    mockMyTaskPage.mockReset();
    mockMyTaskFeedback.mockReset();
    mockAuthorEdit.mockReset();
    mockAuthorAmend.mockReset();
    mockAuthorSignoff.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading state then the author's task list", async () => {
    mockMyTaskPage.mockResolvedValue(page([
      item({ task_id: "t1", title: "Task A", status: "pending" }),
      item({ task_id: "t2", sub_key: "s2", title: "Task B", status: "approved" }),
    ]));
    const root = renderMyTasks(ctx());
    expect(root.textContent).toContain("Loading your tasks…");

    await flush();

    expect(root.textContent).toContain("Task A");
    expect(root.textContent).toContain("Task B");
    expect(root.querySelectorAll(".admin-submission")).toHaveLength(2);
    expect(root.textContent).toContain("Back to home");
  });

  it("shows an empty state when the author has no tasks", async () => {
    mockMyTaskPage.mockResolvedValue(page([]));
    const root = renderMyTasks(ctx());
    await flush();
    expect(root.textContent).toContain("You haven't submitted any tasks yet.");
  });

  it("shows a retry button when the list fails to load", async () => {
    mockMyTaskPage.mockRejectedValue(new Error("boom"));
    const root = renderMyTasks(ctx());
    await flush();
    expect(root.textContent).toContain("Couldn't load your tasks: boom");
    expect(root.querySelector("button")?.textContent).toContain("Retry");
  });

  it("shows a rejected reason line and a danger badge", async () => {
    mockMyTaskPage.mockResolvedValue(page([
      item({ status: "rejected", rejection_reason: "Unsalvageable as written." }),
    ]));
    const root = renderMyTasks(ctx());
    await flush();
    expect(root.textContent).toContain("Unsalvageable as written.");
    const badge = root.querySelector(".badge.danger");
    expect(badge?.textContent).toBe("Rejected");
  });

  it("fetches feedback on expand and offers an edit button for a pending task", async () => {
    mockMyTaskPage.mockResolvedValue(page([item({ status: "pending" })]));
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
    mockMyTaskPage.mockResolvedValue(page([item({ status: "in_review" })]));
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

  it("shows the reviewer diff for an approved task", async () => {
    mockMyTaskPage.mockResolvedValue(page([item({ status: "approved" })]));
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
  });

  it("closes the edit form on Cancel, while Remove only drops a step", async () => {
    mockMyTaskPage.mockResolvedValue(page([item({ status: "returned", returned_reason: "Please revise." })]));
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
    mockMyTaskPage.mockResolvedValue(page([item({ status: "pending" })]));
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
    mockMyTaskPage.mockResolvedValue(page([item({ status: "pending" })]));
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
    expect(mockMyTaskPage).toHaveBeenCalledTimes(1);
  });
  it("names the reviewer on an approved task so the author can go and ask them", async () => {
    mockMyTaskPage.mockResolvedValue(
      page([item({ status: "approved", reviewed_by: "Dana", reviewer_changed: true, needs_signoff: true })])
    );
    mockMyTaskFeedback.mockResolvedValue(
      feedback({ status: "approved", needs_signoff: true, human_review: humanReview({ reviewed_by: "Dana" }) })
    );
    const root = renderMyTasks(ctx());
    await flush();
    await openRow(root);

    expect(root.textContent).toMatch(/reviewed by/i);
    expect(root.textContent).toContain("Dana");
  });

  it("gives a rejected task the reviewer's step notes and never their name", async () => {
    mockMyTaskPage.mockResolvedValue(
      page([item({ status: "rejected", rejection_reason: "Not long-horizon enough.", can_appeal: true })])
    );
    mockMyTaskFeedback.mockResolvedValue(
      feedback({
        status: "rejected",
        rejection_reason: "Not long-horizon enough.",
        task: currentTask(),
        rejection_feedback: {
          rubrics: [
            {
              rubric_id: "rubric-1",
              kind: "step",
              title: "One",
              original: "first",
              final: "This step is a single lookup.",
              changed: true,
              checked: false,
            },
          ],
        },
      })
    );
    const root = renderMyTasks(ctx());
    await flush();
    await openRow(root);

    expect(root.textContent).toContain("Why this was rejected");
    expect(root.textContent).toContain("Not long-horizon enough.");
    expect(root.textContent).toContain("This step is a single lookup.");
    // The substance reaches the author; the identity behind it does not.
    expect(root.textContent).not.toMatch(/reviewed by/i);
    expect(root.textContent).not.toContain("Dana");
  });

  it("offers one appeal on a rejected task, and none once it is used", async () => {
    mockMyTaskPage.mockResolvedValue(
      page([item({ status: "rejected", rejection_reason: "No.", can_appeal: true })])
    );
    mockMyTaskFeedback.mockResolvedValue(
      feedback({ status: "rejected", rejection_reason: "No.", task: currentTask() })
    );
    let root = renderMyTasks(ctx());
    await flush();
    await openRow(root);
    expect(btn(root, "Revise and appeal")).toBeTruthy();
    expect(root.textContent).toMatch(/one appeal/i);

    mockMyTaskPage.mockResolvedValue(
      page([item({ status: "rejected", rejection_reason: "No.", can_appeal: false })])
    );
    root = renderMyTasks(ctx());
    await flush();
    await openRow(root);
    expect(btn(root, "Revise and appeal")).toBeFalsy();
    expect(root.textContent).toMatch(/already appealed/i);
  });

  it("lists only the tasks awaiting sign-off in the sign-off section", async () => {
    mockMyTaskPage.mockResolvedValue(
      page([
        item({ task_id: "t1", sub_key: "s1", title: "Needs me", status: "approved", needs_signoff: true }),
        item({ task_id: "t2", sub_key: "s2", title: "Already done", status: "approved", needs_signoff: false }),
      ])
    );
    const root = renderMyTasks(ctx());
    await flush();

    const section = root.querySelector(".needs-signoff")!;
    expect(section).toBeTruthy();
    expect(section.textContent).toContain("Needs me");
    expect(section.textContent).not.toContain("Already done");
    // Counted over every task, not the page, so paging cannot move it.
    expect(section.textContent).toContain("1 of 2 signed off");
  });

  it("has no sign-off section when nothing is waiting", async () => {
    mockMyTaskPage.mockResolvedValue(page([item({ status: "approved", needs_signoff: false })]));
    const root = renderMyTasks(ctx());
    await flush();
    expect(root.querySelector(".needs-signoff")).toBeFalsy();
    expect(root.textContent).toContain("All submissions");
  });

  it("accepts the reviewer's version and sends how long the author looked at it", async () => {
    mockMyTaskPage.mockResolvedValue(
      page([item({ status: "approved", needs_signoff: true, reviewed_by: "Dana" })])
    );
    mockMyTaskFeedback.mockResolvedValue(
      feedback({ status: "approved", needs_signoff: true, human_review: humanReview({ reviewed_by: "Dana" }) })
    );
    mockAuthorSignoff.mockResolvedValue({ ok: true, action: "accepted", signed_off_at: "2026-08-24T00:00:00.000Z" });
    const root = renderMyTasks(ctx());
    await flush();
    await openRow(root);

    btn(root, "Looks good — accept")!.click();
    await flush();

    expect(mockAuthorSignoff).toHaveBeenCalledTimes(1);
    const [, pid, subKey, openedAt] = mockAuthorSignoff.mock.calls[0];
    expect(pid).toBe("author");
    expect(subKey).toBe("s1");
    // The server pairs this with its own completion stamp; a duration is never
    // taken from the client.
    expect(Date.parse(String(openedAt))).not.toBeNaN();
  });

  it("amends an approved task from the reviewer's version, not the author's original", async () => {
    mockMyTaskPage.mockResolvedValue(page([item({ status: "approved", needs_signoff: true })]));
    mockMyTaskFeedback.mockResolvedValue(
      feedback({
        status: "approved",
        needs_signoff: true,
        human_review: humanReview({}),
        task: { ...currentTask(), request: "The author's own original request." },
        final_task: { ...currentTask(), request: "The reviewer's approved request." },
      })
    );
    mockAuthorAmend.mockResolvedValue({ ok: true, revision_count: 2, new_content_hash: "h" });
    const root = renderMyTasks(ctx());
    await flush();
    await openRow(root);

    btn(root, "Edit and make final")!.click();
    await flush();
    const area = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Full task request"]')!;
    expect(area.value).toBe("The reviewer's approved request.");

    btn(root, "Save as the final version")!.click();
    await flush();
    expect(mockAuthorAmend).toHaveBeenCalledTimes(1);
    expect(mockAuthorEdit).not.toHaveBeenCalled();
  });
});

describe("my tasks pure helpers", () => {
  it("picks the action a task's state allows", () => {
    expect(editModeFor(item({ status: "pending" }))).toBe("revise");
    expect(editModeFor(item({ status: "returned" }))).toBe("revise");
    expect(editModeFor(item({ status: "approved" }))).toBe("amend");
    expect(editModeFor(item({ status: "rejected", can_appeal: true }))).toBe("appeal");
    expect(editModeFor(item({ status: "rejected", can_appeal: false }))).toBe(null);
    // A locked task is nobody's to edit while the reviewer holds it.
    expect(editModeFor(item({ status: "in_review" }))).toBe(null);
  });

  it("seeds an amendment from final gold and everything else from the author's copy", () => {
    const fb = feedback({
      task: { ...currentTask(), request: "author" },
      final_task: { ...currentTask(), request: "reviewer" },
    });
    expect(editSeed(fb, "amend")?.request).toBe("reviewer");
    expect(editSeed(fb, "revise")?.request).toBe("author");
    expect(editSeed(fb, "appeal")?.request).toBe("author");
    // An approved task with no final gold falls back rather than rendering blank.
    expect(editSeed(feedback({ task: currentTask() }), "amend")?.request).toBe(currentTask().request);
  });

  it("reports sign-off progress over every task, not the page on screen", () => {
    expect(signoffProgress(137, 90)).toBe("47 of 137 signed off");
    expect(signoffProgress(0, 0)).toBe("0 of 0 signed off");
  });
});
