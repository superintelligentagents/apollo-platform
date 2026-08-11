// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type Ctx } from "../src/ui/context";
import { renderTrajectoryEdit } from "../src/ui/screens/trajectory-edit";

describe("Apollo PC trajectory grader", () => {
  beforeEach(() => vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; }));

  it("hides the LLM judgment and supports step, rubric, and verdict shortcuts", () => {
    const state = initialState();
    state.reviewKey = "key";
    state.trajectoryClaim = {
      manifestKey: "run/manifest.json", token: "token", claimedAtMs: Date.now(), lockTtlMs: 1_800_000,
      run: {
        schema_version: "apollo-trajectory-review-package-v1", run_id: "run-1", task_id: "pc_task-1", task_prompt: "Create the requested artifact from the supplied context.", created_at_utc: null,
        source: { agent: "Skyvern", model: "Claude Opus 5" }, metrics: { num_steps: 2, num_screenshots: 1, average_rubric_score: 0, perfect: false },
        rubrics: [
          { rubric_id: "R1", requirement: "The artifact is complete.", verification: "Inspect it.", llm_status: "FAILURE", llm_score: 0, llm_success: false, llm_reasoning: "Hidden LLM reasoning" },
          { rubric_id: "R2", requirement: "Sources are cited.", verification: "Inspect sources.", llm_status: "SUCCESS", llm_score: 1, llm_success: true, llm_reasoning: "Also hidden" },
        ],
        steps: [
          { index: 0, step_number: 1, action: "open", response: "", final: false, screenshot_path: "1.png", screenshot_url: "https://example.com/1.png" },
          { index: 1, step_number: 2, action: "finish", response: "Done", final: true, screenshot_path: null, screenshot_url: null },
        ],
      },
    };
    const ctx = { state, adapter: { storage: { get: vi.fn(async () => null), set: vi.fn(async () => {}) } }, actions: { reviewerName: () => "Reviewer" } } as unknown as Ctx;
    const root = renderTrajectoryEdit(ctx);
    expect(root.textContent).toContain("Reference only — do not grade the prompt");
    expect(root.textContent).toContain("Choose what should happen to this run.");
    expect(root.textContent).toContain("Edit needed");
    expect(root.textContent).toContain("Needs rerun");
    expect(root.textContent).not.toContain("Hidden LLM reasoning");
    expect(root.textContent).not.toContain("Prompt quality");
    expect(root.querySelector(".pc-trajectory-rubric-track")?.children).toHaveLength(2);

    root.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true }));
    expect(state.trajectoryJudgment?.rubrics[0].human_verdict).toBe("SUCCESS");
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
    expect(root.querySelector(".pc-trajectory-rubric-judge h3")?.textContent).toBe("R2");
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "o", bubbles: true }));
    expect(state.trajectoryJudgment?.rubrics[1].human_verdict).toBe("FAILURE");
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(root.querySelector(".pc-trajectory-action")?.textContent).toBe("finish");

    const editNeeded = [...root.querySelectorAll<HTMLButtonElement>(".pc-overall-option")].find((button) => button.textContent?.includes("Edit needed"));
    editNeeded?.click();
    expect(state.trajectoryJudgment?.trajectory.overall_outcome).toBe("EDIT_NEEDED");
    expect(state.trajectoryJudgment?.trajectory.task_satisfied).toBe("FAILURE");
    expect(root.querySelector<HTMLTextAreaElement>(".pc-outcome-notes")?.placeholder).toContain("what should be edited");
    expect(root.querySelector<HTMLButtonElement>(".pc-trajectory-actions .primary")?.disabled).toBe(true);

    const note = root.querySelector<HTMLTextAreaElement>(".pc-outcome-notes")!;
    note.value = "Rubric R2 asks for evidence the task never requested.";
    note.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.trajectoryJudgment?.trajectory.notes).toContain("task never requested");
    expect(root.querySelector<HTMLButtonElement>(".pc-trajectory-actions .primary")?.disabled).toBe(false);
  });
});
