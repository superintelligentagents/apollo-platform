import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

const {
  S3_BUCKET,
  UPLOAD_PREFIX = "prolific/journeys/",
  MAX_FILE_BYTES = "5000000",
  AWS_REGION = process.env.AWS_REGION || "us-east-1",
  ALLOWED_ORIGIN = "*",
  REVIEW_KEY = "",
  REPORTING_KEY = "",
  REPORTING_KEYS = "",
  REVIEW_PREFIX = "v2-review/",
  APP_SCOPE = "primary",
  LOCK_TTL_MS = String(30 * 60 * 1000),
  ADMIN_EMAILS = "",
  DASHBOARD_TABLE = "",
} = process.env;

const s3 = new S3Client({ region: AWS_REGION });
const dashboardDb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const adminEmails = new Set(
  ADMIN_EMAILS.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean)
);
const reportingKeys = [REPORTING_KEY, ...REPORTING_KEYS.split(",")]
  .map((key) => key.trim())
  .filter(Boolean);

export function isAllowedAdminEmail(email, allowed = adminEmails) {
  return allowed.has(String(email || "").trim().toLowerCase());
}

export function isConditionalConflict(err) {
  const code = err?.$metadata?.httpStatusCode;
  return code === 409 || code === 412 || err?.name === "PreconditionFailed" || err?.name === "ConditionalRequestConflict";
}

// Shared by review finalization and PC admin edits. S3's conditional request
// is the serialization point; callers get false when another writer won.
export async function tryConditionalWrite(write) {
  try {
    await write();
    return true;
  } catch (err) {
    if (isConditionalConflict(err)) return false;
    throw err;
  }
}

export function isMissingObjectError(error) {
  const code = error?.$metadata?.httpStatusCode;
  return code === 404 || error?.name === "NoSuchKey" || error?.name === "NotFound";
}

export function headErrorConfirmsAbsent(error) {
  return isMissingObjectError(error);
}

export async function deleteIfPresent(remove) {
  try {
    await remove();
    return true;
  } catch (error) {
    if (isMissingObjectError(error)) return false;
    throw error;
  }
}

// Credit withdrawal must complete before any done marker is removed. Once a
// done marker is gone, a retry cannot rediscover its reviewer/outcome and
// repair a transiently failed credit deletion.
export async function withdrawReopenedOutcomeState(records, { deleteCredit, deleteLock = null, deleteDone }) {
  for (const record of records ?? []) await deleteCredit(record);
  if (deleteLock) {
    for (const record of records ?? []) await deleteLock(record);
  }
  for (const record of records ?? []) await deleteDone(record);
}

// A conditional conflict is idempotent success only when the object already
// at that key is the marker this request intended to create. Treating every
// 409/412 as success can publish a revision behind a corrupt or unrelated
// routing record.
export async function ensureConditionalMarker({ putIfAbsent, readExisting, matches }) {
  try {
    await putIfAbsent();
    return true;
  } catch (error) {
    if (!isConditionalConflict(error)) return false;
  }
  try {
    return Boolean(matches(await readExisting()));
  } catch {
    return false;
  }
}

export function appealMarkerMatches(actual, expected) {
  if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object") return false;
  return ["sub_key", "appeal_of", "rejected_by_pid", "created_at"]
    .every((field) => String(actual[field] ?? "") === String(expected[field] ?? ""));
}

export function inboxMarkerMatches(actual, expectedSubKey) {
  return typeof actual === "string" && actual === String(expectedSubKey || "");
}

export function buildAppealMarkerForRevision(subKey, revision, rejectedByPid = "") {
  if (!revision?.appeal_of_sub_key) return null;
  return {
    sub_key: subKey,
    appeal_of: String(revision.appeal_of_sub_key),
    rejected_by_pid: String(rejectedByPid || ""),
    // Retry must reproduce the marker for the already-saved revision, not
    // mint a new timestamp that makes a valid conditional conflict look bad.
    created_at: String(revision.created_at || ""),
  };
}

export function appealRevisionCanPublish(revision, rejectedByPid) {
  return !revision?.appeal_of_sub_key || VALID_PID.test(String(rejectedByPid || "").trim().toLowerCase());
}

export function appealMarkerIsVerified(marker, subKey, revision) {
  const rejectedByPid = rejectedByPidFromDocument(marker);
  if (!revision?.appeal_of_sub_key || !rejectedByPid) return false;
  return appealMarkerMatches(
    marker,
    buildAppealMarkerForRevision(subKey, revision, rejectedByPid),
  );
}

// Publish routing state in dependency order. An appeal must be durably routed
// away from its rejecter before its inbox marker makes it claimable. The old
// marker remains until the new inbox object was created or verified, so any
// failed step leaves the previous revision reachable and a retry is safe.
export async function publishAuthorRevisionMarkers({
  appealMarker = null,
  ensureAppealMarker,
  ensureInboxMarker,
  deleteOldInboxMarker,
}) {
  let appealRouted = false;
  if (appealMarker) {
    appealRouted = Boolean(await ensureAppealMarker(appealMarker));
    if (!appealRouted) return { markerWritten: false, appealRouted: false };
  }
  const markerWritten = Boolean(await ensureInboxMarker());
  if (!markerWritten) return { markerWritten: false, appealRouted };
  await deleteOldInboxMarker();
  return { markerWritten: true, appealRouted };
}

export function pcAdminRevision(edit) {
  if (!edit) return 0;
  const explicit = Number(edit.revision_count);
  return Number.isInteger(explicit) && explicit > 0
    ? explicit
    : (Array.isArray(edit.history) ? edit.history.length : 0) + 1;
}

export function reviewContentHash(reviewed) {
  return createHash("sha256").update(JSON.stringify(reviewed)).digest("hex");
}

export function buildApprovedFinalGoldDocument({
  reviewed,
  contentHash,
  reviewer,
  reviewerPid,
  claimedAt,
  completedAt,
}) {
  return {
    ...reviewed,
    review_content_hash: contentHash,
    reviewed_by: reviewer,
    reviewer_pid: reviewerPid,
    claimed_at: claimedAt,
    finished_at: completedAt,
  };
}

export function textContentHash(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

export function uploadObjectKey(participantId, taskId, filename, timestamp = Date.now(), nonce = randomUUID().slice(0, 8)) {
  return `${UPLOAD_PREFIX}${participantId}/${taskId}/${timestamp}-${nonce}_${filename}`;
}

const respond = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST",
    "Content-Type": "application/json",
    ...headers,
  },
  body: JSON.stringify(body),
});

// ---------- review helpers ----------

const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
const lockKeyFor = (subKey) => `${REVIEW_PREFIX}locks/${b64url(subKey)}.json`;
const doneKeyFor = (subKey) => `${REVIEW_PREFIX}done/${b64url(subKey)}`;
// The author's latest acknowledgement of an approved task. The key is the
// submission that produced final gold, so retries are naturally idempotent.
const AUTHOR_SIGNOFF_PREFIX = `${REVIEW_PREFIX}author-signoffs/`;
const authorSignoffKeyFor = (subKey) => `${AUTHOR_SIGNOFF_PREFIX}${b64url(subKey)}.json`;
// Self-contained final tasks that have passed the original author's last
// look. Unlike the compact sign-off receipt, this prefix is directly usable
// by downstream consumers that only want author-approved final gold.
const AUTHOR_APPROVED_PREFIX = `${REVIEW_PREFIX}author-approved/`;
export const authorApprovedKeyFor = (taskId) => {
  const safeTaskId = String(taskId || "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 300) || "task-unknown";
  return `${AUTHOR_APPROVED_PREFIX}${safeTaskId}.json`;
};
const AUTHOR_MUTATION_LOCK_PREFIX = `${REVIEW_PREFIX}author-mutation-locks/`;
export const authorMutationLockKeyFor = (subKey) =>
  `${AUTHOR_MUTATION_LOCK_PREFIX}${b64url(reviewUnitForKey(subKey))}.json`;
// Superseded final-gold revisions. `finished/` remains one object per task so
// status counts and downstream consumers keep their existing contract.
const finishedHistoryKeyFor = (taskId, revision) =>
  `${REVIEW_PREFIX}finished-history/${taskId}/${String(revision).padStart(3, "0")}.json`;
// Small routing records keep an appeal away from the reviewer who rejected the
// prior revision without requiring one task-body GET per claim candidate.
const APPEAL_PREFIX = `${REVIEW_PREFIX}appeals/`;
const appealKeyFor = (subKey) => `${APPEAL_PREFIX}${b64url(subKey)}.json`;
export const UNVERIFIED_APPEAL_REJECTER = "__unverified_appeal__";
const LLM_PASS_PREFIX = `${REVIEW_PREFIX}llm_pass/`;
const LLM_FAIL_PREFIX = `${REVIEW_PREFIX}llm_fail/`;
const LLM_PRE_QC_PASS_PREFIX = `${REVIEW_PREFIX}llm_pre_qc_pass/`;
const LLM_PRE_QC_ATTENTION_PREFIX = `${REVIEW_PREFIX}llm_pre_qc_attention/`;
// v22 is the first artifact contract that requires literal task-request
// support for every step and fails closed on unrequested named apps/sources.
const MIN_REVIEWER_LLM_PIPELINE_VERSION = 22;
const MIN_REJECTION_REASON_LENGTH = 40;
export const MIN_APPEAL_REASON_LENGTH = 20;
const MAX_APPEAL_REASON_LENGTH = 2_000;
const TRAJECTORY_RUNS_PREFIX = `${REVIEW_PREFIX}trajectory-runs/`;
const TRAJECTORY_INBOX_PREFIX = `${REVIEW_PREFIX}trajectory-inbox/`;
const TRAJECTORY_LOCKS_PREFIX = `${REVIEW_PREFIX}trajectory-locks/`;
const TRAJECTORY_DONE_PREFIX = `${REVIEW_PREFIX}trajectory-done/`;
const TRAJECTORY_JUDGMENTS_PREFIX = `${REVIEW_PREFIX}trajectory-judgments/`;
const TRAJECTORY_EDIT_LINKS_PREFIX = `${REVIEW_PREFIX}trajectory-edit-links/`;
const trajectoryLockKeyFor = (manifestKey) => `${TRAJECTORY_LOCKS_PREFIX}${b64url(manifestKey)}.json`;
const trajectoryDoneKeyFor = (manifestKey) => `${TRAJECTORY_DONE_PREFIX}${b64url(manifestKey)}`;
const trajectoryJudgmentKeyFor = (manifestKey) => `${TRAJECTORY_JUDGMENTS_PREFIX}${b64url(manifestKey)}.json`;

export function taskIdFromTrajectoryManifestKey(key, reviewPrefix = REVIEW_PREFIX) {
  const runsPrefix = `${String(reviewPrefix).replace(/\/*$/, "/")}trajectory-runs/`;
  const raw = String(key);
  if (!raw.startsWith(runsPrefix)) return null;
  const parts = raw.slice(runsPrefix.length).split("/");
  if (parts.length !== 3 || !parts[0] || !parts[1] || parts[2] !== "manifest.json") return null;
  try {
    const decoded = fromB64url(parts[0]);
    return b64url(decoded) === parts[0] ? decoded : null;
  } catch {
    return null;
  }
}

export function participantIdFromTrajectoryTaskId(taskId) {
  const match = /^(?:v2|pc)\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\//.exec(String(taskId || ""));
  return match?.[1] ?? null;
}

export function participantIdFromTrajectoryManifestKey(key) {
  return participantIdFromTrajectoryTaskId(taskIdFromTrajectoryManifestKey(key));
}

// Trajectory grading is intentionally the inverse of task QC: a run belongs
// to the expert who authored the task. This lets authors assess model behavior
// on their own task without letting them approve the task's human-QC gold.
export function trajectoryRunsForCreator(keys, reviewerPid, creatorByManifest = new Map()) {
  const pid = String(reviewerPid || "").trim().toLowerCase();
  if (!VALID_PID.test(pid)) return [];
  return keys.filter((key) => {
    const assigned = creatorByManifest instanceof Map
      ? creatorByManifest.get(key)
      : creatorByManifest?.[key];
    return (assigned || participantIdFromTrajectoryManifestKey(key)) === pid;
  });
}

// Kept as an exported compatibility alias for older imports. Its behavior now
// follows the creator-only Grade policy.
export const excludeOwnTrajectoryRuns = trajectoryRunsForCreator;

export function uploadScopeAllows(scope, isV2, isPC) {
  if (scope === "pc") return Boolean(isPC);
  if (scope === "v2") return Boolean(isV2);
  if (scope === "primary") return !isPC;
  return false;
}

export function llmReviewKeyFor(taskId, disposition) {
  const prefix = disposition === "FEASIBLE" ? LLM_PASS_PREFIX : LLM_FAIL_PREFIX;
  return `${prefix}${b64url(String(taskId))}.json`;
}

export function taskIdFromLlmReviewKey(key, prefix) {
  if (!String(key).startsWith(prefix) || !String(key).endsWith(".json")) return null;
  const objectName = String(key).slice(prefix.length).replace(/\.json$/, "");
  try {
    const encoded = objectName.split(".", 1)[0];
    const decoded = fromB64url(encoded);
    return b64url(decoded) === encoded ? decoded : null;
  } catch {
    return null;
  }
}

export function parseLlmReviewArtifactKey(key, prefix, status, lastModified = 0, stage = "POST_QC") {
  const taskId = taskIdFromLlmReviewKey(key, prefix);
  if (!taskId) return null;
  const objectName = String(key).slice(String(prefix).length).replace(/\.json$/, "");
  const parts = objectName.split(".");
  const contentHash = parts.length >= 3 && /^[a-f0-9]{64}$/.test(parts[1]) ? parts[1] : null;
  const pipeline = contentHash ? parts.slice(2).join(".") : null;
  const versions = [...String(pipeline || "").matchAll(/(?:^|[-_])v(\d+)(?=$|[-_.])/g)];
  const pipelineVersion = versions.length ? Number(versions[versions.length - 1][1]) : 0;
  const modifiedAt = lastModified instanceof Date
    ? lastModified.getTime()
    : Number.isFinite(Number(lastModified))
      ? Number(lastModified)
      : Date.parse(String(lastModified)) || 0;
  return {
    taskId,
    status,
    stage,
    key: String(key),
    contentHash,
    pipeline,
    pipelineVersion,
    modifiedAt,
  };
}

export function selectLlmReviewArtifact(candidates, currentTaskContentHash) {
  const currentHash = String(currentTaskContentHash || "");
  return [...(Array.isArray(candidates) ? candidates : [])].sort((a, b) => {
    const aMatches = Boolean(currentHash && a?.contentHash === currentHash);
    const bMatches = Boolean(currentHash && b?.contentHash === currentHash);
    if (aMatches !== bMatches) return aMatches ? -1 : 1;
    const versionDifference = (Number(b?.pipelineVersion) || 0) - (Number(a?.pipelineVersion) || 0);
    if (versionDifference) return versionDifference;
    const modifiedDifference = (Number(b?.modifiedAt) || 0) - (Number(a?.modifiedAt) || 0);
    if (modifiedDifference) return modifiedDifference;
    return String(b?.key || "").localeCompare(String(a?.key || ""));
  })[0] ?? null;
}

export function applicableLlmReviewCandidates(candidates, workflowStatus) {
  const stage = workflowStatus === "pending" || workflowStatus === "in_review" ? "PRE_QC" : "POST_QC";
  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate?.stage === stage);
}

export function currentReviewerLlmCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : []).filter(
    (candidate) => Number(candidate?.pipelineVersion) >= MIN_REVIEWER_LLM_PIPELINE_VERSION
  );
}

// Human QC may start only after the current authored content has a completed
// PRE_QC artifact from a reviewer-supported pipeline. Attention results are
// intentionally eligible: Codex supplies evidence, while the human still
// decides whether to edit, approve, or reject the task.
export function hasCompletedReviewerPreQc(candidates, taskId, taskContentHash) {
  const applicable = currentReviewerLlmCandidates(
    (Array.isArray(candidates) ? candidates : []).filter(
      (candidate) => candidate?.stage === "PRE_QC" && candidate?.taskId === taskId
    )
  );
  const selected = selectLlmReviewArtifact(applicable, taskContentHash);
  return Boolean(selected && selected.contentHash === taskContentHash);
}

export function isCompletedReviewerPreQcArtifact(artifact) {
  const status = String(artifact?.status || "");
  if (!["LLM_PASS", "LLM_FAIL", "NEEDS_HUMAN_REVIEW"].includes(status)) return false;
  const expected = Array.isArray(artifact?.source?.rubrics) ? artifact.source.rubrics : [];
  const reviews = Array.isArray(artifact?.rubric_reviews) ? artifact.rubric_reviews : [];
  if (!expected.length || reviews.length !== expected.length) return false;
  const expectedIds = new Set(expected.map((rubric) => String(rubric?.rubric_id || "")).filter(Boolean));
  if (expectedIds.size !== expected.length) return false;
  return reviews.every((review) =>
    review?.status === "COMPLETED" && expectedIds.has(String(review?.rubric_id || ""))
  );
}

export function isCurrentIndexedPreQc(record, candidate, taskContentHash) {
  return Boolean(
    record
    && candidate
    && taskContentHash
    && record.pre_qc_complete === true
    && record.pre_qc_artifact_key === candidate.key
    && record.pre_qc_task_content_hash === taskContentHash
    && candidate.contentHash === taskContentHash
  );
}

// The reviewer queue and author pages ask about different key sets. Cache by
// exact set so they do not continuously evict one another and re-scan S3.
const reviewAuditGateCache = new Map();
const REVIEW_AUDIT_GATE_TTL_MS = 10_000;
const REVIEW_AUDIT_GATE_CACHE_MAX = 8;

function cacheReviewAuditGate(signature, checkedAt, ready) {
  reviewAuditGateCache.delete(signature);
  reviewAuditGateCache.set(signature, { checkedAt, ready: new Set(ready) });
  for (const [key, entry] of reviewAuditGateCache) {
    if (checkedAt - entry.checkedAt >= REVIEW_AUDIT_GATE_TTL_MS) reviewAuditGateCache.delete(key);
  }
  while (reviewAuditGateCache.size > REVIEW_AUDIT_GATE_CACHE_MAX) {
    reviewAuditGateCache.delete(reviewAuditGateCache.keys().next().value);
  }
}

async function completedPreQcSubmissionKeys(submissionKeys) {
  const keys = Array.isArray(submissionKeys) ? submissionKeys : [];
  const signature = keys.join("\n");
  const now = Date.now();
  const cached = reviewAuditGateCache.get(signature);
  if (cached && now - cached.checkedAt < REVIEW_AUDIT_GATE_TTL_MS) {
    return new Set(cached.ready);
  }

  const [passed, attention] = await Promise.all([
    listAllObjects(LLM_PRE_QC_PASS_PREFIX),
    listAllObjects(LLM_PRE_QC_ATTENTION_PREFIX),
  ]);
  const candidates = [];
  for (const [objects, status, prefix] of [
    [passed, "pre_qc_passed", LLM_PRE_QC_PASS_PREFIX],
    [attention, "pre_qc_attention", LLM_PRE_QC_ATTENTION_PREFIX],
  ]) {
    for (const object of objects) {
      const parsed = parseLlmReviewArtifactKey(object.Key, prefix, status, object.LastModified, "PRE_QC");
      if (parsed) candidates.push(parsed);
    }
  }

  if (DASHBOARD_TABLE && dashboardIndexScope() === "v2") {
    try {
      const ready = await completedPreQcSubmissionKeysFromIndex(keys, candidates);
      // The dashboard index is an optimization, not the source of truth. A
      // submission can become visible in S3 before its index row exists (or an
      // older row may be missing), so validate only unresolved keys directly
      // from S3 instead of incorrectly keeping audited tasks behind the gate.
      const unresolved = keys.filter((key) => !ready.has(key));
      if (unresolved.length) {
        const sourceReady = await completedPreQcSubmissionKeysFromSources(unresolved, candidates);
        for (const key of sourceReady) ready.add(key);
      }
      cacheReviewAuditGate(signature, now, ready);
      return new Set(ready);
    } catch (error) {
      console.error("Live-audit index failed; using S3 source-of-truth validation", error);
    }
  }

  const ready = await completedPreQcSubmissionKeysFromSources(keys, candidates);
  cacheReviewAuditGate(signature, now, ready);
  return new Set(ready);
}

async function completedPreQcSubmissionKeysFromSources(keys, candidates) {
  const ready = new Set();
  await Promise.all(keys.map(async (subKey) => {
    try {
      const source = await readJson(subKey).then(({ json }) => json);
      const taskId = cleanText(source?.task_id, 300);
      const original = cleanTaskSnapshot(source?.task ?? source);
      if (!taskId || !original) return;
      const rubrics = cleanRubrics(null, original, null);
      const taskContentHash = reportingTaskContentHash(original, null, rubrics);
      const applicable = currentReviewerLlmCandidates(
        candidates.filter((candidate) => candidate?.stage === "PRE_QC" && candidate?.taskId === taskId)
      );
      const selected = selectLlmReviewArtifact(applicable, taskContentHash);
      if (!selected || selected.contentHash !== taskContentHash) return;
      const artifact = await readJson(selected.key).then(({ json }) => json);
      if (isCompletedReviewerPreQcArtifact(artifact)) ready.add(subKey);
    } catch {
      // A task that cannot be read or fingerprinted is not ready for review.
    }
  }));
  return ready;
}

async function listAll(prefix) {
  return (await listAllObjects(prefix)).map((o) => o.Key);
}

async function listAllObjects(prefix) {
  const objs = [];
  let token;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 })
    );
    for (const o of page.Contents ?? []) objs.push({ Key: o.Key, LastModified: o.LastModified });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objs;
}

async function countAll(prefix) {
  let count = 0;
  let token;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 })
    );
    count += page.KeyCount ?? (page.Contents ?? []).length;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return count;
}

async function listCommonPrefixes(prefix) {
  const prefixes = [];
  let token;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        Delimiter: "/",
        ContinuationToken: token,
        MaxKeys: 1000,
      })
    );
    prefixes.push(...(page.CommonPrefixes ?? []).map((p) => p.Prefix).filter(Boolean));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return prefixes;
}

const inboxKeyFor = (subKey) => `${REVIEW_PREFIX}inbox/${b64url(subKey)}`;
const pcBundleIndexKeyFor = (manifestKey) => `${REVIEW_PREFIX}pc-bundles/${b64url(manifestKey)}`;

// Both task apps embed the submitting participant id in the source key:
// /v2/{pid}/... for Apollo v2 and /pc/{pid}/... for Apollo PC review
// sidecars. Exported so self-review exclusion is unit-testable without S3.
export function participantIdFromSubKey(subKey) {
  const m = /\/(?:v2|pc)\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\//.exec(String(subKey));
  return m ? m[1] : null;
}

const VALID_PID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function rejectedByPidFromDocument(document) {
  const explicit = String(document?.rejected_by_pid || "").trim().toLowerCase();
  return VALID_PID.test(explicit) ? explicit : "";
}

// An appeal is safe only when the rejection carries a stable reviewer id. Old
// rejection records stored only a free-text display name; without a verified
// pid the queue cannot guarantee the second opinion goes to somebody else.
export function rejectionCanAppeal(rejectionCount, rejectedDocument) {
  return Number(rejectionCount) === 1 && Boolean(rejectedByPidFromDocument(rejectedDocument));
}

export function cleanAppealReason(value) {
  return String(value ?? "").trim().slice(0, MAX_APPEAL_REASON_LENGTH);
}

export function appealReasonIsValid(value) {
  return cleanAppealReason(value).length >= MIN_APPEAL_REASON_LENGTH;
}

// Reviewers must never review their own submissions. Given the caller's
// participant id, keep only other people's tasks; with no (or an invalid) id
// the list passes through unchanged — old clients keep working. Exported for
// unit tests.
export function excludeOwnSubmissions(subKeys, reviewerPid) {
  const pid = String(reviewerPid || "").trim().toLowerCase();
  if (!VALID_PID.test(pid)) return subKeys;
  return subKeys.filter((k) => participantIdFromSubKey(k) !== pid);
}

// Exclude both self-review and an appeal of this reviewer's own rejection.
export function excludeIneligible(subKeys, reviewerPid, appealRejecterByKey = new Map()) {
  const pid = String(reviewerPid || "").trim().toLowerCase();
  const verified = subKeys.filter((key) => appealRejecterByKey.get(key) !== UNVERIFIED_APPEAL_REJECTER);
  // Ordinary legacy clients may omit PID, but an appeal requires a valid PID
  // to prove the claimant is not its rejecting reviewer.
  if (!VALID_PID.test(pid)) return verified.filter((key) => !appealRejecterByKey.has(key));
  return verified.filter(
    (key) => participantIdFromSubKey(key) !== pid
      && appealRejecterByKey.get(key) !== pid
  );
}

// A rejected task receives one author appeal. Approved tasks use the distinct
// sign-off/amend flow; a task already held by a reviewer cannot be edited.
export function authorEditEligibility(outcome, locked, rejectionCount = 0, appealInFlight = false) {
  if (locked) {
    return { allowed: false, reason: "A reviewer has claimed this task — it's locked for review." };
  }
  if (outcome === "approved") {
    return {
      allowed: false,
      reason: "This task is approved. Use the sign-off queue to accept it or amend it.",
    };
  }
  if (outcome === "rejected") {
    return rejectionCount <= 1
      ? { allowed: true, reason: "", appeal: true }
      : {
          allowed: false,
          reason: "You have already appealed this rejection once. This task is finished.",
        };
  }
  if (!outcome && appealInFlight) {
    return {
      allowed: false,
      reason: "Your one appeal is already queued for Codex and reviewer re-check.",
    };
  }
  return { allowed: true, reason: "" };
}

const MAX_STAGE_MINUTES = 24 * 60;
export function stageMinutes(startedAt, endedAt) {
  const start = Date.parse(startedAt ?? "");
  const end = Date.parse(endedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const minutes = (end - start) / 60_000;
  if (minutes < 0 || minutes > MAX_STAGE_MINUTES) return null;
  return Math.round(minutes * 100) / 100;
}

// "Skip" means "not now", not "never": the claim endpoints accept the
// caller's recently-skipped keys and serve everything else first, so skipping
// a task never hands the same one straight back. Skipped keys stay at the END
// of the order (never dropped) — when they are all that's left, the queue
// still hands one out instead of dead-ending. Exported for unit tests.
export function orderClaimCandidates(unlocked, locked, skipKeys) {
  const skips = new Set(
    (Array.isArray(skipKeys) ? skipKeys : [])
      .slice(0, 100)
      .map((key) => cleanText(key, 2_000))
      .filter(Boolean)
  );
  if (!skips.size) return [...unlocked, ...locked];
  const partition = (keys, skipped) => keys.filter((key) => skips.has(key) === skipped);
  return [
    ...partition(unlocked, false),
    ...partition(locked, false),
    ...partition(unlocked, true),
    ...partition(locked, true),
  ];
}
const fromB64url = (s) => Buffer.from(s, "base64url").toString("utf8");
const reviewerKeyFor = (reviewer) =>
  `${REVIEW_PREFIX}reviewers/${reviewer.replace(/[^A-Za-z0-9@._-]/g, "_").slice(0, 80)}.json`;
const reviewerCreditRoot = (reviewer) =>
  `${REVIEW_PREFIX}credits/${b64url(String(reviewer).trim().toLowerCase())}/`;
const reviewerCreditPrefix = (reviewer, outcome) => `${reviewerCreditRoot(reviewer)}${outcome}/`;
const reviewerCreditKeyFor = (reviewer, outcome, subKey) =>
  `${reviewerCreditPrefix(reviewer, outcome)}${createHash("sha256").update(subKey).digest("hex")}.json`;

async function participantTaskCount(participantId) {
  // One CommonPrefix per stable task id. Retries add files inside the same
  // directory and therefore never inflate the count. This targeted LIST does
  // not scan or download raw history objects.
  const prefix = `${UPLOAD_PREFIX}${participantId}/v2/${participantId}/internal/`;
  let count = 0;
  let token;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        Delimiter: "/",
        ContinuationToken: token,
        MaxKeys: 1000,
      })
    );
    count += (page.CommonPrefixes ?? []).length;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return count;
}

async function readJson(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  const text = await res.Body.transformToString();
  return { json: JSON.parse(text), etag: res.ETag, text };
}

async function ensureAuthorInboxMarker(subKey) {
  return await ensureConditionalMarker({
    putIfAbsent: () => s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: inboxKeyFor(subKey),
      Body: subKey,
      ContentType: "text/plain",
      IfNoneMatch: "*",
    })),
    readExisting: async () => {
      const response = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: inboxKeyFor(subKey) }));
      return await response.Body.transformToString();
    },
    matches: (existing) => inboxMarkerMatches(existing, subKey),
  });
}

async function ensureAuthorAppealMarker(subKey, marker) {
  return await ensureConditionalMarker({
    putIfAbsent: () => s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: appealKeyFor(subKey),
      Body: JSON.stringify(marker),
      ContentType: "application/json",
      IfNoneMatch: "*",
    })),
    readExisting: () => readJson(appealKeyFor(subKey)).then(({ json }) => json),
    matches: (existing) => appealMarkerMatches(existing, marker),
  });
}

async function publishStoredAuthorRevision({ subKey, revision, previousSubKey, rejectedByPid }) {
  if (!appealRevisionCanPublish(revision, rejectedByPid)) {
    return { markerWritten: false, appealRouted: false };
  }
  const appealMarker = buildAppealMarkerForRevision(subKey, revision, rejectedByPid);
  return await publishAuthorRevisionMarkers({
    appealMarker,
    ensureAppealMarker: (marker) => ensureAuthorAppealMarker(subKey, marker),
    ensureInboxMarker: () => ensureAuthorInboxMarker(subKey),
    deleteOldInboxMarker: async () => {
      if (!previousSubKey || previousSubKey === subKey) return;
      await s3.send(new DeleteObjectCommand({
        Bucket: S3_BUCKET,
        Key: inboxKeyFor(previousSubKey),
      })).catch(() => {});
    },
  });
}

export function reviewUnitForKey(key) {
  const dir = key.slice(0, key.lastIndexOf("/"));
  if (key.includes("/pc/") && /_review_task_[A-Za-z0-9_-]{1,120}\.json$/.test(key)) {
    // Retries get new timestamp prefixes. Group only retries of the same PC
    // task, while keeping separate tasks from one bundle independently
    // claimable.
    const filename = key.slice(key.lastIndexOf("/") + 1).replace(/^\d+(?:-[A-Za-z0-9]+)?_/, "");
    return `${dir}/${filename}`;
  }
  return dir;
}

export function isReviewSubmissionKey(key) {
  return (
    (key.includes("/v2/") && key.endsWith("long_task.json")) ||
    (key.includes("/pc/") && /_review_task_[A-Za-z0-9_-]{1,120}\.json$/.test(key))
  );
}

function cleanText(value, max = 20_000) {
  return String(value ?? "").slice(0, max);
}

function cleanCriteria(value) {
  return Array.isArray(value) ? value.slice(0, 50).map((item) => String(item ?? "")).filter(Boolean) : [];
}

function cleanSteps(value) {
  return Array.isArray(value)
    ? value.slice(0, 50).map((step, index) => ({
        order: Number.isFinite(Number(step?.order)) ? Number(step.order) : index + 1,
        title: cleanText(step?.title || `Step ${index + 1}`, 200),
        description: String(step?.description ?? ""),
      })).filter((step) => step.description.trim())
    : [];
}

export function taskMetadataForReporting(task) {
  const raw = task?.metadata;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const region = cleanText(raw.region, 20).trim();
  const subjects = Array.isArray(raw.subjects)
    ? raw.subjects.slice(0, 3).map((subject) => cleanText(subject, 200).trim()).filter(Boolean)
    : [];
  return region || subjects.length ? { region, subjects } : null;
}

export function cleanTaskSnapshot(task) {
  if (!task || typeof task !== "object") return null;
  return {
    title: cleanText(task.task_title ?? task.title, 300),
    request: String(task.agent_request ?? task.request ?? ""),
    difficulty: cleanText(task.difficulty || "high", 30),
    criteria: cleanCriteria(task.success_criteria ?? task.criteria),
    steps: cleanSteps(task.steps),
    site_scope: Array.isArray(task.site_scope) ? task.site_scope.slice(0, 30).map((item) => cleanText(item, 500)) : [],
    key_urls: Array.isArray(task.must_visit_or_reach) ? task.must_visit_or_reach.slice(0, 50).map((item) => cleanText(item, 2_000)) : [],
    required_outputs: Array.isArray(task.required_outputs) ? task.required_outputs.slice(0, 30).map((item) => cleanText(item, 2_000)) : [],
    notes: task.notes == null ? null : String(task.notes),
  };
}

export function cleanRubrics(review, original, final) {
  if (Array.isArray(review?.rubrics) && review.rubrics.length) {
    const editedRubrics = review.rubrics.slice(0, 50).map((rubric, index) => ({
      rubric_id: `rubric-${index + 1}`,
      kind: rubric?.kind === "criterion" ? "criterion" : "step",
      source_index: rubric?.source_index == null
        ? null
        : Number.isInteger(Number(rubric.source_index)) ? Number(rubric.source_index) : null,
      title: rubric?.title == null ? null : cleanText(rubric.title, 200),
      original: rubric?.original == null ? null : String(rubric.original),
      final: String(rubric?.final ?? ""),
      changed: Boolean(rubric?.changed),
      checked: Boolean(rubric?.checked),
    })).filter((rubric) => rubric.final.trim());
    // Early reviewed records stored rubric audit entries without `final`.
    // Fall back to the final-gold steps instead of letting that empty audit
    // hide the canonical rubric list.
    if (editedRubrics.length) return editedRubrics;
  }
  const task = final ?? original;
  if (task?.steps?.length) {
    return task.steps.map((step, index) => ({
      rubric_id: `rubric-${index + 1}`,
      kind: "step",
      source_index: index,
      title: step.title,
      original: original?.steps?.[index]?.description ?? null,
      final: step.description,
      changed: Boolean(original?.steps?.[index] && original.steps[index].description !== step.description),
      checked: false,
    }));
  }
  return (task?.criteria ?? []).map((criterion, index) => ({
    rubric_id: `rubric-${index + 1}`,
    kind: "criterion",
    source_index: index,
    title: null,
    original: original?.criteria?.[index] ?? null,
    final: criterion,
    changed: Boolean(original?.criteria?.[index] && original.criteria[index] !== criterion),
    checked: false,
  }));
}

export function reportingTaskContentHash(original, final, rubrics = []) {
  const effectiveTask = final ?? original ?? null;
  const effectiveRubrics = (Array.isArray(rubrics) ? rubrics : []).map((rubric) => ({
    rubric_id: cleanText(rubric?.rubric_id, 100),
    kind: rubric?.kind === "criterion" ? "criterion" : "step",
    source_index: rubric?.source_index == null ? null : Number(rubric.source_index),
    title: rubric?.title == null ? null : cleanText(rubric.title, 200),
    text: String(rubric?.final ?? ""),
  }));
  return reviewContentHash({ task: effectiveTask, rubrics: effectiveRubrics });
}

export function llmFeedbackFromReview(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) return null;
  const taskFeedback = review.feedback?.task
    ?? review.manager_review?.task_feedback
    ?? review.manager_review?.summary
    ?? null;
  const explicitRubrics = Array.isArray(review.feedback?.rubrics) ? review.feedback.rubrics : [];
  const outcomes = Array.isArray(review.rubric_reviews) ? review.rubric_reviews : [];
  const assessments = Array.isArray(review.manager_review?.rubric_assessments)
    ? review.manager_review.rubric_assessments
    : [];
  const explicitById = new Map(explicitRubrics.map((item) => [String(item?.rubric_id || ""), item]));
  const outcomeById = new Map(outcomes.map((item) => [String(item?.rubric_id || ""), item]));
  const assessmentById = new Map(assessments.map((item) => [String(item?.rubric_id || ""), item]));
  const rubricIds = [...new Set([
    ...outcomes.map((item) => String(item?.rubric_id || "")),
    ...assessments.map((item) => String(item?.rubric_id || "")),
    ...explicitRubrics.map((item) => String(item?.rubric_id || "")),
  ].filter(Boolean))];
  return {
    task: taskFeedback == null ? null : cleanText(taskFeedback, 5_000),
    rubrics: rubricIds.slice(0, 100).map((rubricId) => {
      const explicit = explicitById.get(rubricId);
      const outcome = outcomeById.get(rubricId);
      const assessment = assessmentById.get(rubricId);
      const feedback = explicit?.feedback
        ?? assessment?.manager_note
        ?? outcome?.browser_review?.review?.rubric_feedback
        ?? outcome?.review?.rubric_feedback
        ?? outcome?.review?.summary
        ?? null;
      return {
        rubric_id: cleanText(rubricId, 100),
        feedback: feedback == null ? null : cleanText(feedback, 5_000),
      };
    }).filter((item) => item.rubric_id),
  };
}

