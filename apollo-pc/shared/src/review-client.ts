import { presignEndpoint } from "./config";
import { STORAGE_KEYS } from "./platform";
import type { ReviewLongTask } from "./types";

function reviewBase(): string {
  return presignEndpoint().replace(/\/presign\/?$/, "");
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${reviewBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(json.error ?? `Review API error (${response.status})`));
  return json;
}

export interface ReviewCounts {
  submitted: number;
  finished: number;
  locked: number;
  pending: number;
  claimable: number;
  rejected?: number;
  approved?: number;
  own_pending?: number;
  own_awaiting_signoff?: number;
  awaiting_live_audit?: number;
  reviewers?: ReviewerTotals[];
}

export interface ReviewerTotals {
  reviewer: string;
  approved: number;
  rejected: number;
  last_at?: string;
}

export interface ReviewClaim {
  subKey: string;
  token: string;
  task: ReviewLongTask;
  lockTtlMs: number;
  claimedAtMs: number;
}

export interface RubricRow {
  text: string;
  original: string | null;
  checked: boolean;
  kind: "criterion" | "step";
  sourceIndex: number | null;
  title: string | null;
  seedVersion: 2 | 3;
}

export interface LlmRubricReviewForHuman {
  rubric_id: string;
  verdict: "POSSIBLE" | "SHORTFALL" | "IMPOSSIBLE" | "WORKER_ERROR";
  summary: string | null;
  feedback: string | null;
  quality_verdict: "PASS" | "FAIL" | "NEEDS_HUMAN_REVIEW" | null;
  quality_summary: string | null;
  quality_issues: string[];
  blockers: string[];
  evidence: { url: string; title: string; supports: string }[];
  repair: {
    repair_kind: string;
    quality_verdict?: string | null;
    reason: string | null;
    suggested_rubric_text: string | null;
    verified_possible: boolean;
  } | null;
}

export interface LlmReviewForHuman {
  schema_version: "apollo-llm-review-for-human-v1";
  advisory_only: true;
  task_id: string;
  task_content_hash: string | null;
  pipeline_version: string | null;
  reviewed_at_utc: string | null;
  status: "LLM_PASS" | "LLM_FAIL" | "NEEDS_HUMAN_REVIEW" | "PIPELINE_ERROR";
  manager_disposition: "FEASIBLE" | "NOT_FEASIBLE" | "NEEDS_HUMAN_REVIEW" | null;
  manager_summary: string | null;
  task_feedback: string | null;
  quality: {
    overall_verdict: "PASS" | "FAIL" | "NEEDS_HUMAN_REVIEW";
    confidence: number | null;
    summary: string | null;
    task_coherence: { verdict: "PASS" | "FAIL" | "NEEDS_HUMAN_REVIEW"; summary: string | null; concerns: string[] } | null;
    prompt_realism: { verdict: "PASS" | "FAIL" | "NEEDS_HUMAN_REVIEW"; summary: string | null; concerns: string[] } | null;
    prompt_quality: { verdict: "PASS" | "FAIL" | "NEEDS_HUMAN_REVIEW"; summary: string | null; concerns: string[] } | null;
    difficulty: { verdict: "PASS" | "FAIL" | "NEEDS_HUMAN_REVIEW"; rating: "TOO_EASY" | "APPROPRIATE" | "TOO_HARD" | "UNJUDGEABLE"; summary: string | null; concerns: string[] } | null;
  } | null;
  evergreen: { verdict: "NOT_ASSESSED" | "EVERGREEN" | "NOT_EVERGREEN" | "NEEDS_HUMAN_REVIEW"; summary: string; concerns: string[] } | null;
  projected_task_status: "POSSIBLE" | "UNRESOLVED" | null;
  task_repair: {
    suggested_task_prompt: string;
    summary: string | null;
    preserves_task_flow: boolean;
    all_suggested_changes_verified: boolean;
  } | null;
  rubrics: LlmRubricReviewForHuman[];
}

export interface TrajectoryStep {
  index: number;
  step_number: number;
  action: string;
  response: string;
  final: boolean;
  screenshot_path: string | null;
  screenshot_url: string | null;
}

export interface TrajectoryRubric {
  rubric_id: string;
  requirement: string;
  verification: string;
  llm_status?: "SUCCESS" | "FAILURE" | "ERROR";
  llm_score?: 0 | 1 | null;
  llm_success?: boolean | null;
  llm_reasoning?: string;
}

