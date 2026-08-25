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
  repair: { reason: string | null; suggested_rubric_text: string | null; verified_possible: boolean } | null;
}

export interface LlmReviewForHuman {
  status: "LLM_PASS" | "LLM_FAIL" | "NEEDS_HUMAN_REVIEW" | "PIPELINE_ERROR";
  manager_disposition: "FEASIBLE" | "NOT_FEASIBLE" | "NEEDS_HUMAN_REVIEW" | null;
  manager_summary: string | null;
  task_feedback: string | null;
  evergreen: { verdict: string; summary: string; concerns: string[] } | null;
  quality: {
    task_coherence: { verdict: string; summary: string | null; concerns: string[] } | null;
    prompt_quality: { verdict: string; summary: string | null; concerns: string[] } | null;
    summary: string | null;
  } | null;
  task_repair: { suggested_task_prompt: string; summary: string | null } | null;
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

export interface TrajectoryClaim {
  manifestKey: string;
  token: string;
  run: TrajectoryRun;
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

export async function reviewClaim(reviewKey: string, reviewer: string, reviewerPid?: string): Promise<ReviewClaim | null> {
  const response = await post("/review/claim", { reviewKey, reviewer, ...(reviewerPid ? { reviewer_pid: reviewerPid } : {}) });
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
  const finalSteps = (task.task.steps ?? []).flatMap((step, sourceIndex) => {
    const row = stepRows.find((candidate) => candidate.sourceIndex === sourceIndex);
    return row ? [{ ...step, description: row.text.trim() }] : [];
  });
  const addedSteps = stepRows.filter((row) => row.sourceIndex === null).map((row, index) => ({ order: finalSteps.length + index, title: row.title || `Step ${finalSteps.length + index + 1}`, description: row.text.trim() }));
  const final = {
    ...task.task,
    task_title: edited.title.trim(),
    agent_request: edited.request.trim(),
    difficulty: edited.difficulty,
    success_criteria: (task.task.steps?.length ?? 0) ? task.task.success_criteria : criterionRows.map((row) => row.text.trim()).filter(Boolean),
    steps: [...finalSteps, ...addedSteps],
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
  const response = await post("/trajectory/claim", { reviewKey, reviewer, ...(reviewerPid ? { reviewer_pid: reviewerPid } : {}) });
  if (!response.manifest_key) return null;
  return { manifestKey: String(response.manifest_key), token: String(response.token), run: response.run as unknown as TrajectoryRun, lockTtlMs: Number(response.lock_ttl_ms) || 1_800_000, claimedAtMs: Date.now() };
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
