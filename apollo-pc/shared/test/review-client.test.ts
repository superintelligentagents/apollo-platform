import { afterEach, describe, expect, it, vi } from "vitest";
import { authorEdit, authorAmend, authorSignoff, myTaskPage, reviewReturn, reviewClaim, trajectoryClaim, sessionSkips, rememberReviewSkip, rememberTrajectorySkip, buildReviewedTask, rejectionReviewBlock, reviewReject, seedRubrics, upgradeRubrics } from "../src/review-client";
import type { ReviewLongTask } from "../src/types";

const task = {
  schema_version: "odyssey_long_task_v2", task_id: "pc_task-1", mode: "guided", created_at: "now",
  app: { name: "apollo-pc", version: "1", platform: "web" },
  participant: { kind: "internal", participant_id: "redacted", session_id: null, name: null, email: null, consent: { version: "x", accepted_at: "now" } },
  task: { task_title: "Original", agent_request: "Original request", task_summary: null, difficulty: "high", site_scope: [], success_criteria: [], must_visit_or_reach: [], required_outputs: [], notes: null, time_span: { start: null, end: null }, steps: [{ order: 0, title: "Check", description: "Original rubric" }] },
  provenance: { source_journeys: [], theme_suggestion: null, template: null, attached_urls: [] },
} satisfies ReviewLongTask;

describe("PC review result", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps original text and adds a separately auditable final version", () => {
    const rubrics = seedRubrics(task);
    rubrics[0].text = "Minimally revised rubric";
    rubrics[0].checked = true;
    const result = buildReviewedTask(task, { title: "Original", request: "Original request clarified", difficulty: "high", rubrics, evergreenVerified: true }) as any;
    expect(result.review.original.agent_request).toBe("Original request");
    expect(result.review.final.agent_request).toBe("Original request clarified");
    expect(result.review.rubrics[0]).toMatchObject({ original: "Original rubric", final: "Minimally revised rubric", changed: true, checked: true });
    expect(result.review.evergreen_verified).toBe(true);
  });

  it("upgrades a legacy resumed checklist to the structured Apollo v2 step rubric", () => {
    const legacy = [{
      text: "Legacy generated criterion",
      original: "Legacy generated criterion",
      checked: true,
      kind: "criterion" as const,
      sourceIndex: 0,
      title: null,
      seedVersion: 2 as const,
    }];
    expect(upgradeRubrics(task, legacy)).toEqual([expect.objectContaining({
      text: "Original rubric",
      kind: "step",
      sourceIndex: 0,
      title: "Check",
      seedVersion: 3,
    })]);
  });

  it("sends anonymous step notes and the reviewer pid with a rejection", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    const rubrics = seedRubrics(task);
    rubrics[0].text = "The public source required by this step is unavailable.";
    const claim = {
      subKey: "submission.json",
      token: "token",
      task,
      lockTtlMs: 30 * 60 * 1000,
      claimedAtMs: Date.now(),
    };

    await reviewReject(
      "key",
      "Dana",
      claim,
      "The core task cannot be completed from the public web as written.",
      rubrics,
      "dana"
    );

    const init = fetchMock.mock.calls[0][1]!;
    const body = JSON.parse(String(init.body));
    expect(body.reviewer_pid).toBe("dana");
    expect(body.review).toEqual(rejectionReviewBlock(rubrics));
    expect(body.review.rubrics[0]).not.toHaveProperty("reviewer");
  });
});


describe("PC parity contracts", () => {
  afterEach(() => { vi.unstubAllGlobals(); sessionSkips.review.length = 0; sessionSkips.trajectory.length = 0; });
  it("preserves rubric order and insertion while keeping source provenance", () => {
    const rows = seedRubrics(task);
    const added = { ...rows[0], sourceIndex: null, title: "First", text: "Inserted before the source step", original: null };
    const result = buildReviewedTask(task, { title: "T", request: "R", difficulty: "high", rubrics: [added, rows[0]] }) as any;
    expect(result.task.steps.map((s: any) => s.description)).toEqual([added.text, rows[0].text]);
    expect(result.task.steps.map((s: any) => s.order)).toEqual([0, 1]);
    expect(result.review.rubrics[1].source_index).toBe(0);
    expect(task.task.steps).toHaveLength(1);
  });
  it("routes every author mutation and return to the PC API", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, items: [], source_total: 250, offset: 200, limit: 50 }) }));
    vi.stubGlobal("fetch", fetcher);
    const page = await myTaskPage("key", "author", 200, 50);
    expect(page.source_total).toBe(250);
    const payload = { task_title: "T", agent_request: "R", difficulty: "high", success_criteria: [], steps: [], must_visit_or_reach: [], required_outputs: [], notes: null };
    await authorEdit("key", "author", "source", payload, "opened", "appeal reason");
    await authorAmend("key", "author", "source", payload, "opened");
    await authorSignoff("key", "author", "source", "opened");
    await reviewReturn("key", "Reviewer", { subKey: "source", token: "lock", task, claimedAtMs: 0, lockTtlMs: 1 }, "Return reason", "reviewer");
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => new URL(url).hostname)).toEqual(Array(5).fill("t1ynh195m1.execute-api.us-east-1.amazonaws.com"));
    expect(JSON.parse(String(calls[1][1].body))).toMatchObject({ participant_id: "author", appeal_reason: "appeal reason", edit_started_at: "opened" });
    expect(JSON.parse(String(calls[4][1].body))).toMatchObject({ token: "lock", reviewer_pid: "reviewer" });
  });
  it("keeps skips bounded and carries grading history from AWS", async () => {
    for (let i = 0; i < 60; i++) rememberReviewSkip(`task-${i}`);
    rememberTrajectorySkip("manifest-old");
    const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith("/trajectory/claim") ? { manifest_key: "manifest", token: "lock", run: {}, task_lineage: { changed: true }, prior_grades: [{ run_id: "previous" }] } : {} }));
    vi.stubGlobal("fetch", fetcher);
    await reviewClaim("key", "Reviewer", "pid");
    const claim = await trajectoryClaim("key", "Reviewer", "pid");
    expect(sessionSkips.review).toHaveLength(50);
    expect(claim?.taskLineage).toEqual({ changed: true });
    expect(claim?.priorGrades?.[0].run_id).toBe("previous");
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(String(calls[0][1].body)).skip_keys).toEqual(sessionSkips.review);
    expect(JSON.parse(String(calls[1][1].body)).skip_keys).toEqual(["manifest-old"]);
  });
});
