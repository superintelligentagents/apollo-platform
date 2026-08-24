import test from "node:test";
import assert from "node:assert/strict";
import {
  excludeOwnSubmissions,
  excludeIneligible,
  authorEditEligibility,
  buildAmendedFinalGold,
  finalGoldRevision,
  stageMinutes,
  distinctRejectedTaskIds,
  participantIdFromFinishedKey,
  buildAuthorHistory,
  isReviewSubmissionKey,
  participantIdFromSubKey,
  reviewUnitForKey,
  summarizeAdminUsers,
  isAllowedAdminEmail,
  summarizePCBundles,
  buildPCAdminEdit,
  restrictPCAdminRecord,
  isConditionalConflict,
  tryConditionalWrite,
  pcAdminRevision,
  reviewContentHash,
  textContentHash,
  uploadObjectKey,
  buildReportingReport,
  llmReviewKeyFor,
  taskIdFromLlmReviewKey,
  parseLlmReviewArtifactKey,
  selectLlmReviewArtifact,
  applicableLlmReviewCandidates,
  currentReviewerLlmCandidates,
  hasCompletedReviewerPreQc,
  isCompletedReviewerPreQcArtifact,
  reportingTaskContentHash,
  llmFeedbackFromReview,
  llmRepairPlanFromReview,
  llmRubricResultsFromReview,
  llmEvergreenReviewFromReview,
  hydrateReportingLlmReviews,
  cleanTaskSnapshot,
  cleanRubrics,
  taskMetadataForReporting,
  sortPendingReviewUnits,
  pendingReviewUnits,
  reportingKeyMatches,
  taskIdFromTrajectoryManifestKey,
  participantIdFromTrajectoryManifestKey,
  excludeOwnTrajectoryRuns,
  cleanTrajectoryManifest,
  trajectoryManifestForHuman,
  sanitizeHumanTrajectoryJudgment,
  trajectoryOverallOutcome,
  llmReviewForHuman,
  buildTrajectoryReportingReport,
} from "./lambda_presign.js";

const v2 = "prolific/journeys/alice/v2/alice/internal/task-12345678/1_long_task.json";
const pcAlice = "prolific/journeys/alice/pc/alice/internal/bundle-12345678/2_review_task_task-a.json";
const pcBob = "prolific/journeys/bob/pc/bob/internal/bundle-87654321/3_review_task_task-b.json";

test("extracts submitter ids from both task apps", () => {
  assert.equal(participantIdFromSubKey(v2), "alice");
  assert.equal(participantIdFromSubKey(pcAlice), "alice");
  assert.equal(participantIdFromSubKey("v2-review/inbox/not-a-task"), null);
});

test("orders review units by submission time instead of participant slug", () => {
  assert.deepEqual(sortPendingReviewUnits([
    { newest: "prolific/journeys/alice/newer.json", oldestAt: 200 },
    { newest: "prolific/journeys/zoe/oldest.json", oldestAt: 100 },
    { newest: "prolific/journeys/bob/newer.json", oldestAt: 200 },
  ]), [
    "prolific/journeys/zoe/oldest.json",
    "prolific/journeys/alice/newer.json",
    "prolific/journeys/bob/newer.json",
  ]);
});

test("distribution metadata prefers final gold and stays out of the content hash", () => {
  const authored = { metadata: { region: "IN", subjects: ["Travel and Tourism > Air Travel"] } };
  const gold = { metadata: { region: "BR", subjects: ["Health > Medicine"] } };
  // The precedence the admin row builder applies: a reviewer may correct the
  // author's pick during QC, so final gold is what the team-spread panel counts.
  const resolve = (source, final) =>
    taskMetadataForReporting(final) ?? taskMetadataForReporting(source);

  assert.deepEqual(resolve(authored, gold), { region: "BR", subjects: ["Health > Medicine"] });
  assert.deepEqual(resolve(authored, null), {
    region: "IN",
    subjects: ["Travel and Tourism > Air Travel"],
  });
  // Tasks predating the fields carry none, and an empty object is not metadata.
  assert.equal(resolve({}, null), null);
  assert.equal(resolve({ metadata: {} }, null), null);

  // The dashboard reads this beside the snapshots, never inside them: adding a
  // field to cleanTaskSnapshot would restate every stored task's content hash
  // and drop it out of the pre-QC audit gate as stale.
  const task = { task_title: "T", agent_request: "R", steps: [], ...authored };
  assert.equal("metadata" in cleanTaskSnapshot(task), false);
});

test("a returned task re-enters the queue after the author revises it", () => {
  const enc = (key) => Buffer.from(key, "utf8").toString("base64url");
  const dir = "prolific/journeys/alice/v2/alice/internal/task-1";
  const returned = `${dir}/1700000000000-aaaaaaaa_long_task.json`;
  const revised = `${dir}/1700000001000-bbbbbbbb_long_task.json`;
  // Both revisions land in the same task directory (same unit); the newer
  // revision is the unit's newest file.
  const units = [{ newest: revised, files: [returned, revised], oldestAt: 1700000000000 }];
  const doneSet = new Set([enc(returned)]); // the returned revision is done; the new one isn't
  assert.deepEqual(pendingReviewUnits(units, doneSet).map((u) => u.newest), [revised]);
  // The OLD rule (pending unless ANY file was done) would have dropped this
  // unit entirely, stranding the author's revision outside the review queue.
  // Backward compatible: a single-file unit that's done stays out of the queue.
  assert.deepEqual(pendingReviewUnits([{ newest: returned, files: [returned], oldestAt: 1700000000000 }], doneSet), []);
  // ... and a single not-done file still surfaces, exactly as before.
  assert.deepEqual(pendingReviewUnits([{ newest: revised, files: [revised], oldestAt: 1700000000000 }], doneSet).map((u) => u.newest), [revised]);
});

test("accepts individually revocable reporting credentials", () => {
  const keys = ["shared-reporting-key", "kyle-reporting-key"];
  assert.equal(reportingKeyMatches("kyle-reporting-key", keys), true);
  assert.equal(reportingKeyMatches("shared-reporting-key", keys), true);
  assert.equal(reportingKeyMatches("unknown-key", keys), false);
  assert.equal(reportingKeyMatches("", keys), false);
});

test("task review becomes claimable only after a current supported PRE_QC artifact", () => {
  const taskId = "v2/alice/internal/task-12345678";
  const currentHash = "a".repeat(64);
  const candidates = [
    { taskId, contentHash: currentHash, pipelineVersion: 16, stage: "PRE_QC", modifiedAt: 3 },
    { taskId, contentHash: "b".repeat(64), pipelineVersion: 19, stage: "PRE_QC", modifiedAt: 4 },
    { taskId, contentHash: currentHash, pipelineVersion: 19, stage: "POST_QC", modifiedAt: 5 },
  ];
  assert.equal(hasCompletedReviewerPreQc(candidates, taskId, currentHash), false);
  candidates.push({ taskId, contentHash: currentHash, pipelineVersion: 19, stage: "PRE_QC", modifiedAt: 6 });
  assert.equal(hasCompletedReviewerPreQc(candidates, taskId, currentHash), true);
  assert.equal(hasCompletedReviewerPreQc(candidates, "v2/bob/internal/task-2", currentHash), false);
});

test("only complete live-audit artifacts unlock human review", () => {
  const complete = {
    status: "NEEDS_HUMAN_REVIEW",
    source: { rubrics: [{ rubric_id: "rubric-1" }, { rubric_id: "rubric-2" }] },
    rubric_reviews: [
      { rubric_id: "rubric-1", status: "COMPLETED" },
      { rubric_id: "rubric-2", status: "COMPLETED" },
    ],
  };
  assert.equal(isCompletedReviewerPreQcArtifact(complete), true);
  assert.equal(isCompletedReviewerPreQcArtifact({ ...complete, status: "PIPELINE_ERROR" }), false);
  assert.equal(isCompletedReviewerPreQcArtifact({
    ...complete,
    rubric_reviews: [{ rubric_id: "rubric-1", status: "COMPLETED" }],
  }), false);
  assert.equal(isCompletedReviewerPreQcArtifact({
    ...complete,
    rubric_reviews: [
      { rubric_id: "rubric-1", status: "COMPLETED" },
      { rubric_id: "rubric-2", status: "FAILED" },
    ],
  }), false);
});

