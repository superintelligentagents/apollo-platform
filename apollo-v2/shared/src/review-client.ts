import type { LongTask } from "./types";
import { presignEndpoint } from "./config";
import { STORAGE_KEYS } from "./platform";

// The review API lives on the same gateway as /presign.
function reviewBase(): string {
  return presignEndpoint().replace(/\/presign\/?$/, "");
}

export interface ReviewerTotals {
  reviewer: string;
  approved: number;
  rejected: number;
  last_at?: string;
}

export interface ReviewCounts {
  submitted: number;
  finished: number;
  locked: number;
  pending: number;
  claimable: number;
  awaiting_live_audit?: number;
  rejected?: number;
  approved?: number;
  // The caller's own still-pending submissions — excluded from pending and
  // claimable (you can't review your own task) but surfaced so the queue can
  // say why the numbers don't add up.
  own_pending?: number;
  // The caller's own approved tasks still waiting for them to sign off. Rides
  // on the queue response so the Review tab can point at My tasks without a
  // second request.
  own_awaiting_signoff?: number;
  reviewers?: ReviewerTotals[];
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

export interface ReviewClaim {
  subKey: string;
  token: string;
  task: LongTask;
  lockTtlMs: number;
  claimedAtMs: number;
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
  source: {
    evaluator_format: string | null;
    source_result_sha256: string | null;
    run_directory_name: string | null;
    trajectory_filename: string | null;
    agent: string | null;
    model: string | null;
    run_label: string | null;
  };
  metrics: { num_steps: number; num_screenshots: number; average_rubric_score?: number; perfect?: boolean; judge_errors?: number };
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
  lockTtlMs: number;
  claimedAtMs: number;
  // null = server could not find the task's lineage (older Lambda, lookup
  // failure); the grader then shows no edit history rather than blocking.
  taskLineage?: TaskLineage | null;
  // Newest first; empty when this is the first graded run of the task.
  priorGrades?: PriorTrajectoryGrade[];
}

export type HumanRubricVerdict = "" | "SUCCESS" | "FAILURE" | "UNJUDGEABLE";
export type OverallTrajectoryOutcome = "" | "YES" | "NO" | "EDIT_NEEDED" | "NEEDS_RERUN";

export interface TrajectoryJudgmentDraft {
  rubrics: { rubric_id: string; human_verdict: HumanRubricVerdict; notes: string }[];
  trajectory: {
    overall_outcome: OverallTrajectoryOutcome;
    notes: string;
    // Old local snapshots used these fields. They are read only during
    // migration and are not written by newly seeded drafts.
    task_satisfied?: HumanRubricVerdict;
    outcome?: string;
  };
}

export interface TrajectoryCounts {
  submitted: number;
  finished: number;
  locked: number;
  pending: number;
  claimable: number;
  assigned_to_you?: number;
  assigned_to_others?: number;
  unassigned?: number;
}

// A rubric row under review: the editable text plus whether the reviewer has
// verified it. Original text is kept so edits are visible downstream.
export interface RubricRow {
  text: string;
  original: string | null; // null = added by the reviewer
  checked: boolean;
  // Preserve where the editable line came from so guided steps do not get
  // flattened into (or dropped in favor of) success criteria at approval.
  kind: "criterion" | "step";
  sourceIndex: number | null;
  title: string | null;
  seedVersion: 2 | 3;
}

export interface RemovedRubric {
  row: RubricRow;
  // Position in the complete active + removed ordering at removal time.
  index: number;
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${reviewBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error ?? `Review API error (${res.status})`));
  return json;
}

// reviewerPid (the caller's slugified participant id) lets the server exclude
// the caller's own submissions from the counts. Optional for compatibility.
export async function reviewStatus(reviewKey: string, reviewerPid?: string): Promise<ReviewCounts> {
  const body: Record<string, unknown> = { reviewKey };
  if (reviewerPid) body.reviewer_pid = reviewerPid;
  return (await post("/review/status", body)) as unknown as ReviewCounts;
}

