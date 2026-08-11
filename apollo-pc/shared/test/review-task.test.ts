import { describe, expect, it } from "vitest";
import { buildReviewTaskSidecar, reviewTaskFilename } from "../src/review-task";
import type { PCTask } from "../src/types";

const task: PCTask = {
  task_id: "task-a/unsafe",
  category: "multi_step_orchestration",
  task_title: "Plan the trip",
  agent_request: "Plan a complete trip with exact dates and costs.",
  steps: [{ order: 0, title: "Compare", description: "Compare three complete options." }],
  success_criteria: ["Three options are compared."],
  required_sources: ["email", "calendar"],
  referenced_record_ids: ["private-mail-id"],
  expected_answer: "private ground truth",
  notes: "Keep the result concise.",
};

describe("PC peer-review sidecars", () => {
  it("uses a safe deterministic filename", () => {
    expect(reviewTaskFilename(task)).toBe("review_task_task-a_unsafe.json");
  });

  it("contains authored task text but no private context or answer key", () => {
    const body = buildReviewTaskSidecar(task, "2026-07-31T00:00:00.000Z");
    const parsed = JSON.parse(body);

    expect(parsed.task.agent_request).toBe(task.agent_request);
    expect(parsed.task.steps).toEqual(task.steps);
    expect(parsed.participant).toMatchObject({ participant_id: "redacted", name: null, email: null });
    expect(body).not.toContain("private-mail-id");
    expect(body).not.toContain("private ground truth");
    expect(body).not.toContain("required_sources");
    expect(body).not.toContain("referenced_record_ids");
    expect(body).not.toContain("expected_answer");
  });
});