test("trajectory manifest keys preserve task identity and self-review exclusion", () => {
  const taskId = "v2/alice/internal/task-12345678";
  const encoded = Buffer.from(taskId, "utf8").toString("base64url");
  const aliceRun = `v2-review/trajectory-runs/${encoded}/run-a/manifest.json`;
  const bobTask = "v2/bob/internal/task-87654321";
  const bobRun = `v2-review/trajectory-runs/${Buffer.from(bobTask, "utf8").toString("base64url")}/run-b/manifest.json`;
  assert.equal(taskIdFromTrajectoryManifestKey(aliceRun), taskId);
  assert.equal(participantIdFromTrajectoryManifestKey(aliceRun), "alice");
  assert.deepEqual(excludeOwnTrajectoryRuns([aliceRun, bobRun], "alice"), [bobRun]);
  assert.equal(taskIdFromTrajectoryManifestKey("v2-review/trajectory-runs/bad/run/manifest.json"), null);
});

const trajectoryManifest = {
  schema_version: "apollo-trajectory-review-package-v1",
  run_id: "run-1",
  task_id: "v2/alice/internal/task-12345678",
  task_prompt: "Research the live public sources and produce a cited artifact.",
  source: { evaluator_format: "run_full_trajectory_per_rubric.py", source_result_sha256: "abc", agent: "Skyvern", model: "Claude Opus 5", run_label: "pilot" },
  metrics: { average_rubric_score: 0.5 },
  rubrics: [
    { rubric_id: "R1", requirement: "Find source A", verification: "Inspect A", llm_score: 1, llm_success: true, llm_reasoning: "Shown." },
    { rubric_id: "R2", requirement: "Create output B", verification: "Inspect B", llm_score: 0, llm_success: false, llm_reasoning: "Missing." },
  ],
  steps: [
    { index: 0, step_number: 1, action: "open", response: "", screenshot_path: "screens/00001.png" },
    { index: 1, step_number: 2, action: "type", response: "done", screenshot_path: null, final: true },
  ],
};

test("sanitizes trajectory packages and keeps screenshot paths package-relative", () => {
  const clean = cleanTrajectoryManifest(trajectoryManifest);
  assert.equal(clean.task_id, trajectoryManifest.task_id);
  assert.equal(clean.metrics.num_steps, 2);
  assert.equal(clean.metrics.num_screenshots, 1);
  assert.equal(clean.metrics.perfect, false);
  assert.equal(clean.source.agent, "Skyvern");
  assert.equal(clean.source.model, "Claude Opus 5");
  assert.equal(cleanTrajectoryManifest({ ...trajectoryManifest, steps: [{ index: 0, screenshot_path: "../private.png" }] }).steps[0].screenshot_path, null);
  assert.equal(cleanTrajectoryManifest({ ...trajectoryManifest, rubrics: [] }), null);
});

test("grader-facing trajectory packages withhold every LLM judgment field", () => {
  const safe = trajectoryManifestForHuman(trajectoryManifest);
  assert.ok(safe);
  assert.deepEqual(safe.metrics, { num_steps: 2, num_screenshots: 1 });
  assert.deepEqual(safe.rubrics[0], {
    rubric_id: "R1",
    requirement: "Find source A",
    verification: "Inspect A",
  });
  assert.equal(JSON.stringify(safe).includes("llm_"), false);
  assert.equal(JSON.stringify(safe).includes("Shown."), false);
});

test("keeps trajectory judge errors distinct from model failures", () => {
  const withError = {
    ...trajectoryManifest,
    metrics: {},
    rubrics: [
      { ...trajectoryManifest.rubrics[0], llm_status: "ERROR", llm_score: null, llm_success: null, llm_reasoning: "Provider unavailable." },
      { ...trajectoryManifest.rubrics[1], llm_status: "FAILURE" },
    ],
  };
  const clean = cleanTrajectoryManifest(withError);
  assert.equal(clean.rubrics[0].llm_status, "ERROR");
  assert.equal(clean.rubrics[0].llm_score, null);
  assert.equal(clean.rubrics[0].llm_success, null);
  assert.equal(clean.metrics.judge_errors, 1);
  const judgment = sanitizeHumanTrajectoryJudgment({
    rubrics: [
      { rubric_id: "R1", human_verdict: "SUCCESS" },
      { rubric_id: "R2", human_verdict: "FAILURE" },
    ],
    trajectory: { task_satisfied: "FAILURE" },
  }, withError);
  assert.equal(judgment.rubrics[0].llm_judge_correct, null);
  assert.equal(judgment.rubrics[1].llm_judge_correct, true);
  assert.equal(judgment.trajectory.task_satisfied, "FAILURE");
  assert.equal(judgment.trajectory.overall_outcome, "NO");
});

test("requires complete human judgments and records LLM agreement per rubric", () => {
  const judgment = sanitizeHumanTrajectoryJudgment({
    rubrics: [
      { rubric_id: "R1", human_verdict: "SUCCESS", notes: "Visible in step 1." },
      { rubric_id: "R2", human_verdict: "UNJUDGEABLE", notes: "The recording is incomplete." },
    ],
    trajectory: { task_satisfied: "UNJUDGEABLE", notes: "The final evidence is missing." },
  }, trajectoryManifest);
  assert.equal(judgment.rubrics[0].llm_judge_correct, true);
  assert.equal(judgment.rubrics[1].llm_judge_correct, null);
  assert.equal(judgment.trajectory.task_satisfied, "UNJUDGEABLE");
  assert.equal(judgment.trajectory.overall_outcome, "NEEDS_RERUN");
  assert.equal(judgment.schema_version, "apollo-human-trajectory-judgment-v3");
  assert.equal("prompt" in judgment, false);
  assert.throws(() => sanitizeHumanTrajectoryJudgment({
    rubrics: [],
    trajectory: { task_satisfied: "SUCCESS" },
  }, trajectoryManifest), /every rubric/);
});

test("accepts the previous overall trajectory outcome during client migration", () => {
  const judgment = sanitizeHumanTrajectoryJudgment({
    rubrics: [
      { rubric_id: "R1", human_verdict: "SUCCESS" },
      { rubric_id: "R2", human_verdict: "FAILURE" },
    ],
    trajectory: { outcome: "REAL_MODEL_FAILURE" },
  }, trajectoryManifest);
  assert.equal(judgment.trajectory.task_satisfied, "FAILURE");
  assert.equal(judgment.trajectory.overall_outcome, "NO");
});

test("stores four stable overall outcomes and requires actionable edit/rerun notes", () => {
  const rubrics = [
    { rubric_id: "R1", human_verdict: "SUCCESS" },
    { rubric_id: "R2", human_verdict: "FAILURE" },
  ];
  const edited = sanitizeHumanTrajectoryJudgment({
    rubrics,
    trajectory: { overall_outcome: "EDIT_NEEDED", notes: "Replace the unavailable source URL." },
  }, trajectoryManifest);
  assert.equal(edited.trajectory.overall_outcome, "EDIT_NEEDED");
  assert.equal(edited.trajectory.task_satisfied, "FAILURE", "legacy consumers retain a three-way alias");
  assert.throws(() => sanitizeHumanTrajectoryJudgment({
    rubrics,
    trajectory: { overall_outcome: "EDIT_NEEDED", notes: "Too short" },
  }, trajectoryManifest), /at least 10 characters/);
  assert.throws(() => sanitizeHumanTrajectoryJudgment({
    rubrics,
    trajectory: { overall_outcome: "NEEDS_RERUN", notes: "              " },
  }, trajectoryManifest), /follow-up notes/);
  const rerun = sanitizeHumanTrajectoryJudgment({
    rubrics,
    trajectory: { overall_outcome: "NEEDS_RERUN", notes: "Capture the missing final browser state." },
  }, trajectoryManifest);
  assert.equal(rerun.trajectory.overall_outcome, "NEEDS_RERUN");
  assert.equal(rerun.trajectory.task_satisfied, "UNJUDGEABLE");
  assert.equal(trajectoryOverallOutcome({ task_satisfied: "SUCCESS" }), "YES");
  assert.equal(trajectoryOverallOutcome({ outcome: "TASK_OR_RUBRIC_BROKEN" }), "EDIT_NEEDED");
});