export async function reviewRegister(
  reviewKey: string,
  taskId: string,
  participantId: string
): Promise<void> {
  await post("/review/register", {
    reviewKey,
    task_id: taskId,
    participant_id: participantId,
  });
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

// Session-scoped skip memory. Skipping a task means "not now", not "never":
// the next claim sends these keys so the server serves everything else first
// and only falls back to a skipped task when it's all that's left (the queue
// never dead-ends). In-memory on purpose — a reload clears the list, so a
// skip can't shrink anyone's queue permanently. Exported for tests.
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

// reviewerPid keeps the server from ever handing a reviewer their own
// submission (the sub_key embeds the submitter's participant id).
export async function reviewClaim(reviewKey: string, reviewer: string, reviewerPid?: string): Promise<ReviewClaim | null> {
  const body: Record<string, unknown> = { reviewKey, reviewer };
  if (reviewerPid) body.reviewer_pid = reviewerPid;
  if (sessionSkips.review.length) body.skip_keys = [...sessionSkips.review];
  const res = await post("/review/claim", body);
  if (!res.sub_key) return null;
  const claimStub = {
    subKey: String(res.sub_key),
    token: String(res.token),
    lockTtlMs: Number(res.lock_ttl_ms) || 30 * 60 * 1000,
    claimedAtMs: Date.now(),
  };
  let task: LongTask;
  try {
    const taskRes = await fetch(String(res.task_url));
    if (!taskRes.ok) throw new Error(`Couldn't fetch the claimed task (${taskRes.status})`);
    task = (await taskRes.json()) as LongTask;
  } catch (err) {
    // Don't strand the lock for its whole TTL when we never got the task.
    await post("/review/release", { reviewKey, sub_key: claimStub.subKey, token: claimStub.token }).catch(() => {});
    throw err;
  }
  return { ...claimStub, task };
}

export async function reviewLlmFeedback(reviewKey: string, claim: ReviewClaim): Promise<{
  status: "not_reviewed" | "pre_qc_passed" | "pre_qc_attention" | "stale";
  stale: boolean;
  review: LlmReviewForHuman | null;
}> {
  return (await post("/review/llm-feedback", {
    reviewKey,
    sub_key: claim.subKey,
    token: claim.token,
  })) as unknown as { status: "not_reviewed" | "pre_qc_passed" | "pre_qc_attention" | "stale"; stale: boolean; review: LlmReviewForHuman | null };
}

export async function trajectoryStatus(reviewKey: string, reviewerPid?: string): Promise<TrajectoryCounts> {
  const body: Record<string, unknown> = { reviewKey };
  if (reviewerPid) body.reviewer_pid = reviewerPid;
  return (await post("/trajectory/status", body)) as unknown as TrajectoryCounts;
}

export async function trajectoryClaim(reviewKey: string, reviewer: string, reviewerPid?: string): Promise<TrajectoryClaim | null> {
  const body: Record<string, unknown> = { reviewKey, reviewer };
  if (reviewerPid) body.reviewer_pid = reviewerPid;
  if (sessionSkips.trajectory.length) body.skip_keys = [...sessionSkips.trajectory];
  const res = await post("/trajectory/claim", body);
  if (!res.manifest_key) return null;
  return {
    manifestKey: String(res.manifest_key),
    token: String(res.token),
    run: res.run as unknown as TrajectoryRun,
    lockTtlMs: Number(res.lock_ttl_ms) || 30 * 60 * 1000,
    claimedAtMs: Date.now(),
    taskLineage: (res.task_lineage as TaskLineage | null | undefined) ?? null,
    priorGrades: Array.isArray(res.prior_grades) ? (res.prior_grades as PriorTrajectoryGrade[]) : [],
  };
}

export async function trajectoryRelease(reviewKey: string, claim: TrajectoryClaim): Promise<void> {
  await post("/trajectory/release", { reviewKey, manifest_key: claim.manifestKey, token: claim.token });
}

export async function trajectorySubmit(
  reviewKey: string,
  reviewer: string,
  reviewerPid: string,
  claim: TrajectoryClaim,
  judgment: TrajectoryJudgmentDraft
): Promise<void> {
  await post("/trajectory/submit", {
    reviewKey,
    reviewer,
    reviewer_pid: reviewerPid,
    manifest_key: claim.manifestKey,
    token: claim.token,
    judgment,
  });
}

export function seedTrajectoryJudgment(run: TrajectoryRun): TrajectoryJudgmentDraft {
  return {
    rubrics: run.rubrics.map((rubric) => ({ rubric_id: rubric.rubric_id, human_verdict: "", notes: "" })),
    trajectory: { overall_outcome: "", notes: "" },
  };
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
    reviewer_pid: reviewerPid,
    sub_key: claim.subKey,
    token: claim.token,
    task_id: claim.task.task_id,
    reason,
    ...(rubrics?.length ? { review: rejectionReviewBlock(rubrics) } : {}),
  });
}

// Match the per-rubric audit shape written on approval. The backend sanitizes
// it before exposing it to the author and deliberately omits reviewer identity.
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

// ---- refresh-resume for an in-flight claim (stored per device) ----

export interface ClaimSnapshot {
  claim: ReviewClaim;
  rubrics: RubricRow[] | null;
  // Optional so snapshots written by earlier builds continue to resume.
  removedRubrics?: RemovedRubric[] | null;
  edits: { title: string; request: string; difficulty: string; evergreenChecked?: boolean } | null;
}

