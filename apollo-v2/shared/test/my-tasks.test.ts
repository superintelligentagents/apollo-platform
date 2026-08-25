// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../src/ui/context";
import { initialState } from "../src/ui/context";
import {
  approvedReviewChanges,
  editModeFor,
  editSeed,
  filterAndSortMyTasks,
  renderMyTask,
  renderMyTasks,
  resetMyTasksViewState,
  signoffProgress,
  signoffSuffix,
} from "../src/ui/screens/my-tasks";
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
    resetMyTasksViewState();
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

  it("opens a task on its own route instead of expanding it inside the list", async () => {
    mockMyTaskPage.mockResolvedValue(page([item({ title: "Dedicated editor task" })]));
    const context = ctx();
    const root = renderMyTasks(context);
    await flush();

    root.querySelector<HTMLElement>(".admin-submission-summary")!.click();

    expect(context.state.myTaskSelection?.title).toBe("Dedicated editor task");
    expect(context.actions.goto).toHaveBeenCalledWith("my-task");
    expect(root.textContent).not.toContain("Loading feedback…");
  });

  it("renders the selected task and its editor on a dedicated page", async () => {
    const context = ctx();
    context.state.myTaskSelection = item({ status: "returned", returned_reason: "Please clarify it." });
    mockMyTaskFeedback.mockResolvedValue(feedback({ status: "returned", task: currentTask() }));

    const root = renderMyTask(context);
    expect(root.textContent).toContain("Loading feedback…");
    await flush();

    expect(mockMyTaskFeedback).toHaveBeenCalledWith("review-key", "author", "s1");
    expect(root.textContent).toContain("Please clarify it.");
    expect(btn(root, "Edit task")).toBeTruthy();
    expect(btn(root, "Back to My Tasks")).toBeTruthy();
  });

  it("shows an empty state when the author has no tasks", async () => {
    mockMyTaskPage.mockResolvedValue(page([]));
    const root = renderMyTasks(ctx());
    await flush();
    expect(root.textContent).toContain("You haven't submitted any tasks yet.");
  });

  it("searches, filters, clears, and explains an empty result", async () => {
    mockMyTaskPage.mockResolvedValue(page([
      item({ task_id: "alpha", sub_key: "alpha", title: "Alpha approved", status: "approved", needs_signoff: true }),
      item({ task_id: "beta", sub_key: "beta", title: "Beta rejected", status: "rejected", can_appeal: true }),
      item({ task_id: "gamma", sub_key: "gamma", title: "Gamma pending", status: "pending" }),
    ]));
    const root = renderMyTasks(ctx());
    await flush();

    const visibleTitles = () => Array.from(root.querySelectorAll(".admin-submission-summary strong"))
      .map((node) => node.textContent);
    const search = root.querySelector<HTMLInputElement>('input[aria-label="Search my tasks"]')!;
    const filter = root.querySelector<HTMLSelectElement>('select[aria-label="Filter tasks"]')!;
    const sort = root.querySelector<HTMLSelectElement>('select[aria-label="Sort tasks"]')!;
    expect(search).toBeTruthy();
    expect(filter).toBeTruthy();
    expect(sort).toBeTruthy();

    search.value = "beta";
    search.dispatchEvent(new Event("input"));
    expect(visibleTitles()).toEqual(["Beta rejected"]);

    search.value = "";
    search.dispatchEvent(new Event("input"));
    filter.value = "action";
    filter.dispatchEvent(new Event("change"));
    expect(visibleTitles()).toEqual(["Alpha approved", "Beta rejected"]);

    search.value = "nothing matches this";
    search.dispatchEvent(new Event("input"));
    expect(root.textContent).toContain("No tasks match");
    btn(root, "Clear filters")!.click();
    expect(visibleTitles()).toEqual(["Alpha approved", "Beta rejected", "Gamma pending"]);
  });

  it("loads 200 tasks at a time and remembers a later page across screen rebuilds", async () => {
    mockMyTaskPage.mockResolvedValue({
      ...page([item({ title: "Later-page task" })]),
      source_total: 450,
      limit: 200,
    });
    let root = renderMyTasks(ctx());
    await flush();
    expect(mockMyTaskPage).toHaveBeenLastCalledWith("review-key", "author", 0, 200);

    btn(root, "Older")!.click();
    await flush();
    expect(mockMyTaskPage).toHaveBeenLastCalledWith("review-key", "author", 200, 200);
    btn(root, "Older")!.click();
    await flush();
    expect(mockMyTaskPage).toHaveBeenLastCalledWith("review-key", "author", 400, 200);

    // Notifications and route changes can recreate the screen. The author's
    // place survives that rebuild instead of falling back to page one.
    root = renderMyTasks(ctx());
    await flush();
    expect(root.textContent).toContain("Later-page task");
    expect(mockMyTaskPage).toHaveBeenLastCalledWith("review-key", "author", 400, 200);
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
    expect(root.textContent).toContain("3 fields edited");
    expect(root.textContent).toContain("highlighted changes appear first.");
    expect(root.querySelectorAll(".my-task-change-field")).toHaveLength(3);
    expect(root.querySelectorAll("del.diff-del").length).toBeGreaterThan(0);
    expect(root.querySelectorAll("ins.diff-ins").length).toBeGreaterThan(0);
    expect(root.querySelector(".my-task-full-compare")).toBeTruthy();
  });

  it("builds a scan-first field list for additions, removals, and step-title edits", () => {
    const changes = approvedReviewChanges(humanReview({
      original: {
        title: "Plan a museum day",
        request: "Build a museum itinerary.",
        criteria: ["Include opening hours", "Include ticket prices"],
        steps: [{ order: 1, title: "Research", description: "Find two museums." }],
      },
      final: {
        title: "Plan a museum day",
        request: "Build a detailed museum itinerary.",
        criteria: ["Include current opening hours"],
        steps: [{ order: 1, title: "Compare museums", description: "Find two museums." }],
      },
    }));
    expect(changes.map((change) => change.label)).toEqual([
      "Task request",
      "Success criterion 1",
      "Success criterion 2",
      "Step 1 · title",
    ]);
    expect(changes[2]).toMatchObject({ before: "Include ticket prices", after: "" });
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
  it("keeps approval identity anonymous even if an older payload includes it", async () => {
    mockMyTaskPage.mockResolvedValue(
      page([item({ status: "approved", reviewed_by: "Dana", reviewer_changed: true, needs_signoff: true } as never)])
    );
    mockMyTaskFeedback.mockResolvedValue(
      feedback({ status: "approved", needs_signoff: true, human_review: humanReview({ reviewed_by: "Dana" } as never) })
    );
    const root = renderMyTasks(ctx());
    await flush();
    await openRow(root);

    expect(root.textContent).toContain("human review");
    expect(root.textContent).toContain("Approved with edits");
    expect(root.textContent).not.toMatch(/reviewed by/i);
    expect(root.textContent).not.toContain("Dana");
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
        // Even if a malformed backend payload includes names, every reviewer
        // decision remains anonymous in the author UI.
        history: [
          { at: "2026-08-24T11:00:00Z", event: "returned", by: "Dana", minutes: 4, note: "" },
          { at: "2026-08-24T12:00:00Z", event: "rejected", by: "Dana", minutes: 5, note: "" },
          { at: "2026-08-24T13:00:00Z", event: "approved", by: "Eli", minutes: 6, note: "" },
        ],
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
    expect(root.textContent).not.toContain("Eli");
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

  it("requires an appeal reason and sends it to the fresh reviewer workflow", async () => {
    mockMyTaskPage.mockResolvedValue(
      page([item({ status: "rejected", rejection_reason: "The reviewer thought the scope was unclear.", can_appeal: true })])
    );
    mockMyTaskFeedback.mockResolvedValue(
      feedback({ status: "rejected", rejection_reason: "The reviewer thought the scope was unclear.", task: currentTask() })
    );
    mockAuthorEdit.mockResolvedValue({
      ok: true,
      new_sub_key: "s2",
      new_content_hash: "hash",
      status: "awaiting_codex",
      appeal: true,
    });
    const root = renderMyTasks(ctx());
    await flush();
    await openRow(root);
    btn(root, "Revise and appeal")!.click();
    await flush();

    const reason = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Why should this rejection be reviewed again?"]')!;
    expect(reason).toBeTruthy();
    expect(reason.minLength).toBe(20);
    btn(root, "Send back for another review")!.click();
    await flush();
    expect(mockAuthorEdit).not.toHaveBeenCalled();
    expect(root.textContent).toMatch(/20 characters minimum/i);

    reason.value = "The requested market and verification sources are already explicit in the prompt.";
    btn(root, "Send back for another review")!.click();
    await flush();
    expect(mockAuthorEdit).toHaveBeenCalledTimes(1);
    expect(mockAuthorEdit.mock.calls[0][5]).toBe(reason.value);
  });

  it("edits existing step titles and gives a newly added step a custom title during appeal", async () => {
    const manySteps = currentTask();
    manySteps.steps = Array.from({ length: 14 }, (_, index) => ({
      order: index + 1,
      title: `Original ${index + 1}`,
      description: `Description ${index + 1}`,
    }));
    mockMyTaskPage.mockResolvedValue(
      page([item({ status: "rejected", rejection_reason: "Clarify the updated steps.", can_appeal: true })])
    );
    mockMyTaskFeedback.mockResolvedValue(
      feedback({ status: "rejected", rejection_reason: "Clarify the updated steps.", task: manySteps })
    );
    mockAuthorEdit.mockResolvedValue({
      ok: true,
      new_sub_key: "s2",
      new_content_hash: "hash",
      status: "awaiting_codex",
      appeal: true,
    });
    const root = renderMyTasks(ctx());
    await flush();
    await openRow(root);
    btn(root, "Revise and appeal")!.click();
    await flush();

    const s10 = root.querySelector<HTMLInputElement>('input[aria-label="Step 10 title"]')!;
    const s13 = root.querySelector<HTMLInputElement>('input[aria-label="Step 13 title"]')!;
    s10.value = "Verify regional eligibility";
    s10.dispatchEvent(new Event("input"));
    s13.value = "Compare final evidence";
    s13.dispatchEvent(new Event("input"));

    btn(root, "+ Add a step")!.click();
    const s15 = root.querySelector<HTMLInputElement>('input[aria-label="Step 15 title"]')!;
    expect(s15.value).toBe("");
    s15.value = "Document exceptions";
    s15.dispatchEvent(new Event("input"));
    const s15Description = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Step 15 description"]')!;
    s15Description.value = "Record each exception and cite the supporting source.";
    s15Description.dispatchEvent(new Event("input"));

    const reason = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Why should this rejection be reviewed again?"]')!;
    reason.value = "The revised titles now match the clarified scope of each updated step.";
    btn(root, "Send back for another review")!.click();
    await flush();

    const submitted = mockAuthorEdit.mock.calls[0][3];
    expect(submitted.steps[9].title).toBe("Verify regional eligibility");
    expect(submitted.steps[12].title).toBe("Compare final evidence");
    expect(submitted.steps[14]).toMatchObject({
      order: 15,
      title: "Document exceptions",
      description: "Record each exception and cite the supporting source.",
    });
  });

  it("edits success criteria, required outputs, URLs, and notes during appeal", async () => {
    const task = {
      ...currentTask(),
      criteria: ["Original success criterion"],
      required_outputs: ["Original required report"],
      must_visit_or_reach: ["https://original.example/docs"],
      notes: "Original author note",
    };
    mockMyTaskPage.mockResolvedValue(
      page([item({ status: "rejected", rejection_reason: "Clarify the required evidence.", can_appeal: true })])
    );
    mockMyTaskFeedback.mockResolvedValue(
      feedback({ status: "rejected", rejection_reason: "Clarify the required evidence.", task })
    );
    mockAuthorEdit.mockResolvedValue({
      ok: true,
      new_sub_key: "s2",
      new_content_hash: "hash",
      status: "awaiting_codex",
      appeal: true,
    });
    const root = renderMyTasks(ctx());
    await flush();
    await openRow(root);
    btn(root, "Revise and appeal")!.click();
    await flush();

    const criterion = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Success criterion 1"]')!;
    const output = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Required output 1"]')!;
    const url = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Required URL or destination 1"]')!;
    const notes = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes"]')!;
    expect(criterion.value).toBe("Original success criterion");
    expect(output.value).toBe("Original required report");
    expect(url.value).toBe("https://original.example/docs");
    expect(notes.value).toBe("Original author note");

    criterion.value = "Every regional requirement is supported by a first-party citation.";
    criterion.dispatchEvent(new Event("input"));
    btn(root, "+ Add success criterion")!.click();
    const criterion2 = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Success criterion 2"]')!;
    criterion2.value = "Conflicts and exceptions are explicitly resolved.";
    criterion2.dispatchEvent(new Event("input"));
    output.value = "A cited implementation decision";
    output.dispatchEvent(new Event("input"));
    url.value = "https://docs.example.com/requirements";
    url.dispatchEvent(new Event("input"));
    notes.value = "Use only documentation current on the appeal date.";
    notes.dispatchEvent(new Event("input"));

    const reason = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Why should this rejection be reviewed again?"]')!;
    reason.value = "The revision now makes every required source, output, criterion, and constraint explicit.";
    btn(root, "Send back for another review")!.click();
    await flush();

    const submitted = mockAuthorEdit.mock.calls[0][3];
    expect(submitted.success_criteria).toEqual([
      "Every regional requirement is supported by a first-party citation.",
      "Conflicts and exceptions are explicitly resolved.",
    ]);
    expect(submitted.required_outputs).toEqual(["A cited implementation decision"]);
    expect(submitted.must_visit_or_reach).toEqual(["https://docs.example.com/requirements"]);
    expect(submitted.notes).toBe("Use only documentation current on the appeal date.");
  });

  it("explains when a legacy rejection needs routing repair before appeal", async () => {
    mockMyTaskPage.mockResolvedValue(
      page([item({
        status: "rejected",
        rejection_reason: "No.",
        can_appeal: false,
        appeal_unavailable_reason: "This rejection cannot be appealed yet. Ask the task lead to unlock it.",
      })])
    );
    mockMyTaskFeedback.mockResolvedValue(feedback({ status: "rejected", rejection_reason: "No.", task: currentTask() }));
    const root = renderMyTasks(ctx());
    await flush();
    await openRow(root);

    expect(btn(root, "Revise and appeal")).toBeFalsy();
    expect(root.textContent).toMatch(/ask the task lead to unlock it/i);
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
      page([item({ status: "approved", needs_signoff: true })])
    );
    mockMyTaskFeedback.mockResolvedValue(
      feedback({ status: "approved", needs_signoff: true, human_review: humanReview({}) })
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
    const reviewerFinal = {
      ...currentTask(),
      request: "The reviewer's approved request.",
      criteria: ["Reviewer success criterion"],
      required_outputs: ["Reviewer required output"],
      must_visit_or_reach: ["https://reviewer.example/final"],
      notes: "Reviewer-approved note",
    };
    mockMyTaskPage.mockResolvedValue(page([item({ status: "approved", needs_signoff: true })]));
    mockMyTaskFeedback.mockResolvedValue(
      feedback({
        status: "approved",
        needs_signoff: true,
        human_review: humanReview({}),
        task: { ...currentTask(), request: "The author's own original request." },
        final_task: reviewerFinal,
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
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Success criterion 1"]')!.value)
      .toBe("Reviewer success criterion");
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Required output 1"]')!.value)
      .toBe("Reviewer required output");
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Required URL or destination 1"]')!.value)
      .toBe("https://reviewer.example/final");
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes"]')!.value)
      .toBe("Reviewer-approved note");

    const criterion = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Success criterion 1"]')!;
    criterion.value = "Author-final success criterion";
    criterion.dispatchEvent(new Event("input"));
    const output = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Required output 1"]')!;
    output.value = "Author-final required output";
    output.dispatchEvent(new Event("input"));
    const url = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Required URL or destination 1"]')!;
    url.value = "https://author.example/final";
    url.dispatchEvent(new Event("input"));
    const notes = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes"]')!;
    notes.value = "Author-final note";
    notes.dispatchEvent(new Event("input"));

    btn(root, "Save as the final version")!.click();
    await flush();
    expect(mockAuthorAmend).toHaveBeenCalledTimes(1);
    expect(mockAuthorEdit).not.toHaveBeenCalled();
    const submitted = mockAuthorAmend.mock.calls[0][3];
    expect(submitted.success_criteria).toEqual(["Author-final success criterion"]);
    expect(submitted.required_outputs).toEqual(["Author-final required output"]);
    expect(submitted.must_visit_or_reach).toEqual(["https://author.example/final"]);
    expect(submitted.notes).toBe("Author-final note");
  });
});

describe("my tasks pure helpers", () => {
  it("filters by action or progress and sorts deterministically", () => {
    const tasks = [
      item({ task_id: "old", title: "Older approved", status: "approved", submitted_at: "2026-08-01T00:00:00Z" }),
      item({ task_id: "new", title: "New pending", status: "pending", submitted_at: "2026-08-03T00:00:00Z" }),
      item({ task_id: "act", title: "Appealable rejection", status: "rejected", can_appeal: true, submitted_at: "2026-08-02T00:00:00Z" }),
    ];
    expect(filterAndSortMyTasks(tasks, "", "action", "newest").map((task) => task.task_id)).toEqual(["act"]);
    expect(filterAndSortMyTasks(tasks, "", "in_progress", "newest").map((task) => task.task_id)).toEqual(["new"]);
    expect(filterAndSortMyTasks(tasks, "", "all", "oldest").map((task) => task.task_id)).toEqual(["old", "act", "new"]);
    expect(filterAndSortMyTasks(tasks, "appeal", "all", "newest").map((task) => task.task_id)).toEqual(["act"]);
  });

  it("picks the action a task's state allows", () => {
    expect(editModeFor(item({ status: "pending" }))).toBe("revise");
    expect(editModeFor(item({ status: "awaiting_codex", rejection_count: 1 }))).toBe(null);
    expect(editModeFor(item({ status: "pending", rejection_count: 1 }))).toBe(null);
    // An explicit reviewer return reopens the correction flow even when the
    // task originally reached this reviewer through its one appeal.
    expect(editModeFor(item({ status: "returned", rejection_count: 1 }))).toBe("revise");
    // Amend is offered for every approved task, whether or not the reviewer
    // changed anything and whether or not it has already been signed off.
    expect(editModeFor(item({ status: "approved", reviewer_changed: false }))).toBe("amend");
    expect(editModeFor(item({ status: "approved", needs_signoff: false, signed_off_at: "2026-08-24T00:00:00.000Z" }))).toBe("amend");
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

  it("lets the author edit an approval the reviewer did not touch", async () => {
    // Nothing changed in QC is not a reason to take the pen away: the author
    // may still want to improve their own task before it ships.
    mockMyTaskPage.mockResolvedValue(
      page([item({ status: "approved", needs_signoff: true, reviewer_changed: false })])
    );
    mockMyTaskFeedback.mockResolvedValue(
      feedback({
        status: "approved",
        needs_signoff: true,
        human_review: humanReview({ changed: false, request_edited: false, title_edited: false }),
        final_task: currentTask(),
      })
    );
    const root = renderMyTasks(ctx());
    await flush();
    await openRow(root);

    expect(root.textContent).toMatch(/nothing changed/i);
    expect(btn(root, "Looks good — accept")).toBeTruthy();
    expect(btn(root, "Edit and make final")).toBeTruthy();
  });

  it("says what the author did about the review, once they have done it", () => {
    // Before signing off, the row must not claim anything happened.
    expect(signoffSuffix(item({ status: "approved" }))).toBe("");
    expect(signoffSuffix(item({ status: "approved", signed_off_at: "2026-08-24T00:00:00.000Z", signoff_action: "accepted" })))
      .toMatch(/you accepted it on/);
    expect(signoffSuffix(item({ status: "approved", signed_off_at: "2026-08-24T00:00:00.000Z", signoff_action: "amended" })))
      .toMatch(/you made your own version final on/);
  });

  it("counts All submissions as what it lists, not every task", async () => {
    // The sign-off queue is not repeated below, so the header must not include
    // it or the number never matches the rows.
    mockMyTaskPage.mockResolvedValue({
      items: [item({ status: "approved", needs_signoff: true }), item({ task_id: "t2", sub_key: "s2", status: "pending" })],
      offset: 0,
      limit: 50,
      source_total: 10,
      approved_total: 4,
      awaiting_signoff_total: 3,
    });
    const root = renderMyTasks(ctx());
    await flush();
    const head = [...root.querySelectorAll(".my-tasks-section-head")].find((h) =>
      h.textContent?.includes("All submissions")
    )!;
    expect(head.textContent).toContain("7");
  });

  it("reports sign-off progress over every task, not the page on screen", () => {
    expect(signoffProgress(137, 90)).toBe("47 of 137 signed off");
    expect(signoffProgress(0, 0)).toBe("0 of 0 signed off");
  });
});
