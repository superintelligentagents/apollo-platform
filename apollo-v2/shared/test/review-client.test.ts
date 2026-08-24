import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorAmend,
  authorEdit,
  authorSignoff,
  buildReviewedTask,
  myTaskFeedback,
  myTaskPage,
  myTasks,
  rejectionReviewBlock,
  reviewReject,
  reviewReturn,
  seedRubrics,
  type AuthorEditPayload,
  type ReviewClaim,
  type RubricRow,
  upgradeRubrics,
} from "../src/review-client";
import type { LongTask } from "../src/types";

function task(): LongTask {
  return {
    schema_version: "odyssey_long_task_v2",
    task_id: "v2/reviewer/internal/task-12345678-20260731",
    mode: "guided",
    created_at: "2026-07-31T00:00:00.000Z",
    app: { name: "Apollo", version: "0.2.0", platform: "web" },
    participant: {
      kind: "internal",
      participant_id: "reviewer",
      session_id: null,
      name: null,
      email: null,
      consent: { version: "1", accepted_at: "2026-07-31T00:00:00.000Z" },
    },
    task: {
      task_title: "Original title",
      agent_request: "Original request with enough detail to run.",
      task_summary: null,
      difficulty: "high",
      site_scope: ["example.com"],
      success_criteria: ["Return a comparison table."],
      must_visit_or_reach: [],
      required_outputs: ["table"],
      notes: null,
      time_span: { start: null, end: null },
      steps: [{ order: 1, title: "Research", description: "Compare at least three current options." }],
      metadata: {
        region: "IN",
        subjects: ["Ecommerce & Shopping > Price Comparison"],
      },
    },
    provenance: { source_journeys: [], theme_suggestion: null, template: null, attached_urls: [] },
  };
}