const sanitizeEditOperations = (operations) => (Array.isArray(operations) ? operations : [])
  .slice(0, 3)
  .map((operation) => ({
    operation: ["REPLACE", "DELETE", "APPEND"].includes(operation?.operation) ? operation.operation : null,
    old_text: operation?.old_text == null ? null : cleanText(operation.old_text, 8_000),
    new_text: cleanText(operation?.new_text, 8_000),
  }))
  .filter((operation) => operation.operation);

const sanitizeRepairVerification = (verification) => {
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) return null;
  const review = verification.review && typeof verification.review === "object" && !Array.isArray(verification.review)
    ? {
        schema_version: cleanText(verification.review.schema_version, 80) || null,
        task_id: cleanText(verification.review.task_id, 300) || null,
        rubric_id: cleanText(verification.review.rubric_id, 100) || null,
        verdict: cleanText(verification.review.verdict, 40) || null,
        quality_verdict: cleanText(verification.review.quality_verdict, 40) || null,
        quality_summary: cleanText(verification.review.quality_summary, 3_000) || null,
        confidence: Number.isFinite(Number(verification.review.confidence))
          ? Number(verification.review.confidence)
          : null,
        tested_at_utc: cleanText(verification.review.tested_at_utc, 80) || null,
        summary: cleanText(verification.review.summary, 5_000) || null,
        evidence: (Array.isArray(verification.review.evidence) ? verification.review.evidence : [])
          .slice(0, 20)
          .map((source) => ({
            url: cleanText(source?.url, 4_000),
            title: cleanText(source?.title, 500),
            observed_at_utc: cleanText(source?.observed_at_utc, 80) || null,
            supports: cleanText(source?.supports, 3_000),
          }))
          .filter((source) => source.url),
        blockers: (Array.isArray(verification.review.blockers) ? verification.review.blockers : [])
          .slice(0, 20)
          .map((item) => cleanText(item, 1_000))
          .filter(Boolean),
      }
    : null;
  return {
    status: cleanText(verification.status, 40) || "NOT_RUN",
    review,
    error: verification.error == null ? null : cleanText(verification.error, 8_000),
  };
};

export function llmRepairPlanFromReview(review) {
  const plan = review?.repair_plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  const rubricRepairs = (Array.isArray(plan.rubric_repairs) ? plan.rubric_repairs : [])
    .slice(0, 100)
    .map((repair) => {
      const verification = sanitizeRepairVerification(repair?.verification);
      const verifiedPossible = repair?.verified_possible === true;
      const verificationQualityPassed = !verification?.review?.quality_verdict
        || verification.review.quality_verdict === "PASS";
      const exposeSuggestion = verifiedPossible
        && verification?.status === "COMPLETED"
        && verification?.review?.verdict === "POSSIBLE"
        && verificationQualityPassed;
      return {
      rubric_id: cleanText(repair?.rubric_id, 100),
      effective_verdict: cleanText(repair?.effective_verdict, 40) || null,
      quality_verdict: cleanText(repair?.quality_verdict, 40) || null,
      repair_kind: cleanText(repair?.repair_kind, 60) || "HUMAN_REVIEW_REQUIRED",
      confidence: Number.isFinite(Number(repair?.confidence)) ? Number(repair.confidence) : null,
      reason: cleanText(repair?.reason, 5_000) || null,
      edit_operations: exposeSuggestion ? sanitizeEditOperations(repair?.edit_operations) : [],
      suggested_rubric_text: !exposeSuggestion || repair?.suggested_rubric_text == null
        ? null
        : cleanText(repair.suggested_rubric_text, 30_000),
      verified_replacement_urls: (Array.isArray(repair?.verified_replacement_urls)
        ? repair.verified_replacement_urls
        : [])
        .slice(0, 10)
        .map((source) => ({
          url: cleanText(source?.url, 4_000),
          title: cleanText(source?.title, 500),
          supports: cleanText(source?.supports, 3_000),
        }))
        .filter((source) => source.url),
      human_input_needed: repair?.human_input_needed == null
        ? null
        : cleanText(repair.human_input_needed, 3_000),
      preserves_intent: repair?.preserves_intent === true,
      verified_possible: verifiedPossible,
      verification,
    }})
    .filter((repair) => repair.rubric_id);
  return {
    schema_version: cleanText(plan.schema_version, 80) || null,
    task_id: cleanText(plan.task_id, 300) || null,
    created_at_utc: cleanText(plan.created_at_utc, 80) || null,
    applied_automatically: false,
    source_changed: false,
    summary: cleanText(plan.summary, 5_000) || null,
    suggested_task_prompt: plan.projected_task_status !== "POSSIBLE" || plan.suggested_task_prompt == null
      ? null
      : cleanText(plan.suggested_task_prompt, 200_000),
    task_prompt_edit_operations: plan.projected_task_status === "POSSIBLE"
      ? sanitizeEditOperations(plan.task_prompt_edit_operations)
      : [],
    rubric_repairs: rubricRepairs,
    unresolved_rubric_ids: (Array.isArray(plan.unresolved_rubric_ids) ? plan.unresolved_rubric_ids : [])
      .slice(0, 100)
      .map((item) => cleanText(item, 100))
      .filter(Boolean),
    cross_rubric_notes: (Array.isArray(plan.cross_rubric_notes) ? plan.cross_rubric_notes : [])
      .slice(0, 30)
      .map((item) => cleanText(item, 2_000))
      .filter(Boolean),
    preserves_task_flow: plan.preserves_task_flow === true,
    all_suggested_changes_verified: plan.all_suggested_changes_verified === true,
    all_rubrics_projected_possible: plan.all_rubrics_projected_possible === true,
    projected_evergreen_review: plan.projected_evergreen_review && typeof plan.projected_evergreen_review === "object"
      ? {
          status: cleanText(plan.projected_evergreen_review.status, 40) || null,
          verdict: cleanText(plan.projected_evergreen_review.verdict, 40) || null,
          confidence: plan.projected_evergreen_review.confidence != null
            && Number.isFinite(Number(plan.projected_evergreen_review.confidence))
            ? Number(plan.projected_evergreen_review.confidence)
            : null,
          reviewed_at_utc: cleanText(plan.projected_evergreen_review.reviewed_at_utc, 80) || null,
          summary: cleanText(plan.projected_evergreen_review.summary, 5_000) || null,
          concerns: (Array.isArray(plan.projected_evergreen_review.concerns)
            ? plan.projected_evergreen_review.concerns
            : [])
            .slice(0, 30)
            .map((item) => cleanText(item, 2_000))
            .filter(Boolean),
          error: plan.projected_evergreen_review.error == null
            ? null
            : cleanText(plan.projected_evergreen_review.error, 8_000),
        }
      : null,
    projected_feasibility_review: plan.projected_feasibility_review
      && typeof plan.projected_feasibility_review === "object"
      ? {
          status: cleanText(plan.projected_feasibility_review.status, 40) || null,
          disposition: cleanText(plan.projected_feasibility_review.disposition, 40) || null,
          confidence: plan.projected_feasibility_review.confidence != null
            && Number.isFinite(Number(plan.projected_feasibility_review.confidence))
            ? Number(plan.projected_feasibility_review.confidence)
            : null,
          reviewed_at_utc: cleanText(plan.projected_feasibility_review.reviewed_at_utc, 80) || null,
          summary: cleanText(plan.projected_feasibility_review.summary, 5_000) || null,
          cross_rubric_conflicts: (Array.isArray(plan.projected_feasibility_review.cross_rubric_conflicts)
            ? plan.projected_feasibility_review.cross_rubric_conflicts
            : [])
            .slice(0, 30)
            .map((item) => cleanText(item, 2_000))
            .filter(Boolean),
          task_level_risks: (Array.isArray(plan.projected_feasibility_review.task_level_risks)
            ? plan.projected_feasibility_review.task_level_risks
            : [])
            .slice(0, 30)
            .map((item) => cleanText(item, 2_000))
            .filter(Boolean),
          error: plan.projected_feasibility_review.error == null
            ? null
            : cleanText(plan.projected_feasibility_review.error, 8_000),
        }
      : null,
    projected_quality_review: plan.projected_quality_review
      && typeof plan.projected_quality_review === "object"
      && !Array.isArray(plan.projected_quality_review)
      ? {
          status: cleanText(plan.projected_quality_review.status, 40) || null,
          review: llmQualityReviewFromReview({
            manager_review: { quality_review: plan.projected_quality_review.review },
          }),
          error: plan.projected_quality_review.error == null
            ? null
            : cleanText(plan.projected_quality_review.error, 8_000),
        }
      : null,
    projected_task_status: cleanText(plan.projected_task_status, 40) || null,
  };
}

export function llmRubricResultsFromReview(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) return [];
  const outcomes = Array.isArray(review.rubric_reviews) ? review.rubric_reviews : [];
  const assessments = new Map(
    (Array.isArray(review.manager_review?.rubric_assessments) ? review.manager_review.rubric_assessments : [])
      .map((item) => [String(item?.rubric_id || ""), item])
  );
  const feedback = new Map((llmFeedbackFromReview(review)?.rubrics ?? []).map((item) => [item.rubric_id, item.feedback]));
  const repairs = new Map((llmRepairPlanFromReview(review)?.rubric_repairs ?? []).map((item) => [item.rubric_id, item]));
  const qualityAssessments = new Map(
    (Array.isArray(review.manager_review?.quality_review?.rubric_assessments)
      ? review.manager_review.quality_review.rubric_assessments
      : [])
      .map((item) => [String(item?.rubric_id || ""), item])
  );
  return outcomes.slice(0, 100).map((outcome) => {
    const rubricId = cleanText(outcome?.rubric_id, 100);
    const assessment = assessments.get(rubricId);
    const quality = qualityAssessments.get(rubricId);
    const browser = outcome?.browser_review;
    return {
      rubric_id: rubricId,
      effective_verdict: cleanText(outcome?.effective_verdict, 40) || null,
      base_verdict: cleanText(outcome?.review?.verdict, 40) || null,
      browser_status: cleanText(browser?.status, 40) || "NOT_RUN",
      browser_verdict: cleanText(browser?.review?.verdict, 40) || null,
      manager_accepted_verdict: cleanText(assessment?.accepted_worker_verdict, 40) || null,
      manager_note: cleanText(assessment?.manager_note, 3_000) || null,
      quality_verdict: cleanText(quality?.verdict, 40) || null,
      quality_summary: cleanText(quality?.summary, 3_000) || null,
      quality_issues: (Array.isArray(quality?.issues) ? quality.issues : [])
        .slice(0, 20).map((item) => cleanText(item, 1_500)).filter(Boolean),
      feedback: feedback.get(rubricId) ?? null,
      ...(repairs.has(rubricId) ? { repair: repairs.get(rubricId) } : {}),
    };
  }).filter((item) => item.rubric_id);
}

export function llmEvergreenReviewFromReview(review) {
  const evergreen = review?.manager_review?.evergreen_review;
  if (!evergreen || typeof evergreen !== "object" || Array.isArray(evergreen)) return null;
  const verdict = ["NOT_ASSESSED", "EVERGREEN", "NOT_EVERGREEN", "NEEDS_HUMAN_REVIEW"].includes(evergreen.verdict)
    ? evergreen.verdict
    : "NEEDS_HUMAN_REVIEW";
  return {
    verdict,
    summary: cleanText(evergreen.summary, 5_000),
    concerns: Array.isArray(evergreen.concerns)
      ? evergreen.concerns.slice(0, 30).map((item) => cleanText(item, 2_000)).filter(Boolean)
      : [],
  };
}

export function llmQualityReviewFromReview(review) {
  const quality = review?.manager_review?.quality_review;
  if (!quality || typeof quality !== "object" || Array.isArray(quality)) return null;
  const axis = (value, difficulty = false) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
      verdict: cleanText(value.verdict, 40) || "NEEDS_HUMAN_REVIEW",
      ...(difficulty ? { rating: cleanText(value.rating, 40) || "UNJUDGEABLE" } : {}),
      summary: cleanText(value.summary, 3_000) || null,
      concerns: (Array.isArray(value.concerns) ? value.concerns : [])
        .slice(0, 20).map((item) => cleanText(item, 1_500)).filter(Boolean),
    };
  };
  const taskCoherence = axis(quality.task_coherence ?? quality.prompt_quality);
  return {
    overall_verdict: cleanText(quality.overall_verdict, 40) || "NEEDS_HUMAN_REVIEW",
    confidence: Number.isFinite(Number(quality.confidence)) ? Number(quality.confidence) : null,
    summary: cleanText(quality.summary, 5_000) || null,
    task_coherence: taskCoherence,
    prompt_realism: axis(quality.prompt_realism),
    prompt_quality: taskCoherence,
    difficulty: axis(quality.difficulty, true),
  };
}

export function llmReviewForHuman(review, expectedTaskId = "", expectedContentHash = "") {
  if (!review || typeof review !== "object" || Array.isArray(review)) return null;
  const taskId = cleanText(review.task_id, 300);
  const contentHash = cleanText(review.task_content_hash ?? review.source_hash, 128);
  if (expectedTaskId && taskId !== expectedTaskId) return null;
  if (expectedContentHash && contentHash !== expectedContentHash) return null;
  const normalizedResults = new Map(llmRubricResultsFromReview(review).map((item) => [item.rubric_id, item]));
  const rawResults = new Map(
    (Array.isArray(review.rubric_reviews) ? review.rubric_reviews : [])
      .map((item) => [cleanText(item?.rubric_id, 100), item])
  );
  const repairs = new Map((llmRepairPlanFromReview(review)?.rubric_repairs ?? []).map((item) => [item.rubric_id, item]));
  const repairPlan = llmRepairPlanFromReview(review);
  const rubricIds = [...new Set([...rawResults.keys(), ...normalizedResults.keys()].filter(Boolean))];
  return {
    schema_version: "apollo-llm-review-for-human-v1",
    advisory_only: true,
    task_id: taskId,
    task_content_hash: contentHash || null,
    pipeline_version: cleanText(review.pipeline_version, 100) || null,
    reviewed_at_utc: cleanText(review.created_at_utc, 80) || null,
    status: cleanText(review.status, 40) || "NEEDS_HUMAN_REVIEW",
    manager_disposition: cleanText(review.manager_review?.disposition, 40) || null,
    manager_summary: cleanText(review.manager_review?.summary, 5_000) || null,
    task_feedback: llmFeedbackFromReview(review)?.task ?? null,
    quality: llmQualityReviewFromReview(review),
    evergreen: llmEvergreenReviewFromReview(review),
    projected_task_status: cleanText(review.repair_plan?.projected_task_status, 40) || null,
    task_repair: repairPlan?.suggested_task_prompt
      ? {
          suggested_task_prompt: repairPlan.suggested_task_prompt,
          summary: repairPlan.summary,
          preserves_task_flow: repairPlan.preserves_task_flow,
          all_suggested_changes_verified: repairPlan.all_suggested_changes_verified,
        }
      : null,
    rubrics: rubricIds.slice(0, 100).map((rubricId) => {
      const raw = rawResults.get(rubricId);
      const normalized = normalizedResults.get(rubricId);
      const effective = raw?.browser_review?.status === "COMPLETED" && raw?.browser_review?.review
        ? raw.browser_review.review
        : raw?.review;
      return {
        rubric_id: rubricId,
        verdict: normalized?.effective_verdict ?? (cleanText(raw?.effective_verdict, 40) || "WORKER_ERROR"),
        summary: cleanText(effective?.summary, 5_000) || null,
        feedback: normalized?.feedback ?? null,
        quality_verdict: normalized?.quality_verdict ?? null,
        quality_summary: normalized?.quality_summary ?? null,
        quality_issues: normalized?.quality_issues ?? [],
        blockers: (Array.isArray(effective?.blockers) ? effective.blockers : [])
          .slice(0, 20).map((item) => cleanText(item, 1_000)).filter(Boolean),
        evidence: (Array.isArray(effective?.evidence) ? effective.evidence : [])
          .slice(0, 12).map((source) => ({
            url: cleanText(source?.url, 4_000),
            title: cleanText(source?.title, 500),
            supports: cleanText(source?.supports, 2_000),
          })).filter((source) => source.url),
        repair: repairs.get(rubricId) ?? null,
      };
    }),
  };
}

const TRAJECTORY_HUMAN_VERDICTS = new Set(["SUCCESS", "FAILURE", "UNJUDGEABLE"]);
const TRAJECTORY_OVERALL_OUTCOMES = new Set(["YES", "NO", "EDIT_NEEDED", "NEEDS_RERUN"]);

export function trajectoryOverallOutcome(trajectory) {
  if (!trajectory || typeof trajectory !== "object" || Array.isArray(trajectory)) return "";
  const current = cleanText(trajectory.overall_outcome, 30).toUpperCase();
  if (TRAJECTORY_OVERALL_OUTCOMES.has(current)) return current;
  const taskSatisfied = cleanText(trajectory.task_satisfied, 30).toUpperCase();
  if (taskSatisfied === "SUCCESS") return "YES";
  if (taskSatisfied === "FAILURE") return "NO";
  if (taskSatisfied === "UNJUDGEABLE") return "NEEDS_RERUN";
  const legacyOutcome = cleanText(trajectory.outcome, 50).toUpperCase();
  if (legacyOutcome === "MODEL_SUCCEEDED") return "YES";
  if (legacyOutcome === "REAL_MODEL_FAILURE") return "NO";
  if (legacyOutcome === "TASK_OR_RUBRIC_BROKEN") return "EDIT_NEEDED";
  if (legacyOutcome === "TRAJECTORY_INSUFFICIENT") return "NEEDS_RERUN";
  return "";
}

function legacyTaskSatisfiedForOutcome(outcome) {
  if (outcome === "YES") return "SUCCESS";
  if (outcome === "NO" || outcome === "EDIT_NEEDED") return "FAILURE";
  return "UNJUDGEABLE";
}

export function cleanTrajectoryManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  if (manifest.schema_version !== "apollo-trajectory-review-package-v1") return null;
  if (JSON.stringify(manifest).length > 4_000_000) return null;
  if (!Array.isArray(manifest.rubrics) || manifest.rubrics.length < 1 || manifest.rubrics.length > 100) return null;
  if (!Array.isArray(manifest.steps) || manifest.steps.length < 1 || manifest.steps.length > 500) return null;
  const runId = cleanText(manifest.run_id, 120);
  const taskId = cleanText(manifest.task_id, 300);
  const taskPrompt = cleanText(manifest.task_prompt, 200_000);
  if (!runId || !taskId || !taskPrompt) return null;
  const requestedCreatorPid = cleanText(manifest.creator_pid, 80).toLowerCase();
  const creatorPid = VALID_PID.test(requestedCreatorPid)
    ? requestedCreatorPid
    : participantIdFromTrajectoryTaskId(taskId);
  const rubrics = manifest.rubrics.map((rubric) => {
    const rawStatus = cleanText(rubric?.llm_status, 20).toUpperCase();
    const llmStatus = ["SUCCESS", "FAILURE", "ERROR"].includes(rawStatus)
      ? rawStatus
      : (rubric?.llm_success === true || Number(rubric?.llm_score) === 1 ? "SUCCESS" : "FAILURE");
    const llmScore = llmStatus === "ERROR" ? null : (llmStatus === "SUCCESS" ? 1 : 0);
    return {
      rubric_id: cleanText(rubric?.rubric_id, 100),
      requirement: cleanText(rubric?.requirement, 30_000),
      verification: cleanText(rubric?.verification, 20_000),
      llm_status: llmStatus,
      llm_score: llmScore,
      llm_success: llmScore == null ? null : llmScore === 1,
      llm_reasoning: cleanText(rubric?.llm_reasoning, 30_000),
    };
  }).filter((rubric) => rubric.rubric_id && rubric.requirement);
  const rubricIds = rubrics.map((rubric) => rubric.rubric_id);
  if (!rubrics.length || new Set(rubricIds).size !== rubricIds.length) return null;
  const steps = manifest.steps.map((step, index) => {
    const asset = step?.screenshot_path == null ? null : cleanText(step.screenshot_path, 1_000);
    const safeAsset = asset && !asset.startsWith("/") && !asset.split("/").includes("..") ? asset : null;
    return {
      index,
      step_number: Number.isFinite(Number(step?.step_number)) ? Number(step.step_number) : index + 1,
      action: cleanText(step?.action, 20_000),
      response: cleanText(step?.response, 50_000),
      final: step?.final === true,
      screenshot_path: safeAsset,
    };
  });
  if (!steps.length) return null;
  return {
    schema_version: "apollo-trajectory-review-package-v1",
    run_id: runId,
    task_id: taskId,
    creator_pid: creatorPid || null,
    task_prompt: taskPrompt,
    created_at_utc: cleanText(manifest.created_at_utc, 80) || null,
    source: {
      evaluator_format: cleanText(manifest.source?.evaluator_format, 120) || null,
      source_result_sha256: cleanText(manifest.source?.source_result_sha256, 128) || null,
      run_directory_name: cleanText(manifest.source?.run_directory_name, 500) || null,
      trajectory_filename: cleanText(manifest.source?.trajectory_filename, 100) || null,
      agent: cleanText(manifest.source?.agent, 120) || null,
      model: cleanText(manifest.source?.model, 160) || null,
      run_label: cleanText(manifest.source?.run_label, 240) || null,
    },
    metrics: {
      num_steps: steps.length,
      num_screenshots: steps.filter((step) => step.screenshot_path).length,
      average_rubric_score: Number.isFinite(Number(manifest.metrics?.average_rubric_score))
        ? Number(manifest.metrics.average_rubric_score)
        : (() => {
          const judged = rubrics.filter((rubric) => rubric.llm_score != null);
          return judged.length ? judged.reduce((sum, rubric) => sum + rubric.llm_score, 0) / judged.length : 0;
        })(),
      perfect: rubrics.every((rubric) => rubric.llm_success === true),
      judge_errors: rubrics.filter((rubric) => rubric.llm_status === "ERROR").length,
    },
    rubrics,
    steps,
  };
}

export function trajectoryManifestForHuman(manifest) {
  const clean = cleanTrajectoryManifest(manifest);
  if (!clean) return null;
  return {
    ...clean,
    metrics: {
      num_steps: clean.metrics.num_steps,
      num_screenshots: clean.metrics.num_screenshots,
    },
    rubrics: clean.rubrics.map((rubric) => ({
      rubric_id: rubric.rubric_id,
      requirement: rubric.requirement,
      verification: rubric.verification,
    })),
  };
}

// The Grade stage is creator-assigned: the author grades a run of their OWN
// task. Reviewers may have edited the title/request/rubrics before the run,
// so the grader shows those edits inline (original vs what actually ran).
// Pure shaping of an admin item (see buildAdminItemFromDocuments) into the
// minimal, provenance-free lineage the grader needs.
export function trajectoryTaskLineageForHuman(item) {
  if (!item || typeof item !== "object" || !item.original) return null;
  const original = item.original;
  const final = item.final ?? null;
  const field = (before, after) => {
    const from = String(before ?? "");
    const to = final ? String(after ?? "") : from;
    return { original: from, final: to, changed: from !== to };
  };
  const title = field(original.title, final?.title);
  const request = field(original.request, final?.request);
  const rubrics = (Array.isArray(item.rubrics) ? item.rubrics : []).map((rubric) => {
    const before = rubric?.original == null ? null : String(rubric.original);
    const after = String(rubric?.final ?? "");
    return {
      rubric_id: cleanText(rubric?.rubric_id, 100),
      title: rubric?.title == null ? null : cleanText(rubric.title, 200),
      original: before,
      final: after,
      changed: Boolean(final) && Boolean(rubric?.changed) && before !== after,
    };
  });
  const changed = title.changed || request.changed || rubrics.some((rubric) => rubric.changed);
  return {
    task_id: cleanText(item.task_id, 300),
    status: cleanText(item.status, 30) || "pending",
    reviewer: cleanText(item.reviewer, 160),
    reviewed_at: cleanText(item.reviewed_at, 60),
    revision_of_task_id: cleanText(item.revision_of_task_id, 300) || null,
    changed,
    title,
    request,
    rubrics,
  };
}

// Locate the authored source + reviewed outcome for a trajectory's task:
// Dynamo index first, then the S3 submission directory (newest long_task.json
// is the one the queue considered, mirroring task-directory dedupe).
export async function trajectoryTaskLineage(taskId) {
  const cleanId = cleanText(taskId, 300);
  if (!cleanId) return null;
  try {
    const indexed = await indexedAdminDetail(cleanId);
    if (indexed) return trajectoryTaskLineageForHuman(await withRevisionLink(indexed));
  } catch (error) {
    console.error("Trajectory lineage index lookup failed; falling back to S3", error);
  }
  const pid = participantIdFromTrajectoryTaskId(cleanId);
  if (!pid) return null;
  const candidates = (await listAllObjects(`${UPLOAD_PREFIX}${pid}/${cleanId}/`))
    .filter((object) => /(^|\/)[^/]*long_task\.json$/.test(object.Key))
    .sort((a, b) => new Date(b.LastModified).getTime() - new Date(a.LastModified).getTime());
  const sourceKey = candidates[0]?.Key;
  if (!sourceKey) return null;
  const source = await readJson(sourceKey).then(({ json }) => json).catch(() => null);
  if (!source) return null;
  const finishedKey = `${REVIEW_PREFIX}finished/${cleanId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
  const outcome = await readJson(finishedKey).then(({ json }) => json).catch(() => null);
  const done = outcome
    ? { target: finishedKey, outcome: "approved", reviewer: outcome.reviewed_by, completed_at: outcome.finished_at, task_id: cleanId }
    : null;
  const item = buildAdminItemFromDocuments({ source, sourceKey, done, lock: null, outcome });
  return trajectoryTaskLineageForHuman(await withRevisionLink(item, source));
}

// Earlier graded runs of the same task (and of the task it revises), so the
// creator can see how the previous trajectory was graded against the rubric
// as it read then. Pure shaping, unit-tested; the S3 walk is below.
export function priorTrajectoryGradeForHuman(manifest, judgment) {
  const clean = cleanTrajectoryManifest(manifest);
  if (!clean || !judgment || typeof judgment !== "object") return null;
  const verdictById = new Map((Array.isArray(judgment.rubrics) ? judgment.rubrics : [])
    .map((rubric) => [String(rubric?.rubric_id || ""), rubric]));
  return {
    run_id: clean.run_id,
    task_id: clean.task_id,
    created_at_utc: clean.created_at_utc,
    agent: clean.source.agent,
    model: clean.source.model,
    task_prompt: clean.task_prompt,
    graded_by: cleanText(judgment.reviewed_by, 160),
    graded_at: cleanText(judgment.reviewed_at, 60),
    overall_outcome: trajectoryOverallOutcome(judgment.trajectory),
    notes: cleanText(judgment.trajectory?.notes, 20_000),
    rubrics: clean.rubrics.map((rubric) => {
      const human = verdictById.get(rubric.rubric_id);
      return {
        rubric_id: rubric.rubric_id,
        requirement: rubric.requirement,
        verification: rubric.verification,
        human_verdict: cleanText(human?.human_verdict, 30).toUpperCase() || "",
        notes: cleanText(human?.notes, 20_000),
      };
    }),
  };
}

async function priorTrajectoryGrades(run, lineage, limit = 3) {
  const taskIds = [...new Set([run?.task_id, lineage?.revision_of_task_id].filter(Boolean))];
  const found = [];
  for (const taskId of taskIds) {
    const prefix = `${TRAJECTORY_RUNS_PREFIX}${b64url(taskId)}/`;
    const manifestKeys = (await listAll(prefix)).filter((key) => key.endsWith("/manifest.json") && key.split("/").length === prefix.split("/").length + 1);
    await Promise.all(manifestKeys.map(async (manifestKey) => {
      const done = await readDoneRecord(manifestKey, trajectoryDoneKeyFor);
      if (!done?.target) return;
      const [manifest, judgment] = await Promise.all([
        readJson(manifestKey).then(({ json }) => json).catch(() => null),
        readJson(done.target).then(({ json }) => json).catch(() => null),
      ]);
      const shaped = priorTrajectoryGradeForHuman(manifest, judgment);
      if (shaped && shaped.run_id !== run?.run_id) found.push(shaped);
    }));
  }
  found.sort((a, b) => String(b.graded_at).localeCompare(String(a.graded_at)));
  return found.slice(0, limit);
}

async function withRevisionLink(item, source = null) {
  if (!item) return item;
  const workflow = source?.workflow
    ?? (item.source_key ? await readJson(item.source_key).then(({ json }) => json?.workflow).catch(() => null) : null);
  return workflow?.kind === "trajectory_edit"
    ? { ...item, revision_of_task_id: workflow.revision_of_task_id }
    : item;
}

export function sanitizeHumanTrajectoryJudgment(input, manifest) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("judgment must be an object");
  const cleanManifest = cleanTrajectoryManifest(manifest);
  if (!cleanManifest) throw new Error("trajectory manifest is invalid");
  const trajectory = input.trajectory;
  if (!trajectory || typeof trajectory !== "object") throw new Error("overall trajectory judgment is required");
  const usesCurrentOutcome = Object.prototype.hasOwnProperty.call(trajectory, "overall_outcome");
  const explicitOutcome = cleanText(trajectory.overall_outcome, 30).toUpperCase();
  const overallOutcome = usesCurrentOutcome ? explicitOutcome : trajectoryOverallOutcome(trajectory);
  if (!overallOutcome) {
    throw new Error("overall outcome must be YES, NO, EDIT_NEEDED, or NEEDS_RERUN");
  }
  if (!TRAJECTORY_OVERALL_OUTCOMES.has(overallOutcome)) {
    throw new Error("overall outcome must be YES, NO, EDIT_NEEDED, or NEEDS_RERUN");
  }
  const notes = cleanText(trajectory.notes, 20_000);
  if (usesCurrentOutcome && ["EDIT_NEEDED", "NEEDS_RERUN"].includes(overallOutcome) && notes.trim().length < 10) {
    throw new Error("edit-needed and rerun outcomes require at least 10 characters of follow-up notes");
  }
  const rawRubrics = Array.isArray(input.rubrics) ? input.rubrics : [];
  const byId = new Map(rawRubrics.map((rubric) => [cleanText(rubric?.rubric_id, 100), rubric]));
  if (byId.size !== cleanManifest.rubrics.length) throw new Error("every rubric must have one human judgment");
  const rubrics = cleanManifest.rubrics.map((rubric) => {
    const raw = byId.get(rubric.rubric_id);
    const humanVerdict = cleanText(raw?.human_verdict, 30);
    if (!TRAJECTORY_HUMAN_VERDICTS.has(humanVerdict)) throw new Error(`rubric ${rubric.rubric_id} needs a trajectory verdict`);
    const humanSuccess = humanVerdict === "UNJUDGEABLE" ? null : humanVerdict === "SUCCESS";
    return {
      rubric_id: rubric.rubric_id,
      human_verdict: humanVerdict,
      llm_judge_correct: humanSuccess == null || rubric.llm_success == null
        ? null
        : humanSuccess === rubric.llm_success,
      notes: cleanText(raw?.notes, 10_000),
    };
  });
  return {
    schema_version: "apollo-human-trajectory-judgment-v3",
    task_id: cleanManifest.task_id,
    run_id: cleanManifest.run_id,
    rubrics,
    trajectory: {
      overall_outcome: overallOutcome,
      // Kept so existing reporting consumers can migrate without losing the
      // previous three-way task-satisfaction signal.
      task_satisfied: legacyTaskSatisfiedForOutcome(overallOutcome),
      notes,
    },
  };
}

export function trajectoryEditReviewSeed(manifestKey, manifest, judgment, createdAt = new Date().toISOString()) {
  const cleanManifest = cleanTrajectoryManifest(manifest);
  const outcome = trajectoryOverallOutcome(judgment?.trajectory);
  if (!cleanManifest || outcome !== "EDIT_NEEDED" || !cleanManifest.creator_pid) return null;
  const suffix = createHash("sha256").update(String(manifestKey)).digest("hex").slice(0, 16);
  const isPc = REVIEW_PREFIX.startsWith("pc-review/");
  const taskId = isPc
    ? `pc_task-${suffix}`
    : `v2/${cleanManifest.creator_pid}/internal/task-${suffix}-trajectory-edit`;
  const sourceKey = isPc
    ? `${UPLOAD_PREFIX}${cleanManifest.creator_pid}/pc/${cleanManifest.creator_pid}/internal/bundle-${suffix}/trajectory_rework_review_task_task-${suffix}.json`
    : `${UPLOAD_PREFIX}${cleanManifest.creator_pid}/${taskId}/trajectory_rework_long_task.json`;
  return {
    taskId,
    sourceKey,
    source: {
      schema_version: "odyssey_long_task_v2",
      task_id: taskId,
      mode: isPc ? "pc" : "guided",
      created_at: createdAt,
      participant: {
        kind: "internal",
        participant_id: cleanManifest.creator_pid,
        session_id: null,
        name: null,
        email: null,
        consent: { version: "trajectory-edit-v1", accepted_at: createdAt },
      },
      task: {
        task_title: "Trajectory feedback revision",
        agent_request: cleanManifest.task_prompt,
        difficulty: "high",
        site_scope: [],
        success_criteria: [],
        must_visit_or_reach: [],
        required_outputs: [],
        notes: null,
        steps: cleanManifest.rubrics.map((rubric, index) => ({
          order: index + 1,
          title: `Step ${index + 1}`,
          description: rubric.requirement,
        })),
      },
      workflow: {
        kind: "trajectory_edit",
        revision_of_task_id: cleanManifest.task_id,
        source_manifest_key: String(manifestKey),
        run_id: cleanManifest.run_id,
        requested_by: "trajectory_creator_grade",
        reason: cleanText(judgment?.trajectory?.notes, 20_000),
      },
    },
  };
}

async function enqueueTrajectoryEditReview(manifestKey, manifest, judgment, judgmentKey, createdAt) {
  const seed = trajectoryEditReviewSeed(manifestKey, manifest, judgment, createdAt);
  if (!seed) return null;
  const created = await tryConditionalWrite(() => s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: seed.sourceKey,
    Body: JSON.stringify(seed.source, null, 2),
    ContentType: "application/json",
    IfNoneMatch: "*",
  })));
  if (!created) {
    const existing = await readJson(seed.sourceKey).then(({ json }) => json).catch(() => null);
    if (!existing || existing.workflow?.source_manifest_key !== manifestKey) {
      throw new Error("A different trajectory edit request already uses this revision key");
    }
  }
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: inboxKeyFor(seed.sourceKey),
    Body: seed.sourceKey,
    ContentType: "text/plain",
  }));
  await tryConditionalWrite(() => s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: `${TRAJECTORY_EDIT_LINKS_PREFIX}${b64url(manifestKey)}.json`,
    Body: JSON.stringify({
      source_manifest_key: manifestKey,
      judgment_key: judgmentKey,
      revision_task_id: seed.taskId,
      revision_source_key: seed.sourceKey,
      created_at: createdAt,
    }, null, 2),
    ContentType: "application/json",
    IfNoneMatch: "*",
  })));
  return { task_id: seed.taskId, source_key: seed.sourceKey };
}

export function summarizeAdminUsers(items) {
  const users = new Map();
  for (const item of items) {
    const key = item.participant_id || "redacted";
    const current = users.get(key) ?? {
      participant_id: key,
      name: item.participant_name || (key === "redacted" ? "Anonymous / redacted" : key),
      email: item.participant_email || "",
      submitted: 0,
      pending: 0,
      in_review: 0,
      approved: 0,
      rejected: 0,
      decided: 0,
      approval_rate: null,
      qc_edited_approvals: 0,
      qc_edit_rate: null,
      qc_edited_author_accepted: 0,
      qc_edited_author_amended: 0,
      qc_edited_awaiting_signoff: 0,
      author_accepted_approvals: 0,
      author_amended_approvals: 0,
      awaiting_signoff: 0,
      author_amend_rate: null,
      appealed: 0,
      double_rejected: 0,
      author_requeues: 0,
    };
    current.submitted += 1;
    if (item.status in current) current[item.status] += 1;
    if (item.status === "approved") {
      const changedInQc = item.changed_in_qc == null ? Boolean(item.changed) : Boolean(item.changed_in_qc);
      if (changedInQc) current.qc_edited_approvals += 1;
      if (item.signoff_action === "accepted") {
        current.author_accepted_approvals += 1;
        if (changedInQc) current.qc_edited_author_accepted += 1;
      } else if (item.signoff_action === "amended") {
        current.author_amended_approvals += 1;
        if (changedInQc) current.qc_edited_author_amended += 1;
      } else {
        current.awaiting_signoff += 1;
        if (changedInQc) current.qc_edited_awaiting_signoff += 1;
      }
    }
    const appealNumber = Math.max(0, Math.floor(Number(item.appeal_number) || 0));
    if (appealNumber > 0) current.appealed += 1;
    if (appealNumber > 0 && item.status === "rejected") current.double_rejected += 1;
    current.author_requeues += Math.max(0, Math.floor(Number(item.author_requeue_count) || 0));
    users.set(key, current);
  }
  return [...users.values()]
    .map((user) => {
      const decided = user.approved + user.rejected;
      const signedOff = user.author_accepted_approvals + user.author_amended_approvals;
      return {
        ...user,
        decided,
        approval_rate: decided ? Number((user.approved / decided).toFixed(3)) : null,
        qc_edit_rate: user.approved ? Number((user.qc_edited_approvals / user.approved).toFixed(3)) : null,
        author_amend_rate: signedOff ? Number((user.author_amended_approvals / signedOff).toFixed(3)) : null,
      };
    })
    .sort((a, b) => b.submitted - a.submitted || a.name.localeCompare(b.name));
}

export function dashboardIndexScope(reviewPrefix = REVIEW_PREFIX) {
  const prefix = String(reviewPrefix || "").replace(/^\/+|\/+$/g, "");
  if (prefix === "v2-review") return "v2";
  if (prefix === "pc-review") return "pc";
  return prefix.replace(/[^a-z0-9_-]/gi, "-").toLowerCase() || "unknown";
}

export function taskIdFromSubmissionKey(subKey) {
  const raw = String(subKey || "");
  const match = /\/(v2\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/internal\/task-[A-Za-z0-9-]{8,80})\//.exec(raw);
  return match?.[1] ?? null;
}

function effectiveIndexedStatus(record, now = Date.now()) {
  if (record?.status !== "in_review") return record?.status || "pending";
  const expiresAt = Date.parse(String(record.lock_expires_at || ""));
  return Number.isFinite(expiresAt) && expiresAt > now ? "in_review" : "pending";
}

export function buildDashboardIndexRecord(item, scope = dashboardIndexScope(), indexedAt = new Date().toISOString()) {
  if (!item?.task_id || !item?.source_key) return null;
  return {
    scope,
    entity_key: `TASK#${item.task_id}`,
    entity_type: "TASK",
    task_id: item.task_id,
    source_key: item.source_key,
    review_unit: item.review_unit || reviewUnitForKey(item.source_key),
    done_target: item.done_target || null,
    participant_id: item.participant_id || "unknown",
    participant_name: item.participant_name || item.participant_id || "Unknown",
    participant_email: item.participant_email || "",
    mode: item.mode || "unknown",
    submitted_at: item.submitted_at || "",
    status: item.status || "pending",
    reviewer: item.reviewer || "",
    reviewed_at: item.reviewed_at || "",
    claimed_at: item.claimed_at || "",
    rejection_reason: item.rejection_reason || "",
    trajectory_count: Number(item.trajectory_count) || 0,
    visit_count: Number(item.visit_count) || 0,
    changed: Boolean(item.changed),
    changed_in_qc: item.changed_in_qc == null ? Boolean(item.changed) : Boolean(item.changed_in_qc),
    amended_by: item.amended_by || "",
    amended_at: item.amended_at || "",
    final_gold_revision: Number(item.final_gold_revision) || 0,
    signoff_at: item.signoff_at || "",
    signoff_action: item.signoff_action || "",
    signoff_opened_at: item.signoff_opened_at || "",
    appeal_number: Math.max(0, Math.floor(Number(item.appeal_number) || 0)),
    author_revision_number: Math.max(0, Math.floor(Number(item.author_revision_number) || 0)),
    author_requeue_count: Math.max(0, Math.floor(Number(item.author_requeue_count) || 0)),
    author_requeued_at: item.author_requeued_at || "",
    original_title: item.original?.title || "",
    original_difficulty: item.original?.difficulty || "high",
    original_region: item.original?.metadata?.region || "",
    original_subjects: Array.isArray(item.original?.metadata?.subjects) ? item.original.metadata.subjects.slice(0, 3) : [],
    final_title: item.final?.title || "",
    final_difficulty: item.final?.difficulty || "",
    final_region: item.final?.metadata?.region || "",
    final_subjects: Array.isArray(item.final?.metadata?.subjects) ? item.final.metadata.subjects.slice(0, 3) : [],
    task_content_hash: item.task_content_hash || "",
    lock_expires_at: item.lock_expires_at || null,
    indexed_at: indexedAt,
  };
}