export interface TrajectoryRun {
  schema_version: "apollo-trajectory-review-package-v1";
  run_id: string;
  task_id: string;
  task_prompt: string;
  created_at_utc: string | null;
  source: { agent: string | null; model: string | null; [key: string]: unknown };
  metrics: { num_steps: number; num_screenshots: number; average_rubric_score?: number; perfect?: boolean };
  rubrics: TrajectoryRubric[];
  steps: TrajectoryStep[];
}

export interface TaskLineageField {
  original: string;
  final: string;
  changed: boolean;
}

export interface TaskLineageRubric extends Omit<TaskLineageField, "original"> {
  rubric_id: string;
  title: string | null;
  original: string | null;
}

// How the trainer's authored task compares to the version the agent ran
// (reviewers may edit title/request/rubrics before a task is exported).
export interface TaskLineage {
  task_id: string;
  status: string;
  reviewer: string;
  reviewed_at: string;
  revision_of_task_id: string | null;
  changed: boolean;
  title: TaskLineageField;
  request: TaskLineageField;
  rubrics: TaskLineageRubric[];
}

// An earlier graded run of the same task (or of the task this one revises):
// the rubric wording the grader saw then, and what they decided.
export interface PriorTrajectoryGrade {
  run_id: string;
  task_id: string;
  created_at_utc: string | null;
  agent: string | null;
  model: string | null;
  task_prompt: string;
  graded_by: string;
  graded_at: string;
  overall_outcome: string;
  notes: string;
  rubrics: { rubric_id: string; requirement: string; verification: string; human_verdict: string; notes: string }[];
}

export interface TrajectoryClaim {
  manifestKey: string;
  token: string;
  run: TrajectoryRun;
  taskLineage?: TaskLineage | null;
  priorGrades?: PriorTrajectoryGrade[];
  lockTtlMs: number;
  claimedAtMs: number;
}

export type HumanRubricVerdict = "" | "SUCCESS" | "FAILURE" | "UNJUDGEABLE";
export type TrajectoryOverallOutcome = "" | "YES" | "NO" | "EDIT_NEEDED" | "NEEDS_RERUN";
export interface TrajectoryJudgmentDraft {
  rubrics: { rubric_id: string; human_verdict: HumanRubricVerdict; notes: string }[];
  trajectory: { overall_outcome: TrajectoryOverallOutcome; task_satisfied: HumanRubricVerdict; notes: string };
}
export interface TrajectoryCounts { submitted: number; finished: number; locked: number; pending: number; claimable: number; assigned_to_you?: number; assigned_to_others?: number; unassigned?: number }

export async function reviewStatus(reviewKey: string, reviewerPid?: string): Promise<ReviewCounts> {
  return (await post("/review/status", { reviewKey, ...(reviewerPid ? { reviewer_pid: reviewerPid } : {}) })) as unknown as ReviewCounts;
}

export const sessionSkips: { review: string[]; trajectory: string[] } = { review: [], trajectory: [] };
function rememberSkip(list: string[], key: string): void {
  if (!key) return;
  const existing = list.indexOf(key);
  if (existing !== -1) list.splice(existing, 1);
  list.push(key);
  if (list.length > 50) list.shift();
}
export function rememberReviewSkip(subKey: string): void {
  rememberSkip(sessionSkips.review, subKey);
}
export function rememberTrajectorySkip(manifestKey: string): void {
  rememberSkip(sessionSkips.trajectory, manifestKey);
}

export async function reviewClaim(reviewKey: string, reviewer: string, reviewerPid?: string): Promise<ReviewClaim | null> {
  const response = await post("/review/claim", { reviewKey, reviewer, skip_keys: [...sessionSkips.review], ...(reviewerPid ? { reviewer_pid: reviewerPid } : {}) });
  if (!response.sub_key) return null;
  const stub = { subKey: String(response.sub_key), token: String(response.token), lockTtlMs: Number(response.lock_ttl_ms) || 1_800_000, claimedAtMs: Date.now() };
  try {
    const taskResponse = await fetch(String(response.task_url));
    if (!taskResponse.ok) throw new Error(`Couldn't fetch the claimed task (${taskResponse.status})`);
    return { ...stub, task: await taskResponse.json() as ReviewLongTask };
  } catch (error) {
    await post("/review/release", { reviewKey, sub_key: stub.subKey, token: stub.token }).catch(() => {});
    throw error;
  }
}

export async function reviewLlmFeedback(reviewKey: string, claim: ReviewClaim): Promise<{ status: "not_reviewed" | "pre_qc_passed" | "pre_qc_attention" | "stale"; review: LlmReviewForHuman | null }> {
  return (await post("/review/llm-feedback", { reviewKey, sub_key: claim.subKey, token: claim.token })) as unknown as { status: "not_reviewed" | "pre_qc_passed" | "pre_qc_attention" | "stale"; review: LlmReviewForHuman | null };
}