test("normalizes advisory LLM pre-QC for the human task reviewer", () => {
  const hash = "a".repeat(64);
  const review = llmReviewForHuman({
    task_id: trajectoryManifest.task_id,
    task_content_hash: hash,
    pipeline_version: "apollo-llm-feasibility-v11",
    created_at_utc: "2026-08-11T00:00:00Z",
    status: "NEEDS_HUMAN_REVIEW",
    manager_review: {
      disposition: "NEEDS_HUMAN_REVIEW",
      summary: "One rubric needs attention.",
      evergreen_review: { verdict: "EVERGREEN", summary: "Runnable later.", concerns: [] },
      quality_review: {
        overall_verdict: "FAIL",
        confidence: 0.92,
        summary: "One rubric is not bounded enough to judge.",
        prompt_realism: { verdict: "PASS", summary: "Plausible request.", concerns: [] },
        prompt_quality: { verdict: "PASS", summary: "Clear request.", concerns: [] },
        difficulty: { verdict: "PASS", rating: "APPROPRIATE", summary: "Meaningful web work.", concerns: [] },
        rubric_assessments: [{ rubric_id: "R1", verdict: "FAIL", summary: "The verifier population is unbounded.", issues: ["No finite source set."] }],
      },
      rubric_assessments: [{ rubric_id: "R1", accepted_worker_verdict: "SHORTFALL", manager_note: "Bound the source set." }],
    },
    feedback: { task: "Clarify scope.", rubrics: [{ rubric_id: "R1", feedback: "Bound the source set." }] },
    rubric_reviews: [{
      rubric_id: "R1",
      effective_verdict: "SHORTFALL",
      review: { verdict: "SHORTFALL", summary: "The population is open-ended.", blockers: ["No bound."], evidence: [{ url: "https://example.com", title: "Example", supports: "Source exists." }] },
      browser_review: { status: "NOT_RUN", review: null },
    }],
  }, trajectoryManifest.task_id, hash);
  assert.equal(review.advisory_only, true);
  assert.equal(review.rubrics[0].verdict, "SHORTFALL");
  assert.equal(review.quality.prompt_realism.verdict, "PASS");
  assert.equal(review.quality.difficulty.rating, "APPROPRIATE");
  assert.equal(review.rubrics[0].quality_verdict, "FAIL");
  assert.deepEqual(review.rubrics[0].quality_issues, ["No finite source set."]);
  assert.equal(review.rubrics[0].summary, "The population is open-ended.");
  assert.equal(llmReviewForHuman({ task_id: "other", task_content_hash: hash }, trajectoryManifest.task_id, hash), null);
});

test("normalizes the narrowed v17 coherence and compatibility review", () => {
  const hash = "b".repeat(64);
  const review = llmReviewForHuman({
    task_id: trajectoryManifest.task_id,
    task_content_hash: hash,
    pipeline_version: "apollo-llm-feasibility-v17",
    status: "LLM_PASS",
    manager_review: {
      disposition: "FEASIBLE",
      summary: "Every rubric has a practical live-web path.",
      evergreen_review: { verdict: "NOT_ASSESSED", summary: "Not part of v17.", concerns: [] },
      quality_review: {
        overall_verdict: "PASS",
        confidence: 0.95,
        summary: "The task is coherent and its rubrics fit the requested flow.",
        task_coherence: { verdict: "PASS", summary: "Consistent goal.", concerns: [] },
        rubric_assessments: [{ rubric_id: "R1", verdict: "PASS", summary: "Compatible.", issues: [] }],
      },
      rubric_assessments: [{ rubric_id: "R1", accepted_worker_verdict: "POSSIBLE", manager_note: "Reachable." }],
    },
    feedback: { task: null, rubrics: [] },
    rubric_reviews: [{
      rubric_id: "R1",
      effective_verdict: "POSSIBLE",
      review: { verdict: "POSSIBLE", summary: "Reachable.", blockers: [], evidence: [{ url: "https://example.com", title: "Example", supports: "Path exists." }] },
      browser_review: { status: "NOT_RUN", review: null },
    }],
  }, trajectoryManifest.task_id, hash);
  assert.equal(review.quality.task_coherence.verdict, "PASS");
  assert.equal(review.quality.prompt_quality.verdict, "PASS", "legacy clients receive the same coherence axis");
  assert.equal(review.quality.prompt_realism, null);
  assert.equal(review.quality.difficulty, null);
  assert.equal(review.evergreen.verdict, "NOT_ASSESSED");
  assert.equal(review.rubrics[0].quality_verdict, "PASS");
});

test("trajectory reporting separates metadata from opt-in full content", () => {
  const items = [{
    manifest_key: "manifest-a",
    task_id: "task-a",
    run_id: "run-a",
    status: "reviewed",
    reviewer: "Reviewer",
    reviewed_at: "2026-08-11T00:00:00Z",
    llm_average_rubric_score: 0.5,
    llm_perfect: false,
    agent: "Skyvern",
    model: "Claude Opus 5",
    run_label: "pilot",
    human_outcome: "FAILURE",
    human_final_grade: "EDIT_NEEDED",
    manifest: { task_prompt: "private prompt" },
    human_judgment: { notes: "private notes" },
  }];
  const summary = buildTrajectoryReportingReport(items, "2026-08-11T00:01:00Z");
  assert.equal(summary.trajectories[0].human_outcome, "FAILURE");
  assert.equal(summary.trajectories[0].human_final_grade, "EDIT_NEEDED");
  assert.equal(summary.trajectories[0].model, "Claude Opus 5");
  assert.equal("manifest" in summary.trajectories[0], false);
  const full = buildTrajectoryReportingReport(items, "2026-08-11T00:01:00Z", { includeContent: true });
  assert.equal(full.trajectories[0].manifest.task_prompt, "private prompt");
  assert.equal(full.schema_version, "apollo-trajectory-reporting-v2");
});

test("uses collision-free task ids for LLM pass and attention artifacts", () => {
  const taskId = "v2/alice/internal/task-12345678";
  const encoded = Buffer.from(taskId, "utf8").toString("base64url");
  assert.equal(llmReviewKeyFor(taskId, "FEASIBLE"), `v2-review/llm_pass/${encoded}.json`);
  assert.equal(llmReviewKeyFor(taskId, "NOT_FEASIBLE"), `v2-review/llm_fail/${encoded}.json`);
  assert.equal(llmReviewKeyFor(taskId, "FEASIBLE_WITH_EXPLICIT_SHORTFALL"), `v2-review/llm_fail/${encoded}.json`);
  assert.equal(taskIdFromLlmReviewKey(`v2-review/llm_pass/${encoded}.json`, "v2-review/llm_pass/"), taskId);
  assert.equal(taskIdFromLlmReviewKey(`v2-review/llm_pass/${encoded}.${"a".repeat(64)}.apollo-llm-feasibility-v1.json`, "v2-review/llm_pass/"), taskId);
  assert.equal(taskIdFromLlmReviewKey("v2-review/llm_pass/not-base64.abc.json", "v2-review/llm_pass/"), null);
});

test("selects a current-hash LLM artifact before the highest pipeline version and timestamp", () => {
  const taskId = "v2/alice/internal/task-12345678";
  const encoded = Buffer.from(taskId, "utf8").toString("base64url");
  const currentHash = "a".repeat(64);
  const staleHash = "b".repeat(64);
  const prefix = "v2-review/llm_pass/";
  const candidate = (hash, version, modifiedAt) => parseLlmReviewArtifactKey(
    `${prefix}${encoded}.${hash}.apollo-llm-feasibility-v${version}.json`,
    prefix,
    "passed",
    modifiedAt
  );
  const currentV4 = candidate(currentHash, 4, "2026-08-01T00:00:00Z");
  const currentV5Older = candidate(currentHash, 5, "2026-08-02T00:00:00Z");
  const currentV5Latest = candidate(currentHash, 5, "2026-08-03T00:00:00Z");
  const staleV99 = candidate(staleHash, 99, "2026-08-09T00:00:00Z");
  assert.equal(currentV5Latest.pipelineVersion, 5);
  assert.equal(currentV5Latest.stage, "POST_QC");
  assert.equal(selectLlmReviewArtifact([staleV99, currentV4, currentV5Older, currentV5Latest], currentHash)?.key, currentV5Latest.key);
  assert.equal(selectLlmReviewArtifact([staleV99, currentV4], "c".repeat(64))?.key, staleV99.key);
});