export function dashboardSubmissionFromIndexRecord(record, now = Date.now()) {
  const status = effectiveIndexedStatus(record, now);
  const inReview = status === "in_review";
  return {
    task_id: record.task_id,
    participant_id: record.participant_id || "unknown",
    participant_name: record.participant_name || record.participant_id || "Unknown",
    participant_email: record.participant_email || "",
    mode: record.mode || "unknown",
    submitted_at: record.submitted_at || "",
    status,
    reviewer: inReview || status === "approved" || status === "rejected" ? record.reviewer || "" : "",
    reviewed_at: record.reviewed_at || "",
    claimed_at: record.claimed_at || "",
    rejection_reason: status === "rejected" ? record.rejection_reason || "" : "",
    trajectory_count: Number(record.trajectory_count) || 0,
    visit_count: Number(record.visit_count) || 0,
    changed: Boolean(record.changed),
    changed_in_qc: record.changed_in_qc == null ? Boolean(record.changed) : Boolean(record.changed_in_qc),
    amended_by: record.amended_by || "",
    amended_at: record.amended_at || "",
    final_gold_revision: Number(record.final_gold_revision) || 0,
    signoff_at: record.signoff_at || "",
    signoff_action: record.signoff_action || "",
    signoff_opened_at: record.signoff_opened_at || "",
    appeal_number: Math.max(0, Math.floor(Number(record.appeal_number) || 0)),
    author_revision_number: Math.max(0, Math.floor(Number(record.author_revision_number) || 0)),
    author_requeue_count: Math.max(0, Math.floor(Number(record.author_requeue_count) || 0)),
    author_requeued_at: record.author_requeued_at || "",
    source_key: record.source_key,
    review_unit: record.review_unit,
    done_target: record.done_target || null,
    lock_expires_at: inReview ? record.lock_expires_at || null : null,
    original: {
      title: record.original_title || "",
      request: "",
      difficulty: record.original_difficulty || "high",
      criteria: [],
      steps: [],
      ...((record.original_region || record.original_subjects?.length)
        ? {
            metadata: {
              region: record.original_region || "",
              subjects: Array.isArray(record.original_subjects) ? record.original_subjects : [],
            },
          }
        : {}),
    },
    final: record.final_title || record.final_difficulty ? {
      title: record.final_title || "",
      request: "",
      difficulty: record.final_difficulty || record.original_difficulty || "high",
      criteria: [],
      steps: [],
      ...((record.final_region || record.final_subjects?.length || record.original_region || record.original_subjects?.length)
        ? {
            metadata: {
              region: record.final_region || record.original_region || "",
              subjects: Array.isArray(record.final_subjects) && record.final_subjects.length
                ? record.final_subjects
                : Array.isArray(record.original_subjects) ? record.original_subjects : [],
            },
          }
        : {}),
    } : null,
  };
}

export function dashboardFromIndexRecords(records, now = Date.now()) {
  const items = (Array.isArray(records) ? records : [])
    .filter((record) => record?.entity_type === "TASK")
    .map((record) => dashboardSubmissionFromIndexRecord(record, now))
    .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)) || a.task_id.localeCompare(b.task_id));
  return {
    items,
    users: summarizeAdminUsers(items),
    truncated: false,
    total: items.length,
    index_source: "dynamodb",
  };
}

// Reviewer-quality rollup for the executive dashboard. A reviewer who approves
// everything untouched, or moves implausibly fast, is flagged so their
// approvals can be re-queued for a second opinion (see reopenReviewOutcome).
export const REVIEWER_FLAG_MIN_REVIEWS = 10;
export const REVIEWER_FAST_REVIEW_MINUTES = 3;
export function summarizeAdminReviewers(items, now = Date.now()) {
  const byReviewer = new Map();
  for (const item of items ?? []) {
    if (!["approved", "rejected"].includes(item?.status) || !item.reviewer) continue;
    const key = String(item.reviewer).trim();
    if (!key) continue;
    const current = byReviewer.get(key) ?? {
      reviewer: key,
      reviewed: 0,
      approved: 0,
      rejected: 0,
      edited_approvals: 0,
      unedited_approvals: 0,
      reviewed_at: [],
      first_reviewed_at: "",
      last_reviewed_at: "",
    };
    current.reviewed += 1;
    if (item.status === "approved") {
      current.approved += 1;
      if (item.changed_in_qc == null ? item.changed : item.changed_in_qc) current.edited_approvals += 1;
      else current.unedited_approvals += 1;
    } else {
      current.rejected += 1;
    }
    const at = Date.parse(String(item.reviewed_at || ""));
    if (Number.isFinite(at)) {
      current.reviewed_at.push(at);
      if (!current.first_reviewed_at || at < Date.parse(current.first_reviewed_at)) current.first_reviewed_at = new Date(at).toISOString();
      if (!current.last_reviewed_at || at > Date.parse(current.last_reviewed_at)) current.last_reviewed_at = new Date(at).toISOString();
    }
    byReviewer.set(key, current);
  }
  const out = [...byReviewer.values()].map((entry) => {
    // Gap between consecutive decisions within one sitting (<2h) approximates
    // time spent per task; the claim time itself is not persisted.
    const times = entry.reviewed_at.sort((a, b) => a - b);
    const gaps = [];
    for (let index = 1; index < times.length; index += 1) {
      const minutes = (times[index] - times[index - 1]) / 60_000;
      if (minutes >= 0 && minutes < 120) gaps.push(minutes);
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    const medianGap = sorted.length
      ? sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : null;
    const fastShare = gaps.length ? gaps.filter((gap) => gap < REVIEWER_FAST_REVIEW_MINUTES).length / gaps.length : null;
    const rejectRate = entry.reviewed ? entry.rejected / entry.reviewed : 0;
    const editRate = entry.approved ? entry.edited_approvals / entry.approved : 0;
    const flags = [];
    if (entry.reviewed >= REVIEWER_FLAG_MIN_REVIEWS) {
      if (entry.rejected === 0) flags.push("no_rejections");
      if (entry.approved >= REVIEWER_FLAG_MIN_REVIEWS && editRate < 0.25) flags.push("rarely_edits");
      if (gaps.length >= 5 && medianGap !== null && medianGap < REVIEWER_FAST_REVIEW_MINUTES) flags.push("fast");
    }
    const { reviewed_at: _times, ...rest } = entry;
    return {
      ...rest,
      reject_rate: Number(rejectRate.toFixed(3)),
      edit_rate: Number(editRate.toFixed(3)),
      median_gap_minutes: medianGap === null ? null : Number(medianGap.toFixed(1)),
      fast_share: fastShare === null ? null : Number(fastShare.toFixed(3)),
      flags,
      suspicious: flags.length >= 2 || flags.includes("fast"),
    };
  });
  out.sort((a, b) => Number(b.suspicious) - Number(a.suspicious) || b.reviewed - a.reviewed || a.reviewer.localeCompare(b.reviewer));
  return out;
}

// Re-queue markers: `reopen/{b64url(reviewUnit)}/{b64url(reviewer lowercased)}`
// (zero-byte). A task re-queued by an admin is never handed back to the
// reviewer whose decision was revoked.
const REVIEW_SKIPS_PREFIX = `${REVIEW_PREFIX}skips/`;
const reviewSkipMarkerKeyFor = (subKey, reviewer, at = Date.now()) =>
  `${REVIEW_SKIPS_PREFIX}${b64url(reviewUnitForKey(subKey))}/${at}-${b64url(normalizeReviewerName(reviewer) || "unknown")}`;
export function reviewSkipCountsFromKeys(keys, prefix = REVIEW_SKIPS_PREFIX) {
  const counts = new Map(); // review unit -> { count, reviewers[] }
  for (const key of keys ?? []) {
    if (!String(key).startsWith(prefix)) continue;
    const [unitPart, markerPart] = String(key).slice(prefix.length).split("/");
    if (!unitPart || !markerPart) continue;
    try {
      const unit = fromB64url(unitPart);
      const reviewer = fromB64url(markerPart.slice(markerPart.indexOf("-") + 1));
      const entry = counts.get(unit) ?? { count: 0, reviewers: [] };
      entry.count += 1;
      if (reviewer && !entry.reviewers.includes(reviewer)) entry.reviewers.push(reviewer);
      counts.set(unit, entry);
    } catch {
      /* malformed marker */
    }
  }
  return counts;
}
let reviewSkipCache = { counts: null, checkedAt: 0 };
async function reviewSkipCounts() {
  if (reviewSkipCache.counts && Date.now() - reviewSkipCache.checkedAt < 15_000) return reviewSkipCache.counts;
  const counts = reviewSkipCountsFromKeys(await listAll(REVIEW_SKIPS_PREFIX).catch(() => []));
  reviewSkipCache = { counts, checkedAt: Date.now() };
  return counts;
}
const REOPEN_PREFIX = `${REVIEW_PREFIX}reopen/`;
const REOPEN_ARCHIVE_PREFIX = `${REVIEW_PREFIX}reopened/`;
export const normalizeReviewerName = (name) => String(name || "").trim().toLowerCase();
const reopenMarkerKeyFor = (unit, reviewer) => `${REOPEN_PREFIX}${b64url(unit)}/${b64url(normalizeReviewerName(reviewer))}`;
export function reopenExclusionsFromKeys(keys, reopenPrefix = REOPEN_PREFIX) {
  const excluded = new Map(); // review unit -> Set(lowercased reviewer names)
  for (const key of keys ?? []) {
    if (!String(key).startsWith(reopenPrefix)) continue;
    const [unitPart, reviewerPart] = String(key).slice(reopenPrefix.length).split("/");
    if (!unitPart || !reviewerPart) continue;
    try {
      const unit = fromB64url(unitPart);
      const reviewer = fromB64url(reviewerPart);
      if (!excluded.has(unit)) excluded.set(unit, new Set());
      excluded.get(unit).add(reviewer);
    } catch {
      /* malformed marker — ignore */
    }
  }
  return excluded;
}
export function excludeReopenedForReviewer(subKeys, reviewer, exclusions) {
  const name = normalizeReviewerName(reviewer);
  if (!name || !exclusions?.size) return subKeys;
  return subKeys.filter((key) => !exclusions.get(reviewUnitForKey(key))?.has(name));
}

export function pageAdminDashboard(dashboard, options = {}) {
  const query = cleanText(options.query, 240).trim().toLowerCase();
  const participantId = cleanText(options.participant_id, 80).trim().toLowerCase();
  const status = ["pending", "in_review", "approved", "rejected"].includes(options.status)
    ? options.status
    : "";
  const filtered = (dashboard.items ?? []).filter((item) => {
    if (participantId && String(item.participant_id || "").toLowerCase() !== participantId) return false;
    if (status && item.status !== status) return false;
    if (!query) return true;
    return [
      item.task_id,
      item.participant_name,
      item.participant_email,
      item.participant_id,
      item.original?.title,
      item.original?.request,
      item.reviewer,
    ].some((value) => String(value || "").toLowerCase().includes(query));
  });
  const requestedLimit = Math.floor(Number(options.limit) || 50);
  const limit = Math.max(1, Math.min(50, requestedLimit));
  const offset = Math.max(0, Math.min(filtered.length, Math.floor(Number(options.offset) || 0)));
  const items = filtered.slice(offset, offset + limit);
  return {
    ...dashboard,
    reviewers: summarizeAdminReviewers(dashboard.items ?? []),
    distribution_items: (dashboard.items ?? []).map((item) => item.final?.metadata ?? item.original?.metadata ?? {}),
    // List requests should stay small as task prompts and step sets grow.
    // Complete authored content is returned only by the explicit admin detail
    // action when a reviewer opens one row.
    items: items.map((item) => ({
      task_id: item.task_id,
      participant_id: item.participant_id,
      participant_name: item.participant_name,
      participant_email: item.participant_email,
      mode: item.mode,
      submitted_at: item.submitted_at,
      status: item.status,
      reviewer: item.reviewer,
      reviewed_at: item.reviewed_at,
      rejection_reason: item.rejection_reason,
      trajectory_count: item.trajectory_count,
      visit_count: item.visit_count,
      changed: item.changed,
      detail_loaded: false,
      original: {
        title: item.original?.title ?? "",
        request: "",
        difficulty: item.original?.difficulty ?? "",
        criteria: [],
        steps: [],
        ...(item.original?.metadata ? { metadata: item.original.metadata } : {}),
      },
      final: item.final ? {
        title: item.final.title ?? "",
        request: "",
        difficulty: item.final.difficulty ?? "",
        criteria: [],
        steps: [],
        ...(item.final.metadata ? { metadata: item.final.metadata } : {}),
      } : null,
    })),
    filtered_total: filtered.length,
    offset,
    limit,
    next_offset: offset + items.length < filtered.length ? offset + items.length : null,
  };
}

export function summarizePCBundles(bundles) {
  const totals = { bundles: bundles.length, email: 0, calendar: 0, tasks: 0 };
  const users = new Map();
  for (const bundle of bundles) {
    totals.email += bundle.email_count;
    totals.calendar += bundle.calendar_count;
    totals.tasks += bundle.task_count;
    const key = bundle.participant_id || "unknown";
    const current = users.get(key) ?? {
      participant_id: key,
      name: bundle.participant_name || key,
      email: bundle.participant_email || "",
      bundles: 0,
      email_count: 0,
      calendar_count: 0,
      task_count: 0,
    };
    current.bundles += 1;
    current.email_count += bundle.email_count;
    current.calendar_count += bundle.calendar_count;
    current.task_count += bundle.task_count;
    users.set(key, current);
  }
  return {
    totals,
    users: [...users.values()].sort((a, b) => b.bundles - a.bundles || a.name.localeCompare(b.name)),
  };
}

async function pcAdminBundles() {
  const markers = await listAllObjects(`${REVIEW_PREFIX}pc-bundles/`);
  const newestByUnit = new Map();
  for (const marker of markers) {
    try {
      const manifestKey = fromB64url(marker.Key.slice(`${REVIEW_PREFIX}pc-bundles/`.length));
      if (!manifestKey.includes("/pc/") || !manifestKey.endsWith("_manifest.json")) continue;
      const unit = manifestKey.slice(0, manifestKey.lastIndexOf("/"));
      const current = newestByUnit.get(unit);
      if (!current || manifestKey > current) newestByUnit.set(unit, manifestKey);
    } catch {
      /* malformed marker — ignore */
    }
  }
  const manifests = [];
  const keys = [...newestByUnit.values()];
  for (let offset = 0; offset < keys.length; offset += 25) {
    const batch = await Promise.all(keys.slice(offset, offset + 25).map(async (manifestKey) => {
      const manifest = await readJson(manifestKey).then(({ json }) => json).catch(() => null);
      if (!manifest || manifest.schema_version !== "odyssey_personal_context_v1" || !manifest.bundle_id) return null;
      const count = (kind) => (Array.isArray(manifest.parts) ? manifest.parts : [])
        .filter((part) => part?.kind === kind)
        .reduce((sum, part) => sum + (Number(part.record_count) || 0), 0);
      const inlineTasks = Array.isArray(manifest.tasks) ? manifest.tasks.length : 0;
      return {
        manifestKey,
        manifest,
        summary: {
          bundle_id: cleanText(manifest.bundle_id, 180),
          created_at: cleanText(manifest.created_at, 60),
          participant_id: cleanText(manifest.participant?.participant_id || participantIdFromSubKey(manifestKey) || "unknown", 80),
          participant_name: cleanText(manifest.participant?.name || manifest.participant?.participant_id || "Unknown", 160),
          participant_email: cleanText(manifest.participant?.email, 240),
          email_count: count("email"),
          calendar_count: count("calendar"),
          task_count: inlineTasks || count("tasks"),
          edited_count: Number(manifest.redaction?.items_edited) || 0,
          masked_count: Object.values(manifest.redaction?.auto_masks_applied ?? {}).reduce((sum, value) => sum + (Number(value) || 0), 0),
        },
      };
    }));
    manifests.push(...batch.filter(Boolean));
  }
  manifests.sort((a, b) => b.summary.created_at.localeCompare(a.summary.created_at));
  return manifests;
}

const pcEditPrefix = (bundleId, kind) => `${REVIEW_PREFIX}pc-edits/${b64url(bundleId)}/${kind}/`;
const pcEditKey = (bundleId, kind, itemId) => `${pcEditPrefix(bundleId, kind)}${b64url(itemId)}.json`;

function pcItemId(kind, item) {
  if (kind === "tasks") return cleanText(item?.task_id, 180);
  return cleanText(item?.record?.id, 180);
}

export function restrictPCAdminRecord(kind, currentRecord, requestedRecord) {
  const safe = { ...currentRecord };
  if (kind === "email") {
    if (typeof requestedRecord.subject === "string") safe.subject = requestedRecord.subject.slice(0, 10_000);
    if (typeof requestedRecord.body_text === "string") safe.body_text = requestedRecord.body_text.slice(0, 200_000);
  } else if (kind === "calendar") {
    if (typeof requestedRecord.summary === "string") safe.summary = requestedRecord.summary.slice(0, 10_000);
    if (typeof requestedRecord.description === "string") safe.description = requestedRecord.description.slice(0, 200_000);
  }
  safe.id = currentRecord.id;
  return safe;
}

const pcBundleItemCache = new Map();

async function pcBundleItems(bundle, kind) {
  const cacheKey = `${bundle.manifestKey}:${kind}`;
  const cached = pcBundleItemCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 60_000) return cached.items;
  if (kind === "tasks" && Array.isArray(bundle.manifest.tasks) && bundle.manifest.tasks.length) {
    pcBundleItemCache.set(cacheKey, { at: Date.now(), items: bundle.manifest.tasks });
    return bundle.manifest.tasks;
  }
  const parts = (Array.isArray(bundle.manifest.parts) ? bundle.manifest.parts : [])
    .filter((part) => part?.kind === kind && typeof part.filename === "string");
  const dir = bundle.manifestKey.slice(0, bundle.manifestKey.lastIndexOf("/") + 1);
  const objects = await listAllObjects(dir);
  const items = [];
  for (const part of parts) {
    const candidates = objects
      .filter((object) => object.Key.endsWith(`_${part.filename}`))
      .sort((a, b) => b.Key.localeCompare(a.Key));
    let json = null;
    for (const candidate of candidates) {
      const record = await readJson(candidate.Key).catch(() => null);
      if (!record) continue;
      // Current manifests bind every logical part to its exact bytes. This
      // prevents two tabs uploading the same bundle concurrently from mixing
      // one tab's manifest with the other tab's records. Legacy manifests
      // without hashes retain the old newest-file behavior.
      if (!part.sha256 || textContentHash(record.text) === part.sha256) {
        json = record.json;
        break;
      }
    }
    if (kind === "tasks") items.push(...(Array.isArray(json?.tasks) ? json.tasks : []));
    else items.push(...(Array.isArray(json?.records) ? json.records : []));
  }
  pcBundleItemCache.set(cacheKey, { at: Date.now(), items });
  if (pcBundleItemCache.size > 100) pcBundleItemCache.delete(pcBundleItemCache.keys().next().value);
  return items;
}

async function pcEditMap(bundleId, kind) {
  const keys = await listAll(pcEditPrefix(bundleId, kind));
  const reads = await Promise.all(keys.slice(0, 10_000).map((key) => readJson(key).then(({ json }) => json).catch(() => null)));
  return new Map(reads.filter(Boolean).map((edit) => [edit.item_id, edit]));
}

export function buildPCAdminEdit({ existing, sourceRecord, finalRecord, bundleId, kind, itemId, editedBy, editedAt }) {
  const history = Array.isArray(existing?.history) ? existing.history.slice(-19) : [];
  if (existing?.final_record) history.push({ final_record: existing.final_record, edited_by: existing.edited_by, edited_at: existing.edited_at });
  return {
    schema_version: "odyssey_personal_context_admin_edit_v1",
    bundle_id: bundleId,
    kind,
    item_id: itemId,
    original_record: existing?.original_record ?? sourceRecord,
    final_record: { ...finalRecord, id: sourceRecord.id },
    edited_by: editedBy,
    edited_at: editedAt,
    revision_count: pcAdminRevision(existing) + 1,
    history,
  };
}

async function pcAdminDetail(body) {
  const bundleId = cleanText(body.bundle_id, 180);
  const kind = String(body.kind || "");
  if (!bundleId || !["email", "calendar", "tasks"].includes(kind)) {
    return { status: 400, body: { error: "bundle_id and kind (email, calendar, or tasks) required" } };
  }
  const bundles = await pcAdminBundles();
  const bundle = bundles.find((candidate) => candidate.summary.bundle_id === bundleId);
  if (!bundle) return { status: 404, body: { error: "Bundle not found" } };
  const page = Math.max(0, Math.min(10_000, Math.floor(Number(body.page) || 0)));
  const pageSize = Math.max(1, Math.min(100, Math.floor(Number(body.page_size) || 50)));
  const query = cleanText(body.query, 120).trim().toLowerCase();
  let items = await pcBundleItems(bundle, kind);
  if (kind !== "tasks") {
    const edits = await pcEditMap(bundleId, kind);
    items = items.map((item) => {
      const edit = edits.get(pcItemId(kind, item));
      if (!edit) return item;
      return {
        ...item,
        record: edit.final_record,
        admin_edit: {
          edited_by: edit.edited_by,
          edited_at: edit.edited_at,
          revision_count: pcAdminRevision(edit),
          original_record: edit.original_record,
        },
      };
    });
  }
  if (query) items = items.filter((item) => JSON.stringify(item).toLowerCase().includes(query));
  const total = items.length;
  return {
    status: 200,
    body: {
      bundle: bundle.summary,
      kind,
      page,
      page_size: pageSize,
      total,
      protected_emails: [
        bundle.manifest.participant?.email,
        ...(Array.isArray(bundle.manifest.entities)
          ? bundle.manifest.entities.filter((entity) => entity?.category === "self").map((entity) => entity.alias_email)
          : []),
      ].map((email) => cleanText(email, 320)).filter(Boolean),
      items: items.slice(page * pageSize, (page + 1) * pageSize),
    },
  };
}

async function pcAdminSave(body) {
  const bundleId = cleanText(body.bundle_id, 180);
  const kind = String(body.kind || "");
  const itemId = cleanText(body.item_id, 180);
  const finalRecord = body.final_record;
  const baseRevision = Number(body.base_revision_count);
  if (!bundleId || !["email", "calendar"].includes(kind) || !itemId) {
    return { status: 400, body: { error: "bundle_id, email/calendar kind, and item_id required" } };
  }
  if (!finalRecord || typeof finalRecord !== "object" || Array.isArray(finalRecord)) {
    return { status: 400, body: { error: "final_record must be an object" } };
  }
  if (!Number.isInteger(baseRevision) || baseRevision < 0) {
    return { status: 400, body: { error: "base_revision_count must be a non-negative integer" } };
  }
  if (JSON.stringify(finalRecord).length > 256 * 1024) {
    return { status: 400, body: { error: "Edited record is too large (256KB max)" } };
  }
  const bundles = await pcAdminBundles();
  const bundle = bundles.find((candidate) => candidate.summary.bundle_id === bundleId);
  if (!bundle) return { status: 404, body: { error: "Bundle not found" } };
  const items = await pcBundleItems(bundle, kind);
  const sourceItem = items.find((item) => pcItemId(kind, item) === itemId);
  if (!sourceItem?.record || typeof sourceItem.record !== "object") {
    return { status: 404, body: { error: "Record not found in this bundle" } };
  }
  const key = pcEditKey(bundleId, kind, itemId);
  let existing = null;
  let existingEtag = null;
  try {
    const current = await readJson(key);
    existing = current.json;
    existingEtag = current.etag;
  } catch (err) {
    const code = err?.$metadata?.httpStatusCode;
    if (code !== 404 && err?.name !== "NoSuchKey" && err?.name !== "NotFound") throw err;
  }
  const currentRevision = pcAdminRevision(existing);
  if (baseRevision !== currentRevision) {
    return { status: 409, body: { error: "Another admin saved this record first. Cancel and reopen it to review the latest version.", current_revision_count: currentRevision } };
  }
  const editedAt = new Date().toISOString();
  const currentRecord = existing?.final_record ?? sourceItem.record;
  const restrictedFinal = restrictPCAdminRecord(kind, currentRecord, finalRecord);
  const document = buildPCAdminEdit({
    existing,
    sourceRecord: sourceItem.record,
    finalRecord: restrictedFinal,
    bundleId,
    kind,
    itemId,
    editedBy: cleanText(body.admin_email, 240),
    editedAt,
  });
  const wrote = await tryConditionalWrite(() => s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: JSON.stringify(document, null, 2),
    ContentType: "application/json",
    ...(existingEtag ? { IfMatch: existingEtag } : { IfNoneMatch: "*" }),
  })));
  if (!wrote) {
    return { status: 409, body: { error: "Another admin saved this record first. Your changes were not overwritten; cancel and reopen it to review the latest version." } };
  }
  return { status: 200, body: { ok: true, edited_at: editedAt, revision_count: document.revision_count } };
}

export function buildAdminItemFromDocuments({
  source,
  sourceKey,
  submittedAt = "",
  done = null,
  lock = null,
  outcome = null,
  llmCandidates = [],
}) {
  if (!source || !sourceKey) return null;
  const sourceTask = source.task ?? source;
  const finalTask = done?.outcome === "approved" ? outcome?.task ?? null : null;
  const isRedacted = source.participant?.participant_id === "redacted" || sourceKey.includes("/pc/");
  const participantId = isRedacted
    ? "redacted"
    : cleanText(source.participant?.participant_id || participantIdFromSubKey(sourceKey) || "unknown", 80);
  const original = cleanTaskSnapshot(sourceTask);
  const final = cleanTaskSnapshot(finalTask);
  const originalMetadata = taskMetadataForReporting(sourceTask);
  const finalMetadata = taskMetadataForReporting(finalTask) ?? (final ? originalMetadata : null);
  const humanReview = done?.outcome === "approved" && outcome?.review && typeof outcome.review === "object"
    ? {
        evergreen_verified: Boolean(outcome.review.evergreen_verified),
        title_edited: Boolean(outcome.review.title_edited),
        request_edited: Boolean(outcome.review.request_edited),
      }
    : null;
  const rubrics = cleanRubrics(outcome?.review, original, final);
  const taskContentHash = reportingTaskContentHash(original, final, rubrics);
  const changed = Boolean(final && JSON.stringify(original) !== JSON.stringify(final));
  const changedInQc = outcome ? reviewerChangedTask(outcome) : false;
  const sourceJourneys = Array.isArray(source.provenance?.source_journeys) ? source.provenance.source_journeys : [];
  const visitCount = sourceJourneys.reduce(
    (sum, journey) => sum + (Array.isArray(journey?.visits) ? journey.visits.length : 0),
    0
  );
  const status = done?.outcome === "approved" ? "approved" : done?.outcome === "rejected" ? "rejected" : lock ? "in_review" : "pending";
  const taskId = cleanText(source.task_id || done?.task_id || "unknown", 160);
  const llmMeta = selectLlmReviewArtifact(applicableLlmReviewCandidates(llmCandidates, status), taskContentHash);
  const llmReviewStale = Boolean(llmMeta?.contentHash && llmMeta.contentHash !== taskContentHash);
  // The PRE_QC finding stays reportable after the human decision (it was the
  // lead the reviewer worked from). Staleness is judged against the content
  // the draft had when submitted, not the edited final gold.
  const originalContentHash = final ? reportingTaskContentHash(original, null, cleanRubrics(null, original, null)) : taskContentHash;
  const preQcMeta = selectLlmReviewArtifact(
    (Array.isArray(llmCandidates) ? llmCandidates : []).filter((candidate) => candidate?.stage === "PRE_QC"),
    originalContentHash
  );
  const preQcStale = Boolean(preQcMeta?.contentHash && preQcMeta.contentHash !== originalContentHash);
  const claimedAt = Date.parse(String(lock?.claimed_at || ""));
  const lockExpiresAt = lock && Number.isFinite(claimedAt)
    ? new Date(claimedAt + Number(LOCK_TTL_MS)).toISOString()
    : null;
  const appealNumber = Math.max(0, Math.floor(Number(source.appeal_number) || 0));
  const authorRevisionNumber = Math.max(
    0,
    Math.floor(Number(source.author_revision_number) || 0),
    appealNumber > 0 || source.edit_started_at ? 1 : 0,
  );
  const authorRequeueCount = Math.max(
    0,
    Math.floor(Number(source.author_requeue_count) || 0),
    source.edit_started_at ? 1 : 0,
  );
  return {
    task_id: taskId,
    participant_id: participantId,
    participant_name: isRedacted ? "Anonymous / redacted" : cleanText(source.participant?.name || participantId, 160),
    participant_email: isRedacted ? "" : cleanText(source.participant?.email, 240),
    mode: cleanText(source.mode || (sourceKey.includes("/pc/") ? "pc" : "unknown"), 40),
    submitted_at: cleanText(source.created_at || submittedAt, 60),
    status,
    reviewer: cleanText(done?.reviewer || lock?.reviewer, 160),
    reviewed_at: cleanText(done?.completed_at, 60),
    claimed_at: cleanText(done?.claimed_at, 60),
    authoring_started_at: cleanText(source.authoring?.started_at, 60),
    rejection_reason: status === "rejected" ? cleanText(outcome?.reason, 500) : "",
    trajectory_count: sourceJourneys.length,
    visit_count: visitCount,
    changed,
    changed_in_qc: changedInQc,
    source_key: sourceKey,
    review_unit: reviewUnitForKey(sourceKey),
    done_target: done?.target || null,
    lock_expires_at: lockExpiresAt,
    original: original && originalMetadata ? { ...original, metadata: originalMetadata } : original,
    final: final && finalMetadata ? { ...final, metadata: finalMetadata } : final,
    rubrics,
    human_review: humanReview,
    task_content_hash: taskContentHash,
    llm_review_status: llmReviewStale ? "stale" : llmMeta?.status ?? "not_reviewed",
    llm_review_key: llmMeta?.key ?? null,
    llm_review_stage: llmMeta?.stage ?? null,
    llm_review_stale: llmReviewStale,
    llm_pre_qc_status: preQcStale ? "stale" : preQcMeta?.status ?? "not_reviewed",
    llm_pre_qc_key: preQcMeta?.key ?? null,
    edit_started_at: cleanText(source.edit_started_at, 60),
    appeal_started_at: cleanText(source.appeal_started_at, 60),
    appeal_number: appealNumber,
    author_revision_number: authorRevisionNumber,
    author_requeue_count: authorRequeueCount,
    author_requeued_at: cleanText(source.author_requeued_at, 60),
    final_gold_revision: status === "approved" ? finalGoldRevision(outcome) : 0,
    amended_by: cleanText(outcome?.amended_by, 80),
    amended_at: cleanText(outcome?.amended_at, 60),
    signoff_at: "",
    signoff_action: "",
    signoff_opened_at: "",
  };
}

let adminDashboardCache = { dashboard: null, checkedAt: 0, pending: null };

// The full S3-built dashboard (every source doc + outcome) takes ~25s at
// ~1.8k tasks — right under API Gateway's 30s cut-off and growing with the
// corpus. A scheduled invocation (EventBridge, every 5 min) rebuilds it and
// stores a gzipped snapshot; request paths serve the snapshot (≈2s) and only
// fall back to a live build when the snapshot is missing or older than
// SNAPSHOT_MAX_AGE_MS. Reporting therefore lags real-time by ≤5 min.
const ADMIN_SNAPSHOT_KEY = `${REVIEW_PREFIX}cache/admin_dashboard.json.gz`;
const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;

export async function refreshAdminDashboardSnapshot() {
  const startedAt = Date.now();
  const dashboard = await loadAdminDashboard();
  const builtAt = new Date().toISOString();
  const body = gzipSync(Buffer.from(JSON.stringify({ built_at: builtAt, dashboard }), "utf8"));
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: ADMIN_SNAPSHOT_KEY,
    Body: body,
    ContentType: "application/json",
    ContentEncoding: "gzip",
  }));
  adminDashboardCache = { dashboard: { ...dashboard, snapshot_built_at: builtAt }, checkedAt: Date.now(), pending: null };
  return { built_at: builtAt, items: dashboard.items?.length ?? 0, bytes: body.length, build_ms: Date.now() - startedAt };
}

async function readAdminDashboardSnapshot() {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: ADMIN_SNAPSHOT_KEY }));
    const raw = Buffer.from(await res.Body.transformToByteArray());
    const parsed = JSON.parse(gunzipSync(raw).toString("utf8"));
    const builtAt = Date.parse(String(parsed?.built_at || ""));
    if (!parsed?.dashboard || !Number.isFinite(builtAt) || Date.now() - builtAt > SNAPSHOT_MAX_AGE_MS) return null;
    return { ...parsed.dashboard, snapshot_built_at: parsed.built_at };
  } catch {
    return null;
  }
}

export async function adminDashboard() {
  const now = Date.now();
  if (adminDashboardCache.dashboard && now - adminDashboardCache.checkedAt < 15_000) {
    return adminDashboardCache.dashboard;
  }
  if (!adminDashboardCache.pending) {
    adminDashboardCache.pending = (async () => (await readAdminDashboardSnapshot()) ?? (await loadAdminDashboard()))();
  }
  try {
    const dashboard = await adminDashboardCache.pending;
    adminDashboardCache = { dashboard, checkedAt: Date.now(), pending: null };
    return dashboard;
  } catch (error) {
    adminDashboardCache.pending = null;
    throw error;
  }
}

