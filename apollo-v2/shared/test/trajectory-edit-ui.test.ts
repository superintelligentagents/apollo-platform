// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type Ctx } from "../src/ui/context";
import { renderTrajectoryEdit } from "../src/ui/screens/trajectory-edit";

describe("human trajectory grader", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  });

  it("shows reference evidence without the LLM judge and supports fast keyboard grading", () => {
    const state = initialState();
    state.reviewKey = "review-key";
    state.trajectoryClaim = {
      manifestKey: "v2-review/trajectory-runs/task/run/manifest.json",
      token: "token",
      claimedAtMs: Date.now(),
      lockTtlMs: 30 * 60 * 1000,
      run: {
        schema_version: "apollo-trajectory-review-package-v1",
        run_id: "run-1",
        task_id: "v2/alice/internal/task-1",
        task_prompt: "Research the public evidence and create the requested artifact.",
        created_at_utc: "2026-08-11T00:00:00Z",
        source: { evaluator_format: "run_full_trajectory_per_rubric.py", source_result_sha256: "hash", run_directory_name: "run", trajectory_filename: "steps.jsonl", agent: "Skyvern", model: "Claude Opus 5", run_label: "pilot" },
        metrics: { num_steps: 2, num_screenshots: 1, average_rubric_score: 0, perfect: false },
        rubrics: [
          { rubric_id: "R1", requirement: "The artifact contains evidence.", verification: "Inspect it.", llm_status: "FAILURE", llm_score: 0, llm_success: false, llm_reasoning: "The final state did not show it." },
          { rubric_id: "R2", requirement: "The artifact names its public sources.", verification: "Inspect the source list.", llm_status: "SUCCESS", llm_score: 1, llm_success: true, llm_reasoning: "Sources were visible." },
        ],
        steps: [
          { index: 0, step_number: 1, action: "open browser", response: "", final: false, screenshot_path: "screens/1.png", screenshot_url: "https://example.com/1.png" },
          { index: 1, step_number: 2, action: "finish", response: "Done", final: true, screenshot_path: null, screenshot_url: null },
        ],
      },
    };
    const ctx = {
      state,
      adapter: { storage: { set: vi.fn(async () => {}), get: vi.fn(async () => null) } },
      actions: { reviewerName: () => "Reviewer" },
    } as unknown as Ctx;

    const root = renderTrajectoryEdit(ctx);
    expect(root.textContent).toContain("Research the public evidence");
    expect(root.textContent).toContain("Skyvern");
    expect(root.textContent).toContain("Claude Opus 5");
    expect(root.textContent).toContain("Reference only — do not grade the prompt");
    expect(root.textContent).toContain("Judge the agent run, not the task wording.");
    expect(root.textContent).not.toContain("LLM");
    expect(root.textContent).not.toContain("The final state did not show it.");
    expect(root.textContent).not.toContain("Difficulty");
    expect(root.querySelector(".trajectory-rubric-track")?.children).toHaveLength(2);
    expect(root.querySelector<HTMLImageElement>(".trajectory-screenshot")?.src).toBe("https://example.com/1.png");

    root.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true }));
    expect(state.trajectoryJudgment?.rubrics[0].human_verdict).toBe("SUCCESS");

    root.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
    expect(root.querySelector(".rubric-judge h3")?.textContent).toBe("R2");
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "o", bubbles: true }));
    expect(state.trajectoryJudgment?.rubrics[1].human_verdict).toBe("FAILURE");

    root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(root.querySelector(".trajectory-action")?.textContent).toBe("finish");

    const outcomeLabels = [...root.querySelectorAll<HTMLButtonElement>(".overall-judge .judge-option")]
      .map((button) => button.textContent);
    expect(outcomeLabels).toEqual(["Yes", "No", "Edit needed", "Needs rerun"]);
    root.querySelectorAll<HTMLButtonElement>(".overall-judge .judge-option")[2].click();
    expect(state.trajectoryJudgment?.trajectory.overall_outcome).toBe("EDIT_NEEDED");
    expect(root.querySelector<HTMLButtonElement>(".trajectory-submit")?.disabled).toBe(true);
    const followUp = root.querySelector<HTMLTextAreaElement>(".overall-judge .judge-notes")!;
    expect(followUp.placeholder).toContain("Required");
    followUp.value = "Replace the broken rubric URL.";
    followUp.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector<HTMLButtonElement>(".trajectory-submit")?.disabled).toBe(false);
  });
});