test("never mixes advisory PRE_QC reviews with final-gold POST_QC reviews", () => {
  const candidates = [
    { key: "pre", stage: "PRE_QC" },
    { key: "post", stage: "POST_QC" },
  ];
  assert.deepEqual(applicableLlmReviewCandidates(candidates, "pending").map((item) => item.key), ["pre"]);
  assert.deepEqual(applicableLlmReviewCandidates(candidates, "in_review").map((item) => item.key), ["pre"]);
  assert.deepEqual(applicableLlmReviewCandidates(candidates, "approved").map((item) => item.key), ["post"]);
  assert.deepEqual(applicableLlmReviewCandidates(candidates, "rejected").map((item) => item.key), ["post"]);
});

test("human reviewer guidance ignores artifacts from the retired strict policy", () => {
  const candidates = [
    { pipelineVersion: 14, key: "v14" },
    { pipelineVersion: 16, key: "v16" },
    { pipelineVersion: 17, key: "v17" },
    { pipelineVersion: 18, key: "v18" },
    { pipelineVersion: 19, key: "v19" },
  ];
  assert.deepEqual(currentReviewerLlmCandidates(candidates).map((item) => item.key), ["v19"]);
});

test("task content fingerprints change with effective gold text or rubrics", () => {
  const original = { request: "Original", steps: [{ order: 1, title: "One", description: "Find A" }] };
  const final = { request: "Final", steps: [{ order: 1, title: "One", description: "Find B" }] };
  const rubrics = [{ rubric_id: "rubric-1", kind: "step", source_index: 0, title: "One", final: "Find B" }];
  const hash = reportingTaskContentHash(original, final, rubrics);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, reportingTaskContentHash(original, { ...final }, rubrics.map((rubric) => ({ ...rubric }))));
  assert.notEqual(hash, reportingTaskContentHash(original, { ...final, request: "Changed" }, rubrics));
  assert.notEqual(hash, reportingTaskContentHash(original, final, [{ ...rubrics[0], final: "Find C" }]));
});

test("extracts whole-task and per-rubric feedback without changing task content", () => {
  const v2 = {
    feedback: {
      task: "The task scope is ambiguous.",
      rubrics: [{ rubric_id: "rubric-1", feedback: "This rubric needs a bounded source set." }],
    },
  };
  assert.deepEqual(llmFeedbackFromReview(v2), v2.feedback);
  assert.deepEqual(llmFeedbackFromReview({
    manager_review: { summary: "Legacy task review summary", human_action: "Do not expose this action as feedback" },
    rubric_reviews: [{ rubric_id: "rubric-1", review: { summary: "Legacy rubric review summary", recommended_rubric_edit: "Do not expose this edit as feedback" } }],
  }), {
    task: "Legacy task review summary",
    rubrics: [{ rubric_id: "rubric-1", feedback: "Legacy rubric review summary" }],
  });
  assert.equal(llmFeedbackFromReview(null), null);
});

test("uses manager notes as rubric feedback fallback and exposes normalized v5 verdicts", () => {
  const review = {
    status: "NEEDS_HUMAN_REVIEW",
    feedback: {
      task: null,
      rubrics: [
        { rubric_id: "rubric-1", feedback: null },
        { rubric_id: "rubric-2", feedback: "Explicit rubric feedback" },
      ],
    },
    manager_review: {
      disposition: "NEEDS_HUMAN_REVIEW",
      summary: "Manager summary",
      rubric_assessments: [
        { rubric_id: "rubric-1", accepted_worker_verdict: "POSSIBLE", manager_note: "Manager-confirmed fallback" },
        { rubric_id: "rubric-2", accepted_worker_verdict: "SHORTFALL", manager_note: "Manager note two" },
      ],
    },
    rubric_reviews: [
      {
        rubric_id: "rubric-1",
        effective_verdict: "POSSIBLE",
        review: { verdict: "SHORTFALL", rubric_feedback: null },
        browser_review: { status: "COMPLETED", review: { verdict: "POSSIBLE", rubric_feedback: null } },
      },
      {
        rubric_id: "rubric-2",
        effective_verdict: "SHORTFALL",
        review: { verdict: "SHORTFALL", rubric_feedback: "Worker feedback" },
        browser_review: { status: "NOT_RUN", review: null },
      },
    ],
  };
  assert.deepEqual(llmFeedbackFromReview(review), {
    task: "Manager summary",
    rubrics: [
      { rubric_id: "rubric-1", feedback: "Manager-confirmed fallback" },
      { rubric_id: "rubric-2", feedback: "Explicit rubric feedback" },
    ],
  });
  assert.deepEqual(llmRubricResultsFromReview(review), [
    {
      rubric_id: "rubric-1",
      effective_verdict: "POSSIBLE",
      base_verdict: "SHORTFALL",
      browser_status: "COMPLETED",
      browser_verdict: "POSSIBLE",
      manager_accepted_verdict: "POSSIBLE",
      manager_note: "Manager-confirmed fallback",
      quality_verdict: null,
      quality_summary: null,
      quality_issues: [],
      feedback: "Manager-confirmed fallback",
    },
    {
      rubric_id: "rubric-2",
      effective_verdict: "SHORTFALL",
      base_verdict: "SHORTFALL",
      browser_status: "NOT_RUN",
      browser_verdict: null,
      manager_accepted_verdict: "SHORTFALL",
      manager_note: "Manager note two",
      quality_verdict: null,
      quality_summary: null,
      quality_issues: [],
      feedback: "Explicit rubric feedback",
    },
  ]);
});

test("exposes a normalized whole-task evergreen review", () => {
  const review = {
    manager_review: {
      evergreen_review: {
        verdict: "NOT_EVERGREEN",
        summary: "The task depends on today's result.",
        concerns: ["Uses today.", "Expected value will expire."],
      },
    },
  };
  assert.deepEqual(llmEvergreenReviewFromReview(review), review.manager_review.evergreen_review);
  assert.equal(llmEvergreenReviewFromReview({ manager_review: {} }), null);
});

test("reporting snapshots and rubric audits do not truncate authored text", () => {
  const longText = "complete rubric text ".repeat(1_500);
  assert.ok(longText.length > 20_000);
  const original = cleanTaskSnapshot({
    agent_request: longText,
    success_criteria: [longText],
    steps: [{ title: "Long step", description: longText }],
  });
  const final = cleanTaskSnapshot({
    agent_request: `${longText} edited`,
    steps: [{ title: "Long step", description: `${longText} edited` }],
  });
  const rubrics = cleanRubrics({ rubrics: [{ kind: "step", source_index: 0, title: "Long step", original: longText, final: `${longText} edited`, changed: true, checked: true }] }, original, final);
  assert.equal(original.request, longText);
  assert.equal(original.criteria[0], longText);
  assert.equal(original.steps[0].description, longText);
  assert.equal(rubrics[0].original, longText);
  assert.equal(rubrics[0].final, `${longText} edited`);
  const legacyAuditFallback = cleanRubrics({ rubrics: [{ kind: "step", checked: true }] }, original, final);
  assert.equal(legacyAuditFallback.length, 1);
  assert.equal(legacyAuditFallback[0].final, `${longText} edited`);
});

test("sanitizes distribution metadata without adding it to content snapshots", () => {
  const task = {
    task_title: "Compare routes",
    agent_request: "Compare current routes.",
    metadata: { region: "IN", subjects: ["Travel and Tourism > Air Travel"] },
  };
  assert.deepEqual(taskMetadataForReporting(task), {
    region: "IN",
    subjects: ["Travel and Tourism > Air Travel"],
  });
  assert.equal(cleanTaskSnapshot(task).metadata, undefined);
});