export async function loadAdminDashboard() {
  const [
    inbox,
    doneObjects,
    lockObjects,
    llmPassObjects,
    llmFailObjects,
    llmPreQcPassObjects,
    llmPreQcAttentionObjects,
  ] = await Promise.all([
    listAllObjects(`${REVIEW_PREFIX}inbox/`),
    listAllObjects(`${REVIEW_PREFIX}done/`),
    listAllObjects(`${REVIEW_PREFIX}locks/`),
    listAllObjects(LLM_PASS_PREFIX),
    listAllObjects(LLM_FAIL_PREFIX),
    listAllObjects(LLM_PRE_QC_PASS_PREFIX),
    listAllObjects(LLM_PRE_QC_ATTENTION_PREFIX),
  ]);
  const llmCandidatesByTaskId = new Map();
  for (const [objects, status, prefix, stage] of [
    [llmPassObjects, "passed", LLM_PASS_PREFIX, "POST_QC"],
    [llmFailObjects, "needs_attention", LLM_FAIL_PREFIX, "POST_QC"],
    [llmPreQcPassObjects, "pre_qc_passed", LLM_PRE_QC_PASS_PREFIX, "PRE_QC"],
    [llmPreQcAttentionObjects, "pre_qc_attention", LLM_PRE_QC_ATTENTION_PREFIX, "PRE_QC"],
  ]) {
    for (const object of objects) {
      try {
        // Current pipeline keys are immutable per task content and pipeline
        // version: <base64url-task>.<content-hash>.<pipeline>.json. Keep
        // accepting the original flat <base64url-task>.json form as well.
        const candidate = parseLlmReviewArtifactKey(object.Key, prefix, status, object.LastModified, stage);
        if (!candidate) continue;
        const current = llmCandidatesByTaskId.get(candidate.taskId) ?? [];
        current.push(candidate);
        llmCandidatesByTaskId.set(candidate.taskId, current);
      } catch {
        /* malformed LLM-review key — ignore */
      }
    }
  }
  const markerTime = new Map();
  const byUnit = new Map();
  for (const marker of inbox) {
    try {
      const subKey = fromB64url(marker.Key.slice(`${REVIEW_PREFIX}inbox/`.length));
      if (!isReviewSubmissionKey(subKey)) continue;
      markerTime.set(subKey, marker.LastModified?.toISOString() ?? "");
      const unit = reviewUnitForKey(subKey);
      const current = byUnit.get(unit) ?? { newest: subKey, files: [] };
      current.files.push(subKey);
      if (subKey > current.newest) current.newest = subKey;
      byUnit.set(unit, current);
    } catch {
      /* malformed marker — ignore */
    }
  }

  const doneByEncodedKey = new Map();
  await Promise.all(doneObjects.map(async (object) => {
    const encoded = object.Key.slice(`${REVIEW_PREFIX}done/`.length);
    const record = await readJson(object.Key).then(({ json }) => json).catch(() => null);
    if (record) doneByEncodedKey.set(encoded, record);
  }));

  const locks = new Map();
  await Promise.all(lockObjects.map(async (object) => {
    const encoded = object.Key.slice(`${REVIEW_PREFIX}locks/`.length, -".json".length);
    const record = await readJson(object.Key).then(({ json }) => json).catch(() => null);
    const claimedAt = Date.parse(record?.claimed_at);
    if (record && Number.isFinite(claimedAt) && Date.now() - claimedAt <= Number(LOCK_TTL_MS)) {
      locks.set(encoded, record);
    }
  }));

  const units = [...byUnit.values()]
    .sort((a, b) => (markerTime.get(b.newest) || "").localeCompare(markerTime.get(a.newest) || ""));
  const items = [];
  // Bound concurrent S3 reads. Admin views can cover hundreds of submissions,
  // and one unbounded Promise.all would create avoidable throttling spikes.
  for (let offset = 0; offset < units.length; offset += 25) {
    const batch = await Promise.all(units.slice(offset, offset + 25).map(async ({ newest }) => {
      const source = await readJson(newest).then(({ json }) => json).catch(() => null);
      if (!source) return null;
      // Resolve the same newest revision the reviewer queue uses. An earlier
      // rejection/return must not mask a later appeal or revision.
      const done = doneByEncodedKey.get(b64url(newest)) ?? null;
      const lock = !done ? locks.get(b64url(newest)) ?? null : null;
      let outcome = null;
      if (done?.target) outcome = await readJson(done.target).then(({ json }) => json).catch(() => null);

      const taskId = cleanText(source.task_id || done?.task_id || "unknown", 160);
      return buildAdminItemFromDocuments({
        source,
        sourceKey: newest,
        submittedAt: markerTime.get(newest),
        done,
        lock,
        outcome,
        llmCandidates: llmCandidatesByTaskId.get(taskId) ?? [],
      });
    }));
    items.push(...batch.filter(Boolean));
  }
  await attachAuthorSignoffs(items);
  return { items, users: summarizeAdminUsers(items), truncated: false, total: byUnit.size };
}

async function attachAuthorSignoffs(items) {
  const objects = await listAllObjects(AUTHOR_SIGNOFF_PREFIX).catch(() => []);
  if (!objects.length) return;
  const have = new Set();
  for (const object of objects) {
    const encoded = object.Key.slice(AUTHOR_SIGNOFF_PREFIX.length).replace(/\.json$/, "");
    try {
      have.add(fromB64url(encoded));
    } catch {
      // Malformed receipts are not addressable and cannot match a row.
    }
  }
  const signed = items.filter((item) => item.source_key && have.has(item.source_key));
  for (let offset = 0; offset < signed.length; offset += 25) {
    await Promise.all(signed.slice(offset, offset + 25).map(async (item) => {
      const receipt = await readJson(authorSignoffKeyFor(item.source_key))
        .then(({ json }) => json)
        .catch(() => null);
      if (!receipt) return;
      item.signoff_at = cleanText(receipt.signed_off_at, 60);
      item.signoff_action = cleanText(receipt.action, 20);
      item.signoff_opened_at = cleanText(receipt.opened_at, 60);
    }));
  }
}

async function refreshAuthorDashboardIndex(subKey, done, outcome, receipt = null) {
  if (!DASHBOARD_TABLE) return false;
  const source = await readJson(subKey).then(({ json }) => json).catch(() => null);
  if (!source) return false;
  const item = buildAdminItemFromDocuments({ source, sourceKey: subKey, done, outcome });
  if (!item) return false;
  if (receipt) {
    item.signoff_at = cleanText(receipt.signed_off_at, 60);
    item.signoff_action = cleanText(receipt.action, 20);
    item.signoff_opened_at = cleanText(receipt.opened_at, 60);
  }
  return await putDashboardIndexItem(item, { refreshDurable: true });
}

function invalidateDashboardIndexCache() {
  dashboardIndexCache = { dashboard: null, checkedAt: 0, pending: null };
}

export async function putDashboardIndexItem(item, options = {}) {
  if (!DASHBOARD_TABLE) return false;
  const record = buildDashboardIndexRecord(item);
  if (!record) return false;
  const existing = await dashboardDb.send(new GetCommand({
    TableName: DASHBOARD_TABLE,
    Key: { scope: record.scope, entity_key: record.entity_key },
    ConsistentRead: true,
  })).then((response) => response.Item ?? null);
  // A delayed registration must never roll a reviewed task back to pending.
  const existingStatus = existing ? effectiveIndexedStatus(existing) : "pending";
  const matchingAudit = existing && existing.task_content_hash === record.task_content_hash
    ? {
        pre_qc_artifact_key: existing.pre_qc_artifact_key,
        pre_qc_task_content_hash: existing.pre_qc_task_content_hash,
        pre_qc_pipeline_version: existing.pre_qc_pipeline_version,
        pre_qc_status: existing.pre_qc_status,
        pre_qc_complete: existing.pre_qc_complete,
        pre_qc_indexed_at: existing.pre_qc_indexed_at,
      }
    : {};
  // Preserve a durable outcome only for the same submitted revision. A newer
  // author revision intentionally resets a rejected/returned unit to pending.
  // `refreshDurable` is used after an in-place final-gold amendment.
  const preserveDurable = existing
    && existingStatus !== "pending"
    && existing.source_key === record.source_key
    && !options.refreshDurable;
  const durable = preserveDurable
    ? {
        ...record,
        ...matchingAudit,
        status: existingStatus,
        reviewer: existing.reviewer,
        reviewed_at: existing.reviewed_at,
        claimed_at: existing.claimed_at || "",
        rejection_reason: existing.rejection_reason,
        done_target: existing.done_target,
        changed: existing.changed,
        changed_in_qc: existing.changed_in_qc == null ? Boolean(existing.changed) : Boolean(existing.changed_in_qc),
        amended_by: existing.amended_by || "",
        amended_at: existing.amended_at || "",
        final_gold_revision: Number(existing.final_gold_revision) || 0,
        signoff_at: existing.signoff_at || "",
        signoff_action: existing.signoff_action || "",
        signoff_opened_at: existing.signoff_opened_at || "",
        final_title: existing.final_title,
        final_difficulty: existing.final_difficulty,
        final_region: existing.final_region || "",
        final_subjects: Array.isArray(existing.final_subjects) ? existing.final_subjects : [],
        lock_expires_at: existing.lock_expires_at,
      }
    : { ...record, ...matchingAudit };
  await dashboardDb.send(new PutCommand({ TableName: DASHBOARD_TABLE, Item: durable }));
  invalidateDashboardIndexCache();
  return true;
}

export async function markDashboardIndexReady(expectedCount, backfilledAt = new Date().toISOString()) {
  if (!DASHBOARD_TABLE) return false;
  const scope = dashboardIndexScope();
  await dashboardDb.send(new PutCommand({
    TableName: DASHBOARD_TABLE,
    Item: {
      scope,
      entity_key: "META",
      entity_type: "META",
      ready: true,
      expected_count: Math.max(0, Number(expectedCount) || 0),
      backfilled_at: backfilledAt,
      indexed_at: backfilledAt,
    },
  }));
  invalidateDashboardIndexCache();
  return true;
}

async function dashboardIndexMetadata() {
  if (!DASHBOARD_TABLE) return null;
  const response = await dashboardDb.send(new GetCommand({
    TableName: DASHBOARD_TABLE,
    Key: { scope: dashboardIndexScope(), entity_key: "META" },
    ConsistentRead: true,
  }));
  return response.Item ?? null;
}

export async function loadDashboardIndexRecords() {
  if (!DASHBOARD_TABLE) return [];
  const records = [];
  let ExclusiveStartKey;
  do {
    const response = await dashboardDb.send(new QueryCommand({
      TableName: DASHBOARD_TABLE,
      KeyConditionExpression: "#scope = :scope AND begins_with(#entity, :task)",
      ExpressionAttributeNames: { "#scope": "scope", "#entity": "entity_key" },
      ExpressionAttributeValues: { ":scope": dashboardIndexScope(), ":task": "TASK#" },
      ExclusiveStartKey,
      ConsistentRead: true,
    }));
    records.push(...(response.Items ?? []));
    ExclusiveStartKey = response.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return records;
}

async function updateDashboardPreQcIndex(record, taskContentHash, candidate = null, artifact = null) {
  if (!DASHBOARD_TABLE || !record?.task_id || !record?.source_key || !taskContentHash) return false;
  const complete = candidate ? isCompletedReviewerPreQcArtifact(artifact) : false;
  const values = {
    ":hash": taskContentHash,
    ":artifact": candidate?.key || null,
    ":reviewHash": candidate?.contentHash || null,
    ":version": Number(candidate?.pipelineVersion) || 0,
    ":status": cleanText(artifact?.status, 80),
    ":complete": complete,
    ":indexed": new Date().toISOString(),
  };
  const sourceCondition = dashboardSourceCondition(record.source_key);
  try {
    await dashboardDb.send(new UpdateCommand({
      TableName: DASHBOARD_TABLE,
      Key: { scope: dashboardIndexScope(), entity_key: `TASK#${record.task_id}` },
      ConditionExpression: sourceCondition.ConditionExpression,
      UpdateExpression: "SET task_content_hash = :hash, pre_qc_artifact_key = :artifact, pre_qc_task_content_hash = :reviewHash, pre_qc_pipeline_version = :version, pre_qc_status = :status, pre_qc_complete = :complete, pre_qc_indexed_at = :indexed",
      ExpressionAttributeNames: sourceCondition.ExpressionAttributeNames,
      ExpressionAttributeValues: { ...values, ...sourceCondition.ExpressionAttributeValues },
    }));
    return complete;
  } catch (error) {
    if (error?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

export function dashboardRecordMatchesSource(record, sourceKey) {
  return Boolean(record?.source_key && sourceKey && record.source_key === sourceKey);
}

export function dashboardSourceCondition(expectedSourceKey) {
  if (!expectedSourceKey) return null;
  return {
    ConditionExpression: "attribute_exists(#entity) AND #source = :expectedSource",
    ExpressionAttributeNames: { "#entity": "entity_key", "#source": "source_key" },
    ExpressionAttributeValues: { ":expectedSource": expectedSourceKey },
  };
}

async function taskContentHashForIndexRecord(record) {
  if (record?.task_content_hash) return record.task_content_hash;
  if (!record?.source_key) return "";
  const source = await readJson(record.source_key).then(({ json }) => json).catch(() => null);
  const original = cleanTaskSnapshot(source?.task ?? source);
  if (!original) return "";
  const rubrics = cleanRubrics(null, original, null);
  const taskContentHash = reportingTaskContentHash(original, null, rubrics);
  await updateDashboardPreQcIndex(record, taskContentHash);
  record.task_content_hash = taskContentHash;
  return taskContentHash;
}

async function completedPreQcSubmissionKeysFromIndex(submissionKeys, candidates) {
  const records = await loadDashboardIndexRecords();
  const byTaskId = new Map(records.map((record) => [record.task_id, record]));
  const candidatesByTaskId = new Map();
  for (const candidate of currentReviewerLlmCandidates(candidates)) {
    const list = candidatesByTaskId.get(candidate.taskId) ?? [];
    list.push(candidate);
    candidatesByTaskId.set(candidate.taskId, list);
  }

  const ready = new Set();
  const verify = [];
  for (const subKey of submissionKeys) {
    const taskId = taskIdFromSubmissionKey(subKey);
    const record = taskId ? byTaskId.get(taskId) : null;
    // A task id is stable across author revisions. A row for the previous
    // source must not unlock the newest S3 submission; leave it unresolved so
    // the caller performs the normal source-of-truth fallback.
    if (!dashboardRecordMatchesSource(record, subKey)) continue;
    const taskContentHash = await taskContentHashForIndexRecord(record);
    if (!taskContentHash) continue;
    const selected = selectLlmReviewArtifact(candidatesByTaskId.get(taskId) ?? [], taskContentHash);
    if (!selected || selected.contentHash !== taskContentHash) continue;
    if (isCurrentIndexedPreQc(record, selected, taskContentHash)) {
      ready.add(subKey);
      continue;
    }
    const indexedCandidate = record.pre_qc_artifact_key === selected.key
      && record.pre_qc_task_content_hash === taskContentHash;
    if (indexedCandidate && record.pre_qc_complete === false) continue;
    verify.push({ subKey, record, taskContentHash, selected });
  }

  for (let offset = 0; offset < verify.length; offset += 25) {
    const checked = await Promise.all(verify.slice(offset, offset + 25).map(async (item) => {
      const artifact = await readJson(item.selected.key).then(({ json }) => json).catch(() => null);
      const complete = await updateDashboardPreQcIndex(
        item.record,
        item.taskContentHash,
        item.selected,
        artifact,
      );
      return complete ? item.subKey : null;
    }));
    for (const subKey of checked) if (subKey) ready.add(subKey);
  }
  return ready;
}

export async function reconcileDashboardIndex(records) {
  const inbox = await listAllObjects(`${REVIEW_PREFIX}inbox/`);
  const newestByUnit = new Map();
  for (const marker of inbox) {
    try {
      const sourceKey = fromB64url(marker.Key.slice(`${REVIEW_PREFIX}inbox/`.length));
      if (!isReviewSubmissionKey(sourceKey)) continue;
      const unit = reviewUnitForKey(sourceKey);
      const current = newestByUnit.get(unit);
      if (!current || sourceKey > current.sourceKey) {
        newestByUnit.set(unit, {
          sourceKey,
          submittedAt: marker.LastModified?.toISOString() || "",
        });
      }
    } catch {
      // Invalid legacy marker: leave the source of truth untouched and ignore.
    }
  }
  const indexedByUnit = new Map(records.map((record) => [record.review_unit, record.source_key]));
  const missingOrNewer = [...newestByUnit.entries()]
    .filter(([unit, marker]) => indexedByUnit.get(unit) !== marker.sourceKey)
    .map(([, marker]) => marker);
  let indexed = 0;
  for (let offset = 0; offset < missingOrNewer.length; offset += 10) {
    const batch = await Promise.all(missingOrNewer.slice(offset, offset + 10).map(async ({ sourceKey, submittedAt }) => {
      const source = await readJson(sourceKey).then(({ json }) => json).catch(() => null);
      if (!source) return false; // Presigned marker exists, upload has not landed.
      const item = buildAdminItemFromDocuments({ source, sourceKey, submittedAt });
      return item ? await putDashboardIndexItem(item) : false;
    }));
    indexed += batch.filter(Boolean).length;
  }
  return { indexed, candidates: missingOrNewer.length, inbox_units: newestByUnit.size };
}

let dashboardIndexCache = { dashboard: null, checkedAt: 0, pending: null };

export async function indexedAdminDashboard() {
  if (!DASHBOARD_TABLE) return null;
  const now = Date.now();
  if (dashboardIndexCache.dashboard && now - dashboardIndexCache.checkedAt < 15_000) {
    return dashboardIndexCache.dashboard;
  }
  if (!dashboardIndexCache.pending) {
    dashboardIndexCache.pending = (async () => {
      const meta = await dashboardIndexMetadata();
      if (!meta?.ready) return null;
      let records = await loadDashboardIndexRecords();
      const reconciliation = await reconcileDashboardIndex(records);
      if (reconciliation.indexed) records = await loadDashboardIndexRecords();
      return dashboardFromIndexRecords(records);
    })();
  }
  try {
    const dashboard = await dashboardIndexCache.pending;
    dashboardIndexCache = { dashboard, checkedAt: Date.now(), pending: null };
    return dashboard;
  } catch (error) {
    dashboardIndexCache.pending = null;
    throw error;
  }
}

// Admin "throw it back into the pool": revoke an approval/rejection so the
// task is reviewed again by someone else. Everything revoked is archived under
// reopened/ (never deleted outright), the previous reviewer's credit receipt
// is withdrawn, and a reopen marker keeps the task away from that reviewer.
async function reopenReviewOutcome(taskId, adminEmail, reason = "") {
  const cleanId = cleanText(taskId, 300);
  if (!cleanId) return { status: 400, body: { error: "task_id required" } };
  let item = null;
  try {
    item = await indexedAdminDetail(cleanId);
  } catch (error) {
    console.error("Reopen: index detail failed; using S3 source of truth", error);
  }
  if (!item) item = (await adminDashboard()).items.find((candidate) => candidate.task_id === cleanId) ?? null;
  if (!item) return { status: 404, body: { error: "Task not found" } };
  if (!["approved", "rejected"].includes(item.status)) {
    return { status: 409, body: { error: `Only approved or rejected tasks can be re-queued (status: ${item.status})` } };
  }
  const subKey = item.source_key;
  const mutationLock = await acquireAuthorMutationLock(subKey, `admin:${cleanText(adminEmail, 120) || "reopen"}`);
  if (!mutationLock) {
    return { status: 409, body: { error: "This task is being accepted, amended, or reopened. Retry in a moment." } };
  }
  try {
  // The dashboard detail was read before acquiring the mutex. Resolve the
  // unit's actual newest stored revision and revalidate its completion record
  // inside the lock. A failed best-effort index refresh must never let an old
  // rejected row reopen historical state after a newer author edit exists.
  const unit = reviewUnitForKey(subKey);
  const dir = subKey.slice(0, subKey.lastIndexOf("/") + 1);
  const files = (await listAll(dir))
    .filter((key) => isReviewSubmissionKey(key) && reviewUnitForKey(key) === unit)
    .sort();
  const newest = newestReviewRevision(files, unit);
  if (!newest || newest !== subKey) {
    adminDashboardCache = { dashboard: null, checkedAt: 0, pending: null };
    invalidateDashboardIndexCache();
    return { status: 409, body: { error: "Dashboard state is stale; refresh before reopening this task." } };
  }
  const currentDone = await readDoneRecord(newest);
  const currentOutcome = doneOutcome(currentDone);
  if (!["approved", "rejected"].includes(currentOutcome)) {
    return { status: 409, body: { error: "This task is no longer approved or rejected." } };
  }
  item = {
    ...item,
    status: currentOutcome,
    done_target: currentDone.target || item.done_target,
    reviewer: currentDone.reviewer || item.reviewer,
    reviewed_at: currentDone.completed_at || item.reviewed_at,
  };
  const listedDoneKeys = new Set(
    (await listAllObjects(`${REVIEW_PREFIX}done/`))
      .map((object) => object.Key.slice(`${REVIEW_PREFIX}done/`.length)),
  );
  const doneRecords = await resolveDoneRecordsForReopen({
    files,
    newest,
    currentDone,
    listedDoneKeys,
    readDone: readDoneRecord,
  });
  const reviewLockEtags = new Map();
  for (const key of files) {
    try {
      const { etag } = await readJson(lockKeyFor(key));
      if (etag) reviewLockEtags.set(key, etag);
    } catch (error) {
      if (!isMissingObjectError(error)) throw error;
    }
  }
  const reopenedAt = new Date().toISOString();
  const stamp = reopenedAt.replace(/[:.]/g, "-");
  const archiveBase = `${REOPEN_ARCHIVE_PREFIX}${b64url(unit)}/${stamp}_`;
  const archived = [];
  const targets = new Set([item.done_target, ...doneRecords.map((entry) => entry.done?.target)].filter(Boolean));
  for (const target of targets) {
    const archiveKey = `${archiveBase}${target.slice(target.lastIndexOf("/") + 1)}`;
    try {
      await s3.send(new CopyObjectCommand({ Bucket: S3_BUCKET, CopySource: `/${S3_BUCKET}/${encodeURIComponent(target).replace(/%2F/g, "/")}`, Key: archiveKey }));
      await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: target }));
      archived.push({ from: target, to: archiveKey });
    } catch (error) {
      if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== "NoSuchKey") throw error;
    }
  }
  // A new approval is a new version for the author to inspect. Archive and
  // clear any receipt for the revoked approval so it cannot silently satisfy
  // the next sign-off queue entry under the same submission key.
  const signoffKey = authorSignoffKeyFor(subKey);
  try {
    const archiveKey = `${archiveBase}author-signoff.json`;
    await s3.send(new CopyObjectCommand({
      Bucket: S3_BUCKET,
      CopySource: `/${S3_BUCKET}/${encodeURIComponent(signoffKey).replace(/%2F/g, "/")}`,
      Key: archiveKey,
    }));
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: signoffKey }));
    archived.push({ from: signoffKey, to: archiveKey });
  } catch (error) {
    if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== "NoSuchKey") throw error;
  }
  const previousReviewers = [...new Set([item.reviewer, ...doneRecords.map((entry) => entry.done?.reviewer)].filter(Boolean))];
  const previousOutcome = item.status;
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: `${archiveBase}reopen.json`,
    Body: JSON.stringify({
      task_id: cleanId,
      source_key: subKey,
      review_unit: unit,
      previous_outcome: previousOutcome,
      previous_reviewers: previousReviewers,
      previous_reviewed_at: item.reviewed_at || "",
      reopened_by: cleanText(adminEmail, 240),
      reopened_at: reopenedAt,
      reason: cleanText(reason, 500),
      archived,
      done_records: doneRecords.map((entry) => ({ key: entry.key, done: entry.done })),
    }, null, 2),
    ContentType: "application/json",
  }));
  for (const reviewer of previousReviewers) {
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: reopenMarkerKeyFor(unit, reviewer), Body: "", ContentType: "text/plain" }));
  }
  // Withdraw credit receipts, then the done markers (order matters: a crash
  // between the two leaves a still-done task, never a double-credited one).
  await withdrawReopenedOutcomeState(doneRecords, {
    deleteCredit: async ({ key, done }) => {
      const reviewer = done?.reviewer || item.reviewer;
      const outcome = done?.outcome || previousOutcome;
      if (!reviewer || !outcome) return;
      await deleteIfPresent(() => s3.send(new DeleteObjectCommand({
        Bucket: S3_BUCKET,
        Key: reviewerCreditKeyFor(reviewer, outcome, key),
      })));
    },
    deleteLock: async ({ key }) => {
      const etag = reviewLockEtags.get(key);
      if (!etag) return;
      if (!(await deleteLockIfUnchanged(key, etag))) {
        throw new Error("Review lock changed while reopening; retry before deleting completion state");
      }
    },
    deleteDone: ({ key }) => s3.send(new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: doneKeyFor(key),
    })),
  });
  // Make sure the newest file is in the inbox (it normally still is — inbox
  // markers are not removed on completion — so position in the FIFO is kept).
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: inboxKeyFor(newest) }));
  } catch {
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: inboxKeyFor(newest), Body: newest, ContentType: "text/plain" }));
  }
  await setDashboardIndexStatus(cleanId, "pending", { expected_source_key: subKey })
    .catch((error) => console.error("Reopen index update failed", error));
  adminDashboardCache = { dashboard: null, checkedAt: 0, pending: null };
  return {
    status: 200,
    body: {
      ok: true,
      task_id: cleanId,
      previous_outcome: previousOutcome,
      previous_reviewers: previousReviewers,
      archived: archived.length,
      reopened_at: reopenedAt,
    },
  };
  } finally {
    await releaseAuthorMutationLock(subKey, mutationLock);
  }
}

async function adminListDashboard() {
  try {
    const indexed = await indexedAdminDashboard();
    if (indexed) return indexed;
  } catch (error) {
    console.error("Dashboard index read failed; using S3 source of truth", error);
  }
  return await adminDashboard();
}

async function dashboardIndexRecord(taskId) {
  if (!DASHBOARD_TABLE || !taskId) return null;
  const response = await dashboardDb.send(new GetCommand({
    TableName: DASHBOARD_TABLE,
    Key: { scope: dashboardIndexScope(), entity_key: `TASK#${taskId}` },
    ConsistentRead: true,
  }));
  return response.Item ?? null;
}

async function indexedAdminDetail(taskId) {
  const record = await dashboardIndexRecord(taskId);
  if (!record?.source_key) return null;
  const source = await readJson(record.source_key).then(({ json }) => json);
  const status = effectiveIndexedStatus(record);
  const done = ["approved", "rejected"].includes(status)
    ? {
        target: record.done_target,
        outcome: status,
        reviewer: record.reviewer,
        completed_at: record.reviewed_at,
        claimed_at: record.claimed_at,
        task_id: record.task_id,
      }
    : null;
  const outcome = record.done_target
    ? await readJson(record.done_target).then(({ json }) => json).catch(() => null)
    : null;
  const expiresAt = Date.parse(String(record.lock_expires_at || ""));
  const lock = status === "in_review" && Number.isFinite(expiresAt)
    ? {
        reviewer: record.reviewer,
        claimed_at: new Date(expiresAt - Number(LOCK_TTL_MS)).toISOString(),
      }
    : null;
  return buildAdminItemFromDocuments({ source, sourceKey: record.source_key, done, lock, outcome });
}

export function buildDashboardStatusUpdateRequest({
  tableName,
  scope,
  taskId,
  status,
  expectedSourceKey,
  details = {},
  indexedAt = new Date().toISOString(),
}) {
  if (!tableName || !scope || !taskId || !expectedSourceKey) return null;
  const values = {
    ":status": status,
    ":reviewer": details.reviewer || "",
    ":reviewed": details.reviewed_at || "",
    ":reason": details.rejection_reason || "",
    ":target": details.done_target || null,
    ":expires": details.lock_expires_at || null,
    ":changed": Boolean(details.changed),
    ":changedInQc": details.changed_in_qc == null ? Boolean(details.changed) : Boolean(details.changed_in_qc),
    ":finalTitle": details.final_title || "",
    ":finalDifficulty": details.final_difficulty || "",
    ":finalRegion": details.final_metadata?.region || "",
    ":finalSubjects": Array.isArray(details.final_metadata?.subjects) ? details.final_metadata.subjects.slice(0, 3) : [],
    ":claimedAt": details.claimed_at || "",
    ":amendedBy": details.amended_by || "",
    ":amendedAt": details.amended_at || "",
    ":revision": Number(details.final_gold_revision) || 0,
    ":indexed": indexedAt,
    ":expectedSource": expectedSourceKey,
  };
  const clearSignoff = status === "pending"
    ? " REMOVE signoff_at, signoff_action, signoff_opened_at"
    : "";
  return {
    TableName: tableName,
    Key: { scope, entity_key: `TASK#${taskId}` },
    ConditionExpression: "attribute_exists(#entity) AND #source = :expectedSource",
    UpdateExpression: `SET #status = :status, reviewer = :reviewer, reviewed_at = :reviewed, rejection_reason = :reason, done_target = :target, lock_expires_at = :expires, changed = :changed, changed_in_qc = :changedInQc, final_title = :finalTitle, final_difficulty = :finalDifficulty, final_region = :finalRegion, final_subjects = :finalSubjects, claimed_at = :claimedAt, amended_by = :amendedBy, amended_at = :amendedAt, final_gold_revision = :revision, indexed_at = :indexed${clearSignoff}`,
    ExpressionAttributeNames: { "#entity": "entity_key", "#status": "status", "#source": "source_key" },
    ExpressionAttributeValues: values,
  };
}