export async function reviewRelease(reviewKey: string, claim: ReviewClaim): Promise<void> {
  await post("/review/release", { reviewKey, sub_key: claim.subKey, token: claim.token });
}

export async function reviewReject(
  reviewKey: string,
  reviewer: string,
  claim: ReviewClaim,
  reason: string,
  rubrics?: RubricRow[],
  reviewerPid?: string
): Promise<void> {
  await post("/review/reject", {
    reviewKey,
    reviewer,
    ...(reviewerPid ? { reviewer_pid: reviewerPid } : {}),
    sub_key: claim.subKey,
    token: claim.token,
    task_id: claim.task.task_id,
    reason,
    ...(rubrics?.length ? { review: rejectionReviewBlock(rubrics) } : {}),
  });
}

export function rejectionReviewBlock(rubrics: RubricRow[]): Record<string, unknown> {
  return {
    rubrics: rubrics
      .filter((row) => row.text.trim())
      .map((row) => ({
        kind: row.kind,
        source_index: row.sourceIndex,
        title: row.title,
        original: row.original,
        final: row.text.trim(),
        changed: row.original === null || row.text.trim() !== row.original.trim(),
        checked: row.checked,
      })),
  };
}

export function seedRubrics(task: ReviewLongTask): RubricRow[] {
  const steps = (task.task.steps ?? []).flatMap((step, sourceIndex) => step.description.trim() ? [{
    text: step.description,
    original: step.description,
    checked: false,
    kind: "step" as const,
    sourceIndex,
    title: step.title || `Step ${sourceIndex + 1}`,
    seedVersion: 3 as const,
  }] : []);
  if (steps.length) return steps;
  return (task.task.success_criteria ?? []).filter(Boolean).map((text, sourceIndex) => ({ text, original: text, checked: false, kind: "criterion", sourceIndex, title: null, seedVersion: 3 }));
}

// Refresh-resume snapshots from the first PC reviewer build did not always
// distinguish structured task steps from legacy success criteria. Upgrade
// once so a resumed review produces the same gold shape as Apollo v2.
export function upgradeRubrics(task: ReviewLongTask, rows: RubricRow[]): RubricRow[] {
  if (rows.some((row) => row.seedVersion === 3)) return rows;
  const steps = task.task.steps ?? [];
  if (steps.some((step) => step.description?.trim())) {
    const existingSteps = rows.filter((row) => row.kind === "step");
    return (existingSteps.length ? existingSteps : seedRubrics(task)).map((row) => ({ ...row, seedVersion: 3 as const }));
  }
  return rows.map((row, index) => ({
    ...row,
    kind: "criterion" as const,
    sourceIndex: index,
    title: null,
    seedVersion: 3 as const,
  }));
}

export function buildReviewedTask(task: ReviewLongTask, edited: { title: string; request: string; difficulty: string; rubrics: RubricRow[]; evergreenVerified?: boolean }): Record<string, unknown> {
  const stepRows = edited.rubrics.filter((row) => row.kind === "step");
  const criterionRows = edited.rubrics.filter((row) => row.kind === "criterion");
  const finalSteps = stepRows.map((row, index) => ({
    ...(row.sourceIndex === null ? {} : task.task.steps?.[row.sourceIndex]),
    order: index,
    title: row.title || `Step ${index + 1}`,
    description: row.text.trim(),
  }));
  const final = {
    ...task.task,
    task_title: edited.title.trim(),
    agent_request: edited.request.trim(),
    difficulty: edited.difficulty,
    success_criteria: (task.task.steps?.length ?? 0) ? task.task.success_criteria : criterionRows.map((row) => row.text.trim()).filter(Boolean),
    steps: finalSteps,
  };
  return {
    schema_version: "odyssey_long_task_v2_reviewed",
    task_id: task.task_id,
    mode: task.mode,
    task: final,
    review: {
      original: { task_title: task.task.task_title, agent_request: task.task.agent_request, difficulty: task.task.difficulty, success_criteria: task.task.success_criteria, steps: task.task.steps ?? [] },
      final: { task_title: final.task_title, agent_request: final.agent_request, difficulty: final.difficulty, success_criteria: final.success_criteria, steps: final.steps },
      rubrics: edited.rubrics.map((row) => ({ kind: row.kind, source_index: row.sourceIndex, title: row.title, original: row.original, final: row.text.trim(), changed: row.original === null || row.text.trim() !== row.original.trim(), checked: row.checked })),
      title_edited: edited.title.trim() !== task.task.task_title,
      request_edited: edited.request.trim() !== task.task.agent_request,
      evergreen_verified: Boolean(edited.evergreenVerified),
    },
  };
}