describe("review gold audit trail", () => {
  it("uses structured steps as the sole rubric items", () => {
    expect(seedRubrics(task())).toEqual([
      expect.objectContaining({ kind: "step", sourceIndex: 0, title: "Research", text: "Compare at least three current options." }),
    ]);
  });

  it("hides legacy auto-generated criteria when complete steps exist", () => {
    const legacy = task();
    const description = `Create every required worksheet. ${"Include the complete requirement text. ".repeat(6)}`.trim();
    legacy.task.steps = [{ order: 0, title: "Create the spreadsheet", description }];
    const normalized = description.replace(/\s+/g, " ");
    legacy.task.success_criteria = [`Create the spreadsheet: ${normalized.slice(0, 137)}…`];

    const rows = seedRubrics(legacy);
    expect(rows[0]).toEqual(expect.objectContaining({
      kind: "step",
      text: description,
      original: description,
    }));
    expect(rows).toHaveLength(1);
  });

  it("uses criteria as a fallback when a task has no steps", () => {
    const authored = task();
    authored.task.steps = [];
    authored.task.success_criteria = ["A genuinely authored thought…"];
    expect(seedRubrics(authored)[0]).toEqual(expect.objectContaining({ kind: "criterion", text: "A genuinely authored thought…" }));
  });

  it("migrates a refresh-resume snapshot to its complete step rubrics", () => {
    const legacy = task();
    const description = `Create every required worksheet. ${"Include the complete requirement text. ".repeat(6)}`.trim();
    legacy.task.steps = [{ order: 0, title: "Create the spreadsheet", description }];
    const normalized = description.replace(/\s+/g, " ");
    const truncated = `Create the spreadsheet: ${normalized.slice(0, 137)}…`;
    legacy.task.success_criteria = [truncated];
    const snapshot: RubricRow[] = [{
      text: truncated,
      original: truncated,
      checked: false,
      kind: "criterion",
      sourceIndex: 0,
      title: null,
      seedVersion: 2,
    }];

    expect(upgradeRubrics(legacy, snapshot)).toEqual([
      expect.objectContaining({ kind: "step", text: description, original: description, seedVersion: 3 }),
    ]);
  });

  it("stores original and final text while preserving edited structured steps", () => {
    const rows: RubricRow[] = seedRubrics(task()).map((row) => ({ ...row, checked: true }));
    rows[0].text = "Compare at least five current options.";

    const reviewed = buildReviewedTask(task(), {
      title: "Final title",
      request: "Final request with clarified constraints.",
      difficulty: "medium",
      rubrics: rows,
      evergreenVerified: true,
    }) as {
      task: { success_criteria: string[]; steps: Array<{ description: string }> };
      review: {
        original: { task_title: string; steps: Array<{ description: string }> };
        final: { task_title: string; steps: Array<{ description: string }> };
        rubrics: Array<{ original: string | null; final: string; changed: boolean; kind: string }>;
        evergreen_verified: boolean;
      };
    };

    expect(reviewed.task.success_criteria).toEqual(["Return a comparison table."]);
    expect(reviewed.task.steps[0].description).toBe("Compare at least five current options.");
    expect(reviewed.review.original.task_title).toBe("Original title");
    expect(reviewed.review.original.steps[0].description).toBe("Compare at least three current options.");
    expect(reviewed.review.final.task_title).toBe("Final title");
    expect(reviewed.review.final.steps[0].description).toBe("Compare at least five current options.");
    expect(reviewed.review.evergreen_verified).toBe(true);
    expect(reviewed.review.rubrics).toEqual([
      expect.objectContaining({ kind: "step", original: "Compare at least three current options.", final: "Compare at least five current options.", changed: true }),
    ]);
  });

  it("carries the author's distribution metadata into final gold", () => {
    const reviewed = buildReviewedTask(task(), {
      title: "Final title",
      request: "Original request with enough detail to run.",
      difficulty: "high",
      rubrics: seedRubrics(task()).map((row) => ({ ...row, checked: true })),
    }) as { task: { metadata?: { region: string; subjects: string[] } } };

    expect(reviewed.task.metadata).toEqual({
      region: "IN",
      subjects: ["Ecommerce & Shopping > Price Comparison"],
    });
  });

  it("omits metadata in final gold for tasks authored before the field existed", () => {
    const legacy = task();
    delete legacy.task.metadata;
    const reviewed = buildReviewedTask(legacy, {
      title: "Final title",
      request: "Original request with enough detail to run.",
      difficulty: "high",
      rubrics: seedRubrics(legacy).map((row) => ({ ...row, checked: true })),
    }) as { task: Record<string, unknown> };

    expect("metadata" in reviewed.task).toBe(false);
  });

  it("removes legacy generated criteria from final gold", () => {
    const legacy = task();
    const description = `Create every required worksheet. ${"Include the complete requirement text. ".repeat(6)}`.trim();
    legacy.task.steps = [{ order: 0, title: "Create the spreadsheet", description }];
    const normalized = description.replace(/\s+/g, " ");
    legacy.task.success_criteria = [`Create the spreadsheet: ${normalized.slice(0, 137)}…`];
    const reviewed = buildReviewedTask(legacy, {
      title: legacy.task.task_title,
      request: legacy.task.agent_request,
      difficulty: legacy.task.difficulty,
      rubrics: seedRubrics(legacy).map((row) => ({ ...row, checked: true })),
    }) as { task: { success_criteria: string[] } };
    expect(reviewed.task.success_criteria).toEqual([]);
  });

  it("upgrades old snapshots once and honors a deliberately removed step", () => {
    const oldRows = [{
      text: "Return a comparison table.",
      original: "Return a comparison table.",
      checked: false,
    }] as unknown as RubricRow[];
    const upgraded = upgradeRubrics(task(), oldRows);
    expect(upgraded.map((row) => row.kind)).toEqual(["step"]);

    const withoutStep: RubricRow[] = [];
    const reviewed = buildReviewedTask(task(), {
      title: "Original title",
      request: "Original request with enough detail to run.",
      difficulty: "high",
      rubrics: withoutStep,
    }) as { task: { steps: Array<unknown> } };

    expect(reviewed.task.steps).toEqual([]);
  });
});