test("excludes a reviewer's own v2 and PC tasks while retaining another user's", () => {
  assert.deepEqual(excludeOwnSubmissions([v2, pcAlice, pcBob], "alice"), [pcBob]);
  assert.deepEqual(excludeOwnSubmissions([v2, pcAlice, pcBob], "bob"), [v2, pcAlice]);
});

test("indexes only review-safe PC sidecars and keeps each task independent", () => {
  const retry = pcAlice.replace("/2_review_task_", "/9_review_task_");
  const concurrentRetry = pcAlice.replace("/2_review_task_", "/1700000000000-ab12cd34_review_task_");
  const secondTask = pcAlice.replace("task-a", "task-c");
  const privateManifest = pcAlice.replace("2_review_task_task-a.json", "4_manifest.json");

  assert.equal(isReviewSubmissionKey(pcAlice), true);
  assert.equal(isReviewSubmissionKey(privateManifest), false);
  assert.equal(reviewUnitForKey(pcAlice), reviewUnitForKey(retry));
  assert.equal(reviewUnitForKey(pcAlice), reviewUnitForKey(concurrentRetry));
  assert.notEqual(reviewUnitForKey(pcAlice), reviewUnitForKey(secondTask));
});

test("separates V2 and PC upload keys and avoids same-millisecond collisions", () => {
  const at = 1_700_000_000_000;
  const v2Key = uploadObjectKey("alice", "v2/alice/internal/task-12345678", "long_task.json", at, "aaaaaaaa");
  const pcKey = uploadObjectKey("alice", "pc/alice/internal/bundle-12345678", "manifest.json", at, "bbbbbbbb");
  const concurrentV2Key = uploadObjectKey("alice", "v2/alice/internal/task-12345678", "long_task.json", at, "cccccccc");
  assert.match(v2Key, /\/v2\/alice\/internal\/task-12345678\/1700000000000-aaaaaaaa_long_task\.json$/);
  assert.match(pcKey, /\/pc\/alice\/internal\/bundle-12345678\/1700000000000-bbbbbbbb_manifest\.json$/);
  assert.notEqual(v2Key, concurrentV2Key);
  assert.notEqual(v2Key, pcKey);
});

test("conditional writes allow exactly one winner under contention", async () => {
  let stored = null;
  const write = async (candidate) => {
    await Promise.resolve();
    if (stored !== null) {
      const error = new Error("already exists");
      error.name = "PreconditionFailed";
      error.$metadata = { httpStatusCode: 412 };
      throw error;
    }
    stored = candidate;
  };
  const outcomes = await Promise.all(
    Array.from({ length: 32 }, (_, candidate) => tryConditionalWrite(() => write(candidate)))
  );
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(outcomes.filter((won) => !won).length, 31);
  assert.equal(isConditionalConflict({ name: "ConditionalRequestConflict", $metadata: { httpStatusCode: 409 } }), true);
  await assert.rejects(() => tryConditionalWrite(() => Promise.reject(new Error("network failure"))), /network failure/);
});

test("revision and content hashes detect stale PC edits and differing V2 outcomes", () => {
  assert.equal(pcAdminRevision(null), 0);
  assert.equal(pcAdminRevision({ history: [] }), 1);
  assert.equal(pcAdminRevision({ history: [{}, {}] }), 3);
  assert.equal(pcAdminRevision({ revision_count: 47, history: Array(20).fill({}) }), 47);
  const reviewed = { task_id: "task-1", task: { agent_request: "Original" } };
  assert.equal(reviewContentHash(reviewed), reviewContentHash({ ...reviewed }));
  assert.notEqual(reviewContentHash(reviewed), reviewContentHash({ ...reviewed, task: { agent_request: "Changed" } }));
  assert.equal(textContentHash("exact uploaded bytes"), textContentHash("exact uploaded bytes"));
  assert.notEqual(textContentHash("exact uploaded bytes"), textContentHash("different bytes"));
});

test("summarizes admin submissions by participant and workflow status", () => {
  const users = summarizeAdminUsers([
    { participant_id: "alice", participant_name: "Alice", participant_email: "alice@example.com", status: "pending" },
    { participant_id: "alice", participant_name: "Alice", participant_email: "alice@example.com", status: "approved" },
    { participant_id: "bob", participant_name: "Bob", participant_email: "bob@example.com", status: "in_review" },
    { participant_id: "redacted", participant_name: "Anonymous / redacted", participant_email: "", status: "rejected" },
  ]);
  assert.deepEqual(users, [
    { participant_id: "alice", name: "Alice", email: "alice@example.com", submitted: 2, pending: 1, in_review: 0, approved: 1, rejected: 0 },
    { participant_id: "redacted", name: "Anonymous / redacted", email: "", submitted: 1, pending: 0, in_review: 0, approved: 0, rejected: 1 },
    { participant_id: "bob", name: "Bob", email: "bob@example.com", submitted: 1, pending: 0, in_review: 1, approved: 0, rejected: 0 },
  ]);
});

test("builds a content-free reporting feed for created and QC'd tasks", () => {
  const report = buildReportingReport({
    total: 3,
    truncated: false,
    users: [{ participant_id: "alice", submitted: 2 }],
    items: [
      { task_id: "task-1", participant_id: "alice", participant_name: "Alice", participant_email: "alice@example.com", mode: "guided", submitted_at: "2026-08-01T00:00:00Z", status: "pending", reviewer: "", reviewed_at: "", changed: false, rejection_reason: "", trajectory_count: 0, visit_count: 0, original: { request: "private task text" } },
      { task_id: "task-2", participant_id: "alice", participant_name: "Alice", participant_email: "alice@example.com", mode: "theme", submitted_at: "2026-08-02T00:00:00Z", status: "approved", reviewer: "Reviewer", reviewed_at: "2026-08-03T00:00:00Z", changed: true, rejection_reason: "", trajectory_count: 2, visit_count: 14 },
      { task_id: "task-3", participant_id: "bob", participant_name: "Bob", participant_email: "bob@example.com", mode: "compose", submitted_at: "2026-08-02T00:00:00Z", status: "rejected", reviewer: "Reviewer", reviewed_at: "2026-08-03T00:00:00Z", changed: false, rejection_reason: "Not actionable", trajectory_count: 1, visit_count: 4 },
    ],
  }, "2026-08-06T00:00:00Z");
  assert.deepEqual(report.totals, { submitted: 3, pending: 1, in_review: 0, approved: 1, rejected: 1, qc_completed: 2 });
  assert.equal(report.generated_at, "2026-08-06T00:00:00Z");
  assert.equal(report.tasks[1].qc_completed, true);
  assert.equal(report.tasks[1].changed_in_qc, true);
  assert.equal("original" in report.tasks[0], false);
  assert.equal("llm_review_result" in report.tasks[0], false);
  assert.equal("llm_rubric_results" in report.tasks[0], false);
  assert.equal(JSON.stringify(report).includes("private task text"), false);
});