export async function reviewSubmit(reviewKey: string, reviewer: string, claim: ReviewClaim, edited: { title: string; request: string; difficulty: string; rubrics: RubricRow[]; evergreenVerified?: boolean }): Promise<void> {
  await post("/review/submit", { reviewKey, reviewer, sub_key: claim.subKey, token: claim.token, reviewed: buildReviewedTask(claim.task, edited) });
}

export function seedTrajectoryJudgment(run: TrajectoryRun): TrajectoryJudgmentDraft {
  return { rubrics: run.rubrics.map((rubric) => ({ rubric_id: rubric.rubric_id, human_verdict: "", notes: "" })), trajectory: { overall_outcome: "", task_satisfied: "", notes: "" } };
}

export function normalizeTrajectoryJudgment(draft: TrajectoryJudgmentDraft): TrajectoryJudgmentDraft {
  const legacyTrajectory = draft.trajectory as TrajectoryJudgmentDraft["trajectory"] & { final_outcome?: TrajectoryOverallOutcome };
  if (!draft.trajectory.overall_outcome) {
    draft.trajectory.overall_outcome = legacyTrajectory.final_outcome || (draft.trajectory.task_satisfied === "SUCCESS"
      ? "YES"
      : draft.trajectory.task_satisfied === "FAILURE"
        ? "NO"
        : draft.trajectory.task_satisfied === "UNJUDGEABLE"
          ? "NEEDS_RERUN"
          : "");
  }
  delete legacyTrajectory.final_outcome;
  if (draft.trajectory.overall_outcome) {
    draft.trajectory.task_satisfied = trajectoryOutcomeTaskSatisfied(draft.trajectory.overall_outcome);
  }
  return draft;
}

export function setTrajectoryOverallOutcome(draft: TrajectoryJudgmentDraft, outcome: Exclude<TrajectoryOverallOutcome, "">): void {
  draft.trajectory.overall_outcome = outcome;
  draft.trajectory.task_satisfied = trajectoryOutcomeTaskSatisfied(outcome);
}

function trajectoryOutcomeTaskSatisfied(outcome: Exclude<TrajectoryOverallOutcome, "">): Exclude<HumanRubricVerdict, ""> {
  if (outcome === "YES") return "SUCCESS";
  if (outcome === "NEEDS_RERUN") return "UNJUDGEABLE";
  return "FAILURE";
}
export async function trajectoryStatus(reviewKey: string, reviewerPid?: string): Promise<TrajectoryCounts> {
  return (await post("/trajectory/status", { reviewKey, ...(reviewerPid ? { reviewer_pid: reviewerPid } : {}) })) as unknown as TrajectoryCounts;
}
export async function trajectoryClaim(reviewKey: string, reviewer: string, reviewerPid?: string): Promise<TrajectoryClaim | null> {
  const response = await post("/trajectory/claim", { reviewKey, reviewer, skip_keys: [...sessionSkips.trajectory], ...(reviewerPid ? { reviewer_pid: reviewerPid } : {}) });
  if (!response.manifest_key) return null;
  return { manifestKey: String(response.manifest_key), token: String(response.token), run: response.run as unknown as TrajectoryRun, taskLineage: response.task_lineage as TaskLineage | null, priorGrades: (response.prior_grades as PriorTrajectoryGrade[]) ?? [], lockTtlMs: Number(response.lock_ttl_ms) || 1_800_000, claimedAtMs: Date.now() };
}
export async function trajectoryRelease(reviewKey: string, claim: TrajectoryClaim): Promise<void> {
  await post("/trajectory/release", { reviewKey, manifest_key: claim.manifestKey, token: claim.token });
}
export async function trajectorySubmit(reviewKey: string, reviewer: string, reviewerPid: string, claim: TrajectoryClaim, judgment: TrajectoryJudgmentDraft): Promise<void> {
  await post("/trajectory/submit", { reviewKey, reviewer, reviewer_pid: reviewerPid, manifest_key: claim.manifestKey, token: claim.token, judgment });
}

type Store = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
export interface ClaimSnapshot { claim: ReviewClaim; rubrics: RubricRow[] | null; edits: { title: string; request: string; difficulty: string; evergreenChecked?: boolean } | null }
export interface TrajectoryClaimSnapshot { claim: TrajectoryClaim; judgment: TrajectoryJudgmentDraft }