function mockPost(payload: Record<string, unknown>, ok = true): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ ok, json: async () => payload }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
}

describe("author feedback + return client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists the author's tasks", async () => {
    const fetchMock = mockPost({
      items: [
        { task_id: "t1", sub_key: "s1", title: "T", request: "R", status: "pending", submitted_at: null, content_hash: null },
      ],
    });
    const items = await myTasks("key", "pid");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ task_id: "t1", status: "pending" });
    const [url, init] = lastCall(fetchMock);
    expect(String(url)).toContain("/review/my-tasks");
    expect(JSON.parse(init.body as string)).toEqual({
      reviewKey: "key",
      participant_id: "pid",
      offset: 0,
      limit: 50,
    });
  });

  it("returns an empty list when items is missing", async () => {
    mockPost({});
    expect(await myTasks("key", "pid")).toEqual([]);
  });

  it("fetches per-task feedback", async () => {
    const fetchMock = mockPost({
      status: "pre_qc_passed",
      stale: false,
      task_content_hash: "h",
      review: null,
    });
    const fb = await myTaskFeedback("key", "pid", "s1");
    expect(fb.status).toBe("pre_qc_passed");
    expect(fb.review).toBeNull();
    const [url, init] = lastCall(fetchMock);
    expect(String(url)).toContain("/review/my-task-feedback");
    expect(JSON.parse(init.body as string)).toEqual({ reviewKey: "key", participant_id: "pid", sub_key: "s1" });
  });

  it("submits an author edit and returns the new sub key", async () => {
    const fetchMock = mockPost({ ok: true, new_sub_key: "s2", new_content_hash: "h2", status: "awaiting_codex" });
    const edited: AuthorEditPayload = {
      task_title: "T",
      agent_request: "R",
      difficulty: "high",
      success_criteria: [],
      steps: [{ order: 1, title: "Step 1", description: "Do it" }],
      must_visit_or_reach: [],
      required_outputs: [],
      notes: null,
    };
    const res = await authorEdit("key", "pid", "s1", edited);
    expect(res).toEqual({ ok: true, new_sub_key: "s2", new_content_hash: "h2", status: "awaiting_codex" });
    const [url, init] = lastCall(fetchMock);
    expect(String(url)).toContain("/review/author-edit");
    expect(JSON.parse(init.body as string)).toEqual({
      reviewKey: "key",
      participant_id: "pid",
      sub_key: "s1",
      edited,
      edit_started_at: null,
    });
  });

  it("throws on a claimed-or-finished error", async () => {
    mockPost({ error: "A reviewer has claimed this task — it's locked for review." }, false);
    await expect(authorEdit("key", "pid", "s1", {} as AuthorEditPayload)).rejects.toThrow("locked for review");
  });

  it("returns a task to the author with the claim token", async () => {
    const fetchMock = mockPost({ ok: true, returned_key: "rk" });
    const claim: ReviewClaim = {
      subKey: "s1",
      token: "tok",
      task: { ...task(), task_id: "v2/author/internal/task-1" },
      lockTtlMs: 30 * 60 * 1000,
      claimedAtMs: Date.now(),
    };
    await reviewReturn("key", "reviewer", claim, "Please fix step 1.");
    const [url, init] = lastCall(fetchMock);
    expect(String(url)).toContain("/review/return-to-author");
    expect(JSON.parse(init.body as string)).toEqual({
      reviewKey: "key",
      reviewer: "reviewer",
      sub_key: "s1",
      token: "tok",
      task_id: "v2/author/internal/task-1",
      reason: "Please fix step 1.",
    });
  });
});