type Store = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
const CLAIM_KEY = STORAGE_KEYS.reviewClaim;

export async function saveClaimSnapshot(storage: Store, snap: ClaimSnapshot): Promise<void> {
  try {
    const body = JSON.stringify(snap);
    if (body.length > 2 * 1024 * 1024) return; // never blow the storage quota
    await storage.set(CLAIM_KEY, body);
  } catch {
    /* stats-grade persistence — never break the flow */
  }
}

export async function loadClaimSnapshot(storage: Store): Promise<ClaimSnapshot | null> {
  try {
    const raw = await storage.get(CLAIM_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as ClaimSnapshot;
    if (!snap?.claim?.subKey || !snap.claim.token) return null;
    // A snapshot older than the lock TTL is dead — the lock is claimable by
    // others; resuming would just 409 at submit.
    if (Date.now() - snap.claim.claimedAtMs > snap.claim.lockTtlMs) return null;
    return snap;
  } catch {
    return null;
  }
}

export async function clearClaimSnapshot(storage: Store): Promise<void> {
  await storage.set(CLAIM_KEY, "").catch(() => {});
}

export interface TrajectoryClaimSnapshot {
  claim: TrajectoryClaim;
  judgment: TrajectoryJudgmentDraft;
}

const TRAJECTORY_CLAIM_KEY = STORAGE_KEYS.trajectoryClaim;

export async function saveTrajectoryClaimSnapshot(storage: Store, snapshot: TrajectoryClaimSnapshot): Promise<void> {
  try {
    const body = JSON.stringify(snapshot);
    if (body.length > 8 * 1024 * 1024) return;
    await storage.set(TRAJECTORY_CLAIM_KEY, body);
  } catch {
    /* reviewer convenience only; the server lock remains authoritative */
  }
}

export async function loadTrajectoryClaimSnapshot(storage: Store): Promise<TrajectoryClaimSnapshot | null> {
  try {
    const raw = await storage.get(TRAJECTORY_CLAIM_KEY);
    if (!raw) return null;
    const snapshot = JSON.parse(raw) as TrajectoryClaimSnapshot;
    if (!snapshot?.claim?.manifestKey || !snapshot.claim.token || !snapshot.judgment) return null;
    if (Date.now() - snapshot.claim.claimedAtMs > snapshot.claim.lockTtlMs) return null;
    return snapshot;
  } catch {
    return null;
  }
}

export async function clearTrajectoryClaimSnapshot(storage: Store): Promise<void> {
  await storage.set(TRAJECTORY_CLAIM_KEY, "").catch(() => {});
}

export async function reviewRelease(reviewKey: string, claim: ReviewClaim, reviewer = ""): Promise<void> {
  // reviewer attributes the skip marker the server writes on release.
  await post("/review/release", { reviewKey, sub_key: claim.subKey, token: claim.token, reviewer });
}

export async function reviewSubmit(
  reviewKey: string,
  reviewer: string,
  claim: ReviewClaim,
  edited: { title: string; request: string; difficulty: string; rubrics: RubricRow[]; evergreenVerified?: boolean },
  reviewerPid?: string
): Promise<void> {
  const reviewed = buildReviewedTask(claim.task, edited);
  await post("/review/submit", {
    reviewKey,
    reviewer,
    // Stored beside the display name: the name is free text, the pid is the
    // stable handle any later attribution joins on.
    reviewer_pid: reviewerPid,
    sub_key: claim.subKey,
    token: claim.token,
    reviewed,
  });
}

export function buildReviewedTask(
  t: LongTask,
  edited: { title: string; request: string; difficulty: string; rubrics: RubricRow[]; evergreenVerified?: boolean }
): Record<string, unknown> {
  const criterionRows = edited.rubrics.filter((r) => r.kind !== "step");
  const stepRows = edited.rubrics.filter((r) => r.kind === "step");
  // Final gold follows the reviewer's row ORDER (rows can be inserted,
  // reordered, and removed). Original-step metadata rides along via
  // sourceIndex; order is always re-numbered positionally.
  const finalSteps = stepRows
    .filter((row) => row.text.trim())
    .map((row, index) => {
      const source = row.sourceIndex !== null ? t.task.steps?.[row.sourceIndex] : undefined;
      return {
        ...(source ?? {}),
        order: index + 1,
        title: row.title?.trim() || source?.title || `Step ${index + 1}`,
        description: row.text.trim(),
      };
    });
  const sourceHasSteps = (t.task.steps?.length ?? 0) > 0;
  const finalTask = {
    task_title: edited.title.trim(),
    agent_request: edited.request.trim(),
    difficulty: edited.difficulty,
    site_scope: t.task.site_scope,
    // Structured tasks use steps as their sole reviewed rubric. Preserve only
    // genuinely authored criteria as metadata; discard legacy step copies.
    success_criteria: sourceHasSteps
      ? (t.task.success_criteria ?? []).filter((text, index) => !isGeneratedStepCriterion(t, text, index))
      : criterionRows.map((r) => r.text.trim()).filter(Boolean),
    must_visit_or_reach: t.task.must_visit_or_reach,
    required_outputs: t.task.required_outputs,
    notes: t.task.notes,
    // Keep the author's classification with final gold. Reviewers edit the
    // task and rubrics, not this distribution metadata.
    ...(t.task.metadata ? { metadata: t.task.metadata } : {}),
    ...((sourceHasSteps || finalSteps.length) ? { steps: finalSteps } : {}),
  };
  const originalTask = {
    task_title: t.task.task_title,
    agent_request: t.task.agent_request,
    difficulty: t.task.difficulty,
    success_criteria: [...(t.task.success_criteria ?? [])],
    steps: (t.task.steps ?? []).map((step) => ({ ...step })),
  };
  // Authored content only — provenance stays in the original submission.
  return {
    schema_version: "odyssey_long_task_v2_reviewed",
    task_id: t.task_id,
    mode: t.mode,
    task: finalTask,
    review: {
      // Both snapshots intentionally live in final gold. This makes every
      // reviewer mutation auditable without reconstructing the submission.
      original: originalTask,
      final: {
        task_title: finalTask.task_title,
        agent_request: finalTask.agent_request,
        difficulty: finalTask.difficulty,
        success_criteria: finalTask.success_criteria,
        steps: "steps" in finalTask ? finalTask.steps : [],
      },
      rubrics: edited.rubrics.map((r) => ({
        kind: r.kind,
        source_index: r.sourceIndex,
        title: r.title,
        original: r.original,
        final: r.text.trim(),
        changed: r.original === null || r.text.trim() !== r.original.trim(),
        checked: r.checked,
      })),
      title_edited: edited.title.trim() !== t.task.task_title,
      request_edited: edited.request.trim() !== t.task.agent_request,
      evergreen_verified: Boolean(edited.evergreenVerified),
      original_quality: t.quality_signals ?? null,
    },
  };
}

function isGeneratedStepCriterion(task: LongTask, storedText: string, sourceIndex: number): boolean {
  const step = task.task.steps?.[sourceIndex];
  if (!step) return false;
  const normalizedDescription = step?.description?.trim().replace(/\s+/g, " ") ?? "";
  const legacySummary = normalizedDescription.length > 140
    ? `${normalizedDescription.slice(0, 137)}…`
    : normalizedDescription;
  return storedText === `${step.title}: ${normalizedDescription}` || storedText === `${step.title}: ${legacySummary}`;
}

// Steps are the canonical rubric items. Criteria remain a fallback only for
// legacy/non-structured tasks that genuinely have no steps.
export function seedRubrics(task: LongTask): RubricRow[] {
  const steps = (task.task.steps ?? []).flatMap((step, sourceIndex) => {
    if (!step.description?.trim()) return [];
    return [{
      text: step.description,
      original: step.description,
      checked: false,
      kind: "step" as const,
      sourceIndex,
      title: step.title || `Step ${sourceIndex + 1}`,
      seedVersion: 3 as const,
    }];
  });
  if (steps.length) return steps;
  return (task.task.success_criteria ?? []).filter((text) => text.trim()).map((text, sourceIndex) => ({
    text,
    original: text,
    checked: false,
    kind: "criterion" as const,
    sourceIndex,
    title: null,
    seedVersion: 3 as const,
  }));
}

// Upgrade a refresh-resume snapshot written before criteria and steps were
// tracked separately. Run once; after that, an absent row means the reviewer
// intentionally removed it and must stay absent from final gold.
export function upgradeRubrics(task: LongTask, rows: RubricRow[]): RubricRow[] {
  if (rows.some((row) => row.seedVersion === 3)) return rows;
  const steps = task.task.steps ?? [];
  if (steps.some((step) => step.description?.trim())) {
    const existingSteps = rows.filter((row) => row.kind === "step");
    return (existingSteps.length ? existingSteps : seedRubrics(task)).map((row) => ({ ...row, seedVersion: 3 as const }));
  }
  const upgraded: RubricRow[] = rows.map((row, index) => ({
    ...row,
    kind: "criterion" as const,
    sourceIndex: index,
    title: null,
    seedVersion: 3 as const,
  }));
  return upgraded;
}

// ---- Author-facing "my tasks" + self-edit + return-to-author ----

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