async function save(storage: Store, key: string, value: unknown): Promise<void> {
  try { await storage.set(key, JSON.stringify(value)); } catch { /* reviewer convenience only */ }
}
async function load<T>(storage: Store, key: string): Promise<T | null> {
  try { const raw = await storage.get(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}
export const saveClaimSnapshot = (storage: Store, value: ClaimSnapshot) => save(storage, STORAGE_KEYS.reviewClaim, value);
export const clearClaimSnapshot = (storage: Store) => storage.set(STORAGE_KEYS.reviewClaim, "").catch(() => {});
export async function loadClaimSnapshot(storage: Store): Promise<ClaimSnapshot | null> {
  const value = await load<ClaimSnapshot>(storage, STORAGE_KEYS.reviewClaim);
  return value && Date.now() - value.claim.claimedAtMs < value.claim.lockTtlMs ? value : null;
}
export const saveTrajectoryClaimSnapshot = (storage: Store, value: TrajectoryClaimSnapshot) => save(storage, STORAGE_KEYS.trajectoryClaim, value);
export const clearTrajectoryClaimSnapshot = (storage: Store) => storage.set(STORAGE_KEYS.trajectoryClaim, "").catch(() => {});
export async function loadTrajectoryClaimSnapshot(storage: Store): Promise<TrajectoryClaimSnapshot | null> {
  const value = await load<TrajectoryClaimSnapshot>(storage, STORAGE_KEYS.trajectoryClaim);
  return value && Date.now() - value.claim.claimedAtMs < value.claim.lockTtlMs ? value : null;
}

export type MyTaskStatus = "awaiting_codex" | "pending" | "in_review" | "approved" | "rejected" | "returned";

export interface MyTaskItem {
  task_id: string;
  sub_key: string;
  title: string;
  request: string;
  status: MyTaskStatus;
  submitted_at: string | null;
  rejection_reason?: string;
  returned_reason?: string;
  content_hash: string | null;
  // Whether human QC changed the task, without identifying the reviewer.
  reviewer_changed?: boolean;
  revision_count?: number;
  // Approved and not yet acknowledged — this is what the sign-off queue lists.
  needs_signoff?: boolean;
  signed_off_at?: string;
  signoff_action?: string;
  // Rejected tasks: how many times, and whether the one appeal is still open.
  rejection_count?: number;
  can_appeal?: boolean;
  appeal_unavailable_reason?: string;
}

export interface MyTaskPage {
  items: MyTaskItem[];
  offset: number;
  limit: number;
  source_total: number;
  // Counted across every one of the author's tasks, not just this page, so the
  // sign-off progress stays honest while they page through.
  approved_total: number;
  awaiting_signoff_total: number;
}

// One thing that happened to a task, oldest first. Author-facing history keeps
// `by` empty so no reviewer identity can cross this contract.
export interface MyTaskHistoryEntry {
  at: string;
  event: "submitted" | "revised" | "appealed" | "returned" | "rejected" | "approved" | "accepted" | "amended";
  by: string;
  minutes: number | null;
  note: string;
}

export interface MyTaskContentSnapshot {
  title: string;
  request: string;
  criteria: string[];
  steps: { order: number; title: string; description: string }[];
}

export interface MyTaskHumanReviewRubric {
  rubric_id: string;
  kind: string;
  title: string | null;
  original: string | null;
  final: string;
  changed: boolean;
  checked: boolean;
}

export interface MyTaskHumanReview {
  original: MyTaskContentSnapshot;
  final: MyTaskContentSnapshot;
  rubrics: MyTaskHumanReviewRubric[];
  title_edited: boolean;
  request_edited: boolean;
  evergreen_verified: boolean;
  // Whether the reviewer altered anything at all.
  changed?: boolean;
  revision_count?: number;
  amended_by?: string;
  amended_at?: string;
}

// The reviewer's step-level notes on a rejection. Same rubric shape as the
// approved diff, and carries no identity.
export interface MyTaskRejectionFeedback {
  rubrics: MyTaskHumanReviewRubric[];
}

// The full current task content. NOT in the written my-task-feedback contract:
// human_review is only present for approved tasks, but the author needs the
// full title/request/difficulty/steps to render the read-only view and pre-fill
// the self-edit form for awaiting_codex/pending/returned states. Flagged for
// reconciliation with the backend agent — this optional field is a forward-
// compatible extension so the screen degrades gracefully until it ships.
export interface MyTaskCurrentContent {
  title: string;
  request: string;
  difficulty: string;
  criteria: string[];
  steps: { order: number; title: string; description: string }[];
  must_visit_or_reach: string[];
  required_outputs: string[];
  notes: string | null;
  metadata?: { region?: string; subjects?: string[] };
}

export interface MyTaskFeedback {
  status: "not_reviewed" | "pre_qc_passed" | "pre_qc_attention" | "stale" | "approved" | "rejected" | "returned";
  stale: boolean;
  task_content_hash: string | null;
  review: LlmReviewForHuman | null;
  human_review?: MyTaskHumanReview;
  rejection_reason?: string;
  returned_reason?: string;
  task?: MyTaskCurrentContent;
  // The full final gold, for approved tasks. The amend form seeds from this:
  // an author correcting an approved task starts from the reviewer's version.
  // human_review.final is a display snapshot with no difficulty or metadata.
  final_task?: MyTaskCurrentContent | null;
  rejection_feedback?: MyTaskRejectionFeedback;
  needs_signoff?: boolean;
  signed_off_at?: string;
  signoff_action?: string;
  history?: MyTaskHistoryEntry[];
}

export interface AuthorEditPayload {
  task_title: string;
  agent_request: string;
  difficulty: string;
  success_criteria: string[];
  steps: { order: number; title: string; description: string }[];
  must_visit_or_reach: string[];
  required_outputs: string[];
  notes: string | null;
  metadata?: { region?: string; subjects?: string[] };
}

export interface AuthorEditResult {
  ok: true;
  new_sub_key: string;
  new_content_hash: string;
  status: "awaiting_codex";
  // True when the revision answers a rejection. The server routes an appeal
  // away from the reviewer who rejected it.
  appeal?: boolean;
}

export interface AuthorAmendResult {
  ok: true;
  revision_count: number;
  new_content_hash: string;
  amended_at?: string;
  author_approved_key?: string;
  idempotent?: boolean;
}

export async function myTasks(reviewKey: string, participantId: string): Promise<MyTaskItem[]> {
  return (await myTaskPage(reviewKey, participantId)).items;
}

// Paged: an active trainer's sign-off backlog runs to well over a hundred
// tasks, and every row costs the server at least one object read.
export async function myTaskPage(
  reviewKey: string,
  participantId: string,
  offset = 0,
  limit = 50
): Promise<MyTaskPage> {
  const res = await post("/review/my-tasks", {
    reviewKey,
    participant_id: participantId,
    offset,
    limit,
  });
  const items = (res.items as MyTaskItem[] | undefined) ?? [];
  return {
    items,
    offset: Number(res.offset) || 0,
    limit: Number(res.limit) || limit,
    source_total: Number(res.source_total ?? items.length),
    approved_total: Number(res.approved_total) || 0,
    awaiting_signoff_total: Number(res.awaiting_signoff_total) || 0,
  };
}

// "I have read what the reviewer did and I accept it." Writes an immutable
// receipt; final gold is untouched. `openedAt` is when the author opened the
// task — the server pairs it with its own completion stamp, and never trusts a
// duration sent by a client.
export async function authorSignoff(
  reviewKey: string,
  participantId: string,
  subKey: string,
  openedAt?: string | null
): Promise<{ ok: true; action: string; signed_off_at: string; author_approved_key?: string }> {
  return (await post("/review/author-signoff", {
    reviewKey,
    participant_id: participantId,
    sub_key: subKey,
    opened_at: openedAt ?? null,
  })) as unknown as { ok: true; action: string; signed_off_at: string; author_approved_key?: string };
}

// The author's correction of their own approved task becomes the new final
// gold, with no second reviewer pass. Distinct from authorEdit, which puts a
// revision back into the reviewer queue.
export async function authorAmend(
  reviewKey: string,
  participantId: string,
  subKey: string,
  edited: AuthorEditPayload,
  openedAt?: string | null
): Promise<AuthorAmendResult> {
  return (await post("/review/author-amend", {
    reviewKey,
    participant_id: participantId,
    sub_key: subKey,
    edited,
    opened_at: openedAt ?? null,
  })) as unknown as AuthorAmendResult;
}

export async function myTaskFeedback(
  reviewKey: string,
  participantId: string,
  subKey: string
): Promise<MyTaskFeedback> {
  return (await post("/review/my-task-feedback", {
    reviewKey,
    participant_id: participantId,
    sub_key: subKey,
  })) as unknown as MyTaskFeedback;
}

export async function authorEdit(
  reviewKey: string,
  participantId: string,
  subKey: string,
  edited: AuthorEditPayload,
  editStartedAt?: string | null,
  appealReason?: string | null
): Promise<AuthorEditResult> {
  const body: Record<string, unknown> = {
    reviewKey,
    participant_id: participantId,
    sub_key: subKey,
    edited,
    edit_started_at: editStartedAt ?? null,
  };
  if (appealReason != null) body.appeal_reason = appealReason;
  return (await post("/review/author-edit", body)) as unknown as AuthorEditResult;
}

// Mirrors reviewReject: the reviewer holds the claim lock and sends the task
// back to the author with a reason. The author can then self-edit and resubmit.
export async function reviewReturn(
  reviewKey: string,
  reviewer: string,
  claim: ReviewClaim,
  reason: string,
  reviewerPid?: string
): Promise<void> {
  await post("/review/return-to-author", {
    reviewKey,
    reviewer,
    reviewer_pid: reviewerPid,
    sub_key: claim.subKey,
    token: claim.token,
    task_id: claim.task.task_id,
    reason,
  });
}

export interface ContributionCounts {
  submitted: number;
  reviewed: number;
}

export type AdminSubmissionStatus = "pending" | "in_review" | "approved" | "rejected";

export interface AdminTaskSnapshot {
  title: string;
  request: string;
  difficulty: string;
  criteria: string[];
  steps: { order: number; title: string; description: string }[];
  metadata?: { region?: string; subjects?: string[] };
}

export interface AdminSubmission {
  task_id: string;
  participant_id: string;
  participant_name: string;
  participant_email: string;
  mode: string;
  submitted_at: string;
  status: AdminSubmissionStatus;
  reviewer: string;
  reviewed_at: string;
  // Recorded for decisions made after author sign-off shipped. Older rows do
  // not have them because their claim lock has already been deleted.
  claimed_at?: string;
  review_minutes?: number | null;
  rejection_reason: string;
  trajectory_count: number;
  visit_count: number;
  changed: boolean;
  changed_in_qc?: boolean;
  appeal_number?: number;
  author_revision_number?: number;
  author_requeue_count?: number;
  author_requeued_at?: string;
  signoff_action?: "accepted" | "amended" | "";
  // Admin list pages intentionally contain only compact title-level task
  // snapshots. The complete prompt/rubrics are fetched when a row opens.
  detail_loaded?: boolean;
  original: AdminTaskSnapshot;
  final: AdminTaskSnapshot | null;
  // Resolved once per task rather than duplicated inside both snapshots.
  task_metadata?: { region?: string; subjects?: string[] } | null;
}

export interface AdminUserSummary {
  participant_id: string;
  name: string;
  email: string;
  submitted: number;
  pending: number;
  in_review: number;
  approved: number;
  rejected: number;
  // Author-loop rollups are optional for compatibility while the backend and
  // browser bundle are deployed independently.
  decided?: number;
  approval_rate?: number | null;
  qc_edited_approvals?: number;
  qc_edit_rate?: number | null;
  qc_edited_author_accepted?: number;
  qc_edited_author_amended?: number;
  qc_edited_awaiting_signoff?: number;
  author_accepted_approvals?: number;
  author_amended_approvals?: number;
  awaiting_signoff?: number;
  author_amend_rate?: number | null;
  appealed?: number;
  double_rejected?: number;
  author_requeues?: number;
}

export type AdminReviewerFlag = "no_rejections" | "rarely_edits" | "fast";

export interface AdminReviewerSummary {
  reviewer: string;
  reviewed: number;
  approved: number;
  rejected: number;
  edited_approvals: number;
  unedited_approvals: number;
  first_reviewed_at: string;
  last_reviewed_at: string;
  reject_rate: number;
  edit_rate: number;
  median_gap_minutes: number | null;
  fast_share: number | null;
  flags: AdminReviewerFlag[];
  suspicious: boolean;
}

export interface AdminReopenResult {
  ok: boolean;
  task_id: string;
  previous_outcome: string;
  previous_reviewers: string[];
  archived: number;
  reopened_at: string;
}

export interface AdminBulkReopenResult {
  ok: boolean;
  reviewer: string;
  matched: number;
  reopened: number;
  failed: { task_id: string; error?: string }[];
  remaining: number;
}

export interface AdminDashboard {
  items: AdminSubmission[];
  users: AdminUserSummary[];
  // Reviewer-quality rollup (older backends omit it).
  reviewers?: AdminReviewerSummary[];
  total: number;
  truncated: boolean;
  filtered_total?: number;
  offset?: number;
  limit?: number;
  next_offset?: number | null;
  distribution_items?: { region?: string; subjects?: string[] }[];
}

export interface AdminDashboardFilters {
  query?: string;
  participantId?: string;
  status?: string;
  offset?: number;
  limit?: number;
}

export interface AdminShowcaseDistributionRow {
  category: string;
  count: number;
  share: number;
  showcase_examples: number;
}

export interface AdminShowcaseTask {
  task_id?: string;
  review_content_hash?: string;
  title: string;
  request: string;
  difficulty: string;
  steps: { order: number; title: string; description: string }[];
  rubrics: string[];
  primary_category: string;
  top_level_category: string;
  categories: string[];
  confidence: "high" | "medium" | "low" | "unlabelled";
  rationale: string;
  websites: string[];
  approved_at?: string;
}

export interface AdminShowcaseSummary {
  total_category_assignments: number;
  average_categories_per_task: number;
  primary_categories_used: number;
  top_level_categories_used: number;
  category_count_distribution: { category_count: number; count: number; share: number }[];
  confidence_distribution: { confidence: "high" | "medium" | "low" | "unlabelled"; count: number; share: number }[];
  tasks_with_websites: number;
  tasks_without_websites: number;
  website_coverage_share: number;
  website_mentions: number;
  unique_websites: number;
  top_websites: { label: string; count: number }[];
}

export interface AdminShowcase {
  schema_version: "apollo-admin-author-approved-showcase-v1" | "apollo-public-author-approved-showcase-v1";
  generated_at_utc: string;
  source_tasks: number;
  selected_tasks: number;
  requested_limit: number;
  selection_strategy: string;
  taxonomy: { name: string; source_url: string; sha256?: string };
  summary: AdminShowcaseSummary;
  primary_top_level_distribution: AdminShowcaseDistributionRow[];
  primary_category_distribution: { category: string; count: number }[];
  examples: AdminShowcaseTask[];
}

export async function reviewAdmin(
  reviewKey: string,
  adminEmail: string,
  filters: AdminDashboardFilters = {}
): Promise<AdminDashboard> {
  return (await post("/review/admin", {
    reviewKey,
    admin_email: adminEmail,
    query: filters.query ?? "",
    participant_id: filters.participantId ?? "",
    status: filters.status ?? "",
    offset: filters.offset ?? 0,
    limit: filters.limit ?? 50,
  })) as unknown as AdminDashboard;
}

export async function reviewAdminDetail(
  reviewKey: string,
  adminEmail: string,
  taskId: string
): Promise<AdminSubmission> {
  const response = await post("/review/admin", {
    reviewKey,
    admin_email: adminEmail,
    action: "detail",
    task_id: taskId,
  });
  return response.item as unknown as AdminSubmission;
}

export async function reviewAdminShowcase(
  reviewKey: string,
  adminEmail: string
): Promise<AdminShowcase> {
  return (await post("/review/admin", {
    reviewKey,
    admin_email: adminEmail,
    action: "showcase",
  })) as unknown as AdminShowcase;
}

export async function publicShowcase(): Promise<AdminShowcase> {
  const res = await fetch(`${reviewBase()}/showcase`, { method: "GET" });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error ?? `Showcase API error (${res.status})`));
  return json as unknown as AdminShowcase;
}