async function setDashboardIndexStatus(taskId, status, details = {}) {
  if (!DASHBOARD_TABLE || !taskId || !details.expected_source_key) return false;
  const request = buildDashboardStatusUpdateRequest({
    tableName: DASHBOARD_TABLE,
    scope: dashboardIndexScope(),
    taskId,
    status,
    expectedSourceKey: details.expected_source_key,
    details,
  });
  try {
    await dashboardDb.send(new UpdateCommand(request));
    invalidateDashboardIndexCache();
    return true;
  } catch (error) {
    if (error?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

async function registerDashboardSubmission(taskId, participantId) {
  if (!DASHBOARD_TABLE) return { indexed: false, reason: "disabled" };
  const scope = dashboardIndexScope();
  if (scope !== "v2") return { indexed: false, reason: "unsupported_scope" };
  const pid = cleanText(participantId, 80).trim().toLowerCase();
  const expectedTask = `v2/${pid}/internal/`;
  if (!VALID_PID.test(pid) || !String(taskId).startsWith(expectedTask)) {
    return { indexed: false, reason: "invalid_task" };
  }
  const objects = await listAllObjects(`${UPLOAD_PREFIX}${pid}/${taskId}/`);
  const sourceKey = objects
    .map((object) => object.Key)
    .filter((key) => isReviewSubmissionKey(key))
    .sort()
    .at(-1);
  if (!sourceKey) return { indexed: false, reason: "upload_not_found" };
  const source = await readJson(sourceKey).then(({ json }) => json);
  if (source?.task_id !== taskId) return { indexed: false, reason: "task_mismatch" };
  const item = buildAdminItemFromDocuments({ source, sourceKey });
  await putDashboardIndexItem(item);
  return { indexed: true, task_id: taskId };
}

export function selectReportingPage(dashboard, options = {}) {
  const includeContent = Boolean(options.includeContent);
  const includeLlmReviews = Boolean(options.includeLlmReviews);
  const requestedTaskId = cleanText(options.taskId, 160);
  const requestedStatus = ["pending", "in_review", "approved", "rejected"].includes(options.status)
    ? options.status
    : "";
  const filteredItems = (dashboard.items ?? []).filter((item) =>
    (!requestedTaskId || item.task_id === requestedTaskId) &&
    (!requestedStatus || item.status === requestedStatus)
  );
  const offset = requestedTaskId ? 0 : Math.max(0, Number(options.offset) || 0);
  const requestedLimit = Number(options.limit);
  // Metadata rows are small: one page can hold the whole corpus. Content rows
  // carry prompts + rubrics (a few KB each); LLM artifacts are ~30KB each and
  // stay tightly paged. llm_flags reads the artifact too but emits only a
  // compact summary, so it gets a middle-sized page.
  const includeLlmFlags = Boolean(options.includeLlmFlags);
  const maxPageSize = includeLlmReviews ? 25 : includeLlmFlags ? 200 : includeContent ? 150 : 5_000;
  const limit = requestedTaskId
    ? filteredItems.length || 1
    : Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(maxPageSize, Math.floor(requestedLimit))
      : filteredItems.length || 1;
  return { filteredItems, sourceItems: filteredItems.slice(offset, offset + limit), offset, limit };
}

export async function hydrateReportingLlmReviews(dashboard, options = {}, loadReview = async (key) => (
  readJson(key).then(({ json }) => json).catch(() => null)
)) {
  const { sourceItems } = selectReportingPage(dashboard, options);
  for (let offset = 0; offset < sourceItems.length; offset += 25) {
    await Promise.all(sourceItems.slice(offset, offset + 25).map(async (item) => {
      item.llm_review = item.llm_review_key ? await loadReview(item.llm_review_key) : null;
      const reviewHash = item.llm_review?.task_content_hash ?? item.llm_review?.source_hash ?? null;
      item.llm_review_stale = Boolean(item.llm_review_stale || (reviewHash && reviewHash !== item.task_content_hash));
      if (item.llm_review_stale) item.llm_review_status = "stale";
    }));
  }
  return dashboard;
}

// Compact "which Codex checks fired" summary from a review artifact, so
// reporting rows can carry more than passed/attention without shipping the
// whole artifact. Checks: website feasibility (any rubric not POSSIBLE),
// step alignment (any rubric quality check not PASS), task quality/coherence,
// overall public-web feasibility (manager disposition).
export function llmFlagSummary(review) {
  if (!review || typeof review !== "object") return null;
  const human = review.rubrics && review.status ? review : llmReviewForHuman(review);
  if (!human) return null;
  const flags = [];
  const rubrics = Array.isArray(human.rubrics) ? human.rubrics : [];
  const infeasible = rubrics.filter((rubric) => rubric.verdict && rubric.verdict !== "POSSIBLE");
  const misaligned = rubrics.filter((rubric) => rubric.quality_verdict && rubric.quality_verdict !== "PASS");
  if (infeasible.length) flags.push("website_feasibility");
  if (misaligned.length) flags.push("step_alignment");
  const coherence = human.quality?.task_coherence?.verdict ?? human.quality?.overall_verdict ?? null;
  if (coherence && coherence !== "PASS") flags.push("task_quality");
  if (human.manager_disposition && human.manager_disposition !== "FEASIBLE") flags.push("overall_feasibility");
  return {
    llm_flag_count: flags.length,
    llm_flags: flags,
    llm_result: cleanText(human.status, 40) || null,
    llm_rubrics_infeasible: infeasible.map((rubric) => rubric.rubric_id),
    llm_rubrics_misaligned: misaligned.map((rubric) => rubric.rubric_id),
    llm_has_repair_plan: Boolean(human.task_repair || human.repair_plan),
  };
}

export async function hydrateReportingLlmFlags(dashboard, options = {}, loadReview = async (key) => (
  readJson(key).then(({ json }) => json).catch(() => null)
)) {
  const { sourceItems } = selectReportingPage(dashboard, options);
  for (let offset = 0; offset < sourceItems.length; offset += 25) {
    await Promise.all(sourceItems.slice(offset, offset + 25).map(async (item) => {
      const key = item.llm_review_key ?? item.llm_pre_qc_key ?? null;
      if (item.llm_flags_loaded_for === key) return;
      const review = key ? await loadReview(key) : null;
      item.llm_flags = review ? { ...llmFlagSummary(review), llm_flags_stage: key === item.llm_review_key ? item.llm_review_stage ?? "PRE_QC" : "PRE_QC" } : null;
      item.llm_flags_loaded_for = key;
    }));
  }
  return dashboard;
}

// Reporting identity hygiene: one display name per participant_id (the most
// frequent spelling, ties broken toward the one with capital letters), plus
// an optional admin-maintained alias map that pins duplicate accounts to a
// canonical id ({review-root}config/participant_aliases.json: {alias: canonical}).
export function canonicalParticipantNames(items) {
  const tally = new Map(); // pid -> Map(name -> count)
  for (const item of items ?? []) {
    const pid = item?.participant_id || "";
    const name = String(item?.participant_name || "").trim();
    if (!pid || !name) continue;
    if (!tally.has(pid)) tally.set(pid, new Map());
    const names = tally.get(pid);
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const out = new Map();
  for (const [pid, names] of tally) {
    const ranked = [...names.entries()].sort((a, b) =>
      b[1] - a[1] ||
      Number(/[A-Z]/.test(b[0])) - Number(/[A-Z]/.test(a[0])) ||
      a[0].localeCompare(b[0]));
    out.set(pid, ranked[0][0]);
  }
  return out;
}

export function applyParticipantAliases(pid, aliases) {
  const map = aliases && typeof aliases === "object" ? aliases : {};
  let current = String(pid || "");
  for (let hop = 0; hop < 5 && map[current] && map[current] !== current; hop += 1) current = String(map[current]);
  return current;
}

let participantAliasCache = { aliases: null, checkedAt: 0 };
async function participantAliases() {
  if (participantAliasCache.aliases && Date.now() - participantAliasCache.checkedAt < 60_000) return participantAliasCache.aliases;
  const aliases = await readJson(`${REVIEW_PREFIX}config/participant_aliases.json`)
    .then(({ json }) => (json && typeof json === "object" && !Array.isArray(json) ? json : {}))
    .catch(() => ({}));
  participantAliasCache = { aliases, checkedAt: Date.now() };
  return aliases;
}

// Upload time is the server-minted timestamp in the S3 key
// ({ts}-{nonce}_long_task.json); the payload's created_at is when the draft
// was first assembled for submission on the client.
export function uploadedAtFromSourceKey(sourceKey) {
  const match = /\/(\d{13})-[A-Za-z0-9]+_[^/]*$/.exec(String(sourceKey || ""));
  return match ? new Date(Number(match[1])).toISOString() : "";
}

export function reviewMinutes(claimedAt, reviewedAt) {
  return stageMinutes(claimedAt, reviewedAt);
}

export function buildReportingReport(dashboard, generatedAt = new Date().toISOString(), options = {}) {
  const includeContent = Boolean(options.includeContent);
  const includeLlmReviews = Boolean(options.includeLlmReviews);
  const includeLlmFlags = Boolean(options.includeLlmFlags);
  const aliases = options.participantAliases ?? {};
  const skipCounts = options.skipCounts instanceof Map ? options.skipCounts : new Map();
  const canonicalNames = canonicalParticipantNames(dashboard.items ?? []);
  const { filteredItems, sourceItems, offset, limit } = selectReportingPage(dashboard, options);
  const items = sourceItems.map((item) => {
    const effective = item.final ?? item.original ?? {};
    const metadata = effective.metadata ?? item.original?.metadata ?? {};
    const rubrics = Array.isArray(item.rubrics) ? item.rubrics : [];
    const editedRubrics = rubrics.filter((rubric) => rubric.changed);
    const canonicalId = applyParticipantAliases(item.participant_id, aliases);
    const skips = skipCounts.get(item.review_unit || reviewUnitForKey(item.source_key || "")) ?? null;
    const changedInQc = item.changed_in_qc == null ? Boolean(item.changed) : Boolean(item.changed_in_qc);
    return {
    task_id: item.task_id,
    participant_id: item.participant_id,
    canonical_participant_id: canonicalId,
    participant_name: canonicalNames.get(canonicalId) ?? canonicalNames.get(item.participant_id) ?? item.participant_name,
    participant_name_raw: item.participant_name,
    participant_email: item.participant_email,
    mode: item.mode,
    authoring_started_at: item.authoring_started_at || "",
    created_at: item.submitted_at,
    submitted_at: item.submitted_at,
    uploaded_at: uploadedAtFromSourceKey(item.source_key),
    authoring_minutes: reviewMinutes(item.authoring_started_at, item.submitted_at),
    status: item.status,
    qc_completed: item.status === "approved" || item.status === "rejected",
    reviewer: item.reviewer,
    claimed_at: item.claimed_at || "",
    reviewed_at: item.reviewed_at,
    review_minutes: reviewMinutes(item.claimed_at, item.reviewed_at),
    changed_in_qc: changedInQc,
    changed_after_approval: Boolean(item.changed && !changedInQc),
    amended_by: item.amended_by ?? "",
    amended_at: item.amended_at ?? "",
    signoff_at: item.signoff_at ?? "",
    signoff_action: item.signoff_action ?? "",
    signoff_minutes: stageMinutes(item.signoff_opened_at, item.signoff_at),
    author_edit_minutes: stageMinutes(item.edit_started_at, item.submitted_at),
    appeal_minutes: stageMinutes(item.appeal_started_at, item.submitted_at),
    appeal_number: item.appeal_number ?? 0,
    final_gold_revision: item.final_gold_revision ?? 0,
    title_edited: Boolean(item.human_review?.title_edited),
    request_edited: Boolean(item.human_review?.request_edited),
    rubric_count: rubrics.length,
    rubrics_edited: editedRubrics.length,
    rubrics_edited_ids: editedRubrics.map((rubric) => rubric.rubric_id),
    skip_count: skips ? skips.count : 0,
    skipped_by: skips ? skips.reviewers : [],
    anchored_country: cleanText(metadata.region, 120) || "",
    subjects: Array.isArray(metadata.subjects) ? metadata.subjects.slice(0, 10) : [],
    rejection_reason: item.rejection_reason,
    trajectory_count: item.trajectory_count,
    visit_count: item.visit_count,
    llm_review_status: item.llm_review_status ?? "not_reviewed",
    llm_review_stage: item.llm_review_stage ?? null,
    // Pre-QC outcome regardless of workflow state — approved/rejected tasks
    // keep the Codex lead their reviewer saw (llm_review_status switches to
    // the POST_QC artifact once a task is decided).
    llm_pre_qc_status: item.llm_pre_qc_status ?? "not_reviewed",
    ...(includeLlmFlags ? {
      llm_flag_count: item.llm_flags?.llm_flag_count ?? null,
      llm_flags: item.llm_flags?.llm_flags ?? null,
      llm_result: item.llm_flags?.llm_result ?? null,
      llm_rubrics_infeasible: item.llm_flags?.llm_rubrics_infeasible ?? null,
      llm_rubrics_misaligned: item.llm_flags?.llm_rubrics_misaligned ?? null,
      llm_has_repair_plan: item.llm_flags?.llm_has_repair_plan ?? null,
      llm_flags_stage: item.llm_flags?.llm_flags_stage ?? null,
    } : {}),
    ...(includeContent ? {
      content: {
        task_content_hash: item.task_content_hash,
        original: item.original,
        final: item.final,
        rubrics: item.rubrics ?? [],
        human_review: item.human_review ?? null,
      },
    } : {}),
    ...(includeLlmReviews ? {
      llm_review: item.llm_review == null
        ? null
        : {
            ...item.llm_review,
            review_stage: item.llm_review_stage ?? null,
            stale: Boolean(item.llm_review_stale),
          },
      llm_review_result: cleanText(item.llm_review?.status, 40) || null,
      llm_manager_disposition: cleanText(item.llm_review?.manager_review?.disposition, 40) || null,
      llm_rubric_results: llmRubricResultsFromReview(item.llm_review),
      llm_feedback: llmFeedbackFromReview(item.llm_review),
      llm_repair_plan: llmRepairPlanFromReview(item.llm_review),
      llm_evergreen_review: llmEvergreenReviewFromReview(item.llm_review),
      llm_quality_review: llmQualityReviewFromReview(item.llm_review),
    } : {}),
    };
  });
  const totals = { submitted: filteredItems.length, pending: 0, in_review: 0, approved: 0, rejected: 0, qc_completed: 0 };
  for (const item of filteredItems) {
    if (item.status in totals) totals[item.status] += 1;
    if (item.status === "approved" || item.status === "rejected") totals.qc_completed += 1;
  }
  const nextOffset = offset + sourceItems.length < filteredItems.length ? offset + sourceItems.length : null;
  return {
    schema_version: includeContent || includeLlmReviews ? "odyssey_internal_reporting_v2" : "odyssey_internal_reporting_v1",
    generated_at: generatedAt,
    totals,
    users: dashboard.users ?? [],
    tasks: items,
    page: {
      offset,
      limit,
      returned: sourceItems.length,
      next_offset: nextOffset,
      filtered_total: filteredItems.length,
    },
    // True whenever this response does not contain every matching row —
    // either the source listing was capped or this is one page of several.
    truncated: Boolean(dashboard.truncated) || nextOffset !== null,
    source_total: dashboard.total ?? filteredItems.length,
    // When served from the scheduled snapshot: when that snapshot was built
    // (reporting lags live state by up to ~5 minutes). Null = built live.
    snapshot_built_at: dashboard.snapshot_built_at ?? null,
  };
}

export function sortPendingReviewUnits(units) {
  return [...units]
    .sort((a, b) => a.oldestAt - b.oldestAt || a.newest.localeCompare(b.newest))
    .map((unit) => unit.newest);
}

// Shared index for the reviewer queue and author-facing task pages. Done
// records are fetched only when a caller needs their contents and may be
// narrowed to one author/unit to keep page loads proportional.
async function loadReviewIndex({ readDoneRecords = false, doneRecordFilter = null } = {}) {
  const [inbox, doneObjects, lockObjects, reopenKeys] = await Promise.all([
    listAllObjects(`${REVIEW_PREFIX}inbox/`),
    listAllObjects(`${REVIEW_PREFIX}done/`),
    listAllObjects(`${REVIEW_PREFIX}locks/`),
    listAll(REOPEN_PREFIX),
  ]);
  const inboxAge = new Map(); // submission key -> marker LastModified ms
  const submissions = [];
  for (const o of inbox) {
    try {
      const k = fromB64url(o.Key.slice(`${REVIEW_PREFIX}inbox/`.length));
      if (isReviewSubmissionKey(k)) {
        submissions.push(k);
        inboxAge.set(k, o.LastModified?.getTime() ?? 0);
      }
    } catch {
      /* malformed marker — ignore */
    }
  }
  submissions.sort(); // deterministic grouping; queue order is assigned below from marker time
  const doneSet = new Set(doneObjects.map((object) => object.Key.slice(`${REVIEW_PREFIX}done/`.length)));
  let doneByEncodedKey = null;
  if (readDoneRecords) {
    doneByEncodedKey = new Map();
    const wanted = [];
    for (const object of doneObjects) {
      const encoded = object.Key.slice(`${REVIEW_PREFIX}done/`.length);
      let subKey;
      try {
        subKey = fromB64url(encoded);
      } catch {
        continue;
      }
      if (doneRecordFilter && !doneRecordFilter(subKey)) continue;
      wanted.push({ encoded, subKey });
    }
    for (let offset = 0; offset < wanted.length; offset += 25) {
      await Promise.all(wanted.slice(offset, offset + 25).map(async ({ encoded, subKey }) => {
        const record = await readDoneRecord(subKey);
        if (record) doneByEncodedKey.set(encoded, record);
      }));
    }
  }
  // Only fresh locks suppress the claim button. Stale or malformed locks are
  // deliberately treated as claimable; tryLock() atomically takes them over.
  const lockReads = await Promise.all(lockObjects.map(async (o) => {
    const encoded = o.Key.slice(`${REVIEW_PREFIX}locks/`.length, -".json".length);
    try {
      const { json } = await readJson(o.Key);
      return {
        encoded,
        active: reviewLockIsActiveForQueue(json),
        finalizing: Boolean(json?.finalizing),
        unresolved: false,
      };
    } catch {
      return { encoded, active: false, finalizing: false, unresolved: true };
    }
  }));
  const lockSet = new Set(lockReads.filter((entry) => entry.active).map((entry) => entry.encoded));
  const finalizingSet = new Set(
    lockReads.filter((entry) => entry.active && entry.finalizing).map((entry) => entry.encoded),
  );
  const unresolvedLockSet = new Set(lockReads.filter((entry) => entry.unresolved).map((entry) => entry.encoded));
  const byTaskDir = new Map(); // unit -> { newest, files, oldestAt }
  for (const k of submissions) {
    const unit = reviewUnitForKey(k);
    const markerAt = inboxAge.get(k) ?? 0;
    const entry = byTaskDir.get(unit) ?? { newest: k, files: [], oldestAt: markerAt };
    entry.files.push(k);
    if (k > entry.newest) entry.newest = k; // timestamped names sort chronologically
    entry.oldestAt = Math.min(entry.oldestAt, markerAt);
    byTaskDir.set(unit, entry);
  }
  return {
    byTaskDir,
    lockSet,
    finalizingSet,
    unresolvedLockSet,
    doneSet,
    doneByEncodedKey,
    inboxAge,
    reopenExclusions: reopenExclusionsFromKeys(reopenKeys),
    counts: { submitted: byTaskDir.size, finished: doneSet.size, locked: lockSet.size },
  };
}

// A completed older revision must not hide a newer returned-task edit or
// appeal. The newest file alone determines whether the unit is pending.
export function pendingReviewUnits(units, doneSet, finalizingSet = new Set()) {
  const pendingUnits = [];
  for (const { newest, oldestAt } of units) {
    const encoded = b64url(newest);
    // A finalizing lock is also the durable retry trigger for crash recovery.
    // Keep it reachable even when recovery already reconstructed the done
    // record but a later credit/index side effect failed.
    if (!doneSet.has(encoded) || finalizingSet.has(encoded)) pendingUnits.push({ newest, oldestAt });
  }
  return pendingUnits;
}

export function reviewQueueAvailability(subKeys, lockSet, finalizingSet) {
  let claimable = 0;
  let locked = 0;
  for (const key of subKeys ?? []) {
    const encoded = b64url(key);
    const activeLock = lockSet?.has(encoded);
    const recoverableFinalization = finalizingSet?.has(encoded);
    if (!activeLock || recoverableFinalization) claimable += 1;
    else locked += 1;
  }
  return { claimable, locked };
}

export function durableDoneStateIsReadable(doneSet, doneByEncodedKey, subKey) {
  const encoded = b64url(subKey);
  return !doneSet?.has(encoded) || Boolean(doneByEncodedKey?.has(encoded));
}

export function listedLockStateAllowsEdit(lockSet, unresolvedLockSet, subKey) {
  const encoded = b64url(subKey);
  return !lockSet?.has(encoded) && !unresolvedLockSet?.has(encoded);
}

export async function resolveDoneRecordsForReopen({ files, newest, currentDone, listedDoneKeys, readDone }) {
  const records = [{ key: newest, done: currentDone }];
  for (const key of files ?? []) {
    if (key === newest || !listedDoneKeys?.has(b64url(key))) continue;
    const done = await readDone(key);
    if (!done) throw new Error(`Listed completion state is unreadable for ${key}`);
    records.push({ key, done });
  }
  return records;
}

export function newestReviewRevision(keys, unit) {
  return (keys ?? [])
    .filter((key) => isReviewSubmissionKey(key) && reviewUnitForKey(key) === unit)
    .sort()
    .at(-1) ?? null;
}

export function claimCandidateIsCurrent(subKey, storedSubKeys, hasDone = false, inboxMarkerExists = true) {
  if (hasDone || !inboxMarkerExists) return false;
  return newestReviewRevision(storedSubKeys, reviewUnitForKey(subKey)) === subKey;
}

async function revalidateClaimCandidate(subKey) {
  const unit = reviewUnitForKey(subKey);
  const dir = subKey.slice(0, subKey.lastIndexOf("/") + 1);
  const storedSubKeys = (await listAll(dir))
    .filter((key) => isReviewSubmissionKey(key) && reviewUnitForKey(key) === unit);
  const inboxMarkerExists = await s3.send(new HeadObjectCommand({
    Bucket: S3_BUCKET,
    Key: inboxKeyFor(subKey),
  })).then(() => true).catch(() => false);
  const doneDefinitelyAbsent = await s3.send(new HeadObjectCommand({
    Bucket: S3_BUCKET,
    Key: doneKeyFor(subKey),
  })).then(() => false).catch((error) => headErrorConfirmsAbsent(error));
  if (!doneDefinitelyAbsent) return false;
  if (!claimCandidateIsCurrent(subKey, storedSubKeys, false, inboxMarkerExists)) return false;
  const revision = await readJson(subKey).then(({ json }) => json).catch(() => null);
  if (!revision) return false;
  if (revision.appeal_of_sub_key) {
    const marker = await readJson(appealKeyFor(subKey)).then(({ json }) => json).catch(() => null);
    if (!appealMarkerIsVerified(marker, subKey, revision)) return false;
  }
  return true;
}

// The queue state: task submissions minus finished ones minus fresh locks.
async function queueState() {
  const state = await loadReviewIndex();
  // Real FIFO across participants. Sorting full S3 keys put participant names
  // before timestamps, which could starve later-alphabet users as volume grew.
  const pending = sortPendingReviewUnits(
    pendingReviewUnits([...state.byTaskDir.values()], state.doneSet, state.finalizingSet),
  );
  return {
    pending,
    lockSet: state.lockSet,
    finalizingSet: state.finalizingSet,
    inboxAge: state.inboxAge,
    reopenExclusions: state.reopenExclusions,
    counts: state.counts,
  };
}

// Status tiles tolerate a few seconds of staleness; claims must not (a stale
// done-set could hand out a just-finished task). Cache the queue listing for
// the status path only.
let queueStateCache = { state: null, checkedAt: 0, pending: null };
async function cachedQueueState() {
  const now = Date.now();
  if (queueStateCache.state && now - queueStateCache.checkedAt < 10_000) return queueStateCache.state;
  if (!queueStateCache.pending) queueStateCache.pending = queueState();
  try {
    const state = await queueStateCache.pending;
    queueStateCache = { state, checkedAt: Date.now(), pending: null };
    return state;
  } catch (error) {
    queueStateCache.pending = null;
    throw error;
  }
}

// Rejection keys end in `_<sha256-prefix>.json`; task ids may themselves
// contain underscores, so split on the final underscore only.
export function distinctRejectedTaskIds(rejectedKeys) {
  const ids = new Set();
  for (const key of rejectedKeys) {
    const name = String(key).slice(String(key).lastIndexOf("/") + 1).replace(/\.json$/, "");
    const cut = name.lastIndexOf("_");
    ids.add(cut > 0 ? name.slice(0, cut) : name);
  }
  return ids;
}

export function participantIdFromFinishedKey(key) {
  const name = String(key).slice(String(key).lastIndexOf("/") + 1).replace(/\.json$/, "");
  const match = /^v2_([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)_internal_/.exec(name);
  return match?.[1] ?? null;
}

export function sortFinishedExamples(items, limit = 30) {
  return (items ?? [])
    .filter(Boolean)
    .sort((a, b) => String(b.finished_at || "").localeCompare(String(a.finished_at || "")))
    .slice(0, Math.max(0, Number(limit) || 0));
}

async function ownAwaitingSignoff(finishedKeys, reviewerPid) {
  const pid = String(reviewerPid || "").trim().toLowerCase();
  if (!VALID_PID.test(pid)) return 0;
  const own = finishedKeys.filter((key) => participantIdFromFinishedKey(key) === pid);
  if (!own.length) return 0;
  const signoffs = await listAllObjects(AUTHOR_SIGNOFF_PREFIX);
  let signed = 0;
  for (const object of signoffs) {
    const encoded = object.Key.slice(AUTHOR_SIGNOFF_PREFIX.length).replace(/\.json$/, "");
    try {
      const subKey = fromB64url(encoded);
      if (participantIdFromSubKey(subKey) === pid && subKey.includes("/v2/")) signed += 1;
    } catch {
      // Ignore malformed receipt keys.
    }
  }
  return Math.max(0, own.length - signed);
}

export function buildAuthorHistory({ revisions, doneRecords, finalGoldHistory, currentAmendment, signoff }) {
  const entries = [];
  for (const revision of revisions ?? []) {
    const appeal = Boolean(revision.appeal_submission);
    const startedAt = revision.appeal_started_at ?? revision.edit_started_at ?? null;
    entries.push({
      at: revision.created_at ?? "",
      event: revision.first ? "submitted" : appeal ? "appealed" : "revised",
      by: "",
      minutes: stageMinutes(startedAt, revision.created_at),
      note: "",
    });
  }
  for (const done of doneRecords ?? []) {
    const outcome = doneOutcome(done);
    if (!outcome) continue;
    entries.push({
      at: done.completed_at ?? "",
      event: outcome,
      // Reviewer identity is never part of an author-facing history entry.
      by: "",
      minutes: null,
      note: "",
    });
  }
  for (const record of finalGoldHistory ?? []) {
    if (record.source !== "author") continue;
    entries.push({ at: record.at ?? "", event: "amended", by: "", minutes: null, note: "" });
  }
  if (signoff?.signed_off_at && signoff.action === "accepted") {
    entries.push({
      at: signoff.signed_off_at,
      event: "accepted",
      by: "",
      minutes: stageMinutes(signoff.opened_at, signoff.signed_off_at),
      note: "",
    });
  }
  if (currentAmendment?.amended_at) {
    entries.push({
      at: currentAmendment.amended_at,
      event: "amended",
      by: "",
      minutes: null,
      note: "",
    });
  }
  return entries
    .filter((entry) => entry.at)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.event.localeCompare(b.event));
}

async function authorTaskHistory(subKey) {
  const unit = reviewUnitForKey(subKey);
  const [objects, doneObjects] = await Promise.all([
    listAllObjects(`${unit}/`),
    listAllObjects(`${REVIEW_PREFIX}done/`),
  ]);
  const keys = objects.map((object) => object.Key).filter(isReviewSubmissionKey).sort();
  const revisions = [];
  for (let offset = 0; offset < keys.length; offset += 25) {
    const page = await Promise.all(keys.slice(offset, offset + 25).map((key) =>
      readJson(key).then(({ json }) => json).catch(() => null)
    ));
    revisions.push(...page.filter(Boolean));
  }
  revisions.forEach((revision, index) => { revision.first = index === 0; });
  const wanted = [];
  for (const object of doneObjects) {
    try {
      const key = fromB64url(object.Key.slice(`${REVIEW_PREFIX}done/`.length));
      if (reviewUnitForKey(key) === unit) wanted.push(key);
    } catch {
      // Ignore malformed done keys.
    }
  }
  const doneRecords = (await Promise.all(wanted.map((key) => readDoneRecord(key)))).filter(Boolean);
  const approved = [...doneRecords]
    .filter((record) => doneOutcome(record) === "approved")
    .sort((a, b) => String(b.completed_at || "").localeCompare(String(a.completed_at || "")))[0];
  const finished = approved?.target
    ? await readJson(approved.target).then(({ json }) => json).catch(() => null)
    : null;
  return buildAuthorHistory({
    revisions,
    doneRecords,
    finalGoldHistory: Array.isArray(finished?.history) ? finished.history : [],
    currentAmendment: finished?.amended_at ? finished : null,
    signoff: await readJson(authorSignoffKeyFor(subKey)).then(({ json }) => json).catch(() => null),
  });
}

async function writeAuthorSignoff({ subKey, taskId, participantId, action, contentHash, openedAt, at }) {
  const receipt = {
    sub_key: subKey,
    task_id: taskId,
    participant_id: participantId,
    action,
    acknowledged_content_hash: contentHash,
    opened_at: openedAt,
    signed_off_at: at,
  };
  const key = authorSignoffKeyFor(subKey);
  const created = await tryConditionalWrite(() => s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: JSON.stringify(receipt, null, 2),
    ContentType: "application/json",
    IfNoneMatch: "*",
  })));
  if (created) return { receipt, created: true };
  const existing = await readJson(key).catch(() => null);
  if (!existing) return { receipt: null, created: false };
  if (action !== "amended") return { receipt: existing.json, created: false };
  const replaced = await tryConditionalWrite(() => s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: JSON.stringify(receipt, null, 2),
    ContentType: "application/json",
    IfMatch: existing.etag,
  })));
  return replaced ? { receipt, created: false } : { receipt: existing.json, created: false };
}

export function buildAuthorApprovedFinal({
  finished,
  finalGoldKey,
  subKey,
  taskId,
  participantId,
  action,
  approvedAt,
}) {
  if (!finished || typeof finished !== "object" || Array.isArray(finished)) return null;
  return {
    ...finished,
    author_approval: {
      schema_version: "apollo-author-approval-v1",
      participant_id: String(participantId || "").trim().toLowerCase(),
      action: action === "amended" ? "amended" : "accepted",
      approved_at: String(approvedAt || ""),
      acknowledged_content_hash: String(finished.review_content_hash || ""),
      source_key: String(subKey || ""),
      final_gold_key: String(finalGoldKey || ""),
      task_id: String(taskId || ""),
    },
  };
}

export function authorApprovedFinalMatches(actual, expected) {
  if (!actual || !expected) return false;
  const left = actual.author_approval ?? {};
  const right = expected.author_approval ?? {};
  return String(actual.review_content_hash || "") === String(expected.review_content_hash || "")
    && String(actual.task_id || "") === String(expected.task_id || "")
    && ["participant_id", "action", "approved_at", "acknowledged_content_hash", "source_key", "final_gold_key", "task_id"]
      .every((field) => String(left[field] || "") === String(right[field] || ""));
}

async function writeAuthorApprovedFinal(args) {
  const document = buildAuthorApprovedFinal(args);
  if (!document || !VALID_PID.test(document.author_approval.participant_id)) {
    throw new Error("Cannot store author-approved final without a valid author and final document");
  }
  const key = authorApprovedKeyFor(args.taskId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let current = null;
    try {
      current = await readJson(key);
    } catch (error) {
      if (!isMissingObjectError(error)) throw error;
    }
    if (current && authorApprovedFinalMatches(current.json, document)) {
      return { key, document: current.json, created: false };
    }
    if (current) {
      const currentAuthor = String(current.json?.author_approval?.participant_id || "");
      if (currentAuthor && currentAuthor !== document.author_approval.participant_id) {
        throw new Error("Author-approved final belongs to a different participant");
      }
      const replaced = await tryConditionalWrite(() => s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: JSON.stringify(document, null, 2),
        ContentType: "application/json",
        IfMatch: current.etag,
      })));
      if (replaced) return { key, document, created: false };
      continue;
    }
    const created = await tryConditionalWrite(() => s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: JSON.stringify(document, null, 2),
      ContentType: "application/json",
      IfNoneMatch: "*",
    })));
    if (created) return { key, document, created: true };
  }
  const latest = await readJson(key).then(({ json }) => json).catch(() => null);
  if (authorApprovedFinalMatches(latest, document)) {
    return { key, document: latest, created: false };
  }
  throw new Error("Author-approved final changed concurrently");
}

async function rejectedByPidForAppeal(subKey, appealOfSubKey, doneByEncodedKey = null) {
  if (appealOfSubKey) {
    const priorDone = doneByEncodedKey?.get(b64url(appealOfSubKey)) ?? await readDoneRecord(appealOfSubKey);
    const fromRejection = doneOutcome(priorDone) === "rejected" && priorDone?.target
      ? await readJson(priorDone.target)
        .then(({ json }) => rejectedByPidFromDocument(json))
        .catch(() => "")
      : "";
    if (fromRejection) return fromRejection;
  }
  // Legacy rejection records may not carry reviewer_pid. Preserve a verified
  // existing route in that case, but never let it override authoritative
  // rejection provenance when that provenance exists.
  return await readJson(appealKeyFor(subKey))
    .then(({ json }) => rejectedByPidFromDocument(json))
    .catch(() => "");
}

async function appealRejecters() {
  const objects = await listAllObjects(APPEAL_PREFIX);
  const byKey = new Map();
  for (let offset = 0; offset < objects.length; offset += 25) {
    await Promise.all(objects.slice(offset, offset + 25).map(async (object) => {
      let subKey;
      try {
        const encoded = object.Key.slice(APPEAL_PREFIX.length).replace(/\.json$/, "");
        subKey = fromB64url(encoded);
      } catch {
        return;
      }
      const record = await readJson(object.Key).then(({ json }) => json).catch(() => null);
      const rejectedByPid = rejectedByPidFromDocument(record);
      byKey.set(
        subKey,
        record?.sub_key === subKey && rejectedByPid ? rejectedByPid : UNVERIFIED_APPEAL_REJECTER,
      );
    }));
  }
  return byKey;
}

// Atomically claim: create the lock with If-None-Match (first writer wins).
// A stale lock (crashed reviewer) is taken over with If-Match on its ETag, so
// two takeover attempts can't both win.
async function tryLock(subKey, reviewer, scopedLockKeyFor = lockKeyFor, reviewerPid = "") {
  const token = randomUUID();
  const normalizedReviewerPid = String(reviewerPid || "").trim().toLowerCase();
  const lockBody = JSON.stringify({
    reviewer,
    ...(VALID_PID.test(normalizedReviewerPid) ? { reviewer_pid: normalizedReviewerPid } : {}),
    token,
    claimed_at: new Date().toISOString(),
  });
  const lockKey = scopedLockKeyFor(subKey);
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: lockKey,
        Body: lockBody,
        ContentType: "application/json",
        IfNoneMatch: "*",
      })
    );
    return token;
  } catch (err) {
    const code = err.$metadata?.httpStatusCode;
    // 412 = lock exists; 409 ConditionalRequestConflict = concurrent
    // conditional writes on the same key — both mean "we lost the race",
    // never a server error.
    if (code !== 412 && code !== 409 && err.name !== "PreconditionFailed" && err.name !== "ConditionalRequestConflict") {
      throw err;
    }
    if (code === 409 || err.name === "ConditionalRequestConflict") return null;
  }
  // Lock exists — is it stale?
  try {
    const { json: existing, etag } = await readJson(lockKey);
    // A finalization marker is a durable in-flight decision, not an abandoned
    // claim. Never overwrite it on TTL: the same reviewer may safely resume it
    // and reconstruct done, while author edits must remain blocked.
    if (existing?.finalizing) return null;
    // Unparseable claimed_at reads as age=Infinity (stale, reclaimable) —
    // never as an eternally held lock.
    const claimedAt = Date.parse(existing.claimed_at);
    const age = Number.isFinite(claimedAt) ? Date.now() - claimedAt : Infinity;
    if (!(age > Number(LOCK_TTL_MS))) return null;
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: lockKey,
        Body: lockBody,
        ContentType: "application/json",
        IfMatch: etag,
      })
    );
    return token;
  } catch {
    return null; // someone else took it, or read failed — move on
  }
}

// Returns the lock's ETag when the caller's token matches, else null. The
// ETag lets release/submit delete the lock CONDITIONALLY, so a takeover that
// lands between verify and delete is never clobbered.
// When the lock was taken — read before it is deleted at finalization so the
// done record can carry review duration (claimed_at → completed_at).
async function lockClaimedAt(subKey, scopedLockKeyFor = lockKeyFor) {
  try {
    const { json } = await readJson(scopedLockKeyFor(subKey));
    const at = Date.parse(String(json?.claimed_at || ""));
    return Number.isFinite(at) ? new Date(at).toISOString() : "";
  } catch {
    return "";
  }
}

async function verifyLock(subKey, token, scopedLockKeyFor = lockKeyFor) {
  try {
    const { json, etag } = await readJson(scopedLockKeyFor(subKey));
    return json.token === token ? etag : null;
  } catch {
    return null;
  }
}

export function decisionReviewerPid(suppliedPid, lock, token) {
  const fromLock = lock?.token === token
    ? String(lock?.reviewer_pid || "").trim().toLowerCase()
    : "";
  if (VALID_PID.test(fromLock)) return fromLock;
  const supplied = String(suppliedPid || "").trim().toLowerCase();
  return VALID_PID.test(supplied) ? supplied : "";
}

async function reviewerPidForDecision(subKey, token, suppliedPid) {
  const lock = await readJson(lockKeyFor(subKey)).then(({ json }) => json).catch(() => null);
  return decisionReviewerPid(suppliedPid, lock, token);
}

export function reviewLockCanRelease(lock, token) {
  return Boolean(lock && lock.token === token && !lock.finalizing);
}

export function reviewLockIsActiveForQueue(lock, now = Date.now(), ttlMs = Number(LOCK_TTL_MS)) {
  if (lock?.finalizing) return true;
  const claimedAt = Date.parse(String(lock?.claimed_at || ""));
  return Number.isFinite(claimedAt) && now - claimedAt <= Number(ttlMs);
}

export function reviewDecisionIsCurrent({ subKey, storedSubKeys, lock, token, now = Date.now(), ttlMs = Number(LOCK_TTL_MS) }) {
  return newestReviewRevision(storedSubKeys, reviewUnitForKey(subKey)) === subKey
    && lock?.token === token
    && reviewLockIsActiveForQueue(lock, now, ttlMs);
}

export function finalizingOutcomeDescriptor(subKey, source, lock) {
  const rawTaskId = String(source?.task_id || "");
  if (!rawTaskId || !lock?.finalizing || !lock?.content_hash) return null;
  const taskId = rawTaskId.replace(/[^A-Za-z0-9_-]/g, "_");
  if (lock.outcome === "approved") {
    return { outcome: "approved", target: `${REVIEW_PREFIX}finished/${taskId}.json`, hashField: "review_content_hash", taskId };
  }
  if (lock.outcome === "rejected") {
    return {
      outcome: "rejected",
      target: `${REVIEW_PREFIX}rejected/${taskId}_${createHash("sha256").update(subKey).digest("hex").slice(0, 16)}.json`,
      hashField: "review_content_hash",
      taskId,
    };
  }
  if (lock.outcome === "returned") {
    return { outcome: "returned", target: `${REVIEW_PREFIX}returned/${b64url(subKey)}.json`, hashField: "content_hash", taskId };
  }
  return null;
}

export function finalizingOutcomeMatches(document, descriptor, lock) {
  return Boolean(document && descriptor && lock?.content_hash
    && document[descriptor.hashField] === lock.content_hash);
}

export function finalizingRecoveryPlan(outcome) {
  if (!["approved", "rejected", "returned"].includes(outcome)) return null;
  return {
    creditOutcome: ["approved", "rejected"].includes(outcome) ? outcome : null,
    dashboardStatus: outcome === "returned" ? "pending" : outcome,
    deleteFinalizingLock: true,
    leaveDoneNonclaimable: true,
  };
}

export async function applyFinalizingRecoverySideEffects({ recordCredit, repairDashboard, deleteLock }) {
  if (recordCredit) await recordCredit();
  await repairDashboard();
  return await deleteLock();
}

async function recoverStaleFinalizingReview(subKey) {
  let lockRecord;
  try {
    lockRecord = await readJson(lockKeyFor(subKey));
  } catch (error) {
    return isMissingObjectError(error);
  }
  if (!lockRecord.json?.finalizing) return true;
  let source;
  try {
    source = (await readJson(subKey)).json;
  } catch {
    return false;
  }
  const descriptor = finalizingOutcomeDescriptor(subKey, source, lockRecord.json);
  if (!descriptor) return false;
  let outcomeDocument;
  try {
    outcomeDocument = (await readJson(descriptor.target)).json;
  } catch (error) {
    if (!isMissingObjectError(error)) return false;
    // No durable result exists. Under the unit mutex, conditionally clear the
    // abandoned finalization so a reviewer can reclaim the current revision.
    return await deleteLockIfUnchanged(subKey, lockRecord.etag);
  }
  if (!finalizingOutcomeMatches(outcomeDocument, descriptor, lockRecord.json)) return false;
  const completedAt = String(
    outcomeDocument.finished_at || outcomeDocument.rejected_at || outcomeDocument.returned_at || lockRecord.json.finalizing_at || ""
  );
  const reviewer = String(
    outcomeDocument.reviewed_by || outcomeDocument.rejected_by || outcomeDocument.returned_by || lockRecord.json.reviewer || ""
  );
  const reviewerPid = String(
    outcomeDocument.reviewer_pid || outcomeDocument.rejected_by_pid || outcomeDocument.returned_by_pid || ""
  );
  const done = await writeDoneRecord(subKey, {
    target: descriptor.target,
    outcome: descriptor.outcome,
    reviewer,
    reviewer_pid: reviewerPid,
    task_id: descriptor.taskId,
    completed_at: completedAt,
    claimed_at: cleanText(lockRecord.json.claimed_at, 60),
    content_hash: lockRecord.json.content_hash,
  });
  const reconstructed = done?.target === descriptor.target
    && doneOutcome(done) === descriptor.outcome
    && (!done.content_hash || done.content_hash === lockRecord.json.content_hash);
  if (!reconstructed) return false;
  const recoveryPlan = finalizingRecoveryPlan(descriptor.outcome);
  if (!recoveryPlan) return false;
  const creditedReviewer = String(done.reviewer || reviewer);
  const finalCompletedAt = String(done.completed_at || completedAt);
  const rawTaskId = String(source.task_id);
  const repaired = await applyFinalizingRecoverySideEffects({
    recordCredit: recoveryPlan.creditOutcome
      ? () => recordReviewerCredit(
        creditedReviewer,
        recoveryPlan.creditOutcome,
        subKey,
        descriptor.taskId,
        finalCompletedAt,
      )
      : null,
    repairDashboard: async () => {
      if (descriptor.outcome === "approved") {
        const changed = reviewerChangedTask(outcomeDocument);
        await setDashboardIndexStatus(rawTaskId, "approved", {
          expected_source_key: subKey,
          reviewer: creditedReviewer,
          reviewed_at: finalCompletedAt,
          claimed_at: String(done.claimed_at || lockRecord.json.claimed_at || ""),
          done_target: descriptor.target,
          changed,
          changed_in_qc: changed,
          final_title: outcomeDocument.task?.task_title,
          final_difficulty: outcomeDocument.task?.difficulty,
          final_metadata: outcomeDocument.task?.metadata,
          final_gold_revision: finalGoldRevision(outcomeDocument),
        });
      } else if (descriptor.outcome === "rejected") {
        await setDashboardIndexStatus(rawTaskId, "rejected", {
          expected_source_key: subKey,
          reviewer: creditedReviewer,
          reviewed_at: finalCompletedAt,
          claimed_at: String(done.claimed_at || lockRecord.json.claimed_at || ""),
          rejection_reason: cleanText(outcomeDocument.reason, 500),
          done_target: descriptor.target,
        });
      } else {
        await setDashboardIndexStatus(rawTaskId, "pending", { expected_source_key: subKey });
      }
    },
    // This must remain last: the finalizing lock is the durable retry trigger
    // when a credit or Dynamo repair fails transiently.
    deleteLock: () => deleteLockIfUnchanged(subKey, lockRecord.etag),
  });
  if (!repaired) return false;
  adminDashboardCache = { dashboard: null, checkedAt: 0, pending: null };
  return true;
}