describe("author sign-off, amendment, and rejection feedback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs off an approved task with the time the author opened it", async () => {
    const fetchMock = mockPost({ ok: true, action: "accepted", signed_off_at: "2026-08-24T00:00:00.000Z" });
    const res = await authorSignoff("key", "pid", "s1", "2026-08-24T00:00:00.000Z");
    expect(res.action).toBe("accepted");
    const [url, init] = lastCall(fetchMock);
    expect(String(url)).toContain("/review/author-signoff");
    expect(JSON.parse(init.body as string)).toEqual({
      reviewKey: "key",
      participant_id: "pid",
      sub_key: "s1",
      opened_at: "2026-08-24T00:00:00.000Z",
    });
  });

  it("amends an approved task into a new final version", async () => {
    const fetchMock = mockPost({ ok: true, revision_count: 2, new_content_hash: "h2" });
    const edited: AuthorEditPayload = {
      task_title: "T",
      agent_request: "R",
      difficulty: "high",
      success_criteria: [],
      steps: [],
      must_visit_or_reach: [],
      required_outputs: [],
      notes: null,
    };
    const res = await authorAmend("key", "pid", "s1", edited, null);
    expect(res.revision_count).toBe(2);
    const [url, init] = lastCall(fetchMock);
    expect(String(url)).toContain("/review/author-amend");
    expect(JSON.parse(init.body as string)).toEqual({
      reviewKey: "key",
      participant_id: "pid",
      sub_key: "s1",
      edited,
      opened_at: null,
    });
  });

  it("pages the author's task list and carries the sign-off totals", async () => {
    const fetchMock = mockPost({
      items: [],
      offset: 50,
      limit: 50,
      source_total: 137,
      approved_total: 120,
      awaiting_signoff_total: 90,
    });
    const page = await myTaskPage("key", "pid", 50, 50);
    expect(page.source_total).toBe(137);
    expect(page.awaiting_signoff_total).toBe(90);
    const [, init] = lastCall(fetchMock);
    expect(JSON.parse(init.body as string)).toMatchObject({ offset: 50, limit: 50 });
  });

  it("sends the reviewer's step notes with a rejection, and their pid", async () => {
    const fetchMock = mockPost({ ok: true, rejected_key: "rk" });
    const claim: ReviewClaim = {
      subKey: "s1",
      token: "tok",
      task: { ...task(), task_id: "v2/author/internal/task-1" },
      claimedAtMs: Date.now(),
      lockTtlMs: 1000,
    };
    const rows = seedRubrics(claim.task);
    rows[0].text = "This step is a single lookup.";
    await reviewReject("key", "Dana", claim, "Not long-horizon enough to be useful.", rows, "dana");

    const [url, init] = lastCall(fetchMock);
    expect(String(url)).toContain("/review/reject");
    const body = JSON.parse(init.body as string);
    expect(body.reviewer_pid).toBe("dana");
    expect(body.review.rubrics[0]).toMatchObject({
      final: "This step is a single lookup.",
      changed: true,
    });
  });

  it("omits the review block when the reviewer left no rubric notes", async () => {
    const fetchMock = mockPost({ ok: true, rejected_key: "rk" });
    const claim: ReviewClaim = {
      subKey: "s1",
      token: "tok",
      task: { ...task(), task_id: "v2/author/internal/task-1" },
      claimedAtMs: Date.now(),
      lockTtlMs: 1000,
    };
    await reviewReject("key", "Dana", claim, "Not long-horizon enough to be useful.");
    expect(JSON.parse(lastCall(fetchMock)[1].body as string).review).toBeUndefined();
  });

  it("drops empty rows from the rejection block and marks what the reviewer changed", () => {
    const block = rejectionReviewBlock([
      { text: "kept", original: "kept", checked: true, kind: "step", sourceIndex: 0, title: "One", seedVersion: 3 },
      { text: "  ", original: null, checked: false, kind: "step", sourceIndex: 1, title: "Two", seedVersion: 3 },
      { text: "rewritten", original: "before", checked: false, kind: "step", sourceIndex: 2, title: "Three", seedVersion: 3 },
    ] as RubricRow[]);
    expect(block.rubrics).toHaveLength(2);
    expect((block.rubrics as Record<string, unknown>[])[0]).toMatchObject({ final: "kept", changed: false });
    expect((block.rubrics as Record<string, unknown>[])[1]).toMatchObject({ final: "rewritten", changed: true });
  });
});
