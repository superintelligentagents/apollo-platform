import test from "node:test";
import assert from "node:assert/strict";
import {
  finalGoldTaskFromAuthorEdit,
  excludeOwnSubmissions,
  excludeIneligible,
  authorEditEligibility,
  buildAmendedFinalGold,
  buildAuthorApprovedFinal,
  authorApprovedFinalMatches,
  authorApprovedKeyFor,
  finalGoldRevision,
  unchangedAmendSignoffAction,
  stageMinutes,
  distinctRejectedTaskIds,
  participantIdFromFinishedKey,
  buildAuthorHistory,
  buildHumanReviewForAuthor,
  reviewerChangedTask,
  pendingReviewUnits,
  reviewQueueAvailability,
  newestReviewRevision,
  claimCandidateIsCurrent,
  durableDoneStateIsReadable,
  listedLockStateAllowsEdit,
  resolveDoneRecordsForReopen,
  orderClaimCandidates,
  reviewLockCanRelease,
  reviewLockIsActiveForQueue,
  reviewDecisionIsCurrent,
  isAppealRevision,
  rejectionTargetKey,
  finalizingOutcomeDescriptor,
  finalizingOutcomeMatches,
  finalizingRecoveryPlan,
  applyFinalizingRecoverySideEffects,
  isReviewSubmissionKey,
  participantIdFromSubKey,
  reviewUnitForKey,
  summarizeAdminUsers,
  pageAdminDashboard,
  summarizeAdminReviewers,
  llmFlagSummary,
  hydrateReportingLlmFlags,
  canonicalParticipantNames,
  applyParticipantAliases,
  uploadedAtFromSourceKey,
  reviewMinutes,
  reviewSkipCountsFromKeys,
  reopenExclusionsFromKeys,
  excludeReopenedForReviewer,
  buildAdminItemFromDocuments,
  buildDashboardIndexRecord,
  buildDashboardStatusUpdateRequest,
  dashboardRecordMatchesSource,
  dashboardSourceCondition,
  dashboardFromIndexRecords,
  dashboardIndexScope,
  dashboardSubmissionFromIndexRecord,
  taskIdFromSubmissionKey,
  isAllowedAdminEmail,
  summarizePCBundles,
  buildPCAdminEdit,
  restrictPCAdminRecord,
  isConditionalConflict,
  tryConditionalWrite,
  isMissingObjectError,
  headErrorConfirmsAbsent,
  deleteIfPresent,
  withdrawReopenedOutcomeState,
  ensureConditionalMarker,
  appealMarkerMatches,
  inboxMarkerMatches,
  buildAppealMarkerForRevision,
  appealRevisionCanPublish,
  appealMarkerIsVerified,
  rejectedByPidFromDocument,
  rejectionCanAppeal,
  cleanAppealReason,
  appealReasonIsValid,
  MIN_APPEAL_REASON_LENGTH,
  decisionReviewerPid,
  UNVERIFIED_APPEAL_REJECTER,
  publishAuthorRevisionMarkers,
  authorMutationLockKeyFor,
  pcAdminRevision,
  reviewContentHash,
  buildApprovedFinalGoldDocument,
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
  isCurrentIndexedPreQc,
  reportingTaskContentHash,
  llmFeedbackFromReview,
  llmRepairPlanFromReview,
  llmRubricResultsFromReview,
  llmEvergreenReviewFromReview,
  hydrateReportingLlmReviews,
  cleanTaskSnapshot,
  taskMetadataForReporting,
  cleanRubrics,
  sortPendingReviewUnits,
  sortFinishedExamples,
  sanitizeAuthoredTask,
  reportingKeyMatches,
  taskIdFromTrajectoryManifestKey,
  participantIdFromTrajectoryManifestKey,
  participantIdFromTrajectoryTaskId,
  trajectoryRunsForCreator,
  uploadScopeAllows,
  cleanTrajectoryManifest,
  trajectoryManifestForHuman,
  trajectoryTaskLineageForHuman,
  priorTrajectoryGradeForHuman,
  sanitizeHumanTrajectoryJudgment,
  trajectoryOverallOutcome,
  trajectoryEditReviewSeed,
  llmReviewForHuman,
  buildTrajectoryReportingReport,
  safeTrajectoryAssetPath,
  buildOsworldExportReport,
  osworldTaskForItem,
  osworldTaskIdFor,
  acceptedHumanPass,
  selectLatestRunPerTask,
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

test("a completed older revision does not hide a newer author revision", () => {
  const encode = (key) => Buffer.from(key, "utf8").toString("base64url");
  const dir = "prolific/journeys/alice/v2/alice/internal/task-1";
  const returned = `${dir}/1700000000000-aaaaaaaa_long_task.json`;
  const revised = `${dir}/1700000001000-bbbbbbbb_long_task.json`;
  const doneSet = new Set([encode(returned)]);
  assert.deepEqual(
    pendingReviewUnits([{ newest: revised, files: [returned, revised], oldestAt: 1 }], doneSet),
    [{ newest: revised, oldestAt: 1 }]
  );
  assert.deepEqual(
    pendingReviewUnits([{ newest: returned, files: [returned], oldestAt: 1 }], doneSet),
    []
  );
  // A stale Dynamo row may still point at the rejected revision if indexing
  // the newer author edit failed. Reopen must resolve the unit's newest source
  // before touching the historical done record.
  assert.equal(newestReviewRevision([returned, revised], reviewUnitForKey(returned)), revised);
  assert.notEqual(newestReviewRevision([returned, revised], reviewUnitForKey(returned)), returned);
  assert.equal(claimCandidateIsCurrent(returned, [returned, revised], false), false);
  assert.equal(claimCandidateIsCurrent(revised, [returned, revised], false), true);
  assert.equal(claimCandidateIsCurrent(revised, [returned, revised], true), false);
  // Publication can fail after saving the newer source: only the old inbox
  // marker exists, but the old task still must not be claimable. The newer
  // source is not claimable either until its own inbox marker is repaired.
  assert.equal(claimCandidateIsCurrent(returned, [returned, revised], false, true), false);
  assert.equal(claimCandidateIsCurrent(revised, [returned, revised], false, false), false);
  const expiredLock = { token: "old-token", claimed_at: "2026-08-20T00:00:00Z" };
  assert.equal(reviewDecisionIsCurrent({
    subKey: returned,
    storedSubKeys: [returned, revised],
    lock: expiredLock,
    token: "old-token",
    now: Date.parse("2026-08-25T00:00:00Z"),
    ttlMs: 30 * 60 * 1000,
  }), false);
  const finalizingLock = { ...expiredLock, finalizing: true };
  assert.equal(reviewLockIsActiveForQueue(finalizingLock, Date.parse("2026-08-25T00:00:00Z")), true);
  assert.equal(authorEditEligibility(null, reviewLockIsActiveForQueue(finalizingLock), 0).allowed, false);

  const encodedRevised = Buffer.from(revised, "utf8").toString("base64url");
  assert.equal(durableDoneStateIsReadable(new Set([encodedRevised]), new Map(), revised), false);
  assert.equal(listedLockStateAllowsEdit(new Set(), new Set([encodedRevised]), revised), false);
});

test("review status exposes finalizing recovery work without treating ordinary locks as claimable", () => {
  const unlocked = "prolific/journeys/alice/v2/alice/internal/task-1/1_long_task.json";
  const ordinaryLocked = "prolific/journeys/bob/v2/bob/internal/task-2/1_long_task.json";
  const finalizing = "prolific/journeys/carol/v2/carol/internal/task-3/1_long_task.json";
  const encode = (key) => Buffer.from(key, "utf8").toString("base64url");
  const lockSet = new Set([encode(ordinaryLocked), encode(finalizing)]);
  const finalizingSet = new Set([encode(finalizing)]);

  assert.deepEqual(
    reviewQueueAvailability([unlocked, ordinaryLocked, finalizing], lockSet, finalizingSet),
    { claimable: 2, locked: 1 },
  );
  // A reconstructed done record must not hide the finalizing lock before its
  // credit/index repair completes; Claim is the recovery entry point.
  assert.deepEqual(
    pendingReviewUnits(
      [{ newest: finalizing, oldestAt: 1 }],
      new Set([encode(finalizing)]),
      finalizingSet,
    ),
    [{ newest: finalizing, oldestAt: 1 }],
  );
  assert.equal(authorEditEligibility(null, lockSet.has(encode(finalizing)), 0).allowed, false);
});

test("builds a compact additive dashboard index without authored body text", () => {
  const source = {
    task_id: "v2/alice/internal/task-12345678",
    mode: "guided",
    created_at: "2026-08-14T01:00:00.000Z",
    participant: { participant_id: "alice", name: "Alice", email: "alice@example.com" },
    task: {
      task_title: "Compare routes",
      agent_request: "A long private-in-progress task prompt that remains in S3.",
      difficulty: "high",
      metadata: { region: "IN", subjects: ["Travel and Tourism > Air Travel"] },
      steps: [{ order: 1, title: "Compare", description: "Compare three routes." }],
    },
  };
  const item = buildAdminItemFromDocuments({ source, sourceKey: v2 });
  const record = buildDashboardIndexRecord(item, "v2", "2026-08-14T02:00:00.000Z");
  assert.equal(dashboardIndexScope("v2-review/"), "v2");
  assert.equal(taskIdFromSubmissionKey(v2), source.task_id);
  assert.equal(record.source_key, v2);
  assert.equal(record.original_title, "Compare routes");
  assert.equal(record.original_region, "IN");
  assert.deepEqual(record.original_subjects, ["Travel and Tourism > Air Travel"]);
  assert.match(record.task_content_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(record).includes(source.task.agent_request), false);
  assert.equal(JSON.stringify(record).includes("Compare three routes."), false);
});

test("keeps distribution metadata outside the task-content hash", () => {
  const base = {
    task_id: "v2/alice/internal/task-12345678",
    participant: { participant_id: "alice", name: "Alice", email: "alice@example.com" },
    task: { task_title: "Compare routes", agent_request: "Compare three routes.", steps: [{ title: "Compare", description: "Compare routes." }] },
  };
  const withoutMetadata = buildAdminItemFromDocuments({ source: base, sourceKey: v2 });
  const withMetadata = buildAdminItemFromDocuments({
    source: { ...base, task: { ...base.task, metadata: { region: "IN", subjects: ["Travel and Tourism > Air Travel"] } } },
    sourceKey: v2,
  });
  assert.deepEqual(taskMetadataForReporting(withMetadata.original), withMetadata.original.metadata);
  assert.deepEqual(withMetadata.original.metadata, { region: "IN", subjects: ["Travel and Tourism > Air Travel"] });
  assert.equal(withMetadata.task_content_hash, withoutMetadata.task_content_hash);
});

test("indexed live-audit readiness is content-addressed and requires a complete artifact", () => {
  const hash = "a".repeat(64);
  const candidate = { key: "v2-review/llm_pre_qc_pass/task.hash.v22.json", contentHash: hash };
  const record = {
    pre_qc_complete: true,
    pre_qc_artifact_key: candidate.key,
    pre_qc_task_content_hash: hash,
  };
  assert.equal(isCurrentIndexedPreQc(record, candidate, hash), true);
  assert.equal(isCurrentIndexedPreQc({ ...record, pre_qc_complete: false }, candidate, hash), false);
  assert.equal(isCurrentIndexedPreQc(record, { ...candidate, key: `${candidate.key}.new` }, hash), false);
  assert.equal(isCurrentIndexedPreQc(record, candidate, "b".repeat(64)), false);
});

test("Dynamo PRE_QC and lifecycle writes are pinned to the expected source revision", () => {
  const oldSource = v2;
  const newSource = v2.replace("/1_long_task.json", "/2_long_task.json");
  assert.equal(dashboardRecordMatchesSource({ source_key: oldSource }, oldSource), true);
  assert.equal(dashboardRecordMatchesSource({ source_key: oldSource }, newSource), false);
  const sourceCondition = dashboardSourceCondition(newSource);
  assert.equal(sourceCondition.ConditionExpression, "attribute_exists(#entity) AND #source = :expectedSource");
  assert.equal(sourceCondition.ExpressionAttributeValues[":expectedSource"], newSource);

  const pending = buildDashboardStatusUpdateRequest({
    tableName: "dashboard",
    scope: "v2",
    taskId: "v2/alice/internal/task-12345678",
    status: "pending",
    expectedSourceKey: newSource,
    indexedAt: "2026-08-25T01:00:00Z",
  });
  assert.equal(pending.ExpressionAttributeValues[":expectedSource"], newSource);
  assert.match(pending.ConditionExpression, /#source = :expectedSource/);
  assert.match(pending.UpdateExpression, /REMOVE signoff_at, signoff_action, signoff_opened_at$/);
  assert.equal(buildDashboardStatusUpdateRequest({
    tableName: "dashboard",
    scope: "v2",
    taskId: "task",
    status: "approved",
  }), null);
});

test("indexed dashboard expires abandoned review locks and preserves totals", () => {
  const current = {
    scope: "v2",
    entity_key: "TASK#v2/alice/internal/task-12345678",
    entity_type: "TASK",
    task_id: "v2/alice/internal/task-12345678",
    source_key: v2,
    participant_id: "alice",
    participant_name: "Alice",
    submitted_at: "2026-08-14T01:00:00.000Z",
    status: "in_review",
    reviewer: "Reviewer",
    lock_expires_at: "2026-08-14T01:30:00.000Z",
    original_title: "Compare routes",
    original_difficulty: "high",
  };
  const expired = dashboardSubmissionFromIndexRecord(current, Date.parse("2026-08-14T02:00:00.000Z"));
  assert.equal(expired.status, "pending");
  assert.equal(expired.reviewer, "");
  const dashboard = dashboardFromIndexRecords([current], Date.parse("2026-08-14T02:00:00.000Z"));
  assert.equal(dashboard.total, 1);
  assert.equal(dashboard.users[0].pending, 1);
  assert.equal(dashboard.index_source, "dynamodb");
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
    { taskId, contentHash: "b".repeat(64), pipelineVersion: 22, stage: "PRE_QC", modifiedAt: 4 },
    { taskId, contentHash: currentHash, pipelineVersion: 22, stage: "POST_QC", modifiedAt: 5 },
  ];
  assert.equal(hasCompletedReviewerPreQc(candidates, taskId, currentHash), false);
  candidates.push({ taskId, contentHash: currentHash, pipelineVersion: 22, stage: "PRE_QC", modifiedAt: 6 });
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

test("trajectory manifests route only to the task creator", () => {
  const taskId = "v2/alice/internal/task-12345678";
  const encoded = Buffer.from(taskId, "utf8").toString("base64url");
  const aliceRun = `v2-review/trajectory-runs/${encoded}/run-a/manifest.json`;
  const bobTask = "v2/bob/internal/task-87654321";
  const bobRun = `v2-review/trajectory-runs/${Buffer.from(bobTask, "utf8").toString("base64url")}/run-b/manifest.json`;
  assert.equal(taskIdFromTrajectoryManifestKey(aliceRun), taskId);
  assert.equal(participantIdFromTrajectoryManifestKey(aliceRun), "alice");
  assert.equal(participantIdFromTrajectoryTaskId("pc/alice/internal/task-1"), "alice");
  assert.deepEqual(trajectoryRunsForCreator([aliceRun, bobRun], "alice"), [aliceRun]);
  assert.deepEqual(trajectoryRunsForCreator([aliceRun, bobRun], ""), []);
  assert.equal(taskIdFromTrajectoryManifestKey("v2-review/trajectory-runs/bad/run/manifest.json"), null);
});

test("PC deployments accept their own trajectory prefix and upload scope only", () => {
  const taskId = "pc_task-a";
  const encoded = Buffer.from(taskId, "utf8").toString("base64url");
  const pcRun = `pc-review/trajectory-runs/${encoded}/run-a/manifest.json`;
  assert.equal(taskIdFromTrajectoryManifestKey(pcRun, "pc-review/"), taskId);
  assert.equal(taskIdFromTrajectoryManifestKey(pcRun), null);
  assert.equal(uploadScopeAllows("pc", false, true), true);
  assert.equal(uploadScopeAllows("pc", true, false), false);
  assert.equal(uploadScopeAllows("v2", true, false), true);
  assert.equal(uploadScopeAllows("v2", false, true), false);
  assert.equal(uploadScopeAllows("primary", true, false), true);
  assert.equal(uploadScopeAllows("primary", false, false), true);
  assert.equal(uploadScopeAllows("primary", false, true), false);
  assert.equal(uploadScopeAllows("shared", false, false), false);
  assert.equal(uploadScopeAllows("unexpected", true, false), false);
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

test("trajectory task lineage surfaces reviewer edits without provenance", () => {
  const item = {
    task_id: "v2/alice/internal/task-12345678",
    status: "approved",
    reviewer: "Riya",
    reviewed_at: "2026-08-12T00:00:00Z",
    participant_email: "alice@example.com",
    source_key: v2,
    original: { title: "Plan a Seoul trip", request: "Find a hotel near Hongdae for 3 nights.", steps: [] },
    final: { title: "Plan a Seoul trip", request: "Find a hotel near Hongdae for 3 nights under $150/night.", steps: [] },
    rubrics: [
      { rubric_id: "rubric-1", title: "Step 1", original: "Hotel is near Hongdae", final: "Hotel is within 1 km of Hongdae station", changed: true },
      { rubric_id: "rubric-2", title: "Step 2", original: "Three nights", final: "Three nights", changed: false },
    ],
  };
  const lineage = trajectoryTaskLineageForHuman(item);
  assert.equal(lineage.changed, true);
  assert.equal(lineage.title.changed, false);
  assert.equal(lineage.request.changed, true);
  assert.equal(lineage.request.original, "Find a hotel near Hongdae for 3 nights.");
  assert.equal(lineage.rubrics[0].changed, true);
  assert.equal(lineage.rubrics[1].changed, false);
  assert.equal(lineage.reviewer, "Riya");
  assert.equal(lineage.revision_of_task_id, null);
  assert.equal(JSON.stringify(lineage).includes("alice@example.com"), false);
  assert.equal(JSON.stringify(lineage).includes(v2), false);
  // Unreviewed (pending) tasks ran as authored: nothing counts as changed.
  const pending = trajectoryTaskLineageForHuman({ ...item, status: "pending", final: null });
  assert.equal(pending.changed, false);
  assert.equal(pending.request.final, pending.request.original);
  assert.equal(trajectoryTaskLineageForHuman(null), null);
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

test("trajectory edits create a linked additive review seed without changing the source task", () => {
  const original = JSON.stringify(trajectoryManifest);
  const seed = trajectoryEditReviewSeed(
    "v2-review/trajectory-runs/task/run-1/manifest.json",
    trajectoryManifest,
    { trajectory: { overall_outcome: "EDIT_NEEDED", notes: "Replace only the unavailable source." } },
    "2026-08-15T00:00:00Z",
  );
  assert.ok(seed);
  assert.match(seed.taskId, /^v2\/alice\/internal\/task-[a-f0-9]{16}-trajectory-edit$/);
  assert.equal(seed.source.participant.participant_id, "alice");
  assert.equal(seed.source.task.agent_request, trajectoryManifest.task_prompt);
  assert.deepEqual(
    seed.source.task.steps.map((step) => step.description),
    trajectoryManifest.rubrics.map((rubric) => rubric.requirement),
  );
  assert.equal(seed.source.workflow.revision_of_task_id, trajectoryManifest.task_id);
  assert.equal(seed.source.workflow.reason, "Replace only the unavailable source.");
  assert.equal(JSON.stringify(trajectoryManifest), original, "the accepted source task stays byte-for-byte unchanged");
  assert.equal(trajectoryEditReviewSeed("manifest", trajectoryManifest, { trajectory: { overall_outcome: "NEEDS_RERUN" } }), null);
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

test("only relative in-run screenshot paths are signed", () => {
  // The old check appended the path to the prefix and then asserted the result
  // still began with it, which is true by construction and rejected nothing.
  assert.equal(safeTrajectoryAssetPath("screens/00001.png"), "screens/00001.png");
  assert.equal(safeTrajectoryAssetPath("a/b/c.png"), "a/b/c.png");
  for (const bad of [
    "../other-run/manifest.json",
    "screens/../../escape.png",
    "/v2-review/absolute.png",
    "https://example.com/x.png",
    "screens\\windows.png",
    "screens//double.png",
    "./here.png",
    "",
    null,
    undefined,
  ]) {
    assert.equal(safeTrajectoryAssetPath(bad), "", `expected ${JSON.stringify(bad)} to be rejected`);
  }
  assert.equal(safeTrajectoryAssetPath("x".repeat(301)), "");
});

test("trajectory reporting exposes judge coverage beside the average score", () => {
  // A 1.0 average can rest on a subset when rubrics error, so the row has to
  // carry the counts that distinguish a full pass from a partial one.
  const items = [{
    manifest_key: "manifest-a",
    task_id: "task-a",
    run_id: "run-a",
    status: "pending",
    llm_average_rubric_score: 1,
    llm_perfect: false,
    llm_judge_errors: 4,
    llm_rubrics_total: 5,
    llm_rubrics_scored: 1,
  }];
  const row = buildTrajectoryReportingReport(items, "2026-08-11T00:01:00Z").trajectories[0];
  assert.equal(row.llm_average_rubric_score, 1);
  assert.equal(row.llm_perfect, false);
  assert.equal(row.llm_judge_errors, 4);
  assert.equal(row.llm_rubrics_total, 5);
  assert.equal(row.llm_rubrics_scored, 1);

  const clean = buildTrajectoryReportingReport(
    [{ manifest_key: "b", task_id: "t", run_id: "r", status: "pending" }],
    "2026-08-11T00:01:00Z",
  ).trajectories[0];
  assert.equal(clean.llm_judge_errors, 0);
  assert.equal(clean.llm_rubrics_total, null);
});

test("trajectory reporting content pages are larger than the old ten-row cap", () => {
  const items = Array.from({ length: 60 }, (_, index) => ({
    manifest_key: `manifest-${index}`,
    task_id: `task-${index}`,
    run_id: `run-${index}`,
    status: "pending",
    manifest: { task_prompt: "prompt" },
  }));
  const content = buildTrajectoryReportingReport(items, "2026-08-11T00:01:00Z", { includeContent: true });
  assert.equal(content.trajectories.length, 50);
  assert.equal(content.page.next_offset, 50);
  // Screenshot signing is heavier per row, so that view stays smaller.
  const shots = buildTrajectoryReportingReport(items, "2026-08-11T00:01:00Z", {
    includeContent: true,
    includeScreenshots: true,
  });
  assert.equal(shots.trajectories.length, 25);
  // Metadata-only paging is unchanged.
  assert.equal(buildTrajectoryReportingReport(items, "2026-08-11T00:01:00Z").trajectories.length, 60);
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

test("human reviewer guidance requires the request-grounded alignment policy", () => {
  const candidates = [
    { pipelineVersion: 14, key: "v14" },
    { pipelineVersion: 16, key: "v16" },
    { pipelineVersion: 17, key: "v17" },
    { pipelineVersion: 21, key: "v21" },
    { pipelineVersion: 22, key: "v22" },
  ];
  assert.deepEqual(currentReviewerLlmCandidates(candidates).map((item) => item.key), ["v22"]);
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

test("excludes a reviewer's own v2 and PC tasks while retaining another user's", () => {
  assert.deepEqual(excludeOwnSubmissions([v2, pcAlice, pcBob], "alice"), [pcBob]);
  assert.deepEqual(excludeOwnSubmissions([v2, pcAlice, pcBob], "bob"), [v2, pcAlice]);
});

test("claim order serves non-skipped tasks first and keeps skipped ones as a fallback", () => {
  const unlocked = ["a", "b", "c"];
  const locked = ["d", "e"];
  // No skips (absent, empty, or malformed): today's order, untouched.
  assert.deepEqual(orderClaimCandidates(unlocked, locked, undefined), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(orderClaimCandidates(unlocked, locked, []), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(orderClaimCandidates(unlocked, locked, "a"), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(orderClaimCandidates(unlocked, locked, [null, "", 42]), ["a", "b", "c", "d", "e"]);
  // The skipped oldest task moves behind every other candidate — including
  // stale-lock takeovers — so the next claim hands out something different.
  assert.deepEqual(orderClaimCandidates(unlocked, locked, ["a"]), ["b", "c", "d", "e", "a"]);
  assert.deepEqual(orderClaimCandidates(unlocked, locked, ["a", "d"]), ["b", "c", "e", "a", "d"]);
  // Everything skipped: nothing is dropped — the queue still hands one out.
  assert.deepEqual(orderClaimCandidates(unlocked, locked, ["a", "b", "c", "d", "e"]), ["a", "b", "c", "d", "e"]);
  // Skips that aren't in the queue are ignored.
  assert.deepEqual(orderClaimCandidates(unlocked, locked, ["zz"]), ["a", "b", "c", "d", "e"]);
  // Oversized skip lists are capped, never fatal.
  const flood = Array.from({ length: 500 }, (_, i) => `x${i}`);
  assert.deepEqual(orderClaimCandidates(unlocked, locked, flood), ["a", "b", "c", "d", "e"]);
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

test("reopen aborts before done deletion when credit withdrawal fails", async () => {
  const missing = new Error("missing");
  missing.name = "NoSuchKey";
  missing.$metadata = { httpStatusCode: 404 };
  assert.equal(isMissingObjectError(missing), true);
  assert.equal(await deleteIfPresent(() => Promise.reject(missing)), false);
  await assert.rejects(
    () => deleteIfPresent(() => Promise.reject(new Error("transient S3 failure"))),
    /transient S3 failure/,
  );

  const events = [];
  await assert.rejects(() => withdrawReopenedOutcomeState([{ key: "one" }, { key: "two" }], {
    deleteCredit: async ({ key }) => {
      events.push(`credit:${key}`);
      if (key === "two") throw new Error("credit delete failed");
    },
    deleteDone: async ({ key }) => events.push(`done:${key}`),
  }), /credit delete failed/);
  assert.deepEqual(events, ["credit:one", "credit:two"]);

  events.length = 0;
  await withdrawReopenedOutcomeState([{ key: "one" }], {
    deleteCredit: async ({ key }) => events.push(`credit:${key}`),
    deleteLock: async ({ key }) => events.push(`lock:${key}`),
    deleteDone: async ({ key }) => events.push(`done:${key}`),
  });
  assert.deepEqual(events, ["credit:one", "lock:one", "done:one"]);
});

test("reopen keeps authoritative newest done and fails closed on unreadable listed history", async () => {
  const newest = "prolific/journeys/alice/v2/alice/internal/task-1/2_long_task.json";
  const older = "prolific/journeys/alice/v2/alice/internal/task-1/1_long_task.json";
  const encode = (key) => Buffer.from(key, "utf8").toString("base64url");
  const currentDone = { outcome: "approved", target: "finished/current.json" };
  const records = await resolveDoneRecordsForReopen({
    files: [older, newest],
    newest,
    currentDone,
    listedDoneKeys: new Set([encode(newest)]),
    readDone: async () => null,
  });
  assert.deepEqual(records, [{ key: newest, done: currentDone }]);
  await assert.rejects(() => resolveDoneRecordsForReopen({
    files: [older, newest],
    newest,
    currentDone,
    listedDoneKeys: new Set([encode(older), encode(newest)]),
    readDone: async () => null,
  }), /completion state is unreadable/);
});

test("conditional marker conflicts succeed only after existing contents are verified", async () => {
  const expected = {
    sub_key: "new-submission",
    appeal_of: "rejected-submission",
    rejected_by_pid: "reviewer-b",
    created_at: "2026-08-25T01:00:00Z",
  };
  const conflict = async () => {
    const error = new Error("already exists");
    error.name = "PreconditionFailed";
    error.$metadata = { httpStatusCode: 412 };
    throw error;
  };
  let reads = 0;
  assert.equal(await ensureConditionalMarker({
    putIfAbsent: conflict,
    readExisting: async () => {
      reads += 1;
      return { ...expected };
    },
    matches: (existing) => appealMarkerMatches(existing, expected),
  }), true);
  assert.equal(reads, 1);
  assert.equal(await ensureConditionalMarker({
    putIfAbsent: conflict,
    readExisting: async () => ({ ...expected, rejected_by_pid: "somebody-else" }),
    matches: (existing) => appealMarkerMatches(existing, expected),
  }), false);
  assert.equal(await ensureConditionalMarker({
    putIfAbsent: async () => { throw new Error("network failure"); },
    readExisting: async () => expected,
    matches: (existing) => appealMarkerMatches(existing, expected),
  }), false);
  assert.equal(inboxMarkerMatches("new-submission", "new-submission"), true);
  assert.equal(inboxMarkerMatches("different-submission", "new-submission"), false);
});

test("appeal publication is marker-first, failure-safe, and retryable", async () => {
  const storedRevision = {
    appeal_of_sub_key: "rejected-submission",
    created_at: "2026-08-25T01:00:00Z",
  };
  const marker = buildAppealMarkerForRevision("new-submission", storedRevision, "reviewer-b");
  const events = [];
  let storedAppeal = null;
  let failInboxOnce = true;
  let oldInboxExists = true;
  const publish = () => publishAuthorRevisionMarkers({
    appealMarker: marker,
    ensureAppealMarker: async (expected) => {
      events.push(storedAppeal ? "appeal:verify" : "appeal:create");
      if (storedAppeal) return appealMarkerMatches(storedAppeal, expected);
      storedAppeal = { ...expected };
      return true;
    },
    ensureInboxMarker: async () => {
      events.push(failInboxOnce ? "inbox:fail" : "inbox:create");
      if (failInboxOnce) {
        failInboxOnce = false;
        return false;
      }
      return true;
    },
    deleteOldInboxMarker: async () => {
      events.push("old:delete");
      oldInboxExists = false;
    },
  });

  assert.deepEqual(await publish(), { markerWritten: false, appealRouted: true });
  assert.equal(oldInboxExists, true);
  assert.deepEqual(events, ["appeal:create", "inbox:fail"]);

  assert.deepEqual(await publish(), { markerWritten: true, appealRouted: true });
  assert.equal(oldInboxExists, false);
  assert.deepEqual(events, [
    "appeal:create", "inbox:fail", "appeal:verify", "inbox:create", "old:delete",
  ]);
  assert.equal(marker.created_at, storedRevision.created_at);
});

test("appeals fail closed without verified rejecting-reviewer provenance", () => {
  const subKey = "prolific/journeys/alice/v2/alice/internal/task-1/2_long_task.json";
  const revision = {
    appeal_of_sub_key: "prolific/journeys/alice/v2/alice/internal/task-1/1_long_task.json",
    created_at: "2026-08-25T01:00:00Z",
  };
  assert.equal(appealRevisionCanPublish(revision, ""), false);
  assert.equal(appealRevisionCanPublish(revision, "Reviewer Person"), false);
  assert.equal(appealRevisionCanPublish(revision, "reviewer-b"), true);
  const marker = buildAppealMarkerForRevision(subKey, revision, "reviewer-b");
  assert.equal(appealMarkerIsVerified(marker, subKey, revision), true);
  assert.equal(appealMarkerIsVerified({ ...marker, rejected_by_pid: "" }, subKey, revision), false);
  assert.equal(rejectedByPidFromDocument({ rejected_by: "legacy-reviewer" }), "");
  assert.equal(rejectedByPidFromDocument({ rejected_by: "Reviewer Person" }), "");
  assert.deepEqual(
    excludeIneligible([subKey], "", new Map([[subKey, UNVERIFIED_APPEAL_REJECTER]])),
    [],
  );
});

test("an unverified appeal never reaches the inbox or deletes the old marker", async () => {
  const events = [];
  const result = await publishAuthorRevisionMarkers({
    appealMarker: { sub_key: "new-submission" },
    ensureAppealMarker: async () => {
      events.push("appeal:unverified");
      return false;
    },
    ensureInboxMarker: async () => {
      events.push("inbox:create");
      return true;
    },
    deleteOldInboxMarker: async () => events.push("old:delete"),
  });
  assert.deepEqual(result, { markerWritten: false, appealRouted: false });
  assert.deepEqual(events, ["appeal:unverified"]);
});

test("ordinary author revisions still publish inbox before deleting the old marker", async () => {
  const events = [];
  const result = await publishAuthorRevisionMarkers({
    ensureInboxMarker: async () => {
      events.push("inbox:create");
      return true;
    },
    deleteOldInboxMarker: async () => events.push("old:delete"),
  });
  assert.deepEqual(result, { markerWritten: true, appealRouted: false });
  assert.deepEqual(events, ["inbox:create", "old:delete"]);
});

test("reviewer outcomes, author mutations, and reopen serialize on one review-unit lock", async () => {
  const firstRevision = "prolific/journeys/alice/v2/alice/internal/task-12345678/1_long_task.json";
  const secondRevision = "prolific/journeys/alice/v2/alice/internal/task-12345678/2_long_task.json";
  const otherTask = "prolific/journeys/alice/v2/alice/internal/task-87654321/1_long_task.json";
  assert.equal(authorMutationLockKeyFor(firstRevision), authorMutationLockKeyFor(secondRevision));
  assert.notEqual(authorMutationLockKeyFor(firstRevision), authorMutationLockKeyFor(otherTask));

  const held = new Set();
  const acquire = (subKey) => tryConditionalWrite(async () => {
    const key = authorMutationLockKeyFor(subKey);
    if (held.has(key)) {
      const error = new Error("mutation in flight");
      error.name = "PreconditionFailed";
      error.$metadata = { httpStatusCode: 412 };
      throw error;
    }
    held.add(key);
  });
  assert.equal(await acquire(firstRevision), true); // reviewer idempotent retry
  assert.equal(await acquire(secondRevision), false); // reopen/author edit cannot interleave
  assert.equal(authorEditEligibility(null, true, 0).allowed, false); // claim-first: fresh lock blocks edit
  held.delete(authorMutationLockKeyFor(firstRevision));
  assert.equal(await acquire(secondRevision), true); // next actor re-evaluates after release
});

test("release cannot delete a review lock once finalization begins", () => {
  assert.equal(reviewLockCanRelease({ token: "token-1", finalizing: false }, "token-1"), true);
  assert.equal(reviewLockCanRelease({ token: "token-1", finalizing: true }, "token-1"), false);
  assert.equal(reviewLockCanRelease({ token: "token-2", finalizing: false }, "token-1"), false);
  const missing = { name: "NotFound", $metadata: { httpStatusCode: 404 } };
  const transient = { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } };
  assert.equal(headErrorConfirmsAbsent(missing), true);
  assert.equal(headErrorConfirmsAbsent(transient), false);
});

test("stale finalization recovery identifies matching durable outcomes", () => {
  const subKey = "prolific/journeys/alice/v2/alice/internal/task-12345678/1_long_task.json";
  const source = { task_id: "v2/alice/internal/task-12345678" };
  const lock = { finalizing: true, outcome: "approved", content_hash: "hash-approved" };
  const descriptor = finalizingOutcomeDescriptor(subKey, source, lock);
  assert.equal(descriptor.target, "v2-review/finished/v2_alice_internal_task-12345678.json");
  assert.equal(finalizingOutcomeMatches({ review_content_hash: "hash-approved" }, descriptor, lock), true);
  assert.equal(finalizingOutcomeMatches({ review_content_hash: "different" }, descriptor, lock), false);
  assert.equal(finalizingOutcomeDescriptor(subKey, source, { ...lock, outcome: "unknown" }), null);
  assert.deepEqual(finalizingRecoveryPlan("approved"), {
    creditOutcome: "approved",
    dashboardStatus: "approved",
    deleteFinalizingLock: true,
    leaveDoneNonclaimable: true,
  });
  assert.equal(finalizingRecoveryPlan("returned").creditOutcome, null);
  assert.equal(finalizingRecoveryPlan("returned").dashboardStatus, "pending");
});

test("an appealed task's second rejection has a separate terminal target", () => {
  const firstSubKey = "prolific/journeys/alice/v2/alice/internal/task-12345678/1_long_task.json";
  const appealSubKey = "prolific/journeys/alice/v2/alice/internal/task-12345678/2_long_task.json";
  const taskId = "v2/alice/internal/task-12345678";
  const ordinary = { task_id: taskId };
  const appeal = { task_id: taskId, appeal_of_sub_key: firstSubKey, appeal_number: 1 };

  assert.equal(isAppealRevision(ordinary), false);
  assert.equal(isAppealRevision(appeal), true);
  assert.match(rejectionTargetKey(firstSubKey, taskId, ordinary), /^v2-review\/rejected\//);
  assert.match(rejectionTargetKey(appealSubKey, taskId, appeal), /^v2-review\/rejected-twice\//);

  const descriptor = finalizingOutcomeDescriptor(appealSubKey, appeal, {
    finalizing: true,
    outcome: "rejected",
    content_hash: "hash-rejected",
  });
  assert.match(descriptor.target, /^v2-review\/rejected-twice\//);
});

test("finalization recovery keeps its lock until credit and index repair succeed", async () => {
  const events = [];
  const repaired = await applyFinalizingRecoverySideEffects({
    recordCredit: async () => events.push("credit"),
    repairDashboard: async () => events.push("index"),
    deleteLock: async () => {
      events.push("lock");
      return true;
    },
  });
  assert.equal(repaired, true);
  assert.deepEqual(events, ["credit", "index", "lock"]);

  events.length = 0;
  await assert.rejects(() => applyFinalizingRecoverySideEffects({
    recordCredit: async () => events.push("credit"),
    repairDashboard: async () => {
      events.push("index");
      throw new Error("transient Dynamo failure");
    },
    deleteLock: async () => events.push("lock"),
  }), /transient Dynamo failure/);
  assert.deepEqual(events, ["credit", "index"]);
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

test("approved final gold persists claimed_at outside the reviewed content hash", () => {
  const reviewed = {
    schema_version: "odyssey_long_task_v2_reviewed",
    task_id: "task-1",
    task: { agent_request: "Do the task" },
    review: { title_edited: false },
  };
  const contentHash = reviewContentHash(reviewed);
  const doc = buildApprovedFinalGoldDocument({
    reviewed,
    contentHash,
    reviewer: "Reviewer B",
    reviewerPid: "reviewer-b",
    claimedAt: "2026-08-25T00:50:00.000Z",
    completedAt: "2026-08-25T01:00:00.000Z",
  });
  assert.equal(doc.claimed_at, "2026-08-25T00:50:00.000Z");
  assert.equal(doc.reviewer_pid, "reviewer-b");
  assert.equal(doc.review_content_hash, contentHash);
  assert.equal(contentHash, reviewContentHash(reviewed));
});

test("rejection idempotency hash includes sanitized step feedback", () => {
  const base = { task_id: "task-1", reason: "The task needs a substantial correction before review." };
  const first = { ...base, review: { rubrics: [{ rubric_id: "rubric-1", final: "Fix step one" }] } };
  const exactRetry = structuredClone(first);
  const differentFeedback = { ...base, review: { rubrics: [{ rubric_id: "rubric-1", final: "Fix step two" }] } };
  assert.equal(reviewContentHash(first), reviewContentHash(exactRetry));
  assert.notEqual(reviewContentHash(first), reviewContentHash(differentFeedback));
});

test("summarizes admin submissions by participant and workflow status", () => {
  const users = summarizeAdminUsers([
    { participant_id: "alice", participant_name: "Alice", participant_email: "alice@example.com", status: "pending" },
    { participant_id: "alice", participant_name: "Alice", participant_email: "alice@example.com", status: "approved" },
    { participant_id: "bob", participant_name: "Bob", participant_email: "bob@example.com", status: "in_review" },
    { participant_id: "redacted", participant_name: "Anonymous / redacted", participant_email: "", status: "rejected" },
  ]);
  assert.deepEqual(users, [
    {
      participant_id: "alice", name: "Alice", email: "alice@example.com",
      submitted: 2, pending: 1, in_review: 0, approved: 1, rejected: 0,
      decided: 1, approval_rate: 1, qc_edited_approvals: 0, qc_edit_rate: 0,
      qc_edited_author_accepted: 0, qc_edited_author_amended: 0, qc_edited_awaiting_signoff: 0,
      author_accepted_approvals: 0, author_amended_approvals: 0, awaiting_signoff: 1,
      author_amend_rate: null, appealed: 0, double_rejected: 0, author_requeues: 0,
    },
    {
      participant_id: "redacted", name: "Anonymous / redacted", email: "",
      submitted: 1, pending: 0, in_review: 0, approved: 0, rejected: 1,
      decided: 1, approval_rate: 0, qc_edited_approvals: 0, qc_edit_rate: null,
      qc_edited_author_accepted: 0, qc_edited_author_amended: 0, qc_edited_awaiting_signoff: 0,
      author_accepted_approvals: 0, author_amended_approvals: 0, awaiting_signoff: 0,
      author_amend_rate: null, appealed: 0, double_rejected: 0, author_requeues: 0,
    },
    {
      participant_id: "bob", name: "Bob", email: "bob@example.com",
      submitted: 1, pending: 0, in_review: 1, approved: 0, rejected: 0,
      decided: 0, approval_rate: null, qc_edited_approvals: 0, qc_edit_rate: null,
      qc_edited_author_accepted: 0, qc_edited_author_amended: 0, qc_edited_awaiting_signoff: 0,
      author_accepted_approvals: 0, author_amended_approvals: 0, awaiting_signoff: 0,
      author_amend_rate: null, appealed: 0, double_rejected: 0, author_requeues: 0,
    },
  ]);
});

test("author dashboard rollup separates QC edits, sign-off edits, appeals, terminal rejections, and requeues", () => {
  const [alice] = summarizeAdminUsers([
    {
      participant_id: "alice", participant_name: "Alice", status: "approved",
      changed_in_qc: true, signoff_action: "accepted", author_requeue_count: 2,
    },
    {
      participant_id: "alice", participant_name: "Alice", status: "approved",
      changed_in_qc: false, signoff_action: "amended", appeal_number: 1,
    },
    {
      participant_id: "alice", participant_name: "Alice", status: "rejected",
      appeal_number: 1, author_requeue_count: 1,
    },
  ]);
  assert.deepEqual({
    submitted: alice.submitted,
    decided: alice.decided,
    approval_rate: alice.approval_rate,
    qc_edited_approvals: alice.qc_edited_approvals,
    qc_edit_rate: alice.qc_edit_rate,
    qc_edited_author_accepted: alice.qc_edited_author_accepted,
    qc_edited_author_amended: alice.qc_edited_author_amended,
    qc_edited_awaiting_signoff: alice.qc_edited_awaiting_signoff,
    author_accepted_approvals: alice.author_accepted_approvals,
    author_amended_approvals: alice.author_amended_approvals,
    awaiting_signoff: alice.awaiting_signoff,
    author_amend_rate: alice.author_amend_rate,
    appealed: alice.appealed,
    double_rejected: alice.double_rejected,
    author_requeues: alice.author_requeues,
  }, {
    submitted: 3,
    decided: 3,
    approval_rate: 0.667,
    qc_edited_approvals: 1,
    qc_edit_rate: 0.5,
    qc_edited_author_accepted: 1,
    qc_edited_author_amended: 0,
    qc_edited_awaiting_signoff: 0,
    author_accepted_approvals: 1,
    author_amended_approvals: 1,
    awaiting_signoff: 0,
    author_amend_rate: 0.5,
    appealed: 2,
    double_rejected: 1,
    author_requeues: 3,
  });
});

test("pages and filters the admin dashboard without dropping all-annotator totals", () => {
  const items = Array.from({ length: 75 }, (_, index) => ({
    task_id: `task-${index}`,
    participant_id: index % 2 ? "alice" : "bob",
    participant_name: index % 2 ? "Alice" : "Bob",
    participant_email: index % 2 ? "alice@example.com" : "bob@example.com",
    status: index % 3 ? "pending" : "approved",
    reviewer: index % 3 ? "" : "Reviewer One",
    original: {
      title: `Task ${index}`,
      request: index === 72 ? "Find Seoul fares" : "Do browser work",
      metadata: { region: index % 2 ? "IN" : "GLOBAL", subjects: ["Travel and Tourism > Air Travel"] },
    },
  }));
  const dashboard = { items, users: summarizeAdminUsers(items), total: items.length, truncated: false };

  const first = pageAdminDashboard(dashboard, {});
  assert.equal(first.items.length, 50);
  assert.equal(first.filtered_total, 75);
  assert.equal(first.next_offset, 50);
  assert.equal(first.items[0].detail_loaded, false);
  assert.equal(first.items[0].original.request, "");
  assert.equal(first.users.length, 2);
  assert.equal(first.users.reduce((sum, user) => sum + user.submitted, 0), 75);
  assert.equal(first.distribution_items.length, 75);
  assert.deepEqual(first.items[0].original.metadata, items[0].original.metadata);

  const filtered = pageAdminDashboard(dashboard, {
    query: "SEOUL",
    participant_id: "bob",
    status: "approved",
    limit: 10,
  });
  assert.deepEqual(filtered.items.map((item) => item.task_id), ["task-72"]);
  assert.equal(filtered.filtered_total, 1);
  assert.equal(filtered.total, 75);
  assert.equal(filtered.next_offset, null);
  assert.equal(filtered.distribution_items.length, 75);

  const last = pageAdminDashboard(dashboard, { offset: 50, limit: 500 });
  assert.equal(last.items.length, 25);
  assert.equal(last.limit, 50);
  assert.equal(last.next_offset, null);
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

function osworldItem(overrides = {}) {
  const manifest = {
    task_id: "task-a",
    run_id: "run-a",
    creator_pid: "alice",
    task_prompt: "Find the cheapest flight and keep the tab open.",
    rubrics: [
      { rubric_id: "r1", requirement: "Open the flight page", verification: "URL shows the flight", llm_status: "SUCCESS" },
      { rubric_id: "r2", requirement: "Keep the tab open", verification: "Tab remains", llm_status: "SUCCESS" },
    ],
    steps: [{ index: 0, action: "click", response: "ok", final: true, screenshot_path: "screens/00001.png" }],
  };
  return {
    manifest_key: "v2-review/trajectory-runs/x/run-a/manifest.json",
    task_id: "task-a",
    run_id: "run-a",
    status: "reviewed",
    reviewer: "Reviewer",
    reviewed_at: "2026-08-11T00:00:00Z",
    llm_average_rubric_score: 1,
    llm_perfect: true,
    agent: "Skyvern",
    model: "Claude Opus 5",
    run_label: "pilot",
    human_outcome: "SUCCESS",
    human_final_grade: "YES",
    manifest,
    human_judgment: {
      trajectory: { overall_outcome: "YES", notes: "" },
      rubrics: [{ rubric_id: "r1", human_verdict: "SUCCESS" }, { rubric_id: "r2", human_verdict: "SUCCESS" }],
    },
    ...overrides,
  };
}

test("osworld task ids match the Python exporter's uuid5 namespace", () => {
  // python3 -c "import uuid; print(uuid.uuid5(uuid.UUID('7aa8f833-8ea6-4a38-a64f-2d56a9db9de5'),'task-a'))"
  assert.equal(osworldTaskIdFor("task-a"), "28272d35-4acf-5465-94b6-d9b4acf3a715");
});

test("acceptedHumanPass requires reviewed + YES + every rubric SUCCESS", () => {
  assert.equal(acceptedHumanPass(osworldItem()), true);
  assert.equal(acceptedHumanPass(osworldItem({ status: "pending", human_final_grade: null })), false);
  assert.equal(acceptedHumanPass(osworldItem({ human_final_grade: "EDIT_NEEDED" })), false);
  const partial = osworldItem();
  partial.human_judgment.rubrics[1].human_verdict = "FAILURE";
  assert.equal(acceptedHumanPass(partial), false);
  const missing = osworldItem();
  missing.human_judgment.rubrics.pop();
  assert.equal(acceptedHumanPass(missing), false);
});

test("osworldTaskForItem emits a stock OSWorld config with the Apollo block", () => {
  const task = osworldTaskForItem(osworldItem());
  assert.equal(task.id, "28272d35-4acf-5465-94b6-d9b4acf3a715");
  assert.equal(task.snapshot, "chrome");
  assert.equal(task.instruction, "Find the cheapest flight and keep the tab open.");
  assert.equal(task.source, "Apollo");
  assert.deepEqual(task.related_apps, ["chrome"]);
  assert.equal(task.evaluator.func, "is_expected_url_pattern_match");
  assert.equal(task.apollo.schema_version, "apollo-osworld-export-v1");
  assert.equal(task.apollo.task_id, "task-a");
  assert.equal(task.apollo.creator_pid, "alice");
  assert.equal(task.apollo.human_pass, true);
  assert.equal(task.apollo.accepted_run_id, "run-a");
  assert.equal(task.apollo.rubrics.length, 2);
  assert.equal("llm_status" in task.apollo.rubrics[0], false, "LLM verdicts are not copied into runner configs");
  assert.equal("steps" in task, false);
  const pending = osworldTaskForItem(osworldItem({ status: "pending", human_final_grade: null, reviewed_at: "" }));
  assert.equal(pending.apollo.human_pass, false);
  assert.equal(pending.apollo.accepted_run_id, null);
  assert.equal(pending.apollo.run_id, "run-a");
  assert.equal(pending.apollo.status, "pending");
  assert.equal(osworldTaskForItem({ ...osworldItem(), manifest: null }), null);
});

test("include=osworld adds the task config per row without exposing raw content", () => {
  const report = buildTrajectoryReportingReport([osworldItem()], "2026-08-11T00:01:00Z", { includeOsworld: true });
  assert.equal(report.trajectories[0].osworld_task.apollo.task_id, "task-a");
  assert.equal("manifest" in report.trajectories[0], false);
  assert.equal(report.schema_version, "apollo-trajectory-reporting-v1");
});

test("format=osworld returns the exporter bundle: passes by default, grade=any for the whole set", () => {
  const items = [
    osworldItem(),
    osworldItem({ task_id: "task-b", run_id: "run-b", status: "pending", human_final_grade: null, reviewed_at: "",
      manifest: { ...osworldItem().manifest, task_id: "task-b", run_id: "run-b" }, human_judgment: null }),
    osworldItem({ run_id: "run-a-old", reviewed_at: "2026-08-10T00:00:00Z", manifest: { ...osworldItem().manifest, run_id: "run-a-old" } }),
  ];
  const passes = buildOsworldExportReport(items, "2026-08-11T00:01:00Z");
  assert.equal(passes.schema_version, "apollo-osworld-export-v1");
  assert.equal(passes.exported, 1);
  assert.deepEqual(passes.task_ids, ["task-a"]);
  assert.equal(passes.tasks[0].apollo.accepted_run_id, "run-a", "newest accepted run wins");
  assert.deepEqual(passes.test_apollo, { chrome: passes.osworld_ids });
  assert.equal(passes.native_result_txt_is_authoritative, false);
  const all = buildOsworldExportReport(items, "2026-08-11T00:01:00Z", { grade: "any" });
  assert.equal(all.exported, 2);
  assert.deepEqual(all.task_ids, ["task-a", "task-b"]);
  assert.equal(all.tasks[1].apollo.human_pass, false);
  const paged = buildOsworldExportReport(items, "2026-08-11T00:01:00Z", { grade: "any", limit: 1 });
  assert.equal(paged.tasks.length, 1);
  assert.equal(paged.page.next_offset, 1);
  assert.equal(paged.test_apollo.chrome.length, 2, "meta lists every id even when the page is partial");
  assert.equal(selectLatestRunPerTask(items).length, 2);
});

test("reviewer quality rollup flags rubber-stamp and speed-run reviewers", () => {
  const at = (minutes) => new Date(Date.UTC(2026, 7, 19, 10, minutes)).toISOString();
  const items = [];
  // Stamper: 12 approvals, none edited, ~1 minute apart, no rejections.
  for (let index = 0; index < 12; index += 1) {
    items.push({ task_id: `s${index}`, status: "approved", reviewer: "Stamper", reviewed_at: at(index), changed: false });
  }
  // Careful: 12 decisions, 3 rejections, most approvals edited, ~12 min apart.
  for (let index = 0; index < 12; index += 1) {
    items.push({ task_id: `c${index}`, status: index % 4 === 0 ? "rejected" : "approved", reviewer: "Careful", reviewed_at: at(index * 12), changed: index % 4 !== 1 });
  }
  // Newcomer: too few reviews to flag.
  items.push({ task_id: "n1", status: "approved", reviewer: "Newcomer", reviewed_at: at(0), changed: false });
  items.push({ task_id: "p1", status: "pending", reviewer: "", reviewed_at: "", changed: false });
  const rows = summarizeAdminReviewers(items);
  assert.deepEqual(rows.map((row) => row.reviewer), ["Stamper", "Careful", "Newcomer"]);
  const stamper = rows[0];
  assert.equal(stamper.approved, 12);
  assert.equal(stamper.rejected, 0);
  assert.equal(stamper.unedited_approvals, 12);
  assert.equal(stamper.edit_rate, 0);
  assert.equal(stamper.median_gap_minutes, 1);
  assert.deepEqual(stamper.flags, ["no_rejections", "rarely_edits", "fast"]);
  assert.equal(stamper.suspicious, true);
  const careful = rows[1];
  assert.equal(careful.rejected, 3);
  assert.equal(careful.edit_rate, Number((6 / 9).toFixed(3)));
  assert.deepEqual(careful.flags, []);
  assert.equal(careful.suspicious, false);
  assert.deepEqual(rows[2].flags, []);
  // The list response carries the rollup.
  const paged = pageAdminDashboard({ items, users: summarizeAdminUsers(items), total: items.length, truncated: false }, {});
  assert.equal(paged.reviewers[0].reviewer, "Stamper");
});

test("re-queued tasks are never handed back to the reviewer whose decision was revoked", () => {
  const unit = "prolific/journeys/alice/v2/alice/internal/task-12345678";
  const other = "prolific/journeys/bob/v2/bob/internal/task-87654321/1_long_task.json";
  const b64 = (value) => Buffer.from(value, "utf8").toString("base64url");
  const exclusions = reopenExclusionsFromKeys([
    `v2-review/reopen/${b64(unit)}/${b64("stamper")}`,
    "v2-review/reopen/not-a-marker",
  ], "v2-review/reopen/");
  assert.deepEqual([...exclusions.get(unit)], ["stamper"]);
  assert.deepEqual(excludeReopenedForReviewer([v2, other], " Stamper ", exclusions), [other]);
  assert.deepEqual(excludeReopenedForReviewer([v2, other], "Careful", exclusions), [v2, other]);
  assert.deepEqual(excludeReopenedForReviewer([v2, other], "Stamper", new Map()), [v2, other]);
});

test("prior trajectory grades pair each old rubric's wording with its human verdict", () => {
  const judgment = {
    rubrics: [
      { rubric_id: "R1", human_verdict: "FAILURE", notes: "Step 9 never opened source A." },
      { rubric_id: "R2", human_verdict: "SUCCESS", notes: "" },
    ],
    trajectory: { overall_outcome: "EDIT_NEEDED", notes: "Rubric R1 should name the exact page." },
    reviewed_by: "Alice",
    reviewed_at: "2026-08-12T00:00:00Z",
  };
  const prior = priorTrajectoryGradeForHuman(trajectoryManifest, judgment);
  assert.equal(prior.run_id, trajectoryManifest.run_id);
  assert.equal(prior.overall_outcome, "EDIT_NEEDED");
  assert.equal(prior.graded_by, "Alice");
  assert.deepEqual(prior.rubrics.map((rubric) => [rubric.rubric_id, rubric.requirement, rubric.human_verdict]), [
    ["R1", "Find source A", "FAILURE"],
    ["R2", "Create output B", "SUCCESS"],
  ]);
  assert.equal(prior.rubrics[0].notes, "Step 9 never opened source A.");
  assert.equal(JSON.stringify(prior).includes("llm_"), false);
  assert.equal(priorTrajectoryGradeForHuman(trajectoryManifest, null), null);
});

test("reporting rows carry the per-trainer analysis fields and honest truncation", () => {
  const unit = "prolific/journeys/alice/v2/alice/internal/task-12345678";
  const sourceKey = `${unit}/1754985600000-ab12cd34_long_task.json`;
  const b64 = (value) => Buffer.from(value, "utf8").toString("base64url");
  const skipCounts = reviewSkipCountsFromKeys([
    `v2-review/skips/${b64(unit)}/1754990000000-${b64("carol")}`,
    `v2-review/skips/${b64(unit)}/1754991000000-${b64("dave")}`,
    `v2-review/skips/${b64(unit)}/1754992000000-${b64("carol")}`,
  ], "v2-review/skips/");
  const items = [
    {
      task_id: "task-1", participant_id: "onkar-y-turing-com", participant_name: "onkar", participant_email: "o@t.com", mode: "guided",
      submitted_at: "2026-08-12T09:00:00Z", authoring_started_at: "2026-08-12T08:41:00Z", status: "approved", reviewer: "Riya", claimed_at: "2026-08-13T10:00:00Z", reviewed_at: "2026-08-13T10:12:30Z",
      changed: true, rejection_reason: "", trajectory_count: 0, visit_count: 0, source_key: sourceKey, review_unit: unit,
      human_review: { title_edited: false, request_edited: true },
      original: { title: "T", request: "private", metadata: { region: "Japan", subjects: ["Travel"] } },
      final: { title: "T", request: "private edited", metadata: { region: "Japan", subjects: ["Travel", "Food"] } },
      rubrics: [
        { rubric_id: "rubric-1", changed: true, final: "a" },
        { rubric_id: "rubric-2", changed: false, final: "b" },
        { rubric_id: "rubric-3", changed: true, final: "c" },
      ],
    },
    { task_id: "task-2", participant_id: "onkar-y-turing-com", participant_name: "Onkar", participant_email: "o@t.com", mode: "guided", submitted_at: "2026-08-12T10:00:00Z", status: "pending", reviewer: "", reviewed_at: "", changed: false, rejection_reason: "", trajectory_count: 0, visit_count: 0, original: { request: "private" } },
    { task_id: "task-3", participant_id: "onkar-y-turing-com", participant_name: "Onkar", participant_email: "o@t.com", mode: "guided", submitted_at: "2026-08-12T11:00:00Z", status: "pending", reviewer: "", reviewed_at: "", changed: false, rejection_reason: "", trajectory_count: 0, visit_count: 0, original: { request: "private" } },
    { task_id: "task-4", participant_id: "shazyking20-googlemail-com", participant_name: "Shahzan Tahlilkar", participant_email: "s@g.com", mode: "guided", submitted_at: "2026-08-12T12:00:00Z", status: "pending", reviewer: "", reviewed_at: "", changed: false, rejection_reason: "", trajectory_count: 0, visit_count: 0, original: { request: "private" } },
  ];
  const report = buildReportingReport({ total: 4, truncated: false, users: [], items }, "2026-08-20T00:00:00Z", {
    limit: 3,
    skipCounts,
    participantAliases: { "shazyking20-googlemail-com": "shahzan-t-turing-com" },
  });
  const row = report.tasks[0];
  assert.equal(row.anchored_country, "Japan");
  assert.deepEqual(row.subjects, ["Travel", "Food"]);
  assert.equal(row.claimed_at, "2026-08-13T10:00:00Z");
  assert.equal(row.review_minutes, 12.5);
  assert.equal(row.rubric_count, 3);
  assert.equal(row.rubrics_edited, 2);
  assert.deepEqual(row.rubrics_edited_ids, ["rubric-1", "rubric-3"]);
  assert.equal(row.title_edited, false);
  assert.equal(row.request_edited, true);
  assert.equal(row.skip_count, 3);
  assert.deepEqual(row.skipped_by, ["carol", "dave"]);
  assert.equal(row.uploaded_at, new Date(1754985600000).toISOString());
  assert.equal(row.created_at, "2026-08-12T09:00:00Z");
  assert.equal(row.authoring_started_at, "2026-08-12T08:41:00Z");
  assert.equal(row.authoring_minutes, 19);
  assert.equal(report.tasks[1].authoring_minutes, null);
  // One display name per account (most frequent spelling, capitalized wins ties).
  assert.equal(row.participant_name, "Onkar");
  assert.equal(row.participant_name_raw, "onkar");
  assert.equal(row.canonical_participant_id, "onkar-y-turing-com");
  // A page that does not cover every row is truncated, full stop.
  assert.equal(report.truncated, true);
  assert.equal(report.page.next_offset, 3);
  const rest = buildReportingReport({ total: 4, truncated: false, users: [], items }, "2026-08-20T00:00:00Z", {
    limit: 10, offset: 3, participantAliases: { "shazyking20-googlemail-com": "shahzan-t-turing-com" },
  });
  assert.equal(rest.truncated, false);
  assert.equal(rest.tasks[0].canonical_participant_id, "shahzan-t-turing-com");
  assert.equal(rest.tasks[0].participant_id, "shazyking20-googlemail-com");
  assert.equal(JSON.stringify(report).includes("private"), false);
  // Metadata pages can hold the whole corpus now.
  const big = buildReportingReport({ total: 4, truncated: false, users: [], items }, "2026-08-20T00:00:00Z", { limit: 2000 });
  assert.equal(big.page.returned, 4);
  assert.equal(big.truncated, false);
});

test("reporting helpers: aliases chain safely, review minutes, upload time, names", () => {
  assert.equal(applyParticipantAliases("a", { a: "b", b: "c" }), "c");
  assert.ok(["a", "b"].includes(applyParticipantAliases("a", { a: "b", b: "a" }))); // cycles terminate
  assert.equal(applyParticipantAliases("z", {}), "z");
  assert.equal(reviewMinutes("2026-08-13T10:00:00Z", "2026-08-13T10:03:00Z"), 3);
  assert.equal(reviewMinutes("", "2026-08-13T10:03:00Z"), null);
  assert.equal(reviewMinutes("2026-08-13T10:05:00Z", "2026-08-13T10:03:00Z"), null);
  assert.equal(uploadedAtFromSourceKey("prolific/journeys/x/v2/x/internal/task-1/1754985600000-ab12_long_task.json"), "2025-08-12T08:00:00.000Z");
  assert.equal(uploadedAtFromSourceKey("weird/key.json"), "");
  const names = canonicalParticipantNames([
    { participant_id: "p", participant_name: "onkar" },
    { participant_id: "p", participant_name: "Onkar" },
    { participant_id: "p", participant_name: "onkar" },
    { participant_id: "q", participant_name: "Q" },
  ]);
  assert.equal(names.get("p"), "onkar");
  assert.equal(names.get("q"), "Q");
});

test("llm flag summary names which Codex checks fired", async () => {
  const review = {
    status: "NEEDS_HUMAN_REVIEW",
    manager_disposition: "INFEASIBLE",
    quality: { overall_verdict: "PASS", task_coherence: { verdict: "PASS" } },
    rubrics: [
      { rubric_id: "rubric-1", verdict: "POSSIBLE", quality_verdict: "PASS" },
      { rubric_id: "rubric-2", verdict: "SHORTFALL", quality_verdict: "PASS" },
      { rubric_id: "rubric-3", verdict: "POSSIBLE", quality_verdict: "FAIL" },
    ],
  };
  const summary = llmFlagSummary(review);
  assert.deepEqual(summary.llm_flags, ["website_feasibility", "step_alignment", "overall_feasibility"]);
  assert.equal(summary.llm_flag_count, 3);
  assert.deepEqual(summary.llm_rubrics_infeasible, ["rubric-2"]);
  assert.deepEqual(summary.llm_rubrics_misaligned, ["rubric-3"]);
  const clean = llmFlagSummary({ status: "LLM_PASS", manager_disposition: "FEASIBLE", quality: { task_coherence: { verdict: "PASS" } }, rubrics: [{ rubric_id: "rubric-1", verdict: "POSSIBLE", quality_verdict: "PASS" }] });
  assert.equal(clean.llm_flag_count, 0);
  assert.equal(llmFlagSummary(null), null);
  const dashboard = { items: [
    { task_id: "a", status: "pending", llm_review_key: "k1" },
    { task_id: "b", status: "pending", llm_review_key: null },
  ] };
  await hydrateReportingLlmFlags(dashboard, { includeLlmFlags: true, limit: 10 }, async () => review);
  assert.equal(dashboard.items[0].llm_flags.llm_flag_count, 3);
  assert.equal(dashboard.items[1].llm_flags, null);
  const report = buildReportingReport(dashboard, "2026-08-20T00:00:00Z", { includeLlmFlags: true, limit: 10 });
  assert.equal(report.tasks[0].llm_flag_count, 3);
  assert.deepEqual(report.tasks[0].llm_flags, ["website_feasibility", "step_alignment", "overall_feasibility"]);
  assert.equal(report.tasks[1].llm_flag_count, null);
  assert.equal("llm_flag_count" in buildReportingReport(dashboard, "2026-08-20T00:00:00Z", { limit: 10 }).tasks[0], false);
});

// ---- author sign-off, amendment, and appeals ----

const authorFinalGold = (overrides = {}) => ({
  schema_version: "odyssey_long_task_v2_reviewed",
  task_id: "v2/alice/internal/task-1",
  task: { task_title: "Reviewer version", agent_request: "Reviewer wrote this.", steps: [] },
  review: {
    original: { task_title: "Author version" },
    rubrics: [{ final: "a", changed: true }],
    request_edited: true,
  },
  review_content_hash: "hash-reviewer",
  reviewed_by: "Dana",
  finished_at: "2026-08-20T10:00:00Z",
  ...overrides,
});

test("author-approved finals are self-contained, stable, and content-addressed", () => {
  const document = buildAuthorApprovedFinal({
    finished: authorFinalGold(),
    finalGoldKey: "v2-review/finished/v2_alice_internal_task-1.json",
    subKey: "prolific/journeys/alice/v2/alice/internal/task-1/1_long_task.json",
    taskId: "v2_alice_internal_task-1",
    participantId: "alice",
    action: "accepted",
    approvedAt: "2026-08-25T08:00:00Z",
  });
  assert.equal(authorApprovedKeyFor("v2/alice/internal/task-1"), "v2-review/author-approved/v2_alice_internal_task-1.json");
  assert.equal(document.task.agent_request, "Reviewer wrote this.");
  assert.deepEqual(document.author_approval, {
    schema_version: "apollo-author-approval-v1",
    participant_id: "alice",
    action: "accepted",
    approved_at: "2026-08-25T08:00:00Z",
    acknowledged_content_hash: "hash-reviewer",
    source_key: "prolific/journeys/alice/v2/alice/internal/task-1/1_long_task.json",
    final_gold_key: "v2-review/finished/v2_alice_internal_task-1.json",
    task_id: "v2_alice_internal_task-1",
  });
  assert.equal(authorApprovedFinalMatches(document, structuredClone(document)), true);
  assert.equal(authorApprovedFinalMatches(
    document,
    { ...structuredClone(document), review_content_hash: "different" },
  ), false);
  assert.equal(authorApprovedFinalMatches(
    document,
    { ...structuredClone(document), author_approval: { ...document.author_approval, action: "amended" } },
  ), false);
});

test("an appeal requires a meaningful bounded author rationale", () => {
  assert.equal(appealReasonIsValid("too short"), false);
  assert.equal(appealReasonIsValid("x".repeat(MIN_APPEAL_REASON_LENGTH)), true);
  assert.equal(cleanAppealReason(`  ${"x".repeat(2_100)}  `).length, 2_000);
  assert.equal(appealReasonIsValid(" ".repeat(100)), false);
});

test("an author amendment preserves the reviewer audit and bounds revision history", () => {
  let doc = buildAmendedFinalGold({
    existing: authorFinalGold(),
    amendedTask: { task_title: "Author correction", agent_request: "Author rewrote this.", steps: [] },
    contentHash: "hash-author",
    authorPid: "alice",
    amendedAt: "2026-08-24T12:00:00Z",
  });
  assert.equal(doc.revision_count, 2);
  assert.equal(doc.amended_by, "alice");
  assert.deepEqual(doc.review, authorFinalGold().review);
  assert.deepEqual(doc.history[0], {
    task: authorFinalGold().task,
    review_content_hash: "hash-reviewer",
    source: "reviewer",
    by: "Dana",
    at: "2026-08-20T10:00:00Z",
  });

  for (let index = 0; index < 13; index += 1) {
    doc = buildAmendedFinalGold({
      existing: doc,
      amendedTask: { task_title: `v${index}`, agent_request: "x", steps: [] },
      contentHash: `hash-${index}`,
      authorPid: "alice",
      amendedAt: `2026-08-24T12:${String(index).padStart(2, "0")}:00Z`,
    });
  }
  assert.equal(doc.revision_count, 15);
  assert.equal(doc.history.length, 10);
  assert.deepEqual([...new Set(doc.history.map((entry) => entry.source))], ["author"]);
});

test("legacy final gold resolves its revision from history", () => {
  assert.equal(finalGoldRevision(null), 0);
  assert.equal(finalGoldRevision({ task: {} }), 1);
  assert.equal(finalGoldRevision({ history: [{}, {}] }), 3);
  assert.equal(finalGoldRevision({ revision_count: 7, history: [{}] }), 7);
});

test("an amendment retry repairs an amended receipt instead of accepting reviewer gold", () => {
  assert.equal(unchangedAmendSignoffAction(authorFinalGold(), "alice"), "accepted");
  assert.equal(unchangedAmendSignoffAction(authorFinalGold({
    amended_by: "alice",
    revision_count: 2,
    review_content_hash: "hash-author",
  }), "alice"), "amended");
  assert.equal(unchangedAmendSignoffAction(authorFinalGold({
    amended_by: "alice",
    revision_count: 2,
  }), "bob"), "accepted");
});

test("authors may revise open or returned tasks and appeal a rejection once", () => {
  assert.equal(authorEditEligibility(null, false, 0).allowed, true);
  assert.equal(authorEditEligibility("returned", false, 0).allowed, true);
  assert.equal(authorEditEligibility(null, false, 1, true).allowed, false);
  assert.match(authorEditEligibility(null, false, 1, true).reason, /already queued/i);
  assert.equal(authorEditEligibility("returned", false, 1, true).allowed, true);
  assert.equal(authorEditEligibility("rejected", false, 1).appeal, true);
  assert.equal(authorEditEligibility("rejected", false, 2).allowed, false);
  assert.match(authorEditEligibility("approved", false, 0).reason, /sign-off queue/i);
  assert.match(authorEditEligibility(null, true, 0).reason, /claimed/i);
});

test("legacy rejections stay non-appealable until reviewer routing is verified", () => {
  assert.equal(rejectionCanAppeal(1, { rejected_by: "Dana" }), false);
  assert.equal(rejectionCanAppeal(1, { rejected_by: "Dana", rejected_by_pid: "reviewer-b" }), true);
  assert.equal(rejectionCanAppeal(2, { rejected_by: "Dana", rejected_by_pid: "reviewer-b" }), false);
  assert.equal(rejectionCanAppeal(1, { rejected_by_pid: "not a valid pid" }), false);
});

test("review decisions inherit the stable pid from the token-matching claim lock", () => {
  const lock = { token: "claim-token", reviewer_pid: "reviewer-b" };
  assert.equal(decisionReviewerPid("", lock, "claim-token"), "reviewer-b");
  assert.equal(decisionReviewerPid("somebody-else", lock, "claim-token"), "reviewer-b");
  assert.equal(decisionReviewerPid("reviewer-c", lock, "wrong-token"), "reviewer-c");
  assert.equal(decisionReviewerPid("bad pid", lock, "wrong-token"), "");
});

test("appeals are excluded from the rejecting reviewer without losing current queue filters", () => {
  const appeal = "prolific/journeys/carol/v2/carol/internal/task-9/2_long_task.json";
  const rejecters = new Map([[appeal, "alice"]]);
  assert.deepEqual(excludeIneligible([v2, pcBob, appeal], "alice", rejecters), [pcBob]);
  assert.deepEqual(excludeIneligible([v2, pcBob, appeal], "bob", rejecters), [v2, appeal]);
  assert.deepEqual(excludeIneligible([v2, appeal], "", rejecters), [v2]);
});

test("stage durations reject missing, negative, and over-24-hour spans", () => {
  assert.equal(stageMinutes("2026-08-24T12:00:00Z", "2026-08-24T12:06:30Z"), 6.5);
  assert.equal(stageMinutes(null, "2026-08-24T12:00:00Z"), null);
  assert.equal(stageMinutes("2026-08-24T12:00:00Z", "not-a-date"), null);
  assert.equal(stageMinutes("2026-08-22T12:00:00Z", "2026-08-24T12:00:00Z"), null);
  assert.equal(stageMinutes("2026-08-24T12:10:00Z", "2026-08-24T12:00:00Z"), null);
  assert.equal(reviewMinutes("2026-08-22T12:00:00Z", "2026-08-24T12:00:00Z"), null);
});

test("repeated rejection records count one task and approved keys expose their author", () => {
  const ids = distinctRejectedTaskIds([
    "v2-review/rejected/v2_alice_internal_task-1_aaaaaaaaaaaaaaaa.json",
    "v2-review/rejected/v2_alice_internal_task-1_bbbbbbbbbbbbbbbb.json",
    "v2-review/rejected/v2_bob_internal_task-2_cccccccccccccccc.json",
  ]);
  assert.deepEqual([...ids].sort(), ["v2_alice_internal_task-1", "v2_bob_internal_task-2"]);
  assert.equal(participantIdFromFinishedKey("v2-review/finished/v2_alice_internal_task-abc-123.json"), "alice");
  assert.equal(participantIdFromFinishedKey("v2-review/finished/pc_bundle_thing.json"), null);
});

test("author history is chronological and anonymous for every reviewer decision", () => {
  const history = buildAuthorHistory({
    revisions: [
      { first: true, created_at: "2026-08-20T09:00:00Z" },
      {
        created_at: "2026-08-22T09:10:00Z",
        appeal_of_sub_key: "older",
        appeal_submission: true,
        appeal_started_at: "2026-08-22T09:00:00Z",
      },
      { created_at: "2026-08-22T09:30:00Z", appeal_of_sub_key: "older" },
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
  assert.deepEqual(history.map((entry) => entry.event), [
    "submitted", "rejected", "appealed", "revised", "approved", "amended",
  ]);
  assert.equal(history[1].by, "");
  assert.equal(history[2].minutes, 10);
  assert.equal(history[4].by, "");
  assert.equal(history[5].by, "");
  assert.equal(buildAuthorHistory({
    doneRecords: [{ outcome: "returned", reviewer: "Dana", completed_at: "2026-08-21T09:00:00Z" }],
  })[0].by, "");
});

test("author-facing approval detail omits stored reviewer identity", () => {
  const task = {
    task_title: "Compare rail routes",
    agent_request: "Compare three current rail routes.",
    difficulty: "high",
    success_criteria: ["Compare all three routes."],
    steps: [{ order: 1, title: "Compare", description: "Compare all three routes." }],
  };
  const detail = buildHumanReviewForAuthor({
    task,
    reviewed_by: "Dana",
    review: { title_edited: false, request_edited: false, evergreen_verified: true, rubrics: [] },
  }, { task });
  assert.ok(detail);
  assert.equal(Object.prototype.hasOwnProperty.call(detail, "reviewed_by"), false);
});

test("author amendment preserves uneditable gold fields and compatible hash ordering", () => {
  const approvedTask = {
    task_title: "Compare rail routes",
    agent_request: "Compare routes across three carriers.",
    difficulty: "high",
    site_scope: ["seat61.com", "trainline.com"],
    success_criteria: ["A criterion"],
    must_visit_or_reach: [],
    required_outputs: [],
    notes: null,
    metadata: { region: "GB", subjects: ["Travel and Tourism > Rail"] },
    steps: [{ order: 1, title: "One", description: "first" }],
  };
  const fromForm = {
    task_title: approvedTask.task_title,
    agent_request: approvedTask.agent_request,
    difficulty: "high",
    success_criteria: approvedTask.success_criteria,
    must_visit_or_reach: [],
    required_outputs: [],
    notes: null,
    steps: approvedTask.steps,
  };
  const amended = finalGoldTaskFromAuthorEdit(approvedTask, fromForm);
  assert.deepEqual(amended.site_scope, approvedTask.site_scope);
  assert.deepEqual(amended.metadata, approvedTask.metadata);
  assert.deepEqual(Object.keys(amended), Object.keys(approvedTask));
  assert.equal(reviewContentHash(amended), reviewContentHash(approvedTask));
  assert.notEqual(
    reviewContentHash(finalGoldTaskFromAuthorEdit(approvedTask, { ...fromForm, agent_request: "Rewritten." })),
    reviewContentHash(approvedTask)
  );
});

test("author revision sanitization preserves immutable source-derived task fields", () => {
  const original = {
    site_scope: ["seat61.com", "trainline.com"],
    task_summary: "Compare overnight rail routes.",
    time_span: { start: "2026-08-01", end: "2026-08-31" },
  };
  const edited = {
    task_title: "Edited title",
    agent_request: "Edited request",
    difficulty: "high",
    site_scope: ["malicious.example"],
    task_summary: "Client replacement",
    time_span: { start: null, end: null },
    success_criteria: [],
    steps: [{ order: 1, title: "One", description: "Edited step" }],
  };
  const safe = sanitizeAuthoredTask(edited, original);
  assert.deepEqual(safe.site_scope, original.site_scope);
  assert.equal(safe.task_summary, original.task_summary);
  assert.deepEqual(safe.time_span, original.time_span);
  assert.equal(safe.agent_request, edited.agent_request);
});

test("finished examples rank the complete set by approval time, not an amended window", () => {
  const items = Array.from({ length: 75 }, (_, index) => ({
    task_id: `task-${index}`,
    // Model an old approval whose S3 LastModified could now be newest after an amendment.
    finished_at: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
  }));
  items[0].last_modified = "2026-08-25T23:59:00Z";
  const selected = sortFinishedExamples(items, 30);
  assert.equal(selected.length, 30);
  assert.equal(selected[0].task_id, "task-74");
  assert.equal(selected.at(-1).task_id, "task-45");
  assert.equal(selected.some((item) => item.task_id === "task-0"), false);
});

test("reviewer-only edit attribution survives an author amendment in reporting and admin metrics", () => {
  const finished = authorFinalGold({
    review: { title_edited: false, request_edited: false, rubrics: [{ changed: false }] },
    amended_by: "alice",
  });
  assert.equal(reviewerChangedTask(finished), false);
  const report = buildReportingReport({
    total: 1,
    truncated: false,
    users: [],
    items: [{
      task_id: "task-1",
      participant_id: "alice",
      participant_name: "Alice",
      participant_email: "alice@example.com",
      mode: "guided",
      submitted_at: "2026-08-20T09:00:00Z",
      status: "approved",
      reviewer: "Dana",
      reviewed_at: "2026-08-20T10:00:00Z",
      changed: true,
      changed_in_qc: false,
      amended_by: "alice",
      amended_at: "2026-08-24T12:00:00Z",
      rejection_reason: "",
      trajectory_count: 0,
      visit_count: 0,
    }],
  });
  assert.equal(report.tasks[0].changed_in_qc, false);
  assert.equal(report.tasks[0].changed_after_approval, true);
  assert.equal(report.tasks[0].amended_by, "alice");
  const reviewer = summarizeAdminReviewers([{ ...report.tasks[0], changed: true }])[0];
  assert.equal(reviewer.edited_approvals, 0);
  assert.equal(reviewer.unedited_approvals, 1);
});

test("dashboard index carries distinct QC and author-amendment state without content", () => {
  const record = buildDashboardIndexRecord({
    task_id: "v2/alice/internal/task-12345678",
    source_key: v2,
    participant_id: "alice",
    status: "approved",
    changed: true,
    changed_in_qc: false,
    amended_by: "alice",
    amended_at: "2026-08-24T12:00:00Z",
    final_gold_revision: 2,
    signoff_at: "2026-08-24T12:01:00Z",
    signoff_action: "amended",
    appeal_number: 1,
    author_revision_number: 2,
    author_requeue_count: 1,
    author_requeued_at: "2026-08-24T11:00:00Z",
    original: { title: "Original", request: "private" },
    final: { title: "Amended", request: "private amended" },
  }, "v2");
  const item = dashboardSubmissionFromIndexRecord(record);
  assert.equal(item.changed, true);
  assert.equal(item.changed_in_qc, false);
  assert.equal(item.amended_by, "alice");
  assert.equal(item.final_gold_revision, 2);
  assert.equal(item.signoff_action, "amended");
  assert.equal(item.appeal_number, 1);
  assert.equal(item.author_revision_number, 2);
  assert.equal(item.author_requeue_count, 1);
  assert.equal(item.author_requeued_at, "2026-08-24T11:00:00Z");
  assert.equal(JSON.stringify(record).includes("private"), false);
});

test("author-loop reporting additions preserve the deployed reporting contract", () => {
  const report = buildReportingReport({
    total: 1,
    truncated: false,
    snapshot_built_at: "2026-08-24T23:27:14.188Z",
    users: [],
    items: [{
      task_id: "v2/alice/internal/task-12345678",
      source_key: "prolific/journeys/alice/task-12345678/1756020000000-abcd1234_long_task.json",
      participant_id: "alice",
      participant_name: "Alice",
      participant_email: "alice@example.com",
      mode: "guided",
      authoring_started_at: "2026-08-24T08:00:00Z",
      submitted_at: "2026-08-24T09:00:00Z",
      status: "approved",
      reviewer: "Dana",
      claimed_at: "2026-08-24T09:05:00Z",
      reviewed_at: "2026-08-24T09:15:00Z",
      changed: true,
      changed_in_qc: false,
      amended_by: "alice",
      amended_at: "2026-08-24T09:30:00Z",
      signoff_opened_at: "2026-08-24T09:20:00Z",
      signoff_at: "2026-08-24T09:30:00Z",
      signoff_action: "amended",
      final_gold_revision: 2,
      rejection_reason: "",
      trajectory_count: 0,
      visit_count: 0,
      original: { metadata: { region: "GB", subjects: ["Travel"] } },
      final: { metadata: { region: "GB", subjects: ["Travel"] } },
      rubrics: [],
    }],
  }, "2026-08-24T23:30:00Z");
  const baselineTopLevel = [
    "generated_at", "page", "schema_version", "snapshot_built_at", "source_total",
    "tasks", "totals", "truncated", "users",
  ];
  const baselineTaskRow = [
    "anchored_country", "authoring_minutes", "authoring_started_at", "canonical_participant_id",
    "changed_in_qc", "claimed_at", "created_at", "llm_pre_qc_status", "llm_review_stage",
    "llm_review_status", "mode", "participant_email", "participant_id", "participant_name",
    "participant_name_raw", "qc_completed", "rejection_reason", "request_edited", "review_minutes",
    "reviewed_at", "reviewer", "rubric_count", "rubrics_edited", "rubrics_edited_ids", "skip_count",
    "skipped_by", "status", "subjects", "submitted_at", "task_id", "title_edited",
    "trajectory_count", "uploaded_at", "visit_count",
  ];
  const authorLoopTaskRow = [
    "changed_after_approval", "amended_by", "amended_at", "signoff_at", "signoff_action",
    "signoff_minutes", "author_edit_minutes", "appeal_minutes", "appeal_number", "final_gold_revision",
  ];
  assert.deepEqual(baselineTopLevel.filter((field) => !(field in report)), []);
  assert.deepEqual([...baselineTaskRow, ...authorLoopTaskRow].filter((field) => !(field in report.tasks[0])), []);
  assert.equal(report.snapshot_built_at, "2026-08-24T23:27:14.188Z");
});