async function verifyCurrentReviewDecision(subKey, token) {
  const unit = reviewUnitForKey(subKey);
  const dir = subKey.slice(0, subKey.lastIndexOf("/") + 1);
  const storedSubKeys = (await listAll(dir))
    .filter((key) => isReviewSubmissionKey(key) && reviewUnitForKey(key) === unit);
  try {
    const { json, etag } = await readJson(lockKeyFor(subKey));
    return reviewDecisionIsCurrent({ subKey, storedSubKeys, lock: json, token }) ? etag : null;
  } catch {
    return null;
  }
}

async function verifyReleasableLock(subKey, token) {
  try {
    const { json, etag } = await readJson(lockKeyFor(subKey));
    return reviewLockCanRelease(json, token) ? etag : null;
  } catch {
    return null;
  }
}

// Turn an editable claim into a specific immutable outcome before writing any
// result object. Different approve/reject actions from concurrent tabs cannot
// both pass this compare-and-swap. Identical retries may safely resume.
async function beginFinalization(subKey, token, reviewer, outcome, contentHash, scopedLockKeyFor = lockKeyFor) {
  const key = scopedLockKeyFor(subKey);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let current;
    try {
      current = await readJson(key);
    } catch {
      return null;
    }
    if (current.json?.token !== token) return null;
    if (current.json?.finalizing) {
      return current.json.outcome === outcome && current.json.content_hash === contentHash ? current.etag : null;
    }
    const next = {
      ...current.json,
      reviewer: current.json.reviewer || reviewer,
      finalizing: true,
      outcome,
      content_hash: contentHash,
      finalizing_at: new Date().toISOString(),
    };
    try {
      const result = await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: JSON.stringify(next),
        ContentType: "application/json",
        IfMatch: current.etag,
      }));
      return result.ETag || (await readJson(key)).etag;
    } catch (err) {
      if (!isConditionalConflict(err)) throw err;
      // Re-read once: an identical retry is allowed to converge, while a
      // different edit or outcome loses cleanly with a 409.
    }
  }
  return null;
}

async function deleteLockIfUnchanged(subKey, etag, scopedLockKeyFor = lockKeyFor) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: scopedLockKeyFor(subKey), IfMatch: etag }));
    return true;
  } catch {
    // 412: someone took the lock over mid-flight — it's theirs now, leave it.
    return false;
  }
}

async function acquireAuthorMutationLock(subKey, actor) {
  const token = await tryLock(subKey, actor, authorMutationLockKeyFor);
  if (!token) return null;
  const etag = await verifyLock(subKey, token, authorMutationLockKeyFor);
  return etag ? { token, etag } : null;
}

async function releaseAuthorMutationLock(subKey, lock) {
  if (!lock?.etag) return false;
  return await deleteLockIfUnchanged(subKey, lock.etag, authorMutationLockKeyFor);
}

async function readDoneRecord(subKey, scopedDoneKeyFor = doneKeyFor) {
  try {
    const raw = (await readJson(scopedDoneKeyFor(subKey))).json;
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    // Legacy done markers contain the target key as plain text, not JSON.
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: scopedDoneKeyFor(subKey) }));
      const target = (await res.Body.transformToString()).trim();
      return target ? { target } : null;
    } catch {
      return null;
    }
  }
}

async function writeDoneRecord(subKey, record, scopedDoneKeyFor = doneKeyFor) {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: scopedDoneKeyFor(subKey),
        Body: JSON.stringify(record),
        ContentType: "application/json",
        IfNoneMatch: "*",
      })
    );
    return record;
  } catch (err) {
    const code = err.$metadata?.httpStatusCode;
    if (code !== 412 && code !== 409 && err.name !== "PreconditionFailed" && err.name !== "ConditionalRequestConflict") {
      throw err;
    }
    return await readDoneRecord(subKey, scopedDoneKeyFor);
  }
}

// Immutable, idempotent review receipts are authoritative for credit. Unlike
// the old read-modify-write counter, concurrent devices and ambiguous retries
// cannot lose or double-count a review.
async function recordReviewerCredit(reviewer, outcome, subKey, taskId, completedAt) {
  if (!reviewer) return;
  const body = JSON.stringify({ reviewer, outcome, source_key: subKey, task_id: taskId, completed_at: completedAt });
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: reviewerCreditKeyFor(reviewer, outcome, subKey),
        Body: body,
        ContentType: "application/json",
        IfNoneMatch: "*",
      })
    );
  } catch (err) {
    const code = err.$metadata?.httpStatusCode;
    if (code !== 412 && code !== 409 && err.name !== "PreconditionFailed" && err.name !== "ConditionalRequestConflict") {
      throw err;
    }
  }
}

async function reviewerCreditCount(reviewer) {
  const [approved, rejected] = await Promise.all([
    countAll(reviewerCreditPrefix(reviewer, "approved")),
    countAll(reviewerCreditPrefix(reviewer, "rejected")),
  ]);
  if (approved + rejected) return approved + rejected;
  // Legacy fallback until existing reviews are backfilled to receipts.
  const legacy = await readJson(reviewerKeyFor(reviewer)).then((r) => r.json).catch(() => null);
  return Number(legacy?.approved || 0) + Number(legacy?.rejected || 0);
}

let reviewerTotalsCache = { totals: null, checkedAt: 0 };

async function reviewerTotals() {
  // Display-only rollup behind the queue tiles. Credit receipts are
  // append-only, so 60s of staleness is invisible; without this every
  // /review/status call costs 2 LIST requests per reviewer.
  if (reviewerTotalsCache.totals && Date.now() - reviewerTotalsCache.checkedAt < 60_000) {
    return reviewerTotalsCache.totals;
  }
  const [creditRoots, legacyKeys] = await Promise.all([
    listCommonPrefixes(`${REVIEW_PREFIX}credits/`),
    listAll(`${REVIEW_PREFIX}reviewers/`),
  ]);
  const byReviewer = new Map();
  const receiptCounts = await Promise.all(
    creditRoots.map(async (root) => {
      const slug = root.slice(`${REVIEW_PREFIX}credits/`.length, -1);
      const reviewer = fromB64url(slug);
      const [approved, rejected] = await Promise.all([
        countAll(`${root}approved/`),
        countAll(`${root}rejected/`),
      ]);
      return { reviewer, approved, rejected };
    })
  );
  for (const stats of receiptCounts) {
    if (stats.approved + stats.rejected > 0) byReviewer.set(stats.reviewer, stats);
  }
  const legacy = await Promise.all(
    legacyKeys.slice(0, 100).map((k) => readJson(k).then((r) => r.json).catch(() => null))
  );
  // A reviewer with any receipt has been migrated and receipts are the source
  // of truth. Keep old counters only for reviewers not yet migrated.
  for (const stats of legacy.filter(Boolean)) {
    if (!byReviewer.has(stats.reviewer)) byReviewer.set(stats.reviewer, stats);
  }
  const out = [...byReviewer.values()];
  out.sort((a, b) => (b.approved || 0) + (b.rejected || 0) - (a.approved || 0) - (a.rejected || 0));
  reviewerTotalsCache = { totals: out, checkedAt: Date.now() };
  return out;
}

const secureKeyMatches = (provided, expected) => {
  if (!expected || typeof provided !== "string") return false;
  // Hash both sides to fixed length so timingSafeEqual applies.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
};
const keyMatches = (provided) => secureKeyMatches(provided, REVIEW_KEY);

export const reportingKeyMatches = (provided, expectedKeys = reportingKeys) =>
  expectedKeys.some((expected) => secureKeyMatches(provided, expected));

function bearerToken(headers = {}) {
  const authorization = headers.authorization || headers.Authorization || "";
  const match = String(authorization).match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

async function handleReporting(event) {
  if (!reportingKeyMatches(bearerToken(event.headers))) {
    return respond(401, { error: "Bad or missing reporting bearer token" }, { "Cache-Control": "no-store" });
  }
  const params = event.queryStringParameters ?? {};
  const includes = new Set(String(params.include || "").split(",").map((value) => value.trim()).filter(Boolean));
  const includeContent = includes.has("content") || includes.has("full");
  const includeLlmReviews = includes.has("llm_reviews") || includes.has("full");
  const includeLlmFlags = includes.has("llm_flags") || includeLlmReviews;
  const taskId = cleanText(params.task_id, 160);
  const status = cleanText(params.status, 20);
  const defaultLimit = includeLlmReviews ? 10 : includeLlmFlags ? 200 : includeContent ? 100 : 5_000;
  const maxLimit = includeLlmReviews ? 25 : includeLlmFlags ? 200 : includeContent ? 150 : 5_000;
  const limit = Math.min(maxLimit, Math.max(1, Number(params.limit) || defaultLimit));
  const offset = Math.max(0, Number(params.offset) || 0);
  const [dashboard, aliases, skipCounts] = await Promise.all([adminDashboard(), participantAliases(), reviewSkipCounts()]);
  const options = {
    includeContent,
    includeLlmReviews,
    includeLlmFlags,
    taskId,
    status,
    limit,
    offset,
    participantAliases: aliases,
    skipCounts,
  };
  if (includeLlmReviews) await hydrateReportingLlmReviews(dashboard, options);
  if (includeLlmFlags) await hydrateReportingLlmFlags(dashboard, options);
  return respond(200, buildReportingReport(dashboard, new Date().toISOString(), options), { "Cache-Control": "no-store" });
}

async function preQcReviewForClaimedTask(subKey) {
  const source = await readJson(subKey).then(({ json }) => json);
  const taskId = cleanText(source?.task_id, 300);
  const original = cleanTaskSnapshot(source?.task ?? source);
  const rubrics = cleanRubrics(null, original, null);
  const taskContentHash = reportingTaskContentHash(original, null, rubrics);
  const [passed, attention] = await Promise.all([
    listAllObjects(LLM_PRE_QC_PASS_PREFIX),
    listAllObjects(LLM_PRE_QC_ATTENTION_PREFIX),
  ]);
  const candidates = [];
  for (const [objects, status, prefix] of [
    [passed, "pre_qc_passed", LLM_PRE_QC_PASS_PREFIX],
    [attention, "pre_qc_attention", LLM_PRE_QC_ATTENTION_PREFIX],
  ]) {
    for (const object of objects) {
      const parsed = parseLlmReviewArtifactKey(object.Key, prefix, status, object.LastModified, "PRE_QC");
      if (parsed?.taskId === taskId) candidates.push(parsed);
    }
  }
  const selected = selectLlmReviewArtifact(currentReviewerLlmCandidates(candidates), taskContentHash);
  if (!selected) return { status: "not_reviewed", stale: false, task_content_hash: taskContentHash, review: null };
  const stale = Boolean(selected.contentHash && selected.contentHash !== taskContentHash);
  if (stale) return { status: "stale", stale: true, task_content_hash: taskContentHash, review: null };
  const artifact = await readJson(selected.key).then(({ json }) => json).catch(() => null);
  const review = llmReviewForHuman(artifact, taskId, taskContentHash);
  return {
    status: review ? selected.status : "stale",
    stale: !review,
    task_content_hash: taskContentHash,
    review,
  };
}

async function trajectoryQueueState() {
  const [markers, doneObjects, lockObjects] = await Promise.all([
    listAllObjects(TRAJECTORY_INBOX_PREFIX),
    listAllObjects(TRAJECTORY_DONE_PREFIX),
    listAllObjects(TRAJECTORY_LOCKS_PREFIX),
  ]);
  const markerAge = new Map();
  const creatorByManifest = new Map();
  for (const marker of markers) {
    try {
      const suffix = marker.Key.slice(TRAJECTORY_INBOX_PREFIX.length);
      const parts = suffix.split("/");
      const encodedManifestKey = parts.length === 2 ? parts[1] : parts[0];
      const markerCreator = parts.length === 2 && VALID_PID.test(parts[0]) ? parts[0] : null;
      const manifestKey = fromB64url(encodedManifestKey);
      if (!manifestKey.startsWith(TRAJECTORY_RUNS_PREFIX) || !taskIdFromTrajectoryManifestKey(manifestKey)) continue;
      markerAge.set(manifestKey, marker.LastModified?.getTime() ?? 0);
      const inferredCreator = markerCreator || participantIdFromTrajectoryManifestKey(manifestKey);
      if (inferredCreator) creatorByManifest.set(manifestKey, inferredCreator);
    } catch {
      /* malformed marker */
    }
  }
  const doneSet = new Set(doneObjects.map((object) => object.Key.slice(TRAJECTORY_DONE_PREFIX.length)));
  const lockReads = await Promise.all(lockObjects.map((object) => readJson(object.Key).then(({ json }) => {
    const claimedAt = Date.parse(json?.claimed_at);
    const fresh = Number.isFinite(claimedAt) && Date.now() - claimedAt <= Number(LOCK_TTL_MS);
    return fresh ? object.Key.slice(TRAJECTORY_LOCKS_PREFIX.length, -".json".length) : null;
  }).catch(() => null)));
  const lockSet = new Set(lockReads.filter(Boolean));
  const manifests = [...markerAge.keys()].sort((a, b) =>
    (markerAge.get(a) ?? 0) - (markerAge.get(b) ?? 0) || a.localeCompare(b)
  );
  const pending = manifests.filter((key) => !doneSet.has(b64url(key)));
  return {
    manifests,
    pending,
    lockSet,
    markerAge,
    creatorByManifest,
    counts: {
      submitted: manifests.length,
      finished: manifests.filter((key) => doneSet.has(b64url(key))).length,
      locked: pending.filter((key) => lockSet.has(b64url(key))).length,
      unassigned: pending.filter((key) => !creatorByManifest.has(key)).length,
    },
  };
}

async function signedTrajectoryManifest(manifestKey) {
  const raw = await readJson(manifestKey).then(({ json }) => json);
  const manifest = trajectoryManifestForHuman(raw);
  if (!manifest || taskIdFromTrajectoryManifestKey(manifestKey) !== manifest.task_id) return null;
  const base = manifestKey.slice(0, manifestKey.lastIndexOf("/") + 1);
  const steps = await Promise.all(manifest.steps.map(async (step) => {
    if (!step.screenshot_path) return { ...step, screenshot_url: null };
    const assetKey = `${base}${step.screenshot_path}`;
    if (!assetKey.startsWith(base)) return { ...step, screenshot_url: null };
    const screenshotUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: assetKey }), { expiresIn: 3600 });
    return { ...step, screenshot_url: screenshotUrl };
  }));
  return { ...manifest, steps };
}

async function handleTrajectoryReview(path, body) {
  if (!keyMatches(body.reviewKey)) return respond(401, { error: "Bad or missing review key" });
  const reviewer = cleanText(body.reviewer, 120);
  const reviewerPid = cleanText(body.reviewer_pid, 80).toLowerCase();

  if (path === "/trajectory/status") {
    const state = await trajectoryQueueState();
    const eligible = trajectoryRunsForCreator(state.pending, reviewerPid, state.creatorByManifest);
    return respond(200, {
      ...state.counts,
      locked: eligible.filter((key) => state.lockSet.has(b64url(key))).length,
      pending: eligible.length,
      claimable: eligible.filter((key) => !state.lockSet.has(b64url(key))).length,
      assigned_to_you: eligible.length,
      assigned_to_others: Math.max(0, state.pending.length - eligible.length - state.counts.unassigned),
    });
  }

  if (path === "/trajectory/claim") {
    if (!reviewer) return respond(400, { error: "reviewer required" });
    if (!VALID_PID.test(reviewerPid)) return respond(400, { error: "reviewer_pid required for creator-assigned trajectory grading" });
    const state = await trajectoryQueueState();
    const eligible = trajectoryRunsForCreator(state.pending, reviewerPid, state.creatorByManifest);
    const unlocked = eligible.filter((key) => !state.lockSet.has(b64url(key)));
    const locked = eligible.filter((key) => state.lockSet.has(b64url(key)));
    let attempts = 0;
    for (const manifestKey of orderClaimCandidates(unlocked, locked, body.skip_keys)) {
      if (attempts++ >= 25) break;
      try {
        await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: manifestKey }));
      } catch {
        continue;
      }
      const token = await tryLock(manifestKey, reviewer, trajectoryLockKeyFor);
      if (!token) continue;
      const run = await signedTrajectoryManifest(manifestKey).catch(() => null);
      if (!run || run.creator_pid !== reviewerPid) {
        const etag = await verifyLock(manifestKey, token, trajectoryLockKeyFor);
        if (etag) await deleteLockIfUnchanged(manifestKey, etag, trajectoryLockKeyFor);
        continue;
      }
      // Best-effort: the grade must still work if lineage lookup fails.
      const taskLineage = await trajectoryTaskLineage(run.task_id).catch((error) => {
        console.error("Trajectory task lineage lookup failed", error);
        return null;
      });
      const priorGrades = await priorTrajectoryGrades(run, taskLineage).catch((error) => {
        console.error("Prior trajectory grade lookup failed", error);
        return [];
      });
      return respond(200, {
        manifest_key: manifestKey,
        token,
        lock_ttl_ms: Number(LOCK_TTL_MS),
        remaining: Math.max(0, eligible.length - 1),
        run,
        task_lineage: taskLineage,
        prior_grades: priorGrades,
      });
    }
    return respond(200, { manifest_key: null, remaining: 0 });
  }

  if (path === "/trajectory/release") {
    const manifestKey = cleanText(body.manifest_key, 2_000);
    const token = cleanText(body.token, 200);
    if (!manifestKey || !token) return respond(400, { error: "manifest_key and token required" });
    const etag = await verifyLock(manifestKey, token, trajectoryLockKeyFor);
    if (!etag) return respond(409, { error: "Lock not held by you (it may have expired)" });
    await deleteLockIfUnchanged(manifestKey, etag, trajectoryLockKeyFor);
    return respond(200, { ok: true });
  }

  if (path === "/trajectory/submit") {
    const manifestKey = cleanText(body.manifest_key, 2_000);
    const token = cleanText(body.token, 200);
    if (!manifestKey || !token || !body.judgment) {
      return respond(400, { error: "manifest_key, token, and judgment required" });
    }
    const manifest = await readJson(manifestKey).then(({ json }) => json).catch(() => null);
    const cleanManifest = cleanTrajectoryManifest(manifest);
    if (!cleanManifest || taskIdFromTrajectoryManifestKey(manifestKey) !== cleanManifest.task_id) {
      return respond(400, { error: "Trajectory manifest is invalid" });
    }
    if (!VALID_PID.test(reviewerPid) || cleanManifest.creator_pid !== reviewerPid) {
      return respond(403, { error: "Only the task creator can grade this trajectory" });
    }
    let safeJudgment;
    try {
      safeJudgment = sanitizeHumanTrajectoryJudgment(body.judgment, cleanManifest);
    } catch (err) {
      return respond(400, { error: err.message || String(err) });
    }
    const contentHash = reviewContentHash(safeJudgment);
    const target = trajectoryJudgmentKeyFor(manifestKey);
    const existingDone = await readDoneRecord(manifestKey, trajectoryDoneKeyFor);
    if (existingDone) {
      if (existingDone.target !== target || (existingDone.content_hash && existingDone.content_hash !== contentHash)) {
        return respond(409, { error: "This trajectory was already judged by another reviewer" });
      }
      const completedAt = String(existingDone.completed_at || new Date().toISOString());
      const editReview = safeJudgment.trajectory.overall_outcome === "EDIT_NEEDED"
        ? await enqueueTrajectoryEditReview(manifestKey, cleanManifest, safeJudgment, target, completedAt)
        : null;
      return respond(200, {
        ok: true,
        judgment_key: target,
        overall_outcome: safeJudgment.trajectory.overall_outcome,
        edit_review_task_id: editReview?.task_id ?? existingDone.edit_review_task_id ?? null,
        idempotent: true,
      });
    }
    let etag = await verifyLock(manifestKey, token, trajectoryLockKeyFor);
    if (!etag) return respond(409, { error: "Lock not held by you (it may have expired)" });
    etag = await beginFinalization(manifestKey, token, reviewer, "judged", contentHash, trajectoryLockKeyFor);
    if (!etag) return respond(409, { error: "Another judgment is already being submitted" });
    const reviewedAt = new Date().toISOString();
    const document = {
      ...safeJudgment,
      source_manifest_key: manifestKey,
      reviewed_by: reviewer,
      reviewed_at: reviewedAt,
      review_content_hash: contentHash,
    };
    const created = await tryConditionalWrite(() => s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: target,
      Body: JSON.stringify(document, null, 2),
      ContentType: "application/json",
      IfNoneMatch: "*",
    })));
    if (!created) {
      const existing = await readJson(target).then(({ json }) => json).catch(() => null);
      if (!existing || existing.review_content_hash !== contentHash) {
        return respond(409, { error: "A different judgment was already submitted" });
      }
    }
    const editReview = safeJudgment.trajectory.overall_outcome === "EDIT_NEEDED"
      ? await enqueueTrajectoryEditReview(manifestKey, cleanManifest, safeJudgment, target, reviewedAt)
      : null;
    const done = await writeDoneRecord(manifestKey, {
      target,
      outcome: "judged",
      reviewer,
      task_id: cleanManifest.task_id,
      run_id: cleanManifest.run_id,
      overall_outcome: safeJudgment.trajectory.overall_outcome,
      edit_review_task_id: editReview?.task_id ?? null,
      completed_at: reviewedAt,
      content_hash: contentHash,
    }, trajectoryDoneKeyFor);
    if (done.target !== target || (done.content_hash && done.content_hash !== contentHash)) {
      return respond(409, { error: "This trajectory was already judged by another reviewer" });
    }
    await deleteLockIfUnchanged(manifestKey, etag, trajectoryLockKeyFor);
    return respond(200, {
      ok: true,
      judgment_key: target,
      overall_outcome: safeJudgment.trajectory.overall_outcome,
      edit_review_task_id: editReview?.task_id ?? null,
    });
  }

  return respond(404, { error: `Unknown trajectory route ${path}` });
}


// ---- OSWorld-style task view -------------------------------------------
// Server-side twin of scripts/trajectory_review/export_osworld.py so the
// reporting API can hand teammates the original task in stock OSWorld shape
// without a checkout. Keep the two in lockstep (test_export_osworld.py pins
// the Python side; lambda_presign.test.js pins this side).
export const OSWORLD_EXPORT_SCHEMA_VERSION = "apollo-osworld-export-v1";
const APOLLO_OSWORLD_NAMESPACE = "7aa8f833-8ea6-4a38-a64f-2d56a9db9de5";

export function uuidV5(namespaceUuid, name) {
  const ns = Buffer.from(String(namespaceUuid).replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(Buffer.concat([ns, Buffer.from(String(name), "utf8")])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function osworldTaskIdFor(taskId) {
  return uuidV5(APOLLO_OSWORLD_NAMESPACE, String(taskId));
}

// True only for a complete, affirmative human grade: reviewed, YES overall,
// and every manifest rubric human-marked SUCCESS (mirrors accepted_human_pass).
export function acceptedHumanPass(item) {
  if (item?.status !== "reviewed" || item?.human_final_grade !== "YES") return false;
  const manifest = item.manifest;
  const judgment = item.human_judgment;
  if (!manifest || typeof manifest !== "object" || !judgment || typeof judgment !== "object") return false;
  const manifestIds = new Set((manifest.rubrics || []).map((rubric) => cleanText(rubric?.rubric_id, 100)).filter(Boolean));
  const verdicts = new Map((judgment.rubrics || [])
    .map((rubric) => [cleanText(rubric?.rubric_id, 100), cleanText(rubric?.human_verdict, 30).toUpperCase()])
    .filter(([id]) => id));
  if (!manifestIds.size || verdicts.size !== manifestIds.size) return false;
  for (const id of manifestIds) if (verdicts.get(id) !== "SUCCESS") return false;
  return true;
}

function inertOsworldEvaluator() {
  return {
    func: "is_expected_url_pattern_match",
    result: { type: "active_url_from_accessTree" },
    expected: { type: "rule", rules: { expected: ["^apollo-external-human-qc-only$"] } },
  };
}

// Stock OSWorld task config for one trajectory row. Works for any grade
// status; `apollo.human_pass` says whether this run is an accepted pass.
export function osworldTaskForItem(item, snapshot = "chrome") {
  const manifest = item?.manifest;
  if (!manifest || typeof manifest !== "object") return null;
  const taskId = cleanText(manifest.task_id || item.task_id, 300);
  const instruction = cleanText(manifest.task_prompt, 200_000);
  if (!taskId || !instruction) return null;
  const rubrics = [];
  for (const rubric of manifest.rubrics || []) {
    const rubricId = cleanText(rubric?.rubric_id, 100);
    const requirement = cleanText(rubric?.requirement, 30_000);
    if (!rubricId || !requirement) return null;
    rubrics.push({ rubric_id: rubricId, requirement, verification: cleanText(rubric?.verification, 20_000) });
  }
  const pass = acceptedHumanPass(item);
  const runId = cleanText(manifest.run_id || item.run_id, 120);
  const manifestKey = cleanText(item.manifest_key, 2_000);
  return {
    id: osworldTaskIdFor(taskId),
    snapshot,
    instruction,
    source: "Apollo",
    config: [
      { type: "launch", parameters: { command: ["google-chrome", "--remote-debugging-port=1337"] } },
      { type: "launch", parameters: { command: ["socat", "tcp-listen:9222,fork", "tcp:localhost:1337"] } },
      { type: "activate_window", parameters: { window_name: "Google Chrome" } },
    ],
    trajectory: "trajectories/",
    related_apps: ["chrome"],
    evaluator: inertOsworldEvaluator(),
    proxy: false,
    fixed_ip: false,
    possibility_of_env_change: "low",
    apollo: {
      schema_version: OSWORLD_EXPORT_SCHEMA_VERSION,
      task_id: taskId,
      creator_pid: cleanText(manifest.creator_pid, 80) || null,
      run_id: runId,
      manifest_key: manifestKey,
      status: item.status ?? null,
      human_final_grade: item.human_final_grade ?? null,
      human_pass: pass,
      // Same field names the offline exporter writes, populated only for
      // accepted passes so downstream consumers can treat both outputs alike.
      accepted_run_id: pass ? runId : null,
      accepted_manifest_key: pass ? manifestKey : null,
      human_reviewed_at: cleanText(item.reviewed_at, 80) || null,
      rubrics,
      evaluation: "Run scripts/trajectory_review/run.py and complete Apollo human Grade; ignore OSWorld result.txt.",
    },
  };
}

// Newest run per task, deterministically (reviewed_at, then run_id) —
// mirrors select_latest_passes but over whichever rows the caller filtered.
export function selectLatestRunPerTask(items) {
  const selected = new Map();
  for (const item of items) {
    const taskId = cleanText(item?.manifest?.task_id || item?.task_id, 300);
    if (!taskId) continue;
    const current = selected.get(taskId);
    const candidateOrder = `${cleanText(item.reviewed_at, 80)} ${cleanText(item.run_id, 120)}`;
    const currentOrder = current ? `${cleanText(current.reviewed_at, 80)} ${cleanText(current.run_id, 120)}` : "";
    if (!current || candidateOrder > currentOrder) selected.set(taskId, item);
  }
  return [...selected.keys()].sort().map((taskId) => selected.get(taskId));
}

// format=osworld: the same bundle export_osworld.py writes to disk
// (tasks.json + test_apollo.json), served directly. Default = accepted human
// passes only (drop-in parity with the exporter); grade=any = every task in
// the queue regardless of grade.
export function buildOsworldExportReport(items, generatedAt = new Date().toISOString(), options = {}) {
  const requestedTaskId = cleanText(options.taskId, 300);
  const requestedStatus = ["pending", "in_review", "reviewed"].includes(options.status) ? options.status : "";
  const anyGrade = options.grade === "any";
  const snapshot = /^[a-z0-9_-]{1,40}$/i.test(String(options.snapshot || "")) ? String(options.snapshot) : "chrome";
  const filtered = items.filter((item) =>
    (!requestedTaskId || item.task_id === requestedTaskId)
    && (!requestedStatus || item.status === requestedStatus)
    && (anyGrade || acceptedHumanPass(item))
  );
  const selected = selectLatestRunPerTask(filtered);
  const tasks = selected.map((item) => osworldTaskForItem(item, snapshot)).filter(Boolean);
  const offset = Math.max(0, Number(options.offset) || 0);
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 200));
  const page = tasks.slice(offset, offset + limit);
  return {
    schema_version: OSWORLD_EXPORT_SCHEMA_VERSION,
    generated_at: generatedAt,
    snapshot,
    selection: anyGrade ? "latest_run_per_task_any_grade" : "latest_accepted_human_pass_per_task",
    exported: tasks.length,
    task_ids: tasks.map((task) => task.apollo.task_id),
    osworld_ids: tasks.map((task) => task.id),
    // Same two files export_osworld.py writes: tasks.json + test_apollo.json.
    tasks: page,
    test_apollo: { [snapshot]: tasks.map((task) => task.id) },
    native_result_txt_is_authoritative: false,
    page: {
      offset,
      limit,
      returned: page.length,
      filtered_total: tasks.length,
      next_offset: offset + page.length < tasks.length ? offset + page.length : null,
    },
  };
}

export function buildTrajectoryReportingReport(items, generatedAt = new Date().toISOString(), options = {}) {
  const requestedTaskId = cleanText(options.taskId, 300);
  const requestedStatus = ["pending", "in_review", "reviewed"].includes(options.status) ? options.status : "";
  const filtered = items.filter((item) =>
    (!requestedTaskId || item.task_id === requestedTaskId) && (!requestedStatus || item.status === requestedStatus)
  );
  const offset = Math.max(0, Number(options.offset) || 0);
  const limit = Math.min(options.includeContent ? 10 : 1_000, Math.max(1, Number(options.limit) || (options.includeContent ? 10 : 1_000)));
  const page = filtered.slice(offset, offset + limit);
  const totals = { submitted: filtered.length, pending: 0, in_review: 0, reviewed: 0 };
  for (const item of filtered) totals[item.status] += 1;
  return {
    schema_version: options.includeContent ? "apollo-trajectory-reporting-v2" : "apollo-trajectory-reporting-v1",
    generated_at: generatedAt,
    totals,
    trajectories: page.map((item) => ({
      manifest_key: item.manifest_key,
      task_id: item.task_id,
      run_id: item.run_id,
      status: item.status,
      reviewer: item.reviewer ?? "",
      reviewed_at: item.reviewed_at ?? "",
      llm_average_rubric_score: item.llm_average_rubric_score,
      llm_perfect: item.llm_perfect,
      agent: item.agent ?? null,
      model: item.model ?? null,
      run_label: item.run_label ?? null,
      human_outcome: item.human_outcome ?? null,
      human_final_grade: item.human_final_grade ?? null,
      ...(options.includeContent ? { manifest: item.manifest, human_judgment: item.human_judgment } : {}),
      ...(options.includeOsworld ? { osworld_task: osworldTaskForItem(item, options.snapshot || "chrome") } : {}),
    })),
    page: {
      offset,
      limit,
      returned: page.length,
      filtered_total: filtered.length,
      next_offset: offset + page.length < filtered.length ? offset + page.length : null,
    },
  };
}

async function handleTrajectoryReporting(event) {
  if (!reportingKeyMatches(bearerToken(event.headers))) {
    return respond(401, { error: "Bad or missing reporting bearer token" }, { "Cache-Control": "no-store" });
  }
  const params = event.queryStringParameters ?? {};
  const includes = new Set(String(params.include || "").split(",").map((value) => value.trim()).filter(Boolean));
  const includeContent = includes.has("content") || includes.has("full");
  const includeOsworld = includes.has("osworld");
  const formatOsworld = cleanText(params.format, 30).toLowerCase() === "osworld";
  // The OSWorld view is built from manifest + judgment even when the caller
  // did not ask for the raw content, so hydrate whenever either is needed.
  const loadContent = includeContent || includeOsworld || formatOsworld;
  const state = await trajectoryQueueState();
  const items = [];
  for (let offset = 0; offset < state.manifests.length; offset += 25) {
    const batch = await Promise.all(state.manifests.slice(offset, offset + 25).map(async (manifestKey) => {
      const encoded = b64url(manifestKey);
      const [manifestRaw, done, lock] = await Promise.all([
        readJson(manifestKey).then(({ json }) => json).catch(() => null),
        readDoneRecord(manifestKey, trajectoryDoneKeyFor),
        state.lockSet.has(encoded) ? readJson(trajectoryLockKeyFor(manifestKey)).then(({ json }) => json).catch(() => null) : null,
      ]);
      const manifest = cleanTrajectoryManifest(manifestRaw);
      if (!manifest) return null;
      const judgment = done?.target ? await readJson(done.target).then(({ json }) => json).catch(() => null) : null;
      return {
        manifest_key: manifestKey,
        task_id: manifest.task_id,
        run_id: manifest.run_id,
        status: done ? "reviewed" : lock ? "in_review" : "pending",
        reviewer: done?.reviewer ?? lock?.reviewer ?? "",
        reviewed_at: done?.completed_at ?? "",
        llm_average_rubric_score: manifest.metrics.average_rubric_score,
        llm_perfect: manifest.metrics.perfect,
        agent: manifest.source.agent,
        model: manifest.source.model,
        run_label: manifest.source.run_label,
        // Preserve the existing API field and add the normalized four-way
        // grade beside it so reporting clients can migrate independently.
        human_outcome: judgment?.trajectory?.task_satisfied ?? judgment?.trajectory?.outcome ?? null,
        human_final_grade: trajectoryOverallOutcome(judgment?.trajectory) || null,
        manifest: loadContent ? manifest : null,
        human_judgment: loadContent ? judgment : null,
      };
    }));
    items.push(...batch.filter(Boolean));
  }
  const reportOptions = {
    includeContent,
    includeOsworld,
    snapshot: /^[a-z0-9_-]{1,40}$/i.test(String(params.snapshot || "")) ? String(params.snapshot) : "chrome",
    grade: cleanText(params.grade, 10).toLowerCase(),
    taskId: cleanText(params.task_id, 300),
    status: cleanText(params.status, 30),
    limit: params.limit,
    offset: params.offset,
  };
  const report = formatOsworld
    ? buildOsworldExportReport(items, new Date().toISOString(), reportOptions)
    : buildTrajectoryReportingReport(items, new Date().toISOString(), reportOptions);
  return respond(200, report, { "Cache-Control": "no-store" });
}

function doneOutcome(done) {
  if (!done) return null;
  if (done.outcome) return done.outcome;
  const target = String(done.target || "");
  if (target.startsWith(`${REVIEW_PREFIX}finished/`)) return "approved";
  if (target.startsWith(`${REVIEW_PREFIX}rejected/`)) return "rejected";
  if (target.startsWith(`${REVIEW_PREFIX}returned/`)) return "returned";
  return null;
}

function cleanTaskMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const out = {};
  if (metadata.region != null) out.region = cleanText(metadata.region, 8);
  if (Array.isArray(metadata.subjects)) {
    out.subjects = metadata.subjects.slice(0, 10).map((subject) => cleanText(subject, 120)).filter(Boolean);
  }
  return Object.keys(out).length ? out : null;
}

function authoredTaskContentForResponse(task) {
  if (!task || typeof task !== "object") return null;
  const out = {
    title: cleanText(task.task_title ?? task.title, 300),
    request: String(task.agent_request ?? task.request ?? ""),
    difficulty: cleanText(task.difficulty || "high", 30),
    criteria: cleanCriteria(task.success_criteria ?? task.criteria),
    steps: cleanSteps(task.steps),
    must_visit_or_reach: Array.isArray(task.must_visit_or_reach)
      ? task.must_visit_or_reach.slice(0, 50).map((item) => cleanText(item, 2_000))
      : [],
    required_outputs: Array.isArray(task.required_outputs)
      ? task.required_outputs.slice(0, 30).map((item) => cleanText(item, 2_000))
      : [],
    notes: task.notes == null ? null : String(task.notes),
  };
  const metadata = cleanTaskMetadata(task.metadata);
  if (metadata) out.metadata = metadata;
  return out;
}