test("opt-in reporting exposes complete original/final rubrics and LLM reviews", () => {
  const llmReview = {
    schema_version: "apollo-llm-feasibility-artifact-v5",
    task_id: "task-2",
    task_content_hash: "sha256:abc",
    status: "LLM_PASS",
    manager_review: {
      disposition: "FEASIBLE",
      summary: "Every rubric is supported.",
      task_feedback: "Whole-task feedback",
      evergreen_review: { verdict: "EVERGREEN", summary: "Stable over time.", concerns: [] },
      rubric_assessments: [
        { rubric_id: "rubric-1", accepted_worker_verdict: "POSSIBLE", manager_note: "Manager accepted the browser result." },
      ],
    },
    rubric_reviews: [
      {
        rubric_id: "rubric-1",
        effective_verdict: "POSSIBLE",
        review: { verdict: "SHORTFALL", rubric_feedback: "Base worker requested interaction." },
        browser_review: { status: "COMPLETED", review: { verdict: "POSSIBLE", rubric_feedback: "Browser verification passed." } },
      },
    ],
    feedback: {
      task: "Whole-task feedback",
      rubrics: [{ rubric_id: "rubric-1", feedback: "Rubric feedback" }],
    },
    repair_plan: {
      schema_version: "apollo-task-repair-plan-v2",
      task_id: "task-2",
      created_at_utc: "2026-08-09T00:02:00Z",
      applied_automatically: false,
      source_changed: false,
      summary: "Replace only the obsolete source URL.",
      suggested_task_prompt: null,
      task_prompt_edit_operations: [],
      rubric_repairs: [{
        rubric_id: "rubric-1",
        effective_verdict: "POSSIBLE",
        repair_kind: "NONE",
        confidence: 1,
        reason: "No repair needed.",
        edit_operations: [],
        suggested_rubric_text: null,
        verified_replacement_urls: [],
        human_input_needed: null,
        preserves_intent: true,
        verified_possible: true,
        verification: { status: "NOT_REQUIRED", review: null, error: null },
      }],
      unresolved_rubric_ids: [],
      cross_rubric_notes: [],
      preserves_task_flow: true,
      all_suggested_changes_verified: true,
      all_rubrics_projected_possible: true,
      projected_evergreen_review: {
        status: "NOT_REQUIRED",
        verdict: "EVERGREEN",
        confidence: null,
        reviewed_at_utc: null,
        summary: "Stable over time.",
        concerns: [],
        error: null,
      },
      projected_feasibility_review: {
        status: "NOT_REQUIRED",
        disposition: "FEASIBLE",
        confidence: 0.9,
        reviewed_at_utc: "2026-08-09T00:01:00Z",
        summary: "Every rubric is supported.",
        cross_rubric_conflicts: [],
        task_level_risks: [],
        error: null,
      },
      projected_task_status: "POSSIBLE",
    },
  };
  const dashboard = {
    total: 2,
    truncated: false,
    users: [{ participant_id: "alice", submitted: 2 }],
    items: [
      {
        task_id: "task-1",
        participant_id: "alice",
        participant_name: "Alice",
        participant_email: "alice@example.com",
        mode: "guided",
        submitted_at: "2026-08-01T00:00:00Z",
        status: "pending",
        reviewer: "",
        reviewed_at: "",
        changed: false,
        rejection_reason: "",
        trajectory_count: 0,
        visit_count: 0,
        llm_review_status: "not_reviewed",
      },
      {
        task_id: "task-2",
        participant_id: "alice",
        participant_name: "Alice",
        participant_email: "alice@example.com",
        mode: "guided",
        submitted_at: "2026-08-02T00:00:00Z",
        status: "approved",
        reviewer: "Reviewer",
        reviewed_at: "2026-08-03T00:00:00Z",
        changed: true,
        rejection_reason: "",
        trajectory_count: 0,
        visit_count: 0,
        original: { title: "Original", request: "The complete original prompt", steps: [{ order: 1, title: "Find it", description: "Complete original step" }] },
        final: { title: "Final", request: "The complete edited prompt", steps: [{ order: 1, title: "Find it", description: "Complete edited step" }] },
        rubrics: [{ rubric_id: "rubric-1", kind: "step", source_index: 0, title: "Find it", original: "Complete original step", final: "Complete edited step", changed: true, checked: true }],
        human_review: { evergreen_verified: true, title_edited: true, request_edited: true },
        task_content_hash: "current-hash",
        llm_review_status: "passed",
        llm_review_stage: "POST_QC",
        llm_review: llmReview,
        llm_review_stale: true,
      },
    ],
  };
  const report = buildReportingReport(dashboard, "2026-08-09T00:00:00Z", {
    includeContent: true,
    includeLlmReviews: true,
    taskId: "task-2",
  });
  assert.equal(report.schema_version, "odyssey_internal_reporting_v2");
  assert.equal(report.totals.submitted, 1);
  assert.equal(report.totals.approved, 1);
  assert.equal(report.totals.qc_completed, 1);
  assert.equal(report.tasks[0].content.original.request, "The complete original prompt");
  assert.equal(report.tasks[0].content.final.request, "The complete edited prompt");
  assert.equal(report.tasks[0].content.task_content_hash, "current-hash");
  assert.equal(report.tasks[0].content.rubrics[0].original, "Complete original step");
  assert.equal(report.tasks[0].content.rubrics[0].final, "Complete edited step");
  assert.equal(report.tasks[0].llm_review.manager_review.disposition, "FEASIBLE");
  assert.equal(report.tasks[0].llm_review.review_stage, "POST_QC");
  assert.equal(report.tasks[0].llm_review_stage, "POST_QC");
  assert.equal(report.tasks[0].llm_review.stale, true);
  assert.equal(report.tasks[0].llm_review_result, "LLM_PASS");
  assert.equal(report.tasks[0].llm_manager_disposition, "FEASIBLE");
  assert.deepEqual(report.tasks[0].llm_rubric_results[0], {
    rubric_id: "rubric-1",
    effective_verdict: "POSSIBLE",
    base_verdict: "SHORTFALL",
    browser_status: "COMPLETED",
    browser_verdict: "POSSIBLE",
    manager_accepted_verdict: "POSSIBLE",
    manager_note: "Manager accepted the browser result.",
    quality_verdict: null,
    quality_summary: null,
    quality_issues: [],
    feedback: "Rubric feedback",
    repair: llmRepairPlanFromReview(llmReview).rubric_repairs[0],
  });
  assert.deepEqual(report.tasks[0].llm_feedback, llmReview.feedback);
  assert.deepEqual(report.tasks[0].llm_repair_plan, llmRepairPlanFromReview(llmReview));
  assert.equal(report.tasks[0].llm_repair_plan.all_suggested_changes_verified, true);
  assert.equal(report.tasks[0].llm_repair_plan.projected_task_status, "POSSIBLE");
  assert.equal(report.tasks[0].llm_repair_plan.projected_feasibility_review.disposition, "FEASIBLE");
  assert.equal(report.tasks[0].llm_repair_plan.rubric_repairs[0].verified_possible, true);
  assert.deepEqual(report.tasks[0].llm_evergreen_review, llmReview.manager_review.evergreen_review);
  assert.equal(report.page.returned, 1);
  assert.equal(report.page.next_offset, null);
});

test("reporting suppresses repair candidates that lack an independent POSSIBLE verification", () => {
  const plan = llmRepairPlanFromReview({
    repair_plan: {
      schema_version: "apollo-task-repair-plan-v1",
      task_id: "legacy-task",
      created_at_utc: "2026-08-09T00:00:00Z",
      summary: "Legacy unverified candidate.",
      suggested_task_prompt: "Unverified task rewrite",
      task_prompt_edit_operations: [{ operation: "APPEND", old_text: null, new_text: " rewrite" }],
      rubric_repairs: [{
        rubric_id: "R1",
        effective_verdict: "SHORTFALL",
        repair_kind: "CLARIFY_REQUIREMENT",
        confidence: 0.9,
        reason: "Candidate only.",
        edit_operations: [{ operation: "APPEND", old_text: null, new_text: " clarification" }],
        suggested_rubric_text: "Original clarification",
        verified_replacement_urls: [],
        human_input_needed: null,
        preserves_intent: true,
      }],
      unresolved_rubric_ids: [],
      cross_rubric_notes: [],
      preserves_task_flow: true,
    },
  });
  assert.equal(plan.suggested_task_prompt, null);
  assert.deepEqual(plan.task_prompt_edit_operations, []);
  assert.equal(plan.rubric_repairs[0].suggested_rubric_text, null);
  assert.deepEqual(plan.rubric_repairs[0].edit_operations, []);
  assert.equal(plan.rubric_repairs[0].verified_possible, false);
});

