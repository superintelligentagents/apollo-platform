import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReviewedTask, rejectionReviewBlock, reviewReject, seedRubrics, upgradeRubrics } from "../src/review-client";
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