export function sanitizeAuthoredTask(edited, originalTask = null) {
  const safeTask = {
    task_title: String(edited.task_title || "").slice(0, 300),
    agent_request: String(edited.agent_request ?? ""),
    difficulty: cleanText(edited.difficulty || "high", 30),
    success_criteria: cleanCriteria(edited.success_criteria),
    must_visit_or_reach: Array.isArray(edited.must_visit_or_reach)
      ? edited.must_visit_or_reach.slice(0, 50).map((item) => cleanText(item, 2_000))
      : [],
    required_outputs: Array.isArray(edited.required_outputs)
      ? edited.required_outputs.slice(0, 30).map((item) => cleanText(item, 2_000))
      : [],
    notes: edited.notes == null ? null : String(edited.notes),
    steps: cleanSteps(edited.steps).map((step) => ({
      ...step,
      description: step.description.slice(0, 20_000),
    })),
  };
  const metadata = cleanTaskMetadata(edited.metadata);
  if (metadata) safeTask.metadata = metadata;
  // These fields are not editable in the author revision form. Merge them
  // from the stored task instead of trusting an omitted/client-supplied value,
  // otherwise a round-trip through author-edit silently drops task scope and
  // source-derived timing context.
  if (originalTask && typeof originalTask === "object") {
    safeTask.site_scope = Array.isArray(originalTask.site_scope)
      ? originalTask.site_scope.slice(0, 30).map((item) => cleanText(item, 500))
      : [];
    if (Object.hasOwn(originalTask, "task_summary")) {
      safeTask.task_summary = originalTask.task_summary == null
        ? null
        : cleanText(originalTask.task_summary, 20_000);
    }
    if (Object.hasOwn(originalTask, "time_span")) {
      safeTask.time_span = {
        start: originalTask.time_span?.start == null ? null : cleanText(originalTask.time_span.start, 120),
        end: originalTask.time_span?.end == null ? null : cleanText(originalTask.time_span.end, 120),
      };
    }
  }
  return safeTask;
}

function snapshotForHumanReview(snapshot) {
  return {
    title: snapshot?.title ?? "",
    request: snapshot?.request ?? "",
    criteria: snapshot?.criteria ?? [],
    steps: snapshot?.steps ?? [],
  };
}

// Read reviewer edits only from the frozen review block. Re-diffing current
// gold after an author amendment would attribute the author's change to QC.
export function reviewerChangedTask(finished) {
  const review = finished?.review;
  if (!review || typeof review !== "object") return false;
  return Boolean(
    review.title_edited
      || review.request_edited
      || (Array.isArray(review.rubrics) && review.rubrics.some((rubric) => rubric?.changed))
  );
}

export function finalGoldRevision(finished) {
  if (!finished) return 0;
  const explicit = Number(finished.revision_count);
  return Number.isInteger(explicit) && explicit > 0
    ? explicit
    : (Array.isArray(finished.history) ? finished.history.length : 0) + 1;
}

export function unchangedAmendSignoffAction(finished, participantId) {
  return finalGoldRevision(finished) > 1
    && String(finished?.amended_by || "") === String(participantId || "")
    ? "amended"
    : "accepted";
}

const FINAL_GOLD_HISTORY_LIMIT = 10;
export function finalGoldTaskFromAuthorEdit(existingTask, safeTask) {
  const metadata = safeTask.metadata ?? existingTask?.metadata ?? null;
  return {
    task_title: safeTask.task_title,
    agent_request: safeTask.agent_request,
    difficulty: safeTask.difficulty,
    site_scope: Array.isArray(existingTask?.site_scope) ? existingTask.site_scope.slice(0, 30) : [],
    success_criteria: safeTask.success_criteria,
    must_visit_or_reach: safeTask.must_visit_or_reach,
    required_outputs: safeTask.required_outputs,
    notes: safeTask.notes,
    ...(metadata ? { metadata } : {}),
    steps: safeTask.steps,
  };
}

export function buildAmendedFinalGold({ existing, amendedTask, contentHash, authorPid, amendedAt }) {
  const history = Array.isArray(existing?.history)
    ? existing.history.slice(-(FINAL_GOLD_HISTORY_LIMIT - 1))
    : [];
  if (existing?.task) {
    history.push({
      task: existing.task,
      review_content_hash: existing.review_content_hash ?? null,
      source: existing.amended_by ? "author" : "reviewer",
      by: existing.amended_by || existing.reviewed_by || "",
      at: existing.amended_at || existing.finished_at || "",
    });
  }
  return {
    ...existing,
    task: amendedTask,
    review_content_hash: contentHash,
    amended_by: authorPid,
    amended_at: amendedAt,
    revision_count: finalGoldRevision(existing) + 1,
    history,
  };
}

export function buildHumanReviewForAuthor(finished, source) {
  if (!finished || typeof finished !== "object") return null;
  const original = cleanTaskSnapshot(source?.task ?? source);
  const final = cleanTaskSnapshot(finished?.task ?? null);
  if (!original || !final) return null;
  const rubrics = cleanRubrics(finished?.review, original, final);
  return {
    original: snapshotForHumanReview(original),
    final: snapshotForHumanReview(final),
    rubrics: rubrics.map((rubric) => ({
      rubric_id: rubric.rubric_id,
      kind: rubric.kind,
      title: rubric.title,
      original: rubric.original,
      final: rubric.final,
      changed: rubric.changed,
      checked: rubric.checked,
    })),
    title_edited: Boolean(finished?.review?.title_edited),
    request_edited: Boolean(finished?.review?.request_edited),
    evergreen_verified: Boolean(finished?.review?.evergreen_verified),
    changed: reviewerChangedTask(finished),
    revision_count: finalGoldRevision(finished),
    amended_by: cleanText(finished?.amended_by, 80) || "",
    amended_at: cleanText(finished?.amended_at, 60) || "",
  };
}

function buildRejectionFeedbackForAuthor(rejected, source) {
  if (!Array.isArray(rejected?.review?.rubrics) || !rejected.review.rubrics.length) return null;
  const original = cleanTaskSnapshot(source?.task ?? source);
  if (!original) return null;
  const rubrics = cleanRubrics(rejected.review, original, null);
  if (!rubrics.length) return null;
  return {
    rubrics: rubrics.map((rubric) => ({
      rubric_id: rubric.rubric_id,
      kind: rubric.kind,
      title: rubric.title,
      original: rubric.original,
      final: rubric.final,
      changed: rubric.changed,
      checked: rubric.checked,
    })),
  };
}

