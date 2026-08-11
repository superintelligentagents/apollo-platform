import { describe, expect, it } from "vitest";
import { buildReviewedTask, seedRubrics, type RubricRow, upgradeRubrics } from "../src/review-client";
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
