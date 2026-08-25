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

  function claimWith(taskLineage: unknown) {
    return {
      manifestKey: "v2-review/trajectory-runs/task/run/manifest.json",
      token: "token",
      claimedAtMs: Date.now(),
      lockTtlMs: 30 * 60 * 1000,
      run: {
        schema_version: "apollo-trajectory-review-package-v1",
        run_id: "run-2",
        task_id: "v2/alice/internal/task-2",
        task_prompt: "Find a hotel near Hongdae for 3 nights under $150/night.",
        created_at_utc: "2026-08-11T00:00:00Z",
        source: { evaluator_format: null, source_result_sha256: null, run_directory_name: null, trajectory_filename: null, agent: null, model: null, run_label: null },
        metrics: { num_steps: 1, num_screenshots: 0 },
        rubrics: [
          { rubric_id: "rubric-1", requirement: "Hotel is within 1 km of Hongdae station", verification: "Check the map." },
          { rubric_id: "rubric-2", requirement: "Booking covers three nights", verification: "Check the dates." },
        ],
        steps: [{ index: 0, step_number: 1, action: "finish", response: "Done", final: true, screenshot_path: null, screenshot_url: null }],
      },
      taskLineage,
    };
  }

  function ctxFor(claim: unknown) {
    const state = initialState();
    state.reviewKey = "review-key";
    state.trajectoryClaim = claim as typeof state.trajectoryClaim;
    return {
      state,
      adapter: { storage: { set: vi.fn(async () => {}), get: vi.fn(async () => null) } },
      actions: { reviewerName: () => "Reviewer" },
    } as unknown as Ctx;
  }

  it("shows reviewer edits to the trainer's own task inline (request + rubric diffs)", () => {
    const root = renderTrajectoryEdit(ctxFor(claimWith({
      task_id: "v2/alice/internal/task-2",
      status: "approved",
      reviewer: "Riya",
      reviewed_at: "2026-08-12T00:00:00Z",
      revision_of_task_id: null,
      changed: true,
      title: { original: "Seoul trip", final: "Seoul trip", changed: false },
      request: { original: "Find a hotel near Hongdae for 3 nights.", final: "Find a hotel near Hongdae for 3 nights under $150/night.", changed: true },
      rubrics: [
        { rubric_id: "rubric-1", title: "Step 1", original: "Hotel is near Hongdae", final: "Hotel is within 1 km of Hongdae station", changed: true },
        { rubric_id: "rubric-2", title: "Step 2", original: "Booking covers three nights", final: "Booking covers three nights", changed: false },
      ],
    })));

    const note = root.querySelector(".trajectory-lineage-note.changed");
    expect(note?.textContent).toContain("Edited in review by Riya");
    expect(note?.textContent).toContain("request · 1 rubric");
    // Prompt opens in diff mode: inserted words highlighted, struck originals kept.
    const reference = root.querySelector<HTMLDetailsElement>(".trajectory-task-reference")!;
    expect(reference.hasAttribute("open")).toBe(true);
    expect(reference.querySelector(".trajectory-prompt-text .diff-ins")?.textContent).toContain("$150/night");
    expect(reference.querySelector(".trajectory-prompt-text .diff-del")?.textContent).toBe("nights.");
    const toggle = reference.querySelector<HTMLButtonElement>(".trajectory-prompt-toggle")!;
    expect(toggle.textContent).toBe("Show as run");
    toggle.click();
    expect(reference.querySelector(".trajectory-prompt-text .diff-ins")).toBeNull();
    expect(reference.querySelector(".trajectory-prompt-text")?.textContent).toBe("Find a hotel near Hongdae for 3 nights under $150/night.");
    expect(toggle.textContent).toBe("Show my edits");

    // Rubric 1 carries an inline diff; rubric 2 does not.
    expect(root.querySelector(".rubric-judge .rubric-lineage")?.textContent).toContain("EDITED IN REVIEW");
    expect(root.querySelector(".rubric-judge .rubric-lineage .diff-ins")?.textContent).toContain("within 1 km");
    expect(root.querySelectorAll(".trajectory-rubric-chip.edited")).toHaveLength(1);
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
    expect(root.querySelector(".rubric-judge .rubric-lineage")).toBeNull();
  });

  it("says so plainly when the task ran exactly as written, and stays quiet without lineage", () => {
    const unchanged = renderTrajectoryEdit(ctxFor(claimWith({
      task_id: "v2/alice/internal/task-2",
      status: "approved",
      reviewer: "Riya",
      reviewed_at: "2026-08-12T00:00:00Z",
      revision_of_task_id: null,
      changed: false,
      title: { original: "Seoul trip", final: "Seoul trip", changed: false },
      request: { original: "Find a hotel near Hongdae for 3 nights under $150/night.", final: "Find a hotel near Hongdae for 3 nights under $150/night.", changed: false },
      rubrics: [],
    })));
    expect(unchanged.querySelector(".trajectory-lineage-note.unchanged")?.textContent).toContain("Ran exactly as you wrote it.");
    expect(unchanged.querySelector(".trajectory-prompt-toggle")).toBeNull;
    expect(unchanged.querySelector<HTMLButtonElement>(".trajectory-prompt-toggle")?.hidden).toBe(true);
    expect(unchanged.querySelector(".rubric-lineage")).toBeNull();

    const noLineage = renderTrajectoryEdit(ctxFor(claimWith(null)));
    expect(noLineage.querySelector(".trajectory-lineage-note")).toBeNull();
    expect(noLineage.querySelector(".trajectory-prompt-text")?.textContent).toBe("Find a hotel near Hongdae for 3 nights under $150/night.");
  });

  it("shows the previous run's grade per rubric, with the rubric wording as it read then", () => {
    const claim = claimWith(null) as Record<string, unknown>;
    claim.priorGrades = [{
      run_id: "run-1",
      task_id: "v2/alice/internal/task-2",
      created_at_utc: "2026-08-10T00:00:00Z",
      agent: "Skyvern",
      model: "Claude Opus 5",
      task_prompt: "Find a hotel near Hongdae for 3 nights.",
      graded_by: "Alice",
      graded_at: "2026-08-12T00:00:00Z",
      overall_outcome: "EDIT_NEEDED",
      notes: "Rubric 1 was too vague about distance.",
      rubrics: [
        { rubric_id: "rubric-1", requirement: "Hotel is near Hongdae", verification: "Check the map.", human_verdict: "UNJUDGEABLE", notes: "Near is undefined." },
        { rubric_id: "rubric-2", requirement: "Booking covers three nights", verification: "Check the dates.", human_verdict: "SUCCESS", notes: "" },
      ],
    }];
    const root = renderTrajectoryEdit(ctxFor(claim));
    const note = root.querySelector(".trajectory-prior-note")!;
    expect(note.textContent).toContain("Previous run graded Edit needed");
    expect(note.textContent).toContain("1/2 rubrics passed");
    expect(note.textContent).toContain("1 rubric reworded since");
    expect(note.textContent).toContain("Rubric 1 was too vague about distance.");
    const rows = note.querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("Unclear");
    expect(rows[0].querySelector(".diff-ins")?.textContent).toContain("within 1 km");
    expect(rows[1].textContent).toContain("Pass");
    expect(rows[1].textContent).toContain("unchanged");
    // Judge pane for rubric 1 carries the previous verdict + reword diff.
    const priorBlock = root.querySelector(".rubric-judge .rubric-prior")!;
    expect(priorBlock.textContent).toContain("PREVIOUS RUN");
    expect(priorBlock.textContent).toContain("Unclear");
    expect(priorBlock.textContent).toContain("Near is undefined.");
    expect(priorBlock.querySelector(".diff-del")?.textContent).toBe("near");
    // Without prior grades nothing is shown.
    expect(renderTrajectoryEdit(ctxFor(claimWith(null))).querySelector(".trajectory-prior-note")).toBeNull();
  });
});