async function handleReview(path, body) {
  if (!keyMatches(body.reviewKey)) {
    return respond(401, { error: "Bad or missing review key" });
  }
  const reviewer = String(body.reviewer || "").slice(0, 120);
  // The caller's own participant id (slugified email). Optional: clients that
  // don't send it keep today's behavior; when present, their own submissions
  // are invisible to /review/status counts and unclaimable via /review/claim.
  const reviewerPid = String(body.reviewer_pid || "").trim().toLowerCase();

  if (path === "/review/register") {
    const taskId = cleanText(body.task_id, 160);
    const participantId = cleanText(body.participant_id, 80);
    try {
      const registered = await registerDashboardSubmission(taskId, participantId);
      if (registered.reason === "invalid_task") return respond(400, { error: "Invalid task registration" });
      if (registered.reason === "upload_not_found") return respond(409, { error: "Uploaded task is not visible yet" });
      if (registered.reason === "task_mismatch") return respond(409, { error: "Uploaded task identity does not match" });
      return respond(200, { ok: true, ...registered });
    } catch (error) {
      console.error("Dashboard registration failed", error);
      return respond(503, { error: "Task uploaded, but dashboard indexing is temporarily unavailable" });
    }
  }

  if (path === "/review/contributions") {
    const participantId = String(body.participantId || "");
    const validParticipant = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(participantId);
    if (!validParticipant || !reviewer) return respond(400, { error: "participantId and reviewer required" });
    const [submitted, reviewed] = await Promise.all([
      participantTaskCount(participantId),
      reviewerCreditCount(reviewer),
    ]);
    return respond(200, { submitted, reviewed });
  }

  if (path === "/review/status") {
    const [{ pending, lockSet, finalizingSet, counts }, reviewers, rejectedKeys, finishedKeys, rejecters] = await Promise.all([
      cachedQueueState(),
      reviewerTotals(),
      listAll(`${REVIEW_PREFIX}rejected/`),
      listAll(`${REVIEW_PREFIX}finished/`),
      appealRejecters(),
    ]);
    // Exclude the caller's own submissions from pending/claimable so the queue
    // tiles never advertise tasks the reviewer isn't allowed to claim; report
    // them separately as own_pending.
    const allEligible = excludeIneligible(pending, reviewerPid, rejecters);
    const audited = await completedPreQcSubmissionKeys(pending);
    const eligible = allEligible.filter((key) => audited.has(key));
    const availability = reviewQueueAvailability(eligible, lockSet, finalizingSet);
    const approved = finishedKeys.length;
    const approvedTaskIds = new Set(
      finishedKeys.map((key) => String(key).slice(String(key).lastIndexOf("/") + 1).replace(/\.json$/, ""))
    );
    const rejected = [...distinctRejectedTaskIds(rejectedKeys)].filter((id) => !approvedTaskIds.has(id)).length;
    return respond(200, {
      ...counts,
      locked: availability.locked,
      finished: approved + rejected,
      approved,
      pending: eligible.length,
      claimable: availability.claimable,
      awaiting_live_audit: allEligible.length - eligible.length,
      own_pending: pending.length - excludeOwnSubmissions(pending, reviewerPid).length,
      rejected,
      own_awaiting_signoff: await ownAwaitingSignoff(finishedKeys, reviewerPid),
      reviewers,
    });
  }

  if (path === "/review/admin") {
    if (!isAllowedAdminEmail(body.admin_email)) return respond(403, { error: "Admin access required" });
    if (body.action === "reopen") {
      const result = await reopenReviewOutcome(body.task_id, body.admin_email, body.reason);
      return respond(result.status, result.body, { "Cache-Control": "no-store" });
    }
    if (body.action === "reopen_by_reviewer") {
      // Bulk re-queue of one reviewer's decisions (default: approvals they did
      // not edit). Bounded per call so the Lambda stays well inside its
      // timeout; the response says how many remain so the client can repeat.
      const targetReviewer = normalizeReviewerName(body.reviewer);
      if (!targetReviewer) return respond(400, { error: "reviewer required" });
      const onlyUnedited = body.only_unedited !== false;
      const outcome = body.outcome === "rejected" ? "rejected" : "approved";
      const limit = Math.max(1, Math.min(20, Math.floor(Number(body.limit) || 20)));
      const dashboard = await adminListDashboard();
      const matches = (dashboard.items ?? []).filter((item) =>
        item.status === outcome &&
        normalizeReviewerName(item.reviewer) === targetReviewer &&
        (!onlyUnedited || outcome !== "approved" || !(item.changed_in_qc ?? item.changed))
      );
      const results = [];
      for (const item of matches.slice(0, limit)) {
        try {
          const result = await reopenReviewOutcome(item.task_id, body.admin_email, body.reason || `Bulk re-queue of ${outcome} decisions by ${item.reviewer}`);
          results.push({ task_id: item.task_id, ok: result.status === 200, error: result.body?.error });
        } catch (error) {
          results.push({ task_id: item.task_id, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return respond(200, {
        ok: true,
        reviewer: body.reviewer,
        matched: matches.length,
        reopened: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok),
        remaining: Math.max(0, matches.length - results.filter((result) => result.ok).length),
      }, { "Cache-Control": "no-store" });
    }
    if (body.action === "detail") {
      const taskId = cleanText(body.task_id, 160);
      let item = null;
      try {
        item = await indexedAdminDetail(taskId);
      } catch (error) {
        console.error("Dashboard index detail failed; using S3 source of truth", error);
      }
      if (!item) item = (await adminDashboard()).items.find((candidate) => candidate.task_id === taskId);
      if (!item) return respond(404, { error: "Task not found" });
      return respond(200, { item: { ...item, detail_loaded: true } }, { "Cache-Control": "no-store" });
    }
    return respond(200, pageAdminDashboard(await adminListDashboard(), body), { "Cache-Control": "no-store" });
  }

  if (path === "/review/pc-admin") {
    if (!isAllowedAdminEmail(body.admin_email)) return respond(403, { error: "Admin access required" });
    if (body.action === "save") {
      const saved = await pcAdminSave(body);
      return respond(saved.status, saved.body);
    }
    if (body.action === "detail") {
      const detail = await pcAdminDetail(body);
      return respond(detail.status, detail.body);
    }
    const bundles = await pcAdminBundles();
    const summaries = bundles.map((bundle) => bundle.summary);
    return respond(200, { ...summarizePCBundles(summaries), bundles: summaries });
  }

  if (path === "/review/claim") {
    if (!reviewer) return respond(400, { error: "reviewer required" });
    const [{ pending, lockSet, finalizingSet, inboxAge, counts, reopenExclusions }, rejecters] = await Promise.all([
      queueState(),
      appealRejecters(),
    ]);
    // Never hand a reviewer their own submission (server-side authoritative —
    // the client-side filter is only cosmetic), nor a task an admin re-queued
    // away from them for a second opinion.
    const allEligible = excludeReopenedForReviewer(
      excludeIneligible(pending, reviewerPid, rejecters),
      reviewer,
      reopenExclusions
    );
    // Audit the FULL pending list, not the per-reviewer slice: the result is
    // reviewer-independent, so the signature cache hits across concurrent
    // reviewers instead of re-listing the pre-QC prefixes per request.
    const audited = await completedPreQcSubmissionKeys(pending);
    const eligible = allEligible.filter((key) => audited.has(key));
    // Try ordinary unlocked tasks first, then abandoned finalizations that need
    // recovery. Fresh ordinary locks cannot succeed and are deliberately left
    // out so the 25-attempt cap cannot starve recovery work.
    const unlocked = eligible.filter((k) => !lockSet.has(b64url(k)));
    const finalizing = eligible.filter((k) => finalizingSet.has(b64url(k)));
    let attempts = 0;
    for (const subKey of orderClaimCandidates(unlocked, finalizing, body.skip_keys)) {
      if (attempts++ >= 25) break; // bound worst-case latency under heavy contention
      // The marker is written at presign time — make sure the upload actually
      // happened before handing the task to a reviewer.
      try {
        await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: subKey }));
      } catch (err) {
        // Skip anything unverifiable this round — but DELETE the marker only
        // on a definitive 404 (presigned-but-never-uploaded, >1h old). A
        // throttle/permission blip must never hide a real submission forever.
        const code = err.$metadata?.httpStatusCode;
        const definitelyMissing = code === 404 || err.name === "NotFound" || err.name === "NoSuchKey";
        const age = Date.now() - (inboxAge.get(subKey) ?? 0);
        if (definitelyMissing && age > 60 * 60 * 1000) {
          await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: inboxKeyFor(subKey) })).catch(() => {});
        }
        continue;
      }
      // Serialize the final freshness check with author-edit publication. A
      // queue snapshot can name the old revision while an author publishes a
      // newer one; only the current newest inbox revision may receive a review
      // lock, or the old review could occupy the task's singleton final-gold
      // key and permanently block the new revision.
      const mutationLock = await acquireAuthorMutationLock(subKey, `reviewer:${reviewerPid || reviewer}:claim`);
      if (!mutationLock) continue;
      let token = null;
      try {
        if (await recoverStaleFinalizingReview(subKey) && await revalidateClaimCandidate(subKey)) {
          token = await tryLock(subKey, reviewer, lockKeyFor, reviewerPid);
        }
      } finally {
        await releaseAuthorMutationLock(subKey, mutationLock);
      }
      if (token) {
        const indexedTaskId = taskIdFromSubmissionKey(subKey);
        if (indexedTaskId) {
          await setDashboardIndexStatus(indexedTaskId, "in_review", {
            expected_source_key: subKey,
            reviewer,
            lock_expires_at: new Date(Date.now() + Number(LOCK_TTL_MS)).toISOString(),
          }).catch((error) => console.error("Dashboard claim index update failed", error));
        }
        const taskUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: subKey }), {
          expiresIn: 3600,
        });
        return respond(200, {
          sub_key: subKey,
          task_url: taskUrl,
          token,
          lock_ttl_ms: Number(LOCK_TTL_MS),
          remaining: eligible.length - 1,
          counts,
        });
      }
    }
    return respond(200, { sub_key: null, remaining: 0, counts });
  }

  if (path === "/review/release") {
    const { sub_key, token } = body;
    if (!sub_key || !token) return respond(400, { error: "sub_key and token required" });
    const mutationLock = await acquireAuthorMutationLock(sub_key, `reviewer:${reviewerPid || reviewer}:release`);
    if (!mutationLock) {
      return respond(409, { error: "This task is being finalized or changed. Retry in a moment." });
    }
    try {
    const etag = await verifyReleasableLock(sub_key, token);
    if (!etag) return respond(409, { error: "Lock not held by you, or this review is already finalizing" });
    const released = await deleteLockIfUnchanged(sub_key, etag);
    // A release is a skip: record it (zero-byte, keyed by review unit) so
    // reporting can count how many reviewers bounced off a task.
    if (released) {
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: reviewSkipMarkerKeyFor(sub_key, reviewer),
        Body: "",
        ContentType: "text/plain",
      })).catch((error) => console.error("Skip marker write failed", error));
    }
    const indexedTaskId = taskIdFromSubmissionKey(sub_key);
    if (released && indexedTaskId) {
      await setDashboardIndexStatus(indexedTaskId, "pending", { expected_source_key: sub_key })
        .catch((error) => console.error("Dashboard release index update failed", error));
    }
    return respond(200, { ok: true });
    } finally {
      await releaseAuthorMutationLock(sub_key, mutationLock);
    }
  }

  if (path === "/review/llm-feedback") {
    const { sub_key, token } = body;
    if (!sub_key || !token) return respond(400, { error: "sub_key and token required" });
    const etag = await verifyLock(sub_key, token);
    if (!etag) return respond(409, { error: "Lock not held by you (it may have expired)" });
    return respond(200, await preQcReviewForClaimedTask(sub_key));
  }

  if (path === "/review/submit") {
    const { sub_key, token, reviewed } = body;
    if (!sub_key || !token || !reviewed) return respond(400, { error: "sub_key, token, reviewed required" });
    // Validate before any write: shape, size, and the authored-content-only
    // policy (provenance/participant must never reach the finished set —
    // enforced server-side, not just by the well-behaved client).
    if (typeof reviewed !== "object" || Array.isArray(reviewed)) {
      return respond(400, { error: "reviewed must be an object" });
    }
    const taskIdRaw = reviewed.task_id;
    if (typeof taskIdRaw !== "string" || !taskIdRaw.trim()) {
      return respond(400, { error: "reviewed.task_id required" });
    }
    if (typeof reviewed.task !== "object" || typeof reviewed.task?.agent_request !== "string") {
      return respond(400, { error: "reviewed.task.agent_request required" });
    }
    const sourceWorkflow = String(sub_key).includes("trajectory_rework")
      ? await readJson(sub_key).then(({ json }) => json?.workflow).catch(() => null)
      : null;
    const trajectoryEditLink = sourceWorkflow?.kind === "trajectory_edit"
      ? {
          kind: "trajectory_edit",
          revision_of_task_id: cleanText(sourceWorkflow.revision_of_task_id, 300),
          source_manifest_key: cleanText(sourceWorkflow.source_manifest_key, 2_000),
          run_id: cleanText(sourceWorkflow.run_id, 120),
          reason: cleanText(sourceWorkflow.reason, 20_000),
        }
      : null;
    const reviewedMetadata = taskMetadataForReporting(reviewed.task);
    const safeReviewed = {
      schema_version: "odyssey_long_task_v2_reviewed",
      task_id: taskIdRaw,
      mode: reviewed.mode,
      task: {
        task_title: String(reviewed.task.task_title || "").slice(0, 300),
        agent_request: reviewed.task.agent_request,
        difficulty: reviewed.task.difficulty,
        site_scope: Array.isArray(reviewed.task.site_scope) ? reviewed.task.site_scope.slice(0, 30) : [],
        success_criteria: Array.isArray(reviewed.task.success_criteria) ? reviewed.task.success_criteria.slice(0, 50) : [],
        must_visit_or_reach: Array.isArray(reviewed.task.must_visit_or_reach) ? reviewed.task.must_visit_or_reach.slice(0, 50) : [],
        required_outputs: Array.isArray(reviewed.task.required_outputs) ? reviewed.task.required_outputs.slice(0, 30) : [],
        notes: reviewed.task.notes ?? null,
        ...(reviewedMetadata ? { metadata: reviewedMetadata } : {}),
        steps: Array.isArray(reviewed.task.steps)
          ? reviewed.task.steps.slice(0, 50).map((step, index) => ({
              order: Number.isFinite(Number(step?.order)) ? Number(step.order) : index + 1,
              title: String(step?.title || `Step ${index + 1}`).slice(0, 200),
              description: String(step?.description || "").slice(0, 20_000),
            })).filter((step) => step.description.trim())
          : [],
      },
      review: {
        ...(typeof reviewed.review === "object" && !Array.isArray(reviewed.review) ? reviewed.review : {}),
        ...(trajectoryEditLink ? { trajectory_edit: trajectoryEditLink } : {}),
      },
    };
    if (JSON.stringify(safeReviewed).length > 512 * 1024) {
      return respond(400, { error: "reviewed payload too large (512KB max)" });
    }
    const contentHash = reviewContentHash(safeReviewed);
    const taskId = taskIdRaw.replace(/[^A-Za-z0-9_-]/g, "_");
    const finishedKey = `${REVIEW_PREFIX}finished/${taskId}.json`;
    const changedInReview = Boolean(
      safeReviewed.review?.title_edited ||
      safeReviewed.review?.request_edited ||
      (Array.isArray(safeReviewed.review?.rubrics) && safeReviewed.review.rubrics.some((rubric) => rubric?.changed))
    );
    const decisionPid = await reviewerPidForDecision(sub_key, token, reviewerPid);
    const mutationLock = await acquireAuthorMutationLock(sub_key, `reviewer:${decisionPid || reviewer}:approve`);
    if (!mutationLock) {
      return respond(409, { error: "This task is being changed or reopened. Retry in a moment." });
    }
    try {
    // Retry after an ambiguous network/server error: if this exact outcome
    // already won, finish its credit receipt and return success idempotently.
    // Check the durable done record BEFORE requiring the now-deleted lock: a
    // successful first request can lose its HTTP response after finalization.
    const existingDone = await readDoneRecord(sub_key);
    if (existingDone) {
      if (existingDone.target !== finishedKey || (existingDone.outcome && existingDone.outcome !== "approved")) {
        return respond(409, { error: "This task was already finished by another reviewer" });
      }
      if (existingDone.content_hash && existingDone.content_hash !== contentHash) {
        return respond(409, { error: "A different edit of this task was already submitted" });
      }
      const creditedReviewer = String(existingDone.reviewer || reviewer);
      const completedAt = String(existingDone.completed_at || new Date().toISOString());
      await recordReviewerCredit(creditedReviewer, "approved", sub_key, taskId, completedAt);
      const retryEtag = await verifyLock(sub_key, token);
      if (retryEtag) await deleteLockIfUnchanged(sub_key, retryEtag);
      await setDashboardIndexStatus(taskIdRaw, "approved", {
        expected_source_key: sub_key,
        reviewer: creditedReviewer,
        reviewed_at: completedAt,
        done_target: finishedKey,
        claimed_at: String(existingDone.claimed_at || ""),
        changed: changedInReview,
        changed_in_qc: changedInReview,
        final_title: safeReviewed.task.task_title,
        final_difficulty: safeReviewed.task.difficulty,
        final_metadata: safeReviewed.task.metadata,
        final_gold_revision: 1,
      }).catch((error) => console.error("Dashboard approval index update failed", error));
      return respond(200, { ok: true, finished_key: finishedKey, idempotent: true });
    }
    let etag = await verifyCurrentReviewDecision(sub_key, token);
    if (!etag) return respond(409, { error: "Lock not held by you (it may have expired)" });
    etag = await beginFinalization(sub_key, token, reviewer, "approved", contentHash);
    if (!etag) return respond(409, { error: "Another edit or outcome is already being submitted" });
    let completedAt = new Date().toISOString();
    // Capture this before the finished object is written. The lock is deleted
    // immediately after finalization, and reporting needs the same immutable
    // claim timestamp on final gold as on the done record. It deliberately is
    // not part of `safeReviewed` or `contentHash`.
    const claimedAt = await lockClaimedAt(sub_key);
    let doc = buildApprovedFinalGoldDocument({
      reviewed: safeReviewed,
      contentHash,
      reviewer,
      reviewerPid: decisionPid,
      claimedAt,
      completedAt,
    });
    const createdFinished = await tryConditionalWrite(() => s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: finishedKey,
        Body: JSON.stringify(doc, null, 2),
        ContentType: "application/json",
        IfNoneMatch: "*",
      })
    ));
    if (!createdFinished) {
      const existingFinished = await readJson(finishedKey).then(({ json }) => json).catch(() => null);
      if (!existingFinished || existingFinished.review_content_hash !== contentHash) {
        return respond(409, { error: "A different edit or task with this ID was already submitted" });
      }
      doc = existingFinished;
      completedAt = String(existingFinished.finished_at || completedAt);
    }
    // The conditional done marker is both queue completion and the durable
    // source for idempotent finalization. It can never be overwritten.
    const done = await writeDoneRecord(sub_key, {
      target: finishedKey,
      outcome: "approved",
      reviewer,
      reviewer_pid: decisionPid,
      task_id: taskId,
      completed_at: completedAt,
      claimed_at: claimedAt,
      content_hash: contentHash,
    });
    if (done.target !== finishedKey || done.outcome !== "approved" || (done.content_hash && done.content_hash !== contentHash)) {
      return respond(409, { error: "This task was already finished by another reviewer" });
    }
    await recordReviewerCredit(String(done.reviewer || reviewer), "approved", sub_key, taskId, String(done.completed_at || completedAt));
    await deleteLockIfUnchanged(sub_key, etag);
    await setDashboardIndexStatus(taskIdRaw, "approved", {
      expected_source_key: sub_key,
      reviewer: String(done.reviewer || reviewer),
      reviewed_at: String(done.completed_at || completedAt),
      done_target: finishedKey,
      claimed_at: String(done.claimed_at || claimedAt || ""),
      changed: changedInReview,
      changed_in_qc: changedInReview,
      final_title: safeReviewed.task.task_title,
      final_difficulty: safeReviewed.task.difficulty,
      final_metadata: safeReviewed.task.metadata,
      final_gold_revision: 1,
    }).catch((error) => console.error("Dashboard approval index update failed", error));
    return respond(200, { ok: true, finished_key: finishedKey });
    } finally {
      await releaseAuthorMutationLock(sub_key, mutationLock);
    }
  }

  // Newest accepted tasks, for the in-app reference library (authored content
  // only — these records were provenance-stripped at submit time).
  if (path === "/review/finished") {
    const all = await listAllObjects(`${REVIEW_PREFIX}finished/`);
    // Amendments rewrite LastModified, so selecting a LastModified window
    // before reading finished_at can omit genuinely recent approvals. Read in
    // bounded batches, then rank the complete set by the immutable approval
    // timestamp.
    const reads = [];
    for (let offset = 0; offset < all.length; offset += 25) {
      const batch = await Promise.all(
        all.slice(offset, offset + 25).map((o) =>
        readJson(o.Key)
          .then(({ json }) => ({
            task_id: json.task_id,
            title: json.task?.task_title ?? "",
            request: String(json.task?.agent_request ?? "").slice(0, 1200),
            difficulty: json.task?.difficulty ?? "high",
            criteria: (json.task?.success_criteria ?? []).slice(0, 12),
            reviewed_by: json.reviewed_by ?? "",
            finished_at: json.finished_at ?? "",
          }))
          .catch(() => null)
        )
      );
      reads.push(...batch);
    }
    const items = sortFinishedExamples(reads, 30);
    return respond(200, { items });
  }

  // Reject: the task is unusable (spam, gibberish, no salvageable intent).
  // It leaves the queue permanently, with the reviewer's reason on record.
  if (path === "/review/reject") {
    const { sub_key, token, task_id, reason } = body;
    if (!sub_key || !token) return respond(400, { error: "sub_key and token required" });
    const rejectionReason = String(reason || "").trim();
    if (rejectionReason.length < MIN_REJECTION_REASON_LENGTH) {
      return respond(400, {
        error: `A rejection reason of at least ${MIN_REJECTION_REASON_LENGTH} characters is required — say what is wrong so the author can fix it.`,
      });
    }
    const rejectionRubrics = cleanRubrics(body.review, null, null);
    let sanitizedRejectionReview = rejectionRubrics.length ? { rubrics: rejectionRubrics } : null;
    if (sanitizedRejectionReview && JSON.stringify(sanitizedRejectionReview).length > 256 * 1024) {
      sanitizedRejectionReview = null;
    }
    const rejId = String(task_id || "task-unknown").replace(/[^A-Za-z0-9_-]/g, "_");
    const rejectedKey = `${REVIEW_PREFIX}rejected/${rejId}_${createHash("sha256").update(sub_key).digest("hex").slice(0, 16)}.json`;
    const contentHash = reviewContentHash({
      task_id: rejId,
      reason: rejectionReason.slice(0, 500),
      ...(sanitizedRejectionReview ? { review: sanitizedRejectionReview } : {}),
    });
    const decisionPid = await reviewerPidForDecision(sub_key, token, reviewerPid);
    if (!VALID_PID.test(decisionPid)) {
      return respond(409, {
        error: "Refresh and reclaim this task before rejecting it so the author can receive a safely routed appeal.",
      }, { "Cache-Control": "no-store" });
    }
    const mutationLock = await acquireAuthorMutationLock(sub_key, `reviewer:${decisionPid || reviewer}:reject`);
    if (!mutationLock) {
      return respond(409, { error: "This task is being changed or reopened. Retry in a moment." });
    }
    try {
    // As with approval, a byte-identical retry must succeed after the first
    // request committed and removed its lock but lost the HTTP response.
    const existingDone = await readDoneRecord(sub_key);
    if (existingDone) {
      if (existingDone.target !== rejectedKey || (existingDone.outcome && existingDone.outcome !== "rejected")) {
        return respond(409, { error: "This task was already finished by another reviewer" });
      }
      if (existingDone.content_hash && existingDone.content_hash !== contentHash) {
        return respond(409, { error: "A different rejection was already submitted" });
      }
      const creditedReviewer = String(existingDone.reviewer || reviewer);
      const completedAt = String(existingDone.completed_at || new Date().toISOString());
      await recordReviewerCredit(creditedReviewer, "rejected", sub_key, rejId, completedAt);
      const retryEtag = await verifyLock(sub_key, token);
      if (retryEtag) await deleteLockIfUnchanged(sub_key, retryEtag);
      await setDashboardIndexStatus(String(task_id || "task-unknown"), "rejected", {
        expected_source_key: sub_key,
        reviewer: creditedReviewer,
        reviewed_at: completedAt,
        claimed_at: String(existingDone.claimed_at || ""),
        rejection_reason: rejectionReason.slice(0, 500),
        done_target: rejectedKey,
      }).catch((error) => console.error("Dashboard rejection index update failed", error));
      return respond(200, { ok: true, rejected_key: rejectedKey, idempotent: true });
    }
    let etag = await verifyCurrentReviewDecision(sub_key, token);
    if (!etag) return respond(409, { error: "Lock not held by you (it may have expired)" });
    etag = await beginFinalization(sub_key, token, reviewer, "rejected", contentHash);
    if (!etag) return respond(409, { error: "Another edit or outcome is already being submitted" });
    let completedAt = new Date().toISOString();
    const rejectedDoc = {
      source_key: sub_key,
      task_id: rejId,
      rejected_by: reviewer,
      rejected_by_pid: decisionPid,
      ...(sanitizedRejectionReview ? { review: sanitizedRejectionReview } : {}),
      reason: rejectionReason.slice(0, 500),
      review_content_hash: contentHash,
      rejected_at: completedAt,
    };
    const createdRejected = await tryConditionalWrite(() => s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: rejectedKey,
        Body: JSON.stringify(rejectedDoc, null, 2),
        ContentType: "application/json",
        IfNoneMatch: "*",
      })
    ));
    if (!createdRejected) {
      const existingRejected = await readJson(rejectedKey).then(({ json }) => json).catch(() => null);
      if (!existingRejected || existingRejected.review_content_hash !== contentHash) {
        return respond(409, { error: "A different rejection or task with this ID was already submitted" });
      }
      completedAt = String(existingRejected.rejected_at || completedAt);
    }
    const claimedAt = await lockClaimedAt(sub_key);
    const done = await writeDoneRecord(sub_key, {
      target: rejectedKey,
      outcome: "rejected",
      reviewer,
      reviewer_pid: decisionPid,
      task_id: rejId,
      completed_at: completedAt,
      claimed_at: claimedAt,
      content_hash: contentHash,
    });
    if (done.target !== rejectedKey || done.outcome !== "rejected" || (done.content_hash && done.content_hash !== contentHash)) {
      return respond(409, { error: "This task was already finished by another reviewer" });
    }
    await recordReviewerCredit(String(done.reviewer || reviewer), "rejected", sub_key, rejId, String(done.completed_at || completedAt));
    await deleteLockIfUnchanged(sub_key, etag);
    await setDashboardIndexStatus(String(task_id || "task-unknown"), "rejected", {
      expected_source_key: sub_key,
      reviewer: String(done.reviewer || reviewer),
      reviewed_at: String(done.completed_at || completedAt),
      rejection_reason: rejectionReason.slice(0, 500),
      done_target: rejectedKey,
      claimed_at: String(done.claimed_at || claimedAt || ""),
    }).catch((error) => console.error("Dashboard rejection index update failed", error));
    return respond(200, { ok: true, rejected_key: rejectedKey });
    } finally {
      await releaseAuthorMutationLock(sub_key, mutationLock);
    }
  }

  if (path === "/review/author-edit") {
    const { sub_key, edited } = body;
    const participantId = String(body.participant_id || "").trim().toLowerCase();
    if (!sub_key) return respond(400, { error: "sub_key required" }, { "Cache-Control": "no-store" });
    if (!VALID_PID.test(participantId)) {
      return respond(400, { error: "Invalid participant_id" }, { "Cache-Control": "no-store" });
    }
    if (participantIdFromSubKey(sub_key) !== participantId) {
      return respond(403, { error: "You can only edit your own tasks" }, { "Cache-Control": "no-store" });
    }
    if (!edited || typeof edited !== "object" || Array.isArray(edited)) {
      return respond(400, { error: "edited payload required" }, { "Cache-Control": "no-store" });
    }
    const submittedTask = sanitizeAuthoredTask(edited);
    if (!String(submittedTask.agent_request).trim()) {
      return respond(400, { error: "agent_request is required" }, { "Cache-Control": "no-store" });
    }
    const requestedAppealReason = cleanAppealReason(body.appeal_reason);
    const mutationLock = await acquireAuthorMutationLock(sub_key, `author:${participantId}:edit`);
    if (!mutationLock) {
      return respond(409, { error: "This task is being changed or reopened. Retry in a moment." }, { "Cache-Control": "no-store" });
    }
    try {
    const unit = reviewUnitForKey(sub_key);
    const { byTaskDir, lockSet, unresolvedLockSet, doneSet, doneByEncodedKey } = await loadReviewIndex({
      readDoneRecords: true,
      doneRecordFilter: (key) => reviewUnitForKey(key) === unit,
    });
    const entry = byTaskDir.get(unit);
    if (!entry) return respond(404, { error: "Task not found" }, { "Cache-Control": "no-store" });
    const newest = entry.newest;
    if (!durableDoneStateIsReadable(doneSet, doneByEncodedKey, newest)) {
      return respond(503, { error: "Task completion state is temporarily unreadable. Retry before editing." }, { "Cache-Control": "no-store" });
    }
    if (unresolvedLockSet.has(b64url(newest))) {
      return respond(503, { error: "Task review lock is temporarily unreadable. Retry before editing." }, { "Cache-Control": "no-store" });
    }
    const newestDone = doneByEncodedKey.get(b64url(newest)) ?? null;
    const outcome = doneOutcome(newestDone);
    const rejectionCount = [...doneByEncodedKey.values()]
      .filter((record) => doneOutcome(record) === "rejected").length;
    let eligibility = authorEditEligibility(outcome, lockSet.has(b64url(newest)), rejectionCount);
    if (!eligibility.allowed) {
      return respond(409, { error: eligibility.reason }, { "Cache-Control": "no-store" });
    }
    const original = await readJson(newest).then(({ json }) => json).catch(() => null);
    if (!original) {
      return respond(404, { error: "Original submission not found" }, { "Cache-Control": "no-store" });
    }
    let verifiedAppealRejecterPid = "";
    if (eligibility.appeal) {
      if (!appealReasonIsValid(requestedAppealReason)) {
        return respond(400, {
          error: `Explain why this rejection should be reviewed again (${MIN_APPEAL_REASON_LENGTH} characters minimum).`,
        }, { "Cache-Control": "no-store" });
      }
      const rejectedDoc = newestDone?.target
        ? await readJson(newestDone.target).then(({ json }) => json).catch(() => null)
        : null;
      verifiedAppealRejecterPid = rejectedByPidFromDocument(rejectedDoc);
      if (!verifiedAppealRejecterPid) {
        return respond(409, {
          error: "This rejection cannot be appealed yet because its reviewer routing record needs repair. Ask the task lead to unlock it.",
        }, { "Cache-Control": "no-store" });
      }
    }
    const safeTask = sanitizeAuthoredTask(edited, original.task ?? original);
    const newOriginal = cleanTaskSnapshot(safeTask);
    const newRubrics = cleanRubrics(null, newOriginal, null);
    const newContentHash = reportingTaskContentHash(newOriginal, null, newRubrics);
    const dir = newest.slice(0, newest.lastIndexOf("/"));
    // Inbox markers intentionally exclude a source whose publication failed.
    // Look at the task directory itself so an exact retry can recover the
    // latest durably-saved revision instead of creating another orphan.
    const revisionKeys = await listAll(`${dir}/`)
      .then((keys) => keys
        .filter((key) => isReviewSubmissionKey(key) && reviewUnitForKey(key) === unit)
        .sort())
      .catch(() => [...entry.files].sort());
    const retryKey = revisionKeys.at(-1);
    if (retryKey && !doneByEncodedKey.has(b64url(retryKey))) {
      const existing = await readJson(retryKey).then(({ json }) => json).catch(() => null);
      if (existing) {
      const existingOriginal = cleanTaskSnapshot(existing.task ?? existing);
      const existingRubrics = cleanRubrics(null, existingOriginal, null);
      if (reportingTaskContentHash(existingOriginal, null, existingRubrics) === newContentHash) {
          const rejectedByPid = await rejectedByPidForAppeal(
            retryKey,
            existing.appeal_of_sub_key,
            doneByEncodedKey,
          );
          const priorMarkerKey = retryKey !== newest
            ? newest
            : [...entry.files].filter((key) => key !== retryKey).sort().at(-1)
              || existing.appeal_of_sub_key
              || null;
          const { markerWritten, appealRouted } = await publishStoredAuthorRevision({
            subKey: retryKey,
            revision: existing,
            previousSubKey: priorMarkerKey,
            rejectedByPid,
          });
          if (markerWritten) {
            const indexItem = buildAdminItemFromDocuments({
              source: existing,
              sourceKey: retryKey,
              submittedAt: cleanText(existing.created_at, 60),
            });
            await putDashboardIndexItem(indexItem)
              .catch((error) => console.error("Dashboard retried author revision index update failed", error));
            adminDashboardCache = { dashboard: null, checkedAt: 0, pending: null };
          }
          return respond(markerWritten ? 200 : 503, {
          ok: markerWritten,
          ...(markerWritten ? {} : { error: "Your revision was saved but could not be queued safely. Retry to finish publishing it." }),
          new_sub_key: retryKey,
          new_content_hash: newContentHash,
          status: markerWritten ? "awaiting_codex" : "revision_saved_unqueued",
          queued: markerWritten,
          appeal: Boolean(existing.appeal_of_sub_key),
          appeal_routed: appealRouted,
        }, { "Cache-Control": "no-store" });
      }
      }
    }
    // An exact retry above may repair or confirm a publication whose response
    // the client missed. A different edit to an already-queued appeal would
    // create a second author pass before QC, so reject it server-side as well
    // as hiding the action in the UI. Reviewer-returned tasks remain editable.
    eligibility = authorEditEligibility(
      outcome,
      lockSet.has(b64url(newest)),
      rejectionCount,
      !outcome && Boolean(original.appeal_of_sub_key),
    );
    if (!eligibility.allowed) {
      return respond(409, { error: eligibility.reason }, { "Cache-Control": "no-store" });
    }
    // A reason-only appeal is valid: the author may believe the rejection was
    // mistaken even when the task text itself should remain unchanged.
    const revisedAt = new Date().toISOString();
    const newSubmission = { ...original, task: safeTask, created_at: revisedAt };
    delete newSubmission.quality_signals;
    const editStartedAt = cleanText(body.edit_started_at, 60) || null;
    delete newSubmission.edit_started_at;
    delete newSubmission.appeal_started_at;
    if (editStartedAt) {
      newSubmission[eligibility.appeal ? "appeal_started_at" : "edit_started_at"] = editStartedAt;
    }
    const priorAuthorRevisionNumber = Math.max(
      0,
      Math.floor(Number(original.author_revision_number) || 0),
      Number(original.appeal_number) > 0 || original.edit_started_at ? 1 : 0,
    );
    const priorAuthorRequeueCount = Math.max(
      0,
      Math.floor(Number(original.author_requeue_count) || 0),
      original.edit_started_at ? 1 : 0,
    );
    newSubmission.author_revision_of_sub_key = newest;
    newSubmission.author_revision_number = priorAuthorRevisionNumber + 1;
    newSubmission.author_requeue_count = priorAuthorRequeueCount + (eligibility.appeal ? 0 : 1);
    if (!eligibility.appeal) newSubmission.author_requeued_at = revisedAt;
    let rejectedByPid = "";
    if (eligibility.appeal) {
      rejectedByPid = verifiedAppealRejecterPid;
      newSubmission.appeal_of_sub_key = newest;
      newSubmission.appeal_number = rejectionCount;
      newSubmission.appeal_submission = true;
      newSubmission.appeal_reason = requestedAppealReason;
    } else if (original.appeal_of_sub_key) {
      rejectedByPid = await rejectedByPidForAppeal(newest, original.appeal_of_sub_key, doneByEncodedKey);
      newSubmission.appeal_of_sub_key = original.appeal_of_sub_key;
      newSubmission.appeal_number = Number(original.appeal_number) || 1;
      newSubmission.appeal_reason = cleanAppealReason(original.appeal_reason);
      delete newSubmission.appeal_submission;
    } else {
      delete newSubmission.appeal_reason;
    }
    if (!appealRevisionCanPublish(newSubmission, rejectedByPid)) {
      return respond(409, {
        error: "This appeal cannot be queued until its reviewer routing record is repaired. Ask the task lead to unlock it.",
      }, { "Cache-Control": "no-store" });
    }
    if (JSON.stringify(newSubmission).length > 512 * 1024) {
      return respond(400, { error: "edited payload too large (512KB max)" }, { "Cache-Control": "no-store" });
    }
    const baseFilename = newest
      .slice(newest.lastIndexOf("/") + 1)
      .replace(/^\d+(?:-[A-Za-z0-9]+)?_/, "");
    const participantIdFromKey = participantIdFromSubKey(newest);
    const taskId = dir.slice(`${UPLOAD_PREFIX}${participantIdFromKey}/`.length);
    const newSubKey = uploadObjectKey(participantIdFromKey, taskId, baseFilename);
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: newSubKey,
      Body: JSON.stringify(newSubmission, null, 2),
      ContentType: "application/json",
      IfNoneMatch: "*",
    }));
    const { markerWritten, appealRouted } = await publishStoredAuthorRevision({
      subKey: newSubKey,
      revision: newSubmission,
      previousSubKey: newest,
      rejectedByPid,
    });
    if (markerWritten) {
      const indexItem = buildAdminItemFromDocuments({
        source: newSubmission,
        sourceKey: newSubKey,
        submittedAt: revisedAt,
      });
      await putDashboardIndexItem(indexItem)
        .catch((error) => console.error("Dashboard author revision index update failed", error));
      adminDashboardCache = { dashboard: null, checkedAt: 0, pending: null };
    }
    return respond(markerWritten ? 200 : 503, {
      ok: markerWritten,
      ...(markerWritten ? {} : { error: "Your revision was saved but could not be queued safely. Retry to finish publishing it." }),
      new_sub_key: newSubKey,
      new_content_hash: newContentHash,
      status: markerWritten ? "awaiting_codex" : "revision_saved_unqueued",
      queued: markerWritten,
      appeal: Boolean(newSubmission.appeal_of_sub_key),
      appeal_routed: appealRouted,
    }, { "Cache-Control": "no-store" });
    } finally {
      await releaseAuthorMutationLock(sub_key, mutationLock);
    }
  }

  if (path === "/review/author-signoff") {
    const { sub_key } = body;
    const participantId = String(body.participant_id || "").trim().toLowerCase();
    if (!sub_key) return respond(400, { error: "sub_key required" }, { "Cache-Control": "no-store" });
    if (!VALID_PID.test(participantId)) {
      return respond(400, { error: "Invalid participant_id" }, { "Cache-Control": "no-store" });
    }
    if (participantIdFromSubKey(sub_key) !== participantId) {
      return respond(403, { error: "You can only sign off your own tasks" }, { "Cache-Control": "no-store" });
    }
    const mutationLock = await acquireAuthorMutationLock(sub_key, `author:${participantId}:signoff`);
    if (!mutationLock) {
      return respond(409, { error: "This task is being changed or reopened. Retry in a moment." }, { "Cache-Control": "no-store" });
    }
    try {
    const unit = reviewUnitForKey(sub_key);
    const { byTaskDir } = await loadReviewIndex();
    const newest = byTaskDir.get(unit)?.newest ?? sub_key;
    const done = await readDoneRecord(newest);
    if (doneOutcome(done) !== "approved") {
      return respond(409, { error: "Only an approved task can be signed off." }, { "Cache-Control": "no-store" });
    }
    const finished = done?.target
      ? await readJson(done.target).then(({ json }) => json).catch(() => null)
      : null;
    if (!finished) {
      return respond(503, { error: "Approved final task is temporarily unavailable. Retry before signing off." }, { "Cache-Control": "no-store" });
    }
    const signedOffAt = new Date().toISOString();
    let priorReceipt = null;
    try {
      priorReceipt = await readJson(authorSignoffKeyFor(newest)).then(({ json }) => json);
    } catch (error) {
      if (!isMissingObjectError(error)) {
        return respond(503, { error: "Existing author sign-off is temporarily unavailable. Retry." }, { "Cache-Control": "no-store" });
      }
    }
    const effectiveAction = priorReceipt?.action === "amended"
      || unchangedAmendSignoffAction(finished, participantId) === "amended"
      ? "amended"
      : "accepted";
    const effectiveSignedOffAt = cleanText(priorReceipt?.signed_off_at, 60) || signedOffAt;
    let authorApproved;
    try {
      authorApproved = await writeAuthorApprovedFinal({
        finished,
        finalGoldKey: done.target,
        subKey: newest,
        taskId: cleanText(done?.task_id, 300),
        participantId,
        action: effectiveAction,
        approvedAt: effectiveSignedOffAt,
      });
    } catch (error) {
      console.error("Author-approved final write failed", error);
      return respond(503, { error: "The final author-approved copy could not be stored. Retry." }, { "Cache-Control": "no-store" });
    }
    const { receipt, created } = await writeAuthorSignoff({
      subKey: newest,
      taskId: cleanText(done?.task_id, 300),
      participantId,
      action: "accepted",
      contentHash: cleanText(finished?.review_content_hash, 80) || "",
      openedAt: cleanText(body.opened_at, 60) || null,
      at: effectiveSignedOffAt,
    });
    await refreshAuthorDashboardIndex(newest, done, finished, receipt)
      .catch((error) => console.error("Dashboard author sign-off index update failed", error));
    adminDashboardCache = { dashboard: null, checkedAt: 0, pending: null };
    return respond(200, {
      ok: true,
      ...(created ? {} : { idempotent: true }),
      action: receipt?.action ?? "accepted",
      signed_off_at: receipt?.signed_off_at ?? effectiveSignedOffAt,
      author_approved_key: authorApproved.key,
    }, { "Cache-Control": "no-store" });
    } finally {
      await releaseAuthorMutationLock(sub_key, mutationLock);
    }
  }

  if (path === "/review/author-amend") {
    const { sub_key, edited } = body;
    const participantId = String(body.participant_id || "").trim().toLowerCase();
    if (!sub_key) return respond(400, { error: "sub_key required" }, { "Cache-Control": "no-store" });
    if (!VALID_PID.test(participantId)) {
      return respond(400, { error: "Invalid participant_id" }, { "Cache-Control": "no-store" });
    }
    if (participantIdFromSubKey(sub_key) !== participantId) {
      return respond(403, { error: "You can only amend your own tasks" }, { "Cache-Control": "no-store" });
    }
    if (!edited || typeof edited !== "object" || Array.isArray(edited)) {
      return respond(400, { error: "edited payload required" }, { "Cache-Control": "no-store" });
    }
    const safeTask = sanitizeAuthoredTask(edited);
    if (!String(safeTask.agent_request).trim()) {
      return respond(400, { error: "agent_request is required" }, { "Cache-Control": "no-store" });
    }
    const mutationLock = await acquireAuthorMutationLock(sub_key, `author:${participantId}:amend`);
    if (!mutationLock) {
      return respond(409, { error: "This task is being changed or reopened. Retry in a moment." }, { "Cache-Control": "no-store" });
    }
    try {
    const unit = reviewUnitForKey(sub_key);
    const { byTaskDir, lockSet, doneByEncodedKey } = await loadReviewIndex({
      readDoneRecords: true,
      doneRecordFilter: (key) => reviewUnitForKey(key) === unit,
    });
    const entry = byTaskDir.get(unit);
    if (!entry) return respond(404, { error: "Task not found" }, { "Cache-Control": "no-store" });
    const newest = entry.newest;
    const done = doneByEncodedKey.get(b64url(newest)) ?? null;
    if (lockSet.has(b64url(newest))) {
      return respond(409, { error: "A reviewer has claimed this task — it's locked for review." }, { "Cache-Control": "no-store" });
    }
    if (doneOutcome(done) !== "approved" || !done?.target) {
      return respond(409, { error: "Only an approved task can be amended." }, { "Cache-Control": "no-store" });
    }
    const finishedKey = done.target;
    const { json: existing, etag } = await readJson(finishedKey).catch(() => ({ json: null, etag: null }));
    if (!existing || !etag) {
      return respond(404, { error: "Final gold not found" }, { "Cache-Control": "no-store" });
    }
    const amendedTask = finalGoldTaskFromAuthorEdit(existing.task, safeTask);
    const contentHash = reviewContentHash({
      schema_version: existing.schema_version,
      task_id: existing.task_id,
      mode: existing.mode,
      task: amendedTask,
      review: existing.review ?? {},
    });
    const amendedAt = new Date().toISOString();
    if (existing.review_content_hash === contentHash) {
      const signoffAction = unchangedAmendSignoffAction(existing, participantId);
      let priorReceipt = null;
      try {
        priorReceipt = await readJson(authorSignoffKeyFor(newest)).then(({ json }) => json);
      } catch (error) {
        if (!isMissingObjectError(error)) {
          return respond(503, { error: "Existing author sign-off is temporarily unavailable. Retry." }, { "Cache-Control": "no-store" });
        }
      }
      const effectiveSignedOffAt = cleanText(priorReceipt?.signed_off_at, 60)
        || cleanText(existing.amended_at, 60)
        || amendedAt;
      let authorApproved;
      try {
        authorApproved = await writeAuthorApprovedFinal({
          finished: existing,
          finalGoldKey: finishedKey,
          subKey: newest,
          taskId: cleanText(done?.task_id, 300),
          participantId,
          action: signoffAction,
          approvedAt: effectiveSignedOffAt,
        });
      } catch (error) {
        console.error("No-op amendment author-approved final write failed", error);
        return respond(503, { error: "The final author-approved copy could not be stored. Retry." }, { "Cache-Control": "no-store" });
      }
      const { receipt } = await writeAuthorSignoff({
        subKey: newest,
        taskId: cleanText(done?.task_id, 300),
        participantId,
        action: signoffAction,
        contentHash,
        openedAt: cleanText(body.opened_at, 60) || null,
        at: effectiveSignedOffAt,
      });
      await refreshAuthorDashboardIndex(newest, done, existing, receipt)
        .catch((error) => console.error("Dashboard no-op author amend index update failed", error));
      adminDashboardCache = { dashboard: null, checkedAt: 0, pending: null };
      return respond(200, {
        ok: true,
        idempotent: true,
        action: receipt?.action ?? signoffAction,
        revision_count: finalGoldRevision(existing),
        new_content_hash: contentHash,
        author_approved_key: authorApproved.key,
      }, { "Cache-Control": "no-store" });
    }
    const doc = buildAmendedFinalGold({
      existing,
      amendedTask,
      contentHash,
      authorPid: participantId,
      amendedAt,
    });
    if (JSON.stringify(doc).length > 512 * 1024) {
      return respond(400, { error: "amended payload too large (512KB max)" }, { "Cache-Control": "no-store" });
    }
    const archiveKey = finishedHistoryKeyFor(done.task_id || "task-unknown", finalGoldRevision(existing));
    const archived = await tryConditionalWrite(() => s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: archiveKey,
      Body: JSON.stringify(existing, null, 2),
      ContentType: "application/json",
      IfNoneMatch: "*",
    })));
    if (!archived) {
      const archivedDoc = await readJson(archiveKey).then(({ json }) => json).catch(() => null);
      if (archivedDoc?.review_content_hash !== existing.review_content_hash) {
        return respond(409, { error: "Another amendment of this task is already in flight." }, { "Cache-Control": "no-store" });
      }
    }
    const replaced = await tryConditionalWrite(() => s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: finishedKey,
      Body: JSON.stringify(doc, null, 2),
      ContentType: "application/json",
      IfMatch: etag,
    })));
    if (!replaced) {
      return respond(409, { error: "This task changed while you were editing. Reload and try again." }, { "Cache-Control": "no-store" });
    }
    let authorApproved;
    try {
      authorApproved = await writeAuthorApprovedFinal({
        finished: doc,
        finalGoldKey: finishedKey,
        subKey: newest,
        taskId: cleanText(done?.task_id, 300),
        participantId,
        action: "amended",
        approvedAt: amendedAt,
      });
    } catch (error) {
      console.error("Author amendment final copy write failed", error);
      return respond(503, { error: "Your amendment was saved, but the final author-approved copy still needs to be stored. Retry." }, { "Cache-Control": "no-store" });
    }
    const { receipt } = await writeAuthorSignoff({
      subKey: newest,
      taskId: cleanText(done?.task_id, 300),
      participantId,
      action: "amended",
      contentHash,
      openedAt: cleanText(body.opened_at, 60) || null,
      at: amendedAt,
    });
    await refreshAuthorDashboardIndex(newest, done, doc, receipt)
      .catch((error) => console.error("Dashboard author amendment index update failed", error));
    adminDashboardCache = { dashboard: null, checkedAt: 0, pending: null };
    return respond(200, {
      ok: true,
      revision_count: doc.revision_count,
      new_content_hash: contentHash,
      amended_at: amendedAt,
      author_approved_key: authorApproved.key,
    }, { "Cache-Control": "no-store" });
    } finally {
      await releaseAuthorMutationLock(sub_key, mutationLock);
    }
  }

  if (path === "/review/my-tasks") {
    const participantId = String(body.participant_id || "").trim().toLowerCase();
    if (!VALID_PID.test(participantId)) {
      return respond(400, { error: "Invalid participant_id" }, { "Cache-Control": "no-store" });
    }
    const { byTaskDir, lockSet, doneByEncodedKey, inboxAge } = await loadReviewIndex({
      readDoneRecords: true,
      doneRecordFilter: (key) => participantIdFromSubKey(key) === participantId,
    });
    const ownUnits = [];
    for (const { newest, oldestAt } of byTaskDir.values()) {
      if (participantIdFromSubKey(newest) === participantId) ownUnits.push({ newest, oldestAt });
    }
    ownUnits.sort((a, b) => b.oldestAt - a.oldestAt || b.newest.localeCompare(a.newest));
    const sourceTotal = ownUnits.length;
    const offset = Math.max(0, Number(body.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(body.limit) || 50));
    const pageUnits = ownUnits.slice(offset, offset + limit);
    const audited = await completedPreQcSubmissionKeys(pageUnits.map((unit) => unit.newest));
    const signoffObjects = await listAllObjects(AUTHOR_SIGNOFF_PREFIX);
    const signoffKeys = new Set();
    for (const object of signoffObjects) {
      const encoded = object.Key.slice(AUTHOR_SIGNOFF_PREFIX.length).replace(/\.json$/, "");
      try {
        signoffKeys.add(fromB64url(encoded));
      } catch {
        // Ignore malformed receipts.
      }
    }
    let approvedTotal = 0;
    let awaitingSignoffTotal = 0;
    for (const { newest } of ownUnits) {
      if (doneOutcome(doneByEncodedKey.get(b64url(newest)) ?? null) !== "approved") continue;
      approvedTotal += 1;
      if (!signoffKeys.has(newest)) awaitingSignoffTotal += 1;
    }
    const rejectionsInUnit = new Map();
    for (const [encoded, record] of doneByEncodedKey.entries()) {
      if (doneOutcome(record) !== "rejected") continue;
      try {
        const unit = reviewUnitForKey(fromB64url(encoded));
        rejectionsInUnit.set(unit, (rejectionsInUnit.get(unit) ?? 0) + 1);
      } catch {
        // Ignore malformed done keys.
      }
    }
    const buildItem = async ({ newest }) => {
      const done = doneByEncodedKey.get(b64url(newest)) ?? null;
      const outcome = doneOutcome(done);
      let status;
      if (outcome === "approved") status = "approved";
      else if (outcome === "rejected") status = "rejected";
      else if (outcome === "returned") status = "returned";
      else if (lockSet.has(b64url(newest))) status = "in_review";
      else if (audited.has(newest)) status = "pending";
      else status = "awaiting_codex";
      const source = await readJson(newest).then(({ json }) => json).catch(() => null);
      const task = source?.task ?? source;
      const original = cleanTaskSnapshot(task);
      const rubrics = cleanRubrics(null, original, null);
      const contentHash = original ? reportingTaskContentHash(original, null, rubrics) : null;
      const submittedAt = source?.created_at
        || (inboxAge.has(newest) ? new Date(inboxAge.get(newest)).toISOString() : null);
      const item = {
        task_id: cleanText(source?.task_id, 300),
        sub_key: newest,
        title: cleanText(task?.task_title ?? task?.title, 300),
        request: String(task?.agent_request ?? task?.request ?? "").slice(0, 300),
        status,
        submitted_at: submittedAt || null,
        content_hash: contentHash,
      };
      const rejectionCount = rejectionsInUnit.get(reviewUnitForKey(newest)) ?? 0;
      item.rejection_count = rejectionCount;
      if (status === "approved" && done?.target) {
        const finished = await readJson(done.target).then(({ json }) => json).catch(() => null);
        item.reviewer_changed = reviewerChangedTask(finished);
        item.revision_count = finalGoldRevision(finished);
        item.signed_off_at = "";
        item.signoff_action = "";
        item.needs_signoff = !signoffKeys.has(newest);
      }
      if (status === "rejected" && done?.target) {
        const rejected = await readJson(done.target).then(({ json }) => json).catch(() => null);
        item.rejection_reason = cleanText(rejected?.reason, 500) || "";
        item.can_appeal = rejectionCanAppeal(rejectionCount, rejected);
        if (rejectionCount === 1 && !item.can_appeal) {
          item.appeal_unavailable_reason = "This rejection cannot be appealed yet. Ask the task lead to unlock it.";
        }
      }
      if (status === "returned" && done?.target) {
        const returned = await readJson(done.target).then(({ json }) => json).catch(() => null);
        item.returned_reason = cleanText(returned?.reason, 500) || "";
      }
      return item;
    };
    const items = [];
    for (let index = 0; index < pageUnits.length; index += 25) {
      items.push(...(await Promise.all(pageUnits.slice(index, index + 25).map(buildItem))));
    }
    const signedRows = items.filter((item) => item.status === "approved" && !item.needs_signoff);
    for (let index = 0; index < signedRows.length; index += 25) {
      await Promise.all(signedRows.slice(index, index + 25).map(async (item) => {
        const receipt = await readJson(authorSignoffKeyFor(item.sub_key))
          .then(({ json }) => json)
          .catch(() => null);
        item.signed_off_at = cleanText(receipt?.signed_off_at, 60) || "";
        item.signoff_action = cleanText(receipt?.action, 20) || "";
      }));
    }
    return respond(200, {
      items,
      offset,
      limit,
      source_total: sourceTotal,
      approved_total: approvedTotal,
      awaiting_signoff_total: awaitingSignoffTotal,
    }, { "Cache-Control": "no-store" });
  }

  if (path === "/review/my-task-feedback") {
    const { sub_key } = body;
    const participantId = String(body.participant_id || "").trim().toLowerCase();
    if (!sub_key) return respond(400, { error: "sub_key required" }, { "Cache-Control": "no-store" });
    if (!VALID_PID.test(participantId)) {
      return respond(400, { error: "Invalid participant_id" }, { "Cache-Control": "no-store" });
    }
    if (participantIdFromSubKey(sub_key) !== participantId) {
      return respond(403, { error: "You can only view your own tasks" }, { "Cache-Control": "no-store" });
    }
    const preQc = await preQcReviewForClaimedTask(sub_key);
    const source = await readJson(sub_key).then(({ json }) => json).catch(() => null);
    const done = await readDoneRecord(sub_key);
    const outcome = doneOutcome(done);
    const response = {
      status: preQc.status,
      stale: preQc.stale,
      task_content_hash: preQc.task_content_hash,
      review: preQc.review,
      task: authoredTaskContentForResponse(source?.task ?? source),
    };
    if (outcome === "approved" && done?.target) {
      response.status = "approved";
      const finished = await readJson(done.target).then(({ json }) => json).catch(() => null);
      const humanReview = buildHumanReviewForAuthor(finished, source);
      if (humanReview) response.human_review = humanReview;
      response.final_task = authoredTaskContentForResponse(finished?.task ?? null);
      const receipt = await readJson(authorSignoffKeyFor(sub_key))
        .then(({ json }) => json)
        .catch(() => null);
      response.signed_off_at = cleanText(receipt?.signed_off_at, 60) || "";
      response.signoff_action = cleanText(receipt?.action, 20) || "";
      response.needs_signoff = !receipt;
    } else if (outcome === "rejected" && done?.target) {
      response.status = "rejected";
      const rejected = await readJson(done.target).then(({ json }) => json).catch(() => null);
      response.rejection_reason = cleanText(rejected?.reason, 500) || "";
      const feedback = buildRejectionFeedbackForAuthor(rejected, source);
      if (feedback) response.rejection_feedback = feedback;
    } else if (outcome === "returned" && done?.target) {
      response.status = "returned";
      const returned = await readJson(done.target).then(({ json }) => json).catch(() => null);
      response.returned_reason = cleanText(returned?.reason, 500) || "";
    }
    response.history = await authorTaskHistory(sub_key);
    return respond(200, response, { "Cache-Control": "no-store" });
  }

  if (path === "/review/return-to-author") {
    const { sub_key, token, task_id, reason } = body;
    if (!sub_key || !token) {
      return respond(400, { error: "sub_key and token required" }, { "Cache-Control": "no-store" });
    }
    const returnReason = String(reason || "").trim();
    if (returnReason.length < 3) {
      return respond(400, { error: "A return reason is required" }, { "Cache-Control": "no-store" });
    }
    const rawTaskId = String(task_id || "task-unknown");
    const taskId = rawTaskId.replace(/[^A-Za-z0-9_-]/g, "_");
    const returnedKey = `${REVIEW_PREFIX}returned/${b64url(sub_key)}.json`;
    const contentHash = reviewContentHash({ task_id: taskId, reason: returnReason.slice(0, 500) });
    const decisionPid = await reviewerPidForDecision(sub_key, token, reviewerPid);
    const mutationLock = await acquireAuthorMutationLock(sub_key, `reviewer:${decisionPid || reviewer}:return`);
    if (!mutationLock) {
      return respond(409, { error: "This task is being changed or reopened. Retry in a moment." }, { "Cache-Control": "no-store" });
    }
    try {
    const existingDone = await readDoneRecord(sub_key);
    if (existingDone) {
      if (existingDone.target !== returnedKey || (existingDone.outcome && existingDone.outcome !== "returned")) {
        return respond(409, { error: "This task was already finished by another reviewer" }, { "Cache-Control": "no-store" });
      }
      if (existingDone.content_hash && existingDone.content_hash !== contentHash) {
        return respond(409, { error: "A different return was already submitted" }, { "Cache-Control": "no-store" });
      }
      const retryEtag = await verifyLock(sub_key, token);
      if (retryEtag) await deleteLockIfUnchanged(sub_key, retryEtag);
      await setDashboardIndexStatus(rawTaskId, "pending", { expected_source_key: sub_key })
        .catch((error) => console.error("Dashboard return index update failed", error));
      return respond(200, { ok: true, returned_key: returnedKey, idempotent: true }, { "Cache-Control": "no-store" });
    }
    let etag = await verifyCurrentReviewDecision(sub_key, token);
    if (!etag) {
      return respond(409, { error: "Lock not held by you (it may have expired)" }, { "Cache-Control": "no-store" });
    }
    const claimedAt = await lockClaimedAt(sub_key);
    etag = await beginFinalization(sub_key, token, reviewer, "returned", contentHash);
    if (!etag) {
      return respond(409, { error: "Another edit or outcome is already being submitted" }, { "Cache-Control": "no-store" });
    }
    let completedAt = new Date().toISOString();
    const returnedDoc = {
      sub_key,
      task_id: taskId,
      reason: returnReason.slice(0, 500),
      returned_by: reviewer,
      returned_by_pid: decisionPid,
      content_hash: contentHash,
      returned_at: completedAt,
    };
    const createdReturned = await tryConditionalWrite(() => s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: returnedKey,
      Body: JSON.stringify(returnedDoc, null, 2),
      ContentType: "application/json",
      IfNoneMatch: "*",
    })));
    if (!createdReturned) {
      const existingReturned = await readJson(returnedKey).then(({ json }) => json).catch(() => null);
      if (!existingReturned || existingReturned.content_hash !== contentHash) {
        return respond(409, { error: "A different return or task with this ID was already submitted" }, { "Cache-Control": "no-store" });
      }
      completedAt = String(existingReturned.returned_at || completedAt);
    }
    const done = await writeDoneRecord(sub_key, {
      target: returnedKey,
      outcome: "returned",
      reviewer,
      reviewer_pid: decisionPid,
      task_id: taskId,
      completed_at: completedAt,
      content_hash: contentHash,
      claimed_at: claimedAt,
    });
    if (done.target !== returnedKey || done.outcome !== "returned" || (done.content_hash && done.content_hash !== contentHash)) {
      return respond(409, { error: "This task was already finished by another reviewer" }, { "Cache-Control": "no-store" });
    }
    await deleteLockIfUnchanged(sub_key, etag);
    await setDashboardIndexStatus(rawTaskId, "pending", { expected_source_key: sub_key })
      .catch((error) => console.error("Dashboard return index update failed", error));
    adminDashboardCache = { dashboard: null, checkedAt: 0, pending: null };
    return respond(200, { ok: true, returned_key: returnedKey }, { "Cache-Control": "no-store" });
    } finally {
      await releaseAuthorMutationLock(sub_key, mutationLock);
    }
  }

  return respond(404, { error: `Unknown review route ${path}` });
}

// ---------- handler ----------

export const handler = async (event) => {
  try {
    // Scheduled refresh (EventBridge rule) — not an HTTP request.
    if (event?.source === "aws.events" || event?.action === "refresh-admin-snapshot") {
      if (!S3_BUCKET) return { ok: false, error: "Missing S3_BUCKET env var" };
      const result = await refreshAdminDashboardSnapshot();
      console.log("admin snapshot refreshed", JSON.stringify(result));
      return { ok: true, ...result };
    }
    const method = event.requestContext?.http?.method || "POST";
    const path = event.rawPath || event.requestContext?.http?.path || "/presign";
    if (method === "OPTIONS") {
      return respond(200, {});
    }
    if (method === "GET" && path === "/reporting/tasks") {
      if (!S3_BUCKET) return respond(500, { error: "Missing S3_BUCKET env var" });
      return await handleReporting(event);
    }
    if (method === "GET" && path === "/reporting/trajectories") {
      if (!S3_BUCKET) return respond(500, { error: "Missing S3_BUCKET env var" });
      return await handleTrajectoryReporting(event);
    }
    if (method !== "POST") {
      return respond(405, { error: "Method not allowed" }, { Allow: "GET, POST, OPTIONS" });
    }
    if (!S3_BUCKET) {
      return respond(500, { error: "Missing S3_BUCKET env var" });
    }

    let body = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch (err) {
      return respond(400, { error: "Invalid JSON body" });
    }

    if (path.startsWith("/review/")) {
      return await handleReview(path, body);
    }
    if (path.startsWith("/trajectory/")) {
      return await handleTrajectoryReview(path, body);
    }
    if (path !== "/presign") {
      return respond(404, { error: `Unknown route ${path}` });
    }

    const {
      participantId,
      studyId = "unknown",
      taskId = "unknown",
      filename = "journeys.json",
      contentType = "application/json",
    } = body;
    if (!participantId) {
      return respond(400, { error: "participantId required" });
    }

    const isV2 = String(taskId).startsWith("v2/");
    if (isV2) {
      const validParticipant = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(String(participantId));
      const validTaskId = /^v2\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/internal\/task-[A-Za-z0-9-]{8,80}$/.test(String(taskId));
      if (!validParticipant || !validTaskId || studyId !== "internal") {
        return respond(400, { error: "Invalid v2 participant or task identifier" });
      }
      if (filename !== "long_task.json" || contentType !== "application/json") {
        return respond(400, { error: "Invalid v2 upload type" });
      }
    }

    // Apollo PC personal-context bundles: multiple whitelisted files per
    // bundle directory (records parts + tasks), manifest.json uploaded last.
    const isPC = String(taskId).startsWith("pc/");
    if (isPC) {
      const validParticipant = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(String(participantId));
      const validTaskId = /^pc\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/internal\/bundle-[A-Za-z0-9-]{8,80}$/.test(String(taskId));
      const validFilename = /^(manifest|tasks|records_[a-z]{3,20}(_part[1-9][0-9]{0,2})?|review_task_[A-Za-z0-9_-]{1,120})\.json$/.test(String(filename));
      if (!validParticipant || !validTaskId || studyId !== "internal") {
        return respond(400, { error: "Invalid pc participant or bundle identifier" });
      }
      if (!validFilename || contentType !== "application/json") {
        return respond(400, { error: "Invalid pc upload type" });
      }
    }

    // A dedicated Apollo PC deployment uses the same reviewed implementation
    // and bucket, but must never accept v2 or legacy uploads. The primary
    // deployment accepts legacy/v2 traffic while refusing PC uploads, so a
    // misconfigured PC build cannot silently rejoin the v2 queue.
    if (!uploadScopeAllows(APP_SCOPE, isV2, isPC)) {
      return respond(400, { error: `This upload type is not enabled for the ${APP_SCOPE} API` });
    }

    // Timestamp keeps retry ordering stable; the nonce prevents same-millisecond
    // concurrent presigns from targeting the same S3 object.
    const key = uploadObjectKey(participantId, taskId, filename);
    let presign;
    try {
      presign = await createPresignedPost(s3, {
        Bucket: S3_BUCKET,
        Key: key,
        Conditions: [
          ["content-length-range", 0, Number(MAX_FILE_BYTES)],
          ["eq", "$Content-Type", contentType],
          ["eq", "$x-amz-server-side-encryption", "AES256"],
        ],
        Fields: {
          "Content-Type": contentType,
          "x-amz-server-side-encryption": "AES256",
          "x-amz-meta-participant": participantId,
          "x-amz-meta-study": studyId,
          "x-amz-meta-task": taskId,
        },
        Expires: 600,
      });
    } catch (err) {
      console.error("Presign error", err);
      return respond(500, { error: "Failed to presign", detail: err.message || String(err) });
    }

    // Index v2 task uploads for the review queue — one tiny marker instead
    // of scanning the whole bucket later. Fire-and-forget: a marker miss just
    // means the backfill script or a re-upload catches it.
    if (isV2 && filename === "long_task.json") {
      await s3
        .send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: inboxKeyFor(key), Body: key, ContentType: "text/plain" }))
        .catch(() => {});
    }
    // PC review sidecars contain authored task text only — never participant
    // identity, mail, calendar records, aliases, or expected answers. The PC
    // client uploads them after the manifest, so the private bundle is already
    // complete before a task can enter the PC-only review queue.
    if (isPC && /^review_task_[A-Za-z0-9_-]{1,120}\.json$/.test(String(filename))) {
      await s3
        .send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: inboxKeyFor(key), Body: key, ContentType: "text/plain" }))
        .catch(() => {});
    }
    // Completed PC bundles are indexed separately for the allowlisted admin
    // viewer. The manifest uploads last, so a readable manifest represents a
    // complete bundle; stale presign-only markers are ignored by the reader.
    if (isPC && filename === "manifest.json") {
      await s3
        .send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: pcBundleIndexKeyFor(key), Body: key, ContentType: "text/plain" }))
        .catch(() => {});
    }
    return respond(200, { url: presign.url, fields: presign.fields, key });
  } catch (err) {
    console.error(err);
    return respond(500, { error: "Unhandled error", detail: err.message || String(err) });
  }
};
