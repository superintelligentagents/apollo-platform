import { describe, expect, it } from "vitest";
import { normalizeTrajectoryJudgment, seedTrajectoryJudgment, setTrajectoryOverallOutcome, type TrajectoryRun } from "../src/review-client";

const run = {
  rubrics: [{ rubric_id: "R1" }],
} as unknown as TrajectoryRun;

describe("trajectory final outcomes", () => {
  it("seeds the four-way final outcome without changing rubric verdicts", () => {
    const draft = seedTrajectoryJudgment(run);
    expect(draft.trajectory).toEqual({ overall_outcome: "", task_satisfied: "", notes: "" });
    expect(draft.rubrics).toEqual([{ rubric_id: "R1", human_verdict: "", notes: "" }]);
  });

  it.each([
    ["YES", "SUCCESS"],
    ["NO", "FAILURE"],
    ["EDIT_NEEDED", "FAILURE"],
    ["NEEDS_RERUN", "UNJUDGEABLE"],
  ] as const)("maps %s to the backend-compatible task satisfaction value", (outcome, taskSatisfied) => {
    const draft = seedTrajectoryJudgment(run);
    setTrajectoryOverallOutcome(draft, outcome);
    expect(draft.trajectory.overall_outcome).toBe(outcome);
    expect(draft.trajectory.task_satisfied).toBe(taskSatisfied);
  });

  it("migrates an older saved draft", () => {
    const legacy = {
      rubrics: [{ rubric_id: "R1", human_verdict: "SUCCESS", notes: "" }],
      trajectory: { task_satisfied: "UNJUDGEABLE", notes: "Missing final screenshot." },
    } as unknown as ReturnType<typeof seedTrajectoryJudgment>;
    expect(normalizeTrajectoryJudgment(legacy).trajectory.overall_outcome).toBe("NEEDS_RERUN");
  });

  it("migrates the temporary final_outcome draft field to the native backend field", () => {
    const temporary = {
      rubrics: [{ rubric_id: "R1", human_verdict: "SUCCESS", notes: "" }],
      trajectory: { final_outcome: "EDIT_NEEDED", task_satisfied: "FAILURE", notes: "Fix R1." },
    } as unknown as ReturnType<typeof seedTrajectoryJudgment>;
    const normalized = normalizeTrajectoryJudgment(temporary);
    expect(normalized.trajectory.overall_outcome).toBe("EDIT_NEEDED");
    expect("final_outcome" in normalized.trajectory).toBe(false);
  });
});