test("pre-QC reporting is visibly advisory and remains separate from final-gold review state", () => {
  const review = {
    schema_version: "apollo-llm-feasibility-artifact-v5",
    task_id: "pending-task",
    task_content_hash: "pending-hash",
    status: "LLM_PASS",
    manager_review: {
      disposition: "FEASIBLE",
      task_feedback: null,
      evergreen_review: { verdict: "EVERGREEN", summary: "Runnable later.", concerns: [] },
      rubric_assessments: [],
    },
    rubric_reviews: [],
    feedback: { task: null, rubrics: [] },
  };
  const report = buildReportingReport({
    total: 1,
    truncated: false,
    users: [],
    items: [{
      task_id: "pending-task",
      participant_id: "alice",
      participant_name: "Alice",
      participant_email: "alice@example.com",
      mode: "guided",
      submitted_at: "2026-08-10T00:00:00Z",
      status: "pending",
      reviewer: "",
      reviewed_at: "",
      changed: false,
      rejection_reason: "",
      trajectory_count: 0,
      visit_count: 0,
      task_content_hash: "pending-hash",
      llm_review_status: "pre_qc_passed",
      llm_review_stage: "PRE_QC",
      llm_review: review,
      llm_review_stale: false,
    }],
  }, "2026-08-10T00:01:00Z", { includeLlmReviews: true });

  assert.equal(report.tasks[0].status, "pending");
  assert.equal(report.tasks[0].qc_completed, false);
  assert.equal(report.tasks[0].llm_review_status, "pre_qc_passed");
  assert.equal(report.tasks[0].llm_review_stage, "PRE_QC");
  assert.equal(report.tasks[0].llm_review.review_stage, "PRE_QC");
  assert.equal(report.tasks[0].llm_review_result, "LLM_PASS");
});

test("hydrates LLM review bodies only for the filtered reporting page", async () => {
  const dashboard = {
    items: [
      { task_id: "a", status: "approved", task_content_hash: "hash-a", llm_review_key: "review-a", llm_review_stale: true },
      { task_id: "b", status: "approved", task_content_hash: "hash-b", llm_review_key: "review-b", llm_review_status: "stale", llm_review_stale: true },
      { task_id: "c", status: "pending", task_content_hash: "hash-c", llm_review_key: "review-c" },
    ],
  };
  const loaded = [];
  await hydrateReportingLlmReviews(dashboard, {
    includeLlmReviews: true,
    status: "approved",
    limit: 1,
    offset: 1,
  }, async (key) => {
    loaded.push(key);
    return { task_content_hash: "hash-b", status: "LLM_PASS" };
  });
  assert.deepEqual(loaded, ["review-b"]);
  assert.equal("llm_review" in dashboard.items[0], false);
  assert.equal(dashboard.items[0].llm_review_stale, true);
  assert.equal(dashboard.items[1].llm_review.status, "LLM_PASS");
  assert.equal(dashboard.items[1].llm_review_stale, true);
  assert.equal(dashboard.items[1].llm_review_status, "stale");
  assert.equal("llm_review" in dashboard.items[2], false);
});

test("report totals describe the full filtered set even when task rows are paged", () => {
  const dashboard = {
    total: 3,
    truncated: false,
    users: [],
    items: [
      { task_id: "a", status: "pending" },
      { task_id: "b", status: "approved" },
      { task_id: "c", status: "rejected" },
    ],
  };
  const report = buildReportingReport(dashboard, "2026-08-09T00:00:00Z", { limit: 1, offset: 1 });
  assert.deepEqual(report.totals, { submitted: 3, pending: 1, in_review: 0, approved: 1, rejected: 1, qc_completed: 2 });
  assert.equal(report.tasks.length, 1);
  assert.equal(report.tasks[0].task_id, "b");
  assert.equal(report.page.next_offset, 2);
});

test("admin email access is normalized and deny-by-default", () => {
  const allowed = new Set(["admin@example.com"]);
  assert.equal(isAllowedAdminEmail(" ADMIN@example.com ", allowed), true);
  assert.equal(isAllowedAdminEmail("other@example.com", allowed), false);
  assert.equal(isAllowedAdminEmail("", allowed), false);
});

test("summarizes completed PC bundle counts by participant", () => {
  const result = summarizePCBundles([
    { participant_id: "alice", participant_name: "Alice", participant_email: "alice@example.com", email_count: 12, calendar_count: 3, task_count: 2 },
    { participant_id: "alice", participant_name: "Alice", participant_email: "alice@example.com", email_count: 4, calendar_count: 1, task_count: 1 },
    { participant_id: "bob", participant_name: "Bob", participant_email: "bob@example.com", email_count: 8, calendar_count: 0, task_count: 2 },
  ]);
  assert.deepEqual(result.totals, { bundles: 3, email: 24, calendar: 4, tasks: 5 });
  assert.deepEqual(result.users[0], {
    participant_id: "alice",
    name: "Alice",
    email: "alice@example.com",
    bundles: 2,
    email_count: 16,
    calendar_count: 4,
    task_count: 3,
  });
});

test("PC admin edits preserve the uploaded original and prior revisions", () => {
  const sourceRecord = { id: "cal-1", summary: "Submitted title", location: "Old room" };
  const first = buildPCAdminEdit({
    existing: null,
    sourceRecord,
    finalRecord: { id: "attempted-change", summary: "First edit", location: "New room" },
    bundleId: "pc/alice/internal/bundle-1",
    kind: "calendar",
    itemId: "cal-1",
    editedBy: "admin@example.com",
    editedAt: "2026-08-01T00:00:00Z",
  });
  const second = buildPCAdminEdit({
    existing: first,
    sourceRecord,
    finalRecord: { summary: "Second edit", location: "New room" },
    bundleId: first.bundle_id,
    kind: "calendar",
    itemId: "cal-1",
    editedBy: "other-admin@example.com",
    editedAt: "2026-08-02T00:00:00Z",
  });
  assert.deepEqual(second.original_record, sourceRecord);
  assert.equal(second.final_record.id, "cal-1");
  assert.equal(second.final_record.summary, "Second edit");
  assert.equal(second.history.length, 1);
  assert.equal(second.history[0].final_record.summary, "First edit");
  assert.equal(first.revision_count, 1);
  assert.equal(second.revision_count, 2);
});

test("email admin edits allow only subject and content", () => {
  const current = {
    id: "mail-1",
    source: "email",
    source_detail: "gmail-mbox",
    timestamp: "2026-08-01T00:00:00Z",
    from: { name: "Other", email: "other@example.com" },
    to: [{ name: "Participant", email: "self-alias@example.test" }],
    cc: [{ name: "Locked CC", email: "cc@example.com" }],
    subject: "Original",
    body_text: "Original content",
    labels: ["Inbox"],
    attachments: [{ filename: "locked.pdf", size: 12 }],
  };
  const requested = {
    ...current,
    id: "changed-id",
    source_detail: "changed-source",
    timestamp: "changed-time",
    from: { name: "Edited sender", email: "edited@example.com" },
    to: [{ name: "Edited participant", email: "self-alias@example.test" }, { name: "Other recipient", email: "recipient@example.com" }],
    cc: [],
    subject: "Edited subject",
    body_text: "Edited content",
    labels: [],
    attachments: [],
  };
  const safe = restrictPCAdminRecord("email", current, requested);
  assert.equal(safe.id, "mail-1");
  assert.equal(safe.source_detail, "gmail-mbox");
  assert.equal(safe.timestamp, "2026-08-01T00:00:00Z");
  assert.deepEqual(safe.from, current.from);
  assert.deepEqual(safe.to, current.to);
  assert.deepEqual(safe.cc, current.cc);
  assert.deepEqual(safe.labels, current.labels);
  assert.deepEqual(safe.attachments, current.attachments);
  assert.equal(safe.subject, "Edited subject");
  assert.equal(safe.body_text, "Edited content");
});

test("calendar admin edits allow only summary and description", () => {
  const current = { id: "cal-2", summary: "A", description: "B", attendees: [{ email: "person@example.test" }], dtstart: "2026-08-01", location: "Locked" };
  const safe = restrictPCAdminRecord("calendar", current, { ...current, id: "changed", summary: "Edited", description: "Updated", attendees: [], dtstart: "changed", location: "Changed" });
  assert.deepEqual(safe, { ...current, summary: "Edited", description: "Updated" });
});

// ---- author sign-off, amendment, and appeals ----

