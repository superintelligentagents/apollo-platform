// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewLongTask } from "../src/types";
import { initialState, type Ctx } from "../src/ui/context";
import { conciseReviewText, plainReviewText, renderTaskReviewEdit } from "../src/ui/screens/task-review-edit";

const task: ReviewLongTask = {
  schema_version: "odyssey_long_task_v2",
  task_id: "pc_task-1",
  mode: "guided",
  created_at: "2026-08-12T00:00:00Z",
  app: { name: "apollo-pc", version: "0.1.0", platform: "web" },
  participant: { kind: "internal", participant_id: "redacted", session_id: null, name: null, email: null, consent: { version: "redacted", accepted_at: "2026-08-12T00:00:00Z" } },
  task: {
    task_title: "Hidden derived title",
    agent_request: "Use the uploaded context to produce a complete travel brief with every requested comparison.",
    task_summary: null,
    difficulty: "high",
    site_scope: [],
    success_criteria: [],
    must_visit_or_reach: [],
    required_outputs: [],
    notes: null,
    time_span: { start: null, end: null },
    steps: [{ order: 0, title: "Compare options", description: "Compare every suitable option and cite the decisive evidence." }],
  },
  provenance: { source_journeys: [], theme_suggestion: null, template: null, attached_urls: [] },
};

describe("Apollo PC task review", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ status: "not_reviewed", review: null }) })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("translates internal Codex verdict language into plain reviewer guidance", () => {
    expect(plainReviewText("Other rubrics have verification shortfalls; critical step-2 requires NOT_FEASIBLE."))
      .toBe("Other steps have items Codex could not fully check; step 2 means the task needs changes.");
    expect(conciseReviewText("One useful sentence. Another useful sentence. Extra detail that should be hidden."))
      .toBe("One useful sentence. Another useful sentence.");
  });

  it("shows the full request, evergreen check, editable steps, and explicit Codex state", async () => {
    const state = initialState();
    state.reviewKey = "key";
    state.reviewClaim = { subKey: "pc/review_task.json", token: "token", task, lockTtlMs: 1_800_000, claimedAtMs: Date.now() };
    const ctx = { state, adapter: { storage: { get: vi.fn(async () => null), set: vi.fn(async () => {}) } }, actions: { reviewerName: () => "Reviewer" } } as unknown as Ctx;
    const root = renderTaskReviewEdit(ctx);

    const request = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Full task request"]')!;
    const requestColumn = root.querySelector(".pc-task-prompt-column")!;
    expect(request.value).toBe(task.task.agent_request);
    expect(root.textContent).not.toContain("Task title");
    expect(root.textContent).toContain("Task prompt");
    expect(root.textContent).toContain("live web");
    expect(requestColumn.children[1].classList.contains("pc-evergreen-check")).toBe(true);
    await vi.waitFor(() => expect(root.textContent).toContain("Codex has not checked this task version yet"));
    expect(root.textContent).toContain("Open & edit");
    root.querySelector<HTMLButtonElement>(".pc-rubric-summary")!.click();
    expect(root.querySelector<HTMLTextAreaElement>(".pc-rubric-text")!.value).toBe(task.task.steps![0].description);
  });
});