// Throw one decided task back into the review pool (admin only). The
// previous reviewer never gets it again.
export async function reviewAdminReopen(
  reviewKey: string,
  adminEmail: string,
  taskId: string,
  reason = ""
): Promise<AdminReopenResult> {
  return (await post("/review/admin", {
    reviewKey,
    admin_email: adminEmail,
    action: "reopen",
    task_id: taskId,
    reason,
  })) as unknown as AdminReopenResult;
}

// Bulk variant: re-queue one reviewer's decisions (default: approvals they
// did not edit). The server bounds each call; `remaining` says whether to
// call again.
export async function reviewAdminReopenByReviewer(
  reviewKey: string,
  adminEmail: string,
  reviewer: string,
  options: { onlyUnedited?: boolean; outcome?: "approved" | "rejected"; reason?: string; limit?: number } = {}
): Promise<AdminBulkReopenResult> {
  return (await post("/review/admin", {
    reviewKey,
    admin_email: adminEmail,
    action: "reopen_by_reviewer",
    reviewer,
    only_unedited: options.onlyUnedited ?? true,
    outcome: options.outcome ?? "approved",
    reason: options.reason ?? "",
    limit: options.limit ?? 20,
  })) as unknown as AdminBulkReopenResult;
}

export async function contributionStatus(
  reviewKey: string,
  participantId: string,
  reviewer: string
): Promise<ContributionCounts> {
  return (await post("/review/contributions", {
    reviewKey,
    participantId,
    reviewer,
  })) as unknown as ContributionCounts;
}

export interface FinishedItem {
  task_id: string;
  title: string;
  request: string;
  difficulty: "low" | "medium" | "high";
  criteria: string[];
  reviewed_by: string;
  finished_at: string;
}

export async function reviewFinishedList(reviewKey: string): Promise<FinishedItem[]> {
  const res = await post("/review/finished", { reviewKey });
  return (res.items as FinishedItem[]) ?? [];
}