const finalGold = (over = {}) => ({
  schema_version: "odyssey_long_task_v2_reviewed",
  task_id: "v2/alice/internal/task-1",
  task: { task_title: "Reviewer version", agent_request: "Reviewer wrote this.", steps: [] },
  review: { original: { task_title: "Author version" }, rubrics: [{ final: "a", changed: true }], request_edited: true },
  review_content_hash: "hash-reviewer",
  reviewed_by: "Dana",
  finished_at: "2026-08-20T10:00:00Z",
  ...over,
});

test("an author amendment supersedes final gold without erasing the reviewer's audit", () => {
  const doc = buildAmendedFinalGold({
    existing: finalGold(),
    amendedTask: { task_title: "Author's correction", agent_request: "Author rewrote this.", steps: [] },
    contentHash: "hash-author",
    authorPid: "alice",
    amendedAt: "2026-08-24T12:00:00Z",
  });

  assert.equal(doc.task.task_title, "Author's correction");
  assert.equal(doc.review_content_hash, "hash-author");
  assert.equal(doc.amended_by, "alice");
  assert.equal(doc.revision_count, 2);
  // The record of what the human reviewer did survives the author's edit.
  assert.deepEqual(doc.review, finalGold().review);
  assert.equal(doc.reviewed_by, "Dana");
  // ...and the version it replaced is kept, attributed to the reviewer.
  assert.equal(doc.history.length, 1);
  assert.deepEqual(doc.history[0], {
    task: finalGold().task,
    review_content_hash: "hash-reviewer",
    source: "reviewer",
    by: "Dana",
    at: "2026-08-20T10:00:00Z",
  });
});

test("a second amendment is attributed to the author, and history stays bounded", () => {
  let doc = finalGold();
  for (let i = 0; i < 14; i += 1) {
    doc = buildAmendedFinalGold({
      existing: doc,
      amendedTask: { task_title: `v${i}`, agent_request: "x", steps: [] },
      contentHash: `hash-${i}`,
      authorPid: "alice",
      amendedAt: `2026-08-24T12:${String(i).padStart(2, "0")}:00Z`,
    });
  }
  assert.equal(doc.revision_count, 15);
  assert.equal(doc.history.length, 10);
  // Only the very first superseded version came from the reviewer; it has since
  // aged out of the bounded window, leaving author revisions.
  assert.deepEqual([...new Set(doc.history.map((h) => h.source))], ["author"]);
  assert.equal(doc.history.at(-1).by, "alice");
});

test("a finished doc written before the counter existed resolves its revision from history", () => {
  assert.equal(finalGoldRevision(null), 0);
  assert.equal(finalGoldRevision({ task: {} }), 1);
  assert.equal(finalGoldRevision({ history: [{}, {}] }), 3);
  assert.equal(finalGoldRevision({ revision_count: 7, history: [{}] }), 7);
});

test("authors may revise an open or returned task, and appeal a rejection exactly once", () => {
  assert.equal(authorEditEligibility(null, false, 0).allowed, true);
  assert.equal(authorEditEligibility("returned", false, 0).allowed, true);

  const firstAppeal = authorEditEligibility("rejected", false, 1);
  assert.equal(firstAppeal.allowed, true);
  assert.equal(firstAppeal.appeal, true);

  // Rejected a second time: the appeal has been used.
  assert.equal(authorEditEligibility("rejected", false, 2).allowed, false);
  assert.match(authorEditEligibility("rejected", false, 2).reason, /already appealed/i);

  // An approved task goes through the amend path, and a locked one waits.
  assert.equal(authorEditEligibility("approved", false, 0).allowed, false);
  assert.match(authorEditEligibility("approved", false, 0).reason, /sign-off queue/i);
  assert.equal(authorEditEligibility(null, true, 0).allowed, false);
  assert.match(authorEditEligibility(null, true, 0).reason, /claimed/i);
});

test("a reviewer is offered neither their own tasks nor an appeal of a task they rejected", () => {
  const appeal = "prolific/journeys/carol/v2/carol/internal/task-9/2_long_task.json";
  const rejecters = new Map([[appeal, "alice"]]);

  // Alice rejected the first version of Carol's task, so she does not get the
  // appeal — and she never gets her own submission.
  assert.deepEqual(excludeIneligible([v2, pcBob, appeal], "alice", rejecters), [pcBob]);
  // Bob was not involved, so the appeal is his to take.
  assert.deepEqual(excludeIneligible([v2, pcBob, appeal], "bob", rejecters), [v2, appeal]);
  // No participant id (an older client) means no filtering, as before.
  assert.deepEqual(excludeIneligible([v2, appeal], "", rejecters), [v2, appeal]);
});

test("stage minutes come from stored stamps and refuse an implausible span", () => {
  assert.equal(stageMinutes("2026-08-24T12:00:00Z", "2026-08-24T12:06:30Z"), 6.5);
  assert.equal(stageMinutes(null, "2026-08-24T12:00:00Z"), null);
  assert.equal(stageMinutes("2026-08-24T12:00:00Z", "not-a-date"), null);
  // A tab left open overnight, or a clock running backwards, is not a duration.
  assert.equal(stageMinutes("2026-08-22T12:00:00Z", "2026-08-24T12:00:00Z"), null);
  assert.equal(stageMinutes("2026-08-24T12:10:00Z", "2026-08-24T12:00:00Z"), null);
});

test("a task rejected twice counts once, even though it has two rejection records", () => {
  const ids = distinctRejectedTaskIds([
    "v2-review/rejected/v2_alice_internal_task-1_aaaaaaaaaaaaaaaa.json",
    "v2-review/rejected/v2_alice_internal_task-1_bbbbbbbbbbbbbbbb.json",
    "v2-review/rejected/v2_bob_internal_task-2_cccccccccccccccc.json",
  ]);
  assert.deepEqual([...ids].sort(), ["v2_alice_internal_task-1", "v2_bob_internal_task-2"]);
});

test("the author of an approved task is recoverable from its final-gold key", () => {
  assert.equal(
    participantIdFromFinishedKey("v2-review/finished/v2_alice_internal_task-abc-123.json"),
    "alice"
  );
  assert.equal(participantIdFromFinishedKey("v2-review/finished/pc_bundle_thing.json"), null);
});

test("the author history is ordered, and names a reviewer only on an approval", () => {
  const history = buildAuthorHistory({
    revisions: [
      { first: true, created_at: "2026-08-20T09:00:00Z" },
      {
        created_at: "2026-08-22T09:10:00Z",
        appeal_of_sub_key: "older",
        appeal_started_at: "2026-08-22T09:00:00Z",
      },
    ],
    doneRecords: [
      { outcome: "rejected", reviewer: "Dana", completed_at: "2026-08-21T09:00:00Z" },
      { outcome: "approved", reviewer: "Eli", completed_at: "2026-08-23T09:00:00Z" },
    ],
    finalGoldHistory: [
      { source: "reviewer", by: "Eli", at: "2026-08-23T09:00:00Z" },
      { source: "author", by: "alice", at: "2026-08-24T09:00:00Z" },
    ],
  });

  assert.deepEqual(
    history.map((entry) => entry.event),
    ["submitted", "rejected", "appealed", "approved", "amended"]
  );
  // The rejection reaches the author with no name on it; the approval does not.
  assert.equal(history[1].by, "");
  assert.equal(history[3].by, "Eli");
  // The appeal carries how long the author spent revising.
  assert.equal(history[2].minutes, 10);
});

test("an amendment that changes nothing produces the same content hash as the approval", () => {
  // /review/submit hashes final gold this way; the amend route must derive the
  // same value from the same fields or the no-op check never fires and every
  // save burns a revision.
  const existing = finalGold();
  const asSubmitted = {
    schema_version: existing.schema_version,
    task_id: existing.task_id,
    mode: existing.mode,
    task: existing.task,
    review: existing.review,
  };
  const unchanged = {
    schema_version: existing.schema_version,
    task_id: existing.task_id,
    mode: existing.mode,
    task: { ...existing.task },
    review: existing.review,
  };
  assert.equal(reviewContentHash(unchanged), reviewContentHash(asSubmitted));

  const edited = { ...unchanged, task: { ...existing.task, agent_request: "Author rewrote this." } };
  assert.notEqual(reviewContentHash(edited), reviewContentHash(asSubmitted));
});
