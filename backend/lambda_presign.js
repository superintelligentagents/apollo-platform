import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";

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
  LOCK_TTL_MS = String(30 * 60 * 1000),
  ADMIN_EMAILS = "",
} = process.env;

const s3 = new S3Client({ region: AWS_REGION });
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
// The author's acknowledgement of an approved task: immutable, one per
// submission, written whether they accepted the reviewer's version or amended it.
const AUTHOR_SIGNOFF_PREFIX = `${REVIEW_PREFIX}author-signoffs/`;
const authorSignoffKeyFor = (subKey) => `${AUTHOR_SIGNOFF_PREFIX}${b64url(subKey)}.json`;
// Superseded final gold. finished/{task_id}.json must stay one object per task
// (/review/status counts that prefix), so an amendment archives here first.
const finishedHistoryKeyFor = (taskId, revision) =>
  `${REVIEW_PREFIX}finished-history/${taskId}/${String(revision).padStart(3, "0")}.json`;
// A revision an author submitted after a rejection. Small, separate prefix so
// the claim path can route the appeal away from the reviewer who rejected it
// without reading every candidate submission.
const APPEAL_PREFIX = `${REVIEW_PREFIX}appeals/`;
const appealKeyFor = (subKey) => `${APPEAL_PREFIX}${b64url(subKey)}.json`;
const LLM_PASS_PREFIX = `${REVIEW_PREFIX}llm_pass/`;
const LLM_FAIL_PREFIX = `${REVIEW_PREFIX}llm_fail/`;
const LLM_PRE_QC_PASS_PREFIX = `${REVIEW_PREFIX}llm_pre_qc_pass/`;
const LLM_PRE_QC_ATTENTION_PREFIX = `${REVIEW_PREFIX}llm_pre_qc_attention/`;
const MIN_REVIEWER_LLM_PIPELINE_VERSION = 19;
// A rejection an author can appeal has to say enough to act on. See the note at
// the /review/reject validation for why this is no longer 3.
const MIN_REJECTION_REASON_LENGTH = 40;
const TRAJECTORY_RUNS_PREFIX = `${REVIEW_PREFIX}trajectory-runs/`;
const TRAJECTORY_INBOX_PREFIX = `${REVIEW_PREFIX}trajectory-inbox/`;
const TRAJECTORY_LOCKS_PREFIX = `${REVIEW_PREFIX}trajectory-locks/`;
const TRAJECTORY_DONE_PREFIX = `${REVIEW_PREFIX}trajectory-done/`;
const TRAJECTORY_JUDGMENTS_PREFIX = `${REVIEW_PREFIX}trajectory-judgments/`;
const trajectoryLockKeyFor = (manifestKey) => `${TRAJECTORY_LOCKS_PREFIX}${b64url(manifestKey)}.json`;
const trajectoryDoneKeyFor = (manifestKey) => `${TRAJECTORY_DONE_PREFIX}${b64url(manifestKey)}`;
const trajectoryJudgmentKeyFor = (manifestKey) => `${TRAJECTORY_JUDGMENTS_PREFIX}${b64url(manifestKey)}.json`;

export function taskIdFromTrajectoryManifestKey(key) {
  const match = /^v2-review\/trajectory-runs\/([^/]+)\/[^/]+\/manifest\.json$/.exec(String(key));
  if (!match) return null;
  try {
    const decoded = fromB64url(match[1]);
    return b64url(decoded) === match[1] ? decoded : null;
  } catch {
    return null;
  }
}

export function participantIdFromTrajectoryManifestKey(key) {
  const taskId = taskIdFromTrajectoryManifestKey(key);
  const match = /^v2\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\//.exec(String(taskId || ""));
  return match?.[1] ?? null;
}

export function excludeOwnTrajectoryRuns(keys, reviewerPid) {
  const pid = String(reviewerPid || "").trim().toLowerCase();
  if (!VALID_PID.test(pid)) return keys;
  return keys.filter((key) => participantIdFromTrajectoryManifestKey(key) !== pid);
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

// Keyed by the exact key list rather than a single slot: the reviewer queue
// asks about every pending unit while the author-facing my-tasks page asks
// about one participant's, so one shared slot made each caller evict the
// other's entry and turned every page load into a fresh scan of both pre-QC
// prefixes.
const reviewAuditGateCache = new Map(); // signature -> { checkedAt, ready }
const REVIEW_AUDIT_GATE_TTL_MS = 10_000;
const REVIEW_AUDIT_GATE_CACHE_MAX = 8;

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
  // Re-insert so map order tracks recency, then bound the map: drop expired
  // entries first, and only then the least recently written.
  reviewAuditGateCache.delete(signature);
  reviewAuditGateCache.set(signature, { checkedAt: now, ready });
  for (const [key, entry] of reviewAuditGateCache) {
    if (now - entry.checkedAt >= REVIEW_AUDIT_GATE_TTL_MS) reviewAuditGateCache.delete(key);
  }
  while (reviewAuditGateCache.size > REVIEW_AUDIT_GATE_CACHE_MAX) {
    reviewAuditGateCache.delete(reviewAuditGateCache.keys().next().value);
  }
  return new Set(ready);
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

// Reviewers must never review their own submissions. Given the caller's
// participant id, keep only other people's tasks; with no (or an invalid) id
// the list passes through unchanged — old clients keep working. Exported for
// unit tests.
export function excludeOwnSubmissions(subKeys, reviewerPid) {
  const pid = String(reviewerPid || "").trim().toLowerCase();
  if (!VALID_PID.test(pid)) return subKeys;
  return subKeys.filter((k) => participantIdFromSubKey(k) !== pid);
}

// Everything a reviewer must not be offered: their own submissions, and any
// appeal of a task they themselves rejected. An appeal exists because the first
// call is being questioned, so handing it back to the same reviewer makes it a
// second ask rather than a second opinion. `appealRejecterByKey` maps a
// submission key to the pid of the reviewer who rejected the version it
// replaces. Exported so both rules are unit-testable without S3.
export function excludeIneligible(subKeys, reviewerPid, appealRejecterByKey = new Map()) {
  const pid = String(reviewerPid || "").trim().toLowerCase();
  if (!VALID_PID.test(pid)) return subKeys;
  return subKeys.filter(
    (k) => participantIdFromSubKey(k) !== pid && appealRejecterByKey.get(k) !== pid
  );
}

// Who may edit their own task, and why not when they may not. `outcome` is the
// done-record outcome for the unit's newest file (null when it has not been
// reviewed). Appeals are capped at one: a task rejected twice is finished.
// Exported so the rule is testable without S3.
export function authorEditEligibility(outcome, locked, rejectionCount = 0) {
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
  return { allowed: true, reason: "" };
}

// Minutes between two ISO timestamps, for the reporting layer. The client
// supplies the start of an author-side stage, so a clock that is wrong, a tab
// left open overnight, or a hand-edited payload must not become a stored
// duration: anything negative or longer than a working day reads as no
// measurement rather than a bogus one. Mirrors how the deployed reporting route
// derives authoring_minutes and review_minutes from stored timestamps.
const MAX_STAGE_MINUTES = 24 * 60;
export function stageMinutes(startedAt, endedAt) {
  const start = Date.parse(startedAt ?? "");
  const end = Date.parse(endedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const minutes = (end - start) / 60_000;
  if (minutes < 0 || minutes > MAX_STAGE_MINUTES) return null;
  return Math.round(minutes * 100) / 100;
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

// Distribution metadata for a dashboard row. Deliberately NOT part of
// cleanTaskSnapshot: reportingTaskContentHash hashes the snapshot object
// wholesale, so a field added there would restate the content hash of every
// task in the bucket and drop them all out of the pre-QC audit gate as stale.
// It rides beside the snapshots instead.
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
    };
    current.submitted += 1;
    if (item.status in current) current[item.status] += 1;
    users.set(key, current);
  }
  return [...users.values()].sort((a, b) => b.submitted - a.submitted || a.name.localeCompare(b.name));
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

export async function adminDashboard() {
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
    .sort((a, b) => (markerTime.get(b.newest) || "").localeCompare(markerTime.get(a.newest) || ""))
    .slice(0, 1000);
  const items = [];
  // Bound concurrent S3 reads. Admin views can cover hundreds of submissions,
  // and one unbounded Promise.all would create avoidable throttling spikes.
  for (let offset = 0; offset < units.length; offset += 25) {
    const batch = await Promise.all(units.slice(offset, offset + 25).map(async ({ newest, files }) => {
      const source = await readJson(newest).then(({ json }) => json).catch(() => null);
      if (!source) return null;
      const done = files.map((file) => doneByEncodedKey.get(b64url(file))).find(Boolean) ?? null;
      const lock = !done ? locks.get(b64url(newest)) ?? null : null;
      let outcome = null;
      if (done?.target) outcome = await readJson(done.target).then(({ json }) => json).catch(() => null);

      const sourceTask = source.task ?? source;
      const finalTask = done?.outcome === "approved" ? outcome?.task ?? null : null;
      const isRedacted = source.participant?.participant_id === "redacted" || newest.includes("/pc/");
      const participantId = isRedacted
        ? "redacted"
        : cleanText(source.participant?.participant_id || participantIdFromSubKey(newest) || "unknown", 80);
      const original = cleanTaskSnapshot(sourceTask);
      const final = cleanTaskSnapshot(finalTask);
      const originalMetadata = taskMetadataForReporting(sourceTask);
      const finalMetadata = taskMetadataForReporting(finalTask) ?? (final ? originalMetadata : null);
      // One resolved value for the team-spread panel: a reviewer may correct the
      // author's pick during QC, so final gold wins where it exists.
      const taskMetadata = finalMetadata ?? originalMetadata;
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
      const sourceJourneys = Array.isArray(source.provenance?.source_journeys) ? source.provenance.source_journeys : [];
      const visitCount = sourceJourneys.reduce((sum, journey) => sum + (Array.isArray(journey?.visits) ? journey.visits.length : 0), 0);
      const status = done?.outcome === "approved" ? "approved" : done?.outcome === "rejected" ? "rejected" : lock ? "in_review" : "pending";
      const taskId = cleanText(source.task_id || done?.task_id || "unknown", 160);
      const llmCandidates = applicableLlmReviewCandidates(llmCandidatesByTaskId.get(taskId), status);
      const llmMeta = selectLlmReviewArtifact(llmCandidates, taskContentHash);
      const llmReviewStale = Boolean(llmMeta?.contentHash && llmMeta.contentHash !== taskContentHash);
      return {
        task_id: taskId,
        participant_id: participantId,
        participant_name: isRedacted ? "Anonymous / redacted" : cleanText(source.participant?.name || participantId, 160),
        participant_email: isRedacted ? "" : cleanText(source.participant?.email, 240),
        mode: cleanText(source.mode || (newest.includes("/pc/") ? "pc" : "unknown"), 40),
        submitted_at: cleanText(source.created_at || markerTime.get(newest), 60),
        status,
        reviewer: cleanText(done?.reviewer || lock?.reviewer, 160),
        reviewed_at: cleanText(done?.completed_at, 60),
        claimed_at: cleanText(done?.claimed_at || lock?.claimed_at, 60),
        // How long the human review actually took. Recorded from this release
        // onward; rows finished before it read null rather than zero.
        review_minutes: stageMinutes(done?.claimed_at, done?.completed_at),
        rejection_reason: status === "rejected" ? cleanText(outcome?.reason, 500) : "",
        trajectory_count: sourceJourneys.length,
        visit_count: visitCount,
        changed,
        original: original && originalMetadata ? { ...original, metadata: originalMetadata } : original,
        final: final && finalMetadata ? { ...final, metadata: finalMetadata } : final,
        rubrics,
        task_metadata: taskMetadata,
        human_review: humanReview,
        task_content_hash: taskContentHash,
        llm_review_status: llmReviewStale ? "stale" : llmMeta?.status ?? "not_reviewed",
        llm_review_key: llmMeta?.key ?? null,
        llm_review_stage: llmMeta?.stage ?? null,
        llm_review_stale: llmReviewStale,
        // Author-side stage stamps, read straight off the submission the row is
        // built from. The reporting layer turns each pair into minutes.
        sub_key: newest,
        edit_started_at: cleanText(source.edit_started_at, 60),
        appeal_started_at: cleanText(source.appeal_started_at, 60),
        appeal_number: Number(source.appeal_number) || 0,
        final_gold_revision: status === "approved" ? finalGoldRevision(outcome) : 0,
        signoff_at: "",
        signoff_action: "",
        signoff_opened_at: "",
      };
    }));
    items.push(...batch.filter(Boolean));
  }
  await attachAuthorSignoffs(items);
  return { items, users: summarizeAdminUsers(items), truncated: byUnit.size > units.length, total: byUnit.size };
}

// Stamp each approved row with its author sign-off, if one exists. The prefix
// is listed once and only rows that actually have a receipt are read, so this
// costs nothing until authors start signing off and stays proportional to the
// number who have.
async function attachAuthorSignoffs(items) {
  const objects = await listAllObjects(AUTHOR_SIGNOFF_PREFIX).catch(() => []);
  if (!objects.length) return;
  const have = new Set();
  for (const object of objects) {
    const encoded = object.Key.slice(AUTHOR_SIGNOFF_PREFIX.length).replace(/\.json$/, "");
    try {
      have.add(fromB64url(encoded));
    } catch {
      /* malformed receipt key */
    }
  }
  const signed = items.filter((item) => item.sub_key && have.has(item.sub_key));
  for (let i = 0; i < signed.length; i += 25) {
    await Promise.all(signed.slice(i, i + 25).map(async (item) => {
      const receipt = await readJson(authorSignoffKeyFor(item.sub_key))
        .then(({ json }) => json)
        .catch(() => null);
      if (!receipt) return;
      item.signoff_at = cleanText(receipt.signed_off_at, 60);
      item.signoff_action = cleanText(receipt.action, 20);
      item.signoff_opened_at = cleanText(receipt.opened_at, 60);
    }));
  }
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
  const maxPageSize = includeContent ? 1 : includeLlmReviews ? 25 : 1_000;
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

export function buildReportingReport(dashboard, generatedAt = new Date().toISOString(), options = {}) {
  const includeContent = Boolean(options.includeContent);
  const includeLlmReviews = Boolean(options.includeLlmReviews);
  const { filteredItems, sourceItems, offset, limit } = selectReportingPage(dashboard, options);
  const items = sourceItems.map((item) => ({
    task_id: item.task_id,
    participant_id: item.participant_id,
    participant_name: item.participant_name,
    participant_email: item.participant_email,
    mode: item.mode,
    submitted_at: item.submitted_at,
    status: item.status,
    qc_completed: item.status === "approved" || item.status === "rejected",
    reviewer: item.reviewer,
    reviewed_at: item.reviewed_at,
    changed_in_qc: Boolean(item.changed),
    // Author-side stage durations, derived from stored timestamp pairs the same
    // way the deployed route derives authoring_minutes and review_minutes.
    // Added as new keys: the existing row shape is not touched.
    claimed_at: item.claimed_at ?? "",
    review_minutes: item.review_minutes ?? null,
    signoff_at: item.signoff_at ?? "",
    signoff_action: item.signoff_action ?? "",
    signoff_minutes: stageMinutes(item.signoff_opened_at, item.signoff_at),
    author_edit_minutes: stageMinutes(item.edit_started_at, item.submitted_at),
    appeal_minutes: stageMinutes(item.appeal_started_at, item.submitted_at),
    appeal_number: item.appeal_number ?? 0,
    final_gold_revision: item.final_gold_revision ?? 0,
    rejection_reason: item.rejection_reason,
    trajectory_count: item.trajectory_count,
    visit_count: item.visit_count,
    llm_review_status: item.llm_review_status ?? "not_reviewed",
    llm_review_stage: item.llm_review_stage ?? null,
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
  }));
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
    truncated: Boolean(dashboard.truncated),
    source_total: dashboard.total ?? filteredItems.length,
  };
}

export function sortPendingReviewUnits(units) {
  return [...units]
    .sort((a, b) => a.oldestAt - b.oldestAt || a.newest.localeCompare(b.newest))
    .map((unit) => unit.newest);
}

// The review index: inbox markers, done records, and fresh locks, grouped
// into task-directory units (the reviewable entity). Shared by the reviewer
// queue and the author-facing endpoints so they see the same grouping. Done
// records are only read when a caller needs outcomes (my-tasks, author-edit);
// the reviewer queue just needs membership, so it skips the extra reads.
// `doneRecordFilter(subKey)` narrows those reads to the records the caller
// will look at — without it an author-facing call reads the whole bucket.
async function loadReviewIndex({ readDoneRecords = false, doneRecordFilter = null } = {}) {
  const [inbox, doneObjects, lockObjects] = await Promise.all([
    listAllObjects(`${REVIEW_PREFIX}inbox/`),
    listAllObjects(`${REVIEW_PREFIX}done/`),
    listAllObjects(`${REVIEW_PREFIX}locks/`),
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
  const doneSet = new Set(doneObjects.map((o) => o.Key.slice(`${REVIEW_PREFIX}done/`.length)));
  let doneByEncodedKey = null;
  if (readDoneRecords) {
    doneByEncodedKey = new Map();
    // Only the records the caller will actually read. Reading every done
    // record costs one GET per completed review platform-wide — O(all
    // history) on an author-facing page load — so callers pass a filter that
    // narrows this to their own tasks. Batched like the admin dashboard:
    // one unbounded Promise.all creates avoidable throttling spikes.
    const wanted = [];
    for (const object of doneObjects) {
      const encoded = object.Key.slice(`${REVIEW_PREFIX}done/`.length);
      let subKey;
      try {
        subKey = fromB64url(encoded);
      } catch {
        continue; // malformed done key — not addressable by any caller
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
  const lockReads = await Promise.all(
    lockObjects.map((o) =>
      readJson(o.Key)
        .then(({ json }) => {
          const claimedAt = Date.parse(json.claimed_at);
          const age = Number.isFinite(claimedAt) ? Date.now() - claimedAt : Infinity;
          return age <= Number(LOCK_TTL_MS)
            ? o.Key.slice(`${REVIEW_PREFIX}locks/`.length, -".json".length)
            : null;
        })
        .catch(() => null)
    )
  );
  const lockSet = new Set(lockReads.filter(Boolean));
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
    doneSet,
    doneByEncodedKey,
    inboxAge,
    counts: { submitted: byTaskDir.size, finished: doneSet.size, locked: lockSet.size },
  };
}

// A unit is pending iff its NEWEST file is not done. The previous rule (pending
// unless ANY file was done) kept a returned task out of the queue forever once
// the author revised it: the old returned file stayed done, so the fresh
// revision never re-entered review. Backward compatible for single-file units,
// where newest === the only file. Exported so the rule is unit-testable sans S3.
export function pendingReviewUnits(units, doneSet) {
  const pendingUnits = [];
  for (const { newest, oldestAt } of units) {
    if (!doneSet.has(b64url(newest))) pendingUnits.push({ newest, oldestAt });
  }
  return pendingUnits;
}

// The queue state: task submissions minus finished ones minus freshly locked ones.
// Upload retries of the SAME task land in the same directory (the client keeps
// a stable task id) with different timestamped filenames — so the reviewable
// unit is the task DIRECTORY, represented by its newest file. Without this,
// one retried upload would be claimable twice and the second approval would
// clobber the first reviewer's finished record.
async function queueState() {
  const { byTaskDir, lockSet, doneSet, inboxAge, counts } = await loadReviewIndex();
  const pending = sortPendingReviewUnits(pendingReviewUnits([...byTaskDir.values()], doneSet));
  return { pending, lockSet, inboxAge, counts };
}

// Rejection records are keyed `{task_id}_{sha256(sub_key)[0:16]}.json`, and a
// sanitized task id may itself contain underscores, so the hash is everything
// after the LAST one. Exported so the de-duplication is testable.
export function distinctRejectedTaskIds(rejectedKeys) {
  const ids = new Set();
  for (const key of rejectedKeys) {
    const name = String(key).slice(String(key).lastIndexOf("/") + 1).replace(/\.json$/, "");
    const cut = name.lastIndexOf("_");
    ids.add(cut > 0 ? name.slice(0, cut) : name);
  }
  return ids;
}

// Final gold is keyed by the sanitized task id, which for Apollo v2 embeds the
// author: "v2/{pid}/internal/task-..." becomes "v2_{pid}_internal_task-...".
// Exported because recovering the author from a key without reading the object
// is the thing that keeps the sign-off count off the hot path.
export function participantIdFromFinishedKey(key) {
  const name = String(key).slice(String(key).lastIndexOf("/") + 1).replace(/\.json$/, "");
  const m = /^v2_([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)_internal_/.exec(name);
  return m ? m[1] : null;
}

// The caller's approved tasks that carry no sign-off receipt yet. Deliberately
// counts every approval rather than only the ones a reviewer edited: 94% are
// edited in practice, and the exact rule has to match what /review/my-tasks
// shows or the badge and the list disagree.
async function ownAwaitingSignoff(finishedKeys, reviewerPid) {
  const pid = String(reviewerPid || "").trim().toLowerCase();
  if (!VALID_PID.test(pid)) return 0;
  const own = finishedKeys.filter((key) => participantIdFromFinishedKey(key) === pid);
  if (!own.length) return 0;
  const signedOff = await listAllObjects(AUTHOR_SIGNOFF_PREFIX);
  const signedTaskIds = new Set();
  for (const object of signedOff) {
    const encoded = object.Key.slice(AUTHOR_SIGNOFF_PREFIX.length).replace(/\.json$/, "");
    try {
      const subKey = fromB64url(encoded);
      if (participantIdFromSubKey(subKey) === pid) signedTaskIds.add(subKey);
    } catch {
      /* malformed receipt key — not addressable by any caller */
    }
  }
  // Receipts are per submission and final gold is per task, so compare counts
  // rather than trying to map one key shape onto the other.
  return Math.max(0, own.length - signedTaskIds.size);
}

// Order a task's events for the author. Pure so the ordering and the identity
// rules are testable without S3: `by` is carried on approvals and returns and
// on the author's own actions, and is never set for a rejection.
export function buildAuthorHistory({ revisions, doneRecords, finalGoldHistory }) {
  const entries = [];
  for (const revision of revisions ?? []) {
    const appeal = Boolean(revision.appeal_of_sub_key);
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
      // A rejection or a return reaches the author without a name on it; an
      // approval is attributed so they can follow up with the reviewer.
      by: outcome === "approved" ? done.reviewer ?? "" : "",
      minutes: null,
      note: "",
    });
  }
  for (const record of finalGoldHistory ?? []) {
    if (record.source !== "author") continue;
    entries.push({ at: record.at ?? "", event: "amended", by: record.by ?? "", minutes: null, note: "" });
  }
  return entries
    .filter((entry) => entry.at)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.event.localeCompare(b.event));
}

// Gather the pieces buildAuthorHistory orders: every revision file in the task
// directory, every done record for the unit, and the amendments recorded inside
// final gold. Submissions are never deleted, so the directory listing is the
// durable revision chain even after an edit removed an old inbox marker.
async function authorTaskHistory(subKey) {
  const unit = reviewUnitForKey(subKey);
  // Deliberately not loadReviewIndex: this runs every time an author expands a
  // row, and the index lists three prefixes in full. Only this unit's done
  // records are needed, and their keys decode to the submission they belong to,
  // so one listing answers it.
  const [objects, doneObjects] = await Promise.all([
    listAllObjects(`${unit}/`),
    listAllObjects(`${REVIEW_PREFIX}done/`),
  ]);
  const keys = objects.map((object) => object.Key).filter(isReviewSubmissionKey).sort();
  const revisions = [];
  for (let i = 0; i < keys.length; i += 25) {
    const page = await Promise.all(keys.slice(i, i + 25).map((key) =>
      readJson(key).then(({ json }) => json).catch(() => null)
    ));
    revisions.push(...page.filter(Boolean));
  }
  revisions.forEach((revision, index_) => { revision.first = index_ === 0; });
  const wanted = [];
  for (const object of doneObjects) {
    try {
      const key = fromB64url(object.Key.slice(`${REVIEW_PREFIX}done/`.length));
      if (reviewUnitForKey(key) === unit) wanted.push(key);
    } catch {
      /* malformed done key */
    }
  }
  const doneRecords = (await Promise.all(wanted.map((key) => readDoneRecord(key)))).filter(Boolean);
  const approved = doneRecords.find((record) => doneOutcome(record) === "approved");
  const finished = approved?.target
    ? await readJson(approved.target).then(({ json }) => json).catch(() => null)
    : null;
  return buildAuthorHistory({
    revisions,
    doneRecords,
    finalGoldHistory: Array.isArray(finished?.history) ? finished.history : [],
  });
}

// Submission key -> pid of the reviewer whose rejection that submission is
// appealing. Its own prefix rather than a field inside each task: routing an
// appeal must not cost one GET per candidate on every claim. Appeals are rare,
// so the whole (small) prefix is read and batched like the done records.
async function appealRejecters() {
  const objects = await listAllObjects(APPEAL_PREFIX);
  const byKey = new Map();
  for (let offset = 0; offset < objects.length; offset += 25) {
    await Promise.all(objects.slice(offset, offset + 25).map(async (object) => {
      const record = await readJson(object.Key).then(({ json }) => json).catch(() => null);
      if (record?.sub_key && record.rejected_by_pid) {
        byKey.set(String(record.sub_key), String(record.rejected_by_pid).toLowerCase());
      }
    }));
  }
  return byKey;
}

// Atomically claim: create the lock with If-None-Match (first writer wins).
// A stale lock (crashed reviewer) is taken over with If-Match on its ETag, so
// two takeover attempts can't both win.
async function tryLock(subKey, reviewer, scopedLockKeyFor = lockKeyFor) {
  const token = randomUUID();
  const lockBody = JSON.stringify({ reviewer, token, claimed_at: new Date().toISOString() });
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
async function verifyLock(subKey, token, scopedLockKeyFor = lockKeyFor) {
  try {
    const { json, etag } = await readJson(scopedLockKeyFor(subKey));
    return json.token === token ? etag : null;
  } catch {
    return null;
  }
}

// When the reviewer claimed the task. The lock is deleted the moment a review
// finalizes, so how long a review took is unrecoverable afterwards unless the
// stamp is copied onto the done record while the lock still exists.
async function lockClaimedAt(subKey, scopedLockKeyFor = lockKeyFor) {
  try {
    const { json } = await readJson(scopedLockKeyFor(subKey));
    return cleanText(json?.claimed_at, 60) || null;
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
  } catch {
    // 412: someone took the lock over mid-flight — it's theirs now, leave it.
  }
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

async function reviewerTotals() {
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
  const taskId = cleanText(params.task_id, 160);
  const status = cleanText(params.status, 20);
  const defaultLimit = includeContent ? 1 : includeLlmReviews ? 10 : 1_000;
  const maxLimit = includeContent ? 1 : includeLlmReviews ? 25 : 1_000;
  const limit = Math.min(maxLimit, Math.max(1, Number(params.limit) || defaultLimit));
  const offset = Math.max(0, Number(params.offset) || 0);
  const options = {
    includeContent,
    includeLlmReviews,
    taskId,
    status,
    limit,
    offset,
  };
  const dashboard = await adminDashboard();
  if (includeLlmReviews) await hydrateReportingLlmReviews(dashboard, options);
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
  for (const marker of markers) {
    try {
      const manifestKey = fromB64url(marker.Key.slice(TRAJECTORY_INBOX_PREFIX.length));
      if (!manifestKey.startsWith(TRAJECTORY_RUNS_PREFIX) || !taskIdFromTrajectoryManifestKey(manifestKey)) continue;
      markerAge.set(manifestKey, marker.LastModified?.getTime() ?? 0);
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
    counts: {
      submitted: manifests.length,
      finished: manifests.filter((key) => doneSet.has(b64url(key))).length,
      locked: pending.filter((key) => lockSet.has(b64url(key))).length,
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
    const eligible = excludeOwnTrajectoryRuns(state.pending, reviewerPid);
    return respond(200, {
      ...state.counts,
      pending: eligible.length,
      claimable: eligible.filter((key) => !state.lockSet.has(b64url(key))).length,
      own_pending: state.pending.length - eligible.length,
    });
  }

  if (path === "/trajectory/claim") {
    if (!reviewer) return respond(400, { error: "reviewer required" });
    const state = await trajectoryQueueState();
    const eligible = excludeOwnTrajectoryRuns(state.pending, reviewerPid);
    const unlocked = eligible.filter((key) => !state.lockSet.has(b64url(key)));
    const locked = eligible.filter((key) => state.lockSet.has(b64url(key)));
    let attempts = 0;
    for (const manifestKey of [...unlocked, ...locked]) {
      if (attempts++ >= 25) break;
      try {
        await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: manifestKey }));
      } catch {
        continue;
      }
      const token = await tryLock(manifestKey, reviewer, trajectoryLockKeyFor);
      if (!token) continue;
      const run = await signedTrajectoryManifest(manifestKey).catch(() => null);
      if (!run) {
        const etag = await verifyLock(manifestKey, token, trajectoryLockKeyFor);
        if (etag) await deleteLockIfUnchanged(manifestKey, etag, trajectoryLockKeyFor);
        continue;
      }
      return respond(200, {
        manifest_key: manifestKey,
        token,
        lock_ttl_ms: Number(LOCK_TTL_MS),
        remaining: Math.max(0, eligible.length - 1),
        run,
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
      return respond(200, { ok: true, judgment_key: target, idempotent: true });
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
    const done = await writeDoneRecord(manifestKey, {
      target,
      outcome: "judged",
      reviewer,
      task_id: cleanManifest.task_id,
      run_id: cleanManifest.run_id,
      completed_at: reviewedAt,
      content_hash: contentHash,
    }, trajectoryDoneKeyFor);
    if (done.target !== target || (done.content_hash && done.content_hash !== contentHash)) {
      return respond(409, { error: "This trajectory was already judged by another reviewer" });
    }
    await deleteLockIfUnchanged(manifestKey, etag, trajectoryLockKeyFor);
    return respond(200, { ok: true, judgment_key: target });
  }

  return respond(404, { error: `Unknown trajectory route ${path}` });
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
        manifest: includeContent ? manifest : null,
        human_judgment: includeContent ? judgment : null,
      };
    }));
    items.push(...batch.filter(Boolean));
  }
  return respond(200, buildTrajectoryReportingReport(items, new Date().toISOString(), {
    includeContent,
    taskId: cleanText(params.task_id, 300),
    status: cleanText(params.status, 30),
    limit: params.limit,
    offset: params.offset,
  }), { "Cache-Control": "no-store" });
}

// Done records carry an explicit outcome, but legacy markers predate that
// field — infer from the target so historical approvals still surface to the
// author instead of vanishing into awaiting_codex.
function doneOutcome(done) {
  if (!done) return null;
  if (done.outcome) return done.outcome;
  const target = String(done.target || "");
  if (target.startsWith(`${REVIEW_PREFIX}finished/`)) return "approved";
  if (target.startsWith(`${REVIEW_PREFIX}rejected/`)) return "rejected";
  if (target.startsWith(`${REVIEW_PREFIX}returned/`)) return "returned";
  return null;
}

// The author's current task content in the shape the my-tasks screen renders:
// cleaned snapshot field names (title/request/criteria), with the distribution
// metadata echoed back so the edit form can pre-fill it. Distinct from
// cleanTaskSnapshot, which renames must_visit_or_reach to key_urls and drops
// metadata — that shape is for reporting fingerprints, not the author UI.
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
  if (task.metadata != null) {
    const metadata = cleanTaskMetadata(task.metadata);
    if (metadata) out.metadata = metadata;
  }
  return out;
}

// The author's own task content, rebuilt field by field from an untrusted
// payload. Shared by /review/author-edit and /review/author-amend so a revision
// and an amendment are held to exactly the same shape and caps.
function sanitizeAuthoredTask(edited) {
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
    steps: cleanSteps(edited.steps),
  };
  if (edited.metadata != null) {
    const metadata = cleanTaskMetadata(edited.metadata);
    if (metadata) safeTask.metadata = metadata;
  }
  return safeTask;
}

function cleanTaskMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const out = {};
  if (metadata.region != null) out.region = cleanText(metadata.region, 8);
  if (Array.isArray(metadata.subjects)) {
    out.subjects = metadata.subjects.slice(0, 10).map((s) => cleanText(s, 120)).filter(Boolean);
  }
  return Object.keys(out).length ? out : null;
}

function snapshotForHumanReview(snapshot) {
  return {
    title: snapshot?.title ?? "",
    request: snapshot?.request ?? "",
    criteria: snapshot?.criteria ?? [],
    steps: snapshot?.steps ?? [],
  };
}

// The revision number a finished doc is on. 1 for the reviewer's own approval,
// which carries no counter. Mirrors pcAdminRevision so a doc written before the
// counter existed still resolves from its history length.
export function finalGoldRevision(finished) {
  if (!finished) return 0;
  const explicit = Number(finished.revision_count);
  return Number.isInteger(explicit) && explicit > 0
    ? explicit
    : (Array.isArray(finished.history) ? finished.history.length : 0) + 1;
}

// An author's amendment of their own approved task becomes the new final gold.
// Shaped like buildPCAdminEdit: the current final is pushed onto a bounded
// history before being replaced, and revision_count only ever goes up.
//
// The reviewer's `review` block and `reviewed_by` carry through unchanged. That
// block is the record of what the reviewer did to the author's submission;
// rewriting it to describe the author's own edit would destroy the only audit
// of the human QC pass. What the author changed stays legible from the history
// entry this adds.
//
// History is bounded tighter than buildPCAdminEdit's 19: entries hold whole
// task bodies, against the 512KB cap /review/submit enforces.
const FINAL_GOLD_HISTORY_LIMIT = 10;
// `contentHash` must be derived the same way /review/submit derives it, so the
// field keeps one meaning. The POST_QC gate does not read it — that gate keys on
// reportingTaskContentHash over the snapshots, which changes on its own when the
// task body does, so an amendment re-audits either way.
export function buildAmendedFinalGold({ existing, amendedTask, contentHash, authorPid, amendedAt }) {
  const history = Array.isArray(existing?.history)
    ? existing.history.slice(-(FINAL_GOLD_HISTORY_LIMIT - 1))
    : [];
  if (existing?.task) {
    history.push({
      task: existing.task,
      review_content_hash: existing.review_content_hash ?? null,
      // Who wrote the version being superseded: the reviewer for the first
      // amendment, the author for every one after that.
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

// The diff the author sees for an approved task: their original versus the
// reviewer's final gold version, plus the rubric edits. Approvals now carry the
// reviewer's name — the author should be able to go and talk to whoever edited
// their work. Rejections and returns stay anonymous; that is handled at the
// call site, which never passes a rejecter through.
function buildHumanReviewForAuthor(finished, source) {
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
    // The display name only. reviewer_pid is a slugified email address, and the
    // author needs a person to talk to, not another user's contact details.
    reviewed_by: cleanText(finished?.reviewed_by, 160) || "",
    // Whether the reviewer actually altered anything. Drives the author
    // sign-off queue: an untouched approval has nothing to sign off on.
    changed: Boolean(
      finished?.review?.title_edited ||
        finished?.review?.request_edited ||
        rubrics.some((rubric) => rubric.changed)
    ),
    revision_count: finalGoldRevision(finished),
    amended_by: cleanText(finished?.amended_by, 80) || "",
    amended_at: cleanText(finished?.amended_at, 60) || "",
  };
}

// The reviewer's rubric-level notes on a rejection, for the author. Same shape
// the approved diff uses, so the screen renders it with the same component.
// Deliberately carries no identity: an author gets the substance of why the
// task was rejected, not who rejected it.
function buildRejectionFeedbackForAuthor(rejected, source) {
  if (!rejected || typeof rejected !== "object" || !rejected.review) return null;
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
    const [{ pending, lockSet, counts }, reviewers, rejectedKeys, finishedKeys, rejecters] =
      await Promise.all([
        queueState(),
        reviewerTotals(),
        listAll(`${REVIEW_PREFIX}rejected/`),
        listAll(`${REVIEW_PREFIX}finished/`),
        appealRejecters(),
      ]);
    // Exclude the caller's own submissions and appeals they rejected from
    // pending/claimable so the queue tiles never advertise tasks the reviewer
    // isn't allowed to claim; report their own separately as own_pending.
    const allEligible = excludeIneligible(pending, reviewerPid, rejecters);
    const audited = await completedPreQcSubmissionKeys(allEligible);
    const eligible = allEligible.filter((key) => audited.has(key));
    const claimable = eligible.filter((k) => !lockSet.has(b64url(k))).length;
    const approved = finishedKeys.length;
    // One object per task lands under rejected/, but a task can now be rejected
    // twice: once before its appeal and once after. Count tasks, not records.
    const rejected = distinctRejectedTaskIds(rejectedKeys).size;
    return respond(200, {
      ...counts,
      locked: eligible.filter((key) => lockSet.has(b64url(key))).length,
      finished: approved + rejected,
      approved,
      pending: eligible.length,
      claimable,
      awaiting_live_audit: allEligible.length - eligible.length,
      own_pending: pending.length - allEligible.length,
      rejected,
      // How many of the caller's own approved tasks are still waiting for them
      // to sign off. Derived from the two listings above plus one more, with no
      // per-task reads: the participant id is recoverable from both key shapes.
      own_awaiting_signoff: await ownAwaitingSignoff(finishedKeys, reviewerPid),
      reviewers,
    });
  }

  if (path === "/review/admin") {
    if (!isAllowedAdminEmail(body.admin_email)) return respond(403, { error: "Admin access required" });
    return respond(200, await adminDashboard());
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
    const { pending, lockSet, inboxAge, counts } = await queueState();
    // Never hand a reviewer their own submission, nor an appeal of a task they
    // rejected themselves (server-side authoritative — the client-side filter
    // is only cosmetic).
    const allEligible = excludeIneligible(pending, reviewerPid, await appealRejecters());
    const audited = await completedPreQcSubmissionKeys(allEligible);
    const eligible = allEligible.filter((key) => audited.has(key));
    // Try unlocked tasks first, oldest first; then stale-lock takeovers.
    const unlocked = eligible.filter((k) => !lockSet.has(b64url(k)));
    const locked = eligible.filter((k) => lockSet.has(b64url(k)));
    let attempts = 0;
    for (const subKey of [...unlocked, ...locked]) {
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
      const token = await tryLock(subKey, reviewer);
      if (token) {
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
    const etag = await verifyLock(sub_key, token);
    if (!etag) return respond(409, { error: "Lock not held by you (it may have expired)" });
    await deleteLockIfUnchanged(sub_key, etag);
    return respond(200, { ok: true });
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
      review: typeof reviewed.review === "object" && !Array.isArray(reviewed.review) ? reviewed.review : {},
    };
    if (JSON.stringify(safeReviewed).length > 512 * 1024) {
      return respond(400, { error: "reviewed payload too large (512KB max)" });
    }
    const contentHash = reviewContentHash(safeReviewed);
    const taskId = taskIdRaw.replace(/[^A-Za-z0-9_-]/g, "_");
    const finishedKey = `${REVIEW_PREFIX}finished/${taskId}.json`;
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
      return respond(200, { ok: true, finished_key: finishedKey, idempotent: true });
    }
    let etag = await verifyLock(sub_key, token);
    if (!etag) return respond(409, { error: "Lock not held by you (it may have expired)" });
    const claimedAt = await lockClaimedAt(sub_key);
    etag = await beginFinalization(sub_key, token, reviewer, "approved", contentHash);
    if (!etag) return respond(409, { error: "Another edit or outcome is already being submitted" });
    let completedAt = new Date().toISOString();
    // reviewer_pid alongside the display name: the name is free text a client
    // supplies, so it is not a stable handle. Authors are shown the name; the
    // pid is what any later attribution should join on.
    let doc = {
      ...safeReviewed,
      review_content_hash: contentHash,
      reviewed_by: reviewer,
      reviewer_pid: reviewerPid,
      finished_at: completedAt,
    };
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
      task_id: taskId,
      completed_at: completedAt,
      content_hash: contentHash,
      // Copied off the lock before it is deleted: the pair (claimed_at,
      // completed_at) is the only durable record of how long a review took.
      claimed_at: claimedAt,
    });
    if (done.target !== finishedKey || done.outcome !== "approved" || (done.content_hash && done.content_hash !== contentHash)) {
      return respond(409, { error: "This task was already finished by another reviewer" });
    }
    await recordReviewerCredit(String(done.reviewer || reviewer), "approved", sub_key, taskId, String(done.completed_at || completedAt));
    await deleteLockIfUnchanged(sub_key, etag);
    return respond(200, { ok: true, finished_key: finishedKey });
  }

  // Newest accepted tasks, for the in-app reference library (authored content
  // only — these records were provenance-stripped at submit time).
  if (path === "/review/finished") {
    const all = await listAllObjects(`${REVIEW_PREFIX}finished/`);
    const newest = all
      .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))
      .slice(0, 30);
    const reads = await Promise.all(
      newest.map((o) =>
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
    return respond(200, { items: reads.filter(Boolean) });
  }

  // Reject: the task is unusable (spam, gibberish, no salvageable intent).
  // It leaves the queue permanently, with the reviewer's reason on record.
  if (path === "/review/reject") {
    const { sub_key, token, task_id, reason } = body;
    if (!sub_key || !token) return respond(400, { error: "sub_key and token required" });
    const rejectionReason = String(reason || "").trim();
    // The floor used to be 3 characters, which let "spam" and "reject task"
    // through. Authors can now appeal a rejection, and an appeal against a
    // four-word verdict wastes two people's time, so the reason has to say
    // enough to act on.
    if (rejectionReason.length < MIN_REJECTION_REASON_LENGTH) {
      return respond(400, {
        error: `A rejection reason of at least ${MIN_REJECTION_REASON_LENGTH} characters is required — say what is wrong so the author can fix it.`,
      });
    }
    // cleanRubrics doubles as the sanitizer here: with a review present it
    // rebuilds every row field by field under the same caps the approval path
    // uses, and yields [] when the client sent nothing usable.
    const rejectionRubrics = cleanRubrics(body.review, null, null);
    const sanitizedRejectionReview = rejectionRubrics.length ? { rubrics: rejectionRubrics } : null;
    const rejId = String(task_id || "task-unknown").replace(/[^A-Za-z0-9_-]/g, "_");
    const rejectedKey = `${REVIEW_PREFIX}rejected/${rejId}_${createHash("sha256").update(sub_key).digest("hex").slice(0, 16)}.json`;
    const contentHash = reviewContentHash({ task_id: rejId, reason: rejectionReason.slice(0, 500) });
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
      return respond(200, { ok: true, rejected_key: rejectedKey, idempotent: true });
    }
    let etag = await verifyLock(sub_key, token);
    if (!etag) return respond(409, { error: "Lock not held by you (it may have expired)" });
    const claimedAt = await lockClaimedAt(sub_key);
    etag = await beginFinalization(sub_key, token, reviewer, "rejected", contentHash);
    if (!etag) return respond(409, { error: "Another edit or outcome is already being submitted" });
    let completedAt = new Date().toISOString();
    const rejectedDoc = {
      source_key: sub_key,
      task_id: rejId,
      rejected_by: reviewer,
      rejected_by_pid: reviewerPid,
      // The reviewer's working rubric rows, so the author sees which steps
      // failed rather than only a summary sentence. Shown to them without
      // attribution — rejections stay anonymous.
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
    const done = await writeDoneRecord(sub_key, {
      target: rejectedKey,
      outcome: "rejected",
      reviewer,
      task_id: rejId,
      completed_at: completedAt,
      content_hash: contentHash,
      // Copied off the lock before it is deleted: the pair (claimed_at,
      // completed_at) is the only durable record of how long a review took.
      claimed_at: claimedAt,
    });
    if (done.target !== rejectedKey || done.outcome !== "rejected" || (done.content_hash && done.content_hash !== contentHash)) {
      return respond(409, { error: "This task was already finished by another reviewer" });
    }
    await recordReviewerCredit(String(done.reviewer || reviewer), "rejected", sub_key, rejId, String(done.completed_at || completedAt));
    await deleteLockIfUnchanged(sub_key, etag);
    return respond(200, { ok: true, rejected_key: rejectedKey });
  }

  // Author-facing: list this participant's own tasks with their live status.
  // Read-only — no model calls, no mutations. Ownership is enforced server-side
  // (the participant_id must match the submitter embedded in each sub_key).
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
    // Newest first: an author working a long sign-off backlog wants the task
    // they just had reviewed, not the one from three weeks ago.
    ownUnits.sort((a, b) => b.oldestAt - a.oldestAt || b.newest.localeCompare(a.newest));
    const sourceTotal = ownUnits.length;
    const offset = Math.max(0, Number(body.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(body.limit) || 50));
    const pageUnits = ownUnits.slice(offset, offset + limit);
    // pending = passed the PRE_QC audit gate (a current completed artifact),
    // the same definition the reviewer queue uses for claimability.
    const audited = await completedPreQcSubmissionKeys(pageUnits.map((unit) => unit.newest));
    // Which of this author's tasks they have already signed off. One listing,
    // not one GET per row.
    const signoffObjects = await listAllObjects(AUTHOR_SIGNOFF_PREFIX);
    const signoffKeys = new Set();
    for (const object of signoffObjects) {
      const encoded = object.Key.slice(AUTHOR_SIGNOFF_PREFIX.length).replace(/\.json$/, "");
      try {
        signoffKeys.add(fromB64url(encoded));
      } catch {
        /* malformed receipt key */
      }
    }
    // Totals across every one of this author's tasks, not just this page, so
    // the sign-off progress line stays honest while they page through. Free:
    // both maps already cover the whole set.
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
        /* malformed done key */
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
      const submittedAt =
        source?.created_at ||
        (inboxAge.has(newest) ? new Date(inboxAge.get(newest)).toISOString() : null);
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
        // Approvals are attributed: the author should be able to go and talk to
        // whoever edited their task.
        item.reviewed_by = cleanText(finished?.reviewed_by, 160) || "";
        const finalSnapshot = cleanTaskSnapshot(finished?.task ?? null);
        const finalRubrics = cleanRubrics(finished?.review, original, finalSnapshot);
        item.reviewer_changed = Boolean(
          finished?.review?.title_edited ||
            finished?.review?.request_edited ||
            finalRubrics.some((rubric) => rubric.changed)
        );
        item.revision_count = finalGoldRevision(finished);
        item.signed_off_at = "";
        item.signoff_action = "";
        item.needs_signoff = !signoffKeys.has(newest);
      }
      if (status === "rejected" && done?.target) {
        const rejected = await readJson(done.target).then(({ json }) => json).catch(() => null);
        item.rejection_reason = cleanText(rejected?.reason, 500) || "";
        // One appeal per task. Anything already appealed once is finished.
        item.can_appeal = rejectionCount <= 1;
      }
      if (status === "returned" && done?.target) {
        const returned = await readJson(done.target).then(({ json }) => json).catch(() => null);
        item.returned_reason = cleanText(returned?.reason, 500) || "";
        item.returned_by = cleanText(returned?.returned_by, 160) || "";
      }
      return item;
    };
    // Batched rather than one unbounded Promise.all: each row costs at least one
    // GET, and the heaviest author already has well over a hundred tasks. Same
    // width loadReviewIndex uses for done records.
    const items = [];
    for (let i = 0; i < pageUnits.length; i += 25) {
      items.push(...(await Promise.all(pageUnits.slice(i, i + 25).map(buildItem))));
    }
    // Signoff receipts hold the timestamp and which way the author went. Read
    // only for the rows on this page that have one.
    const signedRows = items.filter((item) => item.status === "approved" && !item.needs_signoff);
    for (let i = 0; i < signedRows.length; i += 25) {
      await Promise.all(signedRows.slice(i, i + 25).map(async (item) => {
        const receipt = await readJson(authorSignoffKeyFor(item.sub_key))
          .then(({ json }) => json)
          .catch(() => null);
        item.signed_off_at = cleanText(receipt?.signed_off_at, 60) || "";
        item.signoff_action = cleanText(receipt?.action, 20) || "";
      }));
    }
    return respond(
      200,
      {
        items,
        offset,
        limit,
        source_total: sourceTotal,
        approved_total: approvedTotal,
        awaiting_signoff_total: awaitingSignoffTotal,
      },
      { "Cache-Control": "no-store" }
    );
  }

  // Author-facing: the Codex feedback for one of the author's own submissions.
  // Reuses the claimed-task LLM-review path but skips the reviewer lock (the
  // author holds no lock), and overlays the finished status so an approved/
  // rejected/returned task surfaces its reason and (for approvals) the diff.
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
    const taskField = authoredTaskContentForResponse(source?.task ?? source);
    const done = await readDoneRecord(sub_key);
    const outcome = doneOutcome(done);
    const response = {
      status: preQc.status,
      stale: preQc.stale,
      task_content_hash: preQc.task_content_hash,
      review: preQc.review,
      task: taskField,
    };
    if (outcome === "approved" && done?.target) {
      response.status = "approved";
      const finished = await readJson(done.target).then(({ json }) => json).catch(() => null);
      const humanReview = buildHumanReviewForAuthor(finished, source);
      if (humanReview) response.human_review = humanReview;
      // The full final gold in the same shape as `task`. The amend form seeds
      // from this: an author correcting an approved task starts from the
      // reviewer's version, not from their own original. human_review.final is
      // a display snapshot and carries no difficulty, notes, or metadata.
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
      // Substance without attribution: the author learns which steps failed,
      // not who decided it.
      const feedback = buildRejectionFeedbackForAuthor(rejected, source);
      if (feedback) response.rejection_feedback = feedback;
    } else if (outcome === "returned" && done?.target) {
      response.status = "returned";
      const returned = await readJson(done.target).then(({ json }) => json).catch(() => null);
      response.returned_reason = cleanText(returned?.reason, 500) || "";
      response.returned_by = cleanText(returned?.returned_by, 160) || "";
    }
    response.history = await authorTaskHistory(sub_key);
    return respond(200, response, { "Cache-Control": "no-store" });
  }

  // Author self-edit: write a new submission object in the SAME task directory
  // (so reviewUnitForKey keeps grouping it as the same unit), re-entering the
  // reviewer queue for a fresh Codex audit. Never finalizes; originals stay
  // immutable. Allowed only when the newest revision is open (awaiting_codex,
  // pending) or returned — locked or finished tasks cannot be edited.
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
    const safeTask = sanitizeAuthoredTask(edited);
    if (!String(safeTask.agent_request).trim()) {
      return respond(400, { error: "agent_request is required" }, { "Cache-Control": "no-store" });
    }
    const newOriginal = cleanTaskSnapshot(safeTask);
    const newRubrics = cleanRubrics(null, newOriginal, null);
    const newContentHash = reportingTaskContentHash(newOriginal, null, newRubrics);
    const unit = reviewUnitForKey(sub_key);
    const { byTaskDir, lockSet, doneByEncodedKey } = await loadReviewIndex({
      readDoneRecords: true,
      doneRecordFilter: (key) => reviewUnitForKey(key) === unit,
    });
    const entry = byTaskDir.get(unit);
    if (!entry) return respond(404, { error: "Task not found" }, { "Cache-Control": "no-store" });
    const newest = entry.newest;
    const newestDone = doneByEncodedKey.get(b64url(newest)) ?? null;
    const outcome = doneOutcome(newestDone);
    // Every rejection this unit has ever taken, not just the newest. The map is
    // built from the done/ listing rather than inbox markers, so a revision
    // whose marker was deleted by an earlier edit still counts — which is
    // exactly the case that decides whether an appeal is still available.
    const rejectionCount = [...doneByEncodedKey.values()]
      .filter((record) => doneOutcome(record) === "rejected").length;
    const eligibility = authorEditEligibility(outcome, lockSet.has(b64url(newest)), rejectionCount);
    if (!eligibility.allowed) {
      return respond(409, { error: eligibility.reason }, { "Cache-Control": "no-store" });
    }
    const original = await readJson(sub_key).then(({ json }) => json).catch(() => null);
    if (!original) {
      return respond(404, { error: "Original submission not found" }, { "Cache-Control": "no-store" });
    }
    // Idempotency: if this exact edited content already exists as a not-done
    // file in the unit, return it instead of writing a duplicate.
    for (const fileKey of entry.files) {
      if (doneByEncodedKey.has(b64url(fileKey))) continue; // done files are immutable
      const existing = await readJson(fileKey).then(({ json }) => json).catch(() => null);
      if (!existing) continue;
      const existingOriginal = cleanTaskSnapshot(existing.task ?? existing);
      const existingRubrics = cleanRubrics(null, existingOriginal, null);
      if (reportingTaskContentHash(existingOriginal, null, existingRubrics) === newContentHash) {
        return respond(200, { ok: true, new_sub_key: fileKey, new_content_hash: newContentHash, status: "awaiting_codex" }, { "Cache-Control": "no-store" });
      }
    }
    const revisedAt = new Date().toISOString();
    const newSubmission = { ...original, task: safeTask, created_at: revisedAt };
    delete newSubmission.quality_signals; // advisory — a revised task re-enters audit
    // How long the author spent on this revision. Stored as the pair of stamps
    // the reporting layer derives minutes from, never as a client-sent duration.
    const editStartedAt = cleanText(body.edit_started_at, 60) || null;
    if (editStartedAt) {
      newSubmission[eligibility.appeal ? "appeal_started_at" : "edit_started_at"] = editStartedAt;
    }
    // The rejection this revision answers, so the author's own screen and the
    // reporting feed can tell an appeal apart from an ordinary revision.
    let rejectedByPid = "";
    if (eligibility.appeal) {
      const rejectedDoc = newestDone?.target
        ? await readJson(newestDone.target).then(({ json }) => json).catch(() => null)
        : null;
      rejectedByPid = cleanText(rejectedDoc?.rejected_by_pid, 80) || "";
      newSubmission.appeal_of_sub_key = newest;
      newSubmission.appeal_number = rejectionCount;
    }
    if (JSON.stringify(newSubmission).length > 512 * 1024) {
      return respond(400, { error: "edited payload too large (512KB max)" }, { "Cache-Control": "no-store" });
    }
    // Same task directory via the shared key-builder: the directory MUST match
    // the original so reviewUnitForKey keeps the revision in the same unit.
    const dir = sub_key.slice(0, sub_key.lastIndexOf("/"));
    const baseFilename = sub_key
      .slice(sub_key.lastIndexOf("/") + 1)
      .replace(/^\d+(?:-[A-Za-z0-9]+)?_/, "");
    const participantIdFromKey = participantIdFromSubKey(sub_key);
    const taskId = dir.slice(`${UPLOAD_PREFIX}${participantIdFromKey}/`.length);
    const newSubKey = uploadObjectKey(participantIdFromKey, taskId, baseFilename);
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: newSubKey,
      Body: JSON.stringify(newSubmission, null, 2),
      ContentType: "application/json",
      IfNoneMatch: "*",
    }));
    // Inbox marker so the new revision enters the review queue. The old marker
    // is removed for cleanliness; the old submission object is never deleted
    // (immutability/audit).
    await s3
      .send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: inboxKeyFor(newSubKey),
        Body: newSubKey,
        ContentType: "text/plain",
        IfNoneMatch: "*",
      }))
      .catch(() => {});
    await s3
      .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: inboxKeyFor(sub_key) }))
      .catch(() => {});
    // A small side marker the claim path reads, so an appeal is never offered
    // back to the reviewer who rejected it. Kept out of the submission body:
    // /review/claim would otherwise have to read every candidate task to route.
    if (eligibility.appeal) {
      await s3
        .send(new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: appealKeyFor(newSubKey),
          Body: JSON.stringify({
            sub_key: newSubKey,
            appeal_of: newest,
            rejected_by_pid: rejectedByPid,
            created_at: revisedAt,
          }),
          ContentType: "application/json",
          IfNoneMatch: "*",
        }))
        .catch(() => {});
    }
    return respond(
      200,
      {
        ok: true,
        new_sub_key: newSubKey,
        new_content_hash: newContentHash,
        status: "awaiting_codex",
        appeal: Boolean(eligibility.appeal),
      },
      { "Cache-Control": "no-store" }
    );
  }

  // Author sign-off: "I have read what the reviewer did to my task and I accept
  // it." An immutable receipt, nothing else — final gold is untouched. Pairs
  // with /review/author-amend, which is the same acknowledgement expressed as
  // an edit.
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
    const done = await readDoneRecord(sub_key);
    if (doneOutcome(done) !== "approved") {
      return respond(409, { error: "Only an approved task can be signed off." }, { "Cache-Control": "no-store" });
    }
    const finished = done?.target
      ? await readJson(done.target).then(({ json }) => json).catch(() => null)
      : null;
    const signedOffAt = new Date().toISOString();
    const receipt = {
      sub_key,
      task_id: cleanText(done?.task_id, 300),
      participant_id: participantId,
      action: "accepted",
      acknowledged_content_hash: cleanText(finished?.review_content_hash, 80) || "",
      // The pair the reporting layer derives signoff_minutes from. Client-sent
      // durations are never trusted; stageMinutes drops an implausible span.
      opened_at: cleanText(body.opened_at, 60) || null,
      signed_off_at: signedOffAt,
    };
    const created = await tryConditionalWrite(() => s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: authorSignoffKeyFor(sub_key),
      Body: JSON.stringify(receipt, null, 2),
      ContentType: "application/json",
      IfNoneMatch: "*",
    })));
    if (!created) {
      // Already signed off. A repeat click, or a retry that lost its response —
      // either way the existing receipt stands rather than being overwritten.
      const existing = await readJson(authorSignoffKeyFor(sub_key))
        .then(({ json }) => json)
        .catch(() => null);
      return respond(
        200,
        { ok: true, idempotent: true, action: existing?.action ?? "accepted", signed_off_at: existing?.signed_off_at ?? signedOffAt },
        { "Cache-Control": "no-store" }
      );
    }
    return respond(200, { ok: true, action: "accepted", signed_off_at: signedOffAt }, { "Cache-Control": "no-store" });
  }

  // Author amendment: the author's correction of their own approved task
  // becomes the new final gold, with no second reviewer pass. This is a
  // deliberate departure from "only reviewers write final gold" — see
  // QUALITY_CONTROL.md. The reviewer's audit of the original submission is
  // preserved inside the doc; only the task body moves.
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
    // Hashed the same way /review/submit hashes final gold, over the same
    // fields. Deriving it differently here would leave two incompatible values
    // living in one field, and would break the no-op check below.
    const contentHash = reviewContentHash({
      schema_version: existing.schema_version,
      task_id: existing.task_id,
      mode: existing.mode,
      task: safeTask,
      review: existing.review ?? {},
    });
    // Nothing actually changed: report success without burning a revision.
    if (existing.review_content_hash === contentHash) {
      return respond(
        200,
        { ok: true, idempotent: true, revision_count: finalGoldRevision(existing), new_content_hash: contentHash },
        { "Cache-Control": "no-store" }
      );
    }
    const amendedAt = new Date().toISOString();
    const doc = buildAmendedFinalGold({
      existing,
      amendedTask: safeTask,
      contentHash,
      authorPid: participantId,
      amendedAt,
    });
    if (JSON.stringify(doc).length > 512 * 1024) {
      return respond(400, { error: "amended payload too large (512KB max)" }, { "Cache-Control": "no-store" });
    }
    // Archive first, then replace. The archive is a conditional create, so two
    // concurrent amendments cannot both claim the same revision number; the
    // replace is an If-Match on the version that was archived, so neither can
    // overwrite the other's result.
    const archived = await tryConditionalWrite(() => s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: finishedHistoryKeyFor(done.task_id || "task-unknown", finalGoldRevision(existing)),
      Body: JSON.stringify(existing, null, 2),
      ContentType: "application/json",
      IfNoneMatch: "*",
    })));
    if (!archived) {
      return respond(409, { error: "Another amendment of this task is already in flight." }, { "Cache-Control": "no-store" });
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
    // An amendment is itself a sign-off: the author has read the reviewer's
    // version and responded to it. Best-effort — the amendment is what matters,
    // and a missing receipt only leaves the row in the queue.
    await s3
      .send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: authorSignoffKeyFor(sub_key),
        Body: JSON.stringify({
          sub_key,
          task_id: cleanText(done?.task_id, 300),
          participant_id: participantId,
          action: "amended",
          acknowledged_content_hash: cleanText(existing.review_content_hash, 80) || "",
          opened_at: cleanText(body.opened_at, 60) || null,
          signed_off_at: amendedAt,
        }, null, 2),
        ContentType: "application/json",
        IfNoneMatch: "*",
      }))
      .catch(() => {});
    return respond(
      200,
      { ok: true, revision_count: doc.revision_count, new_content_hash: contentHash, amended_at: amendedAt },
      { "Cache-Control": "no-store" }
    );
  }

  // Reviewer "return to author": mirrors /review/reject's lock handling and
  // idempotent retry, but writes a returned record and a done-record with
  // outcome "returned". No reviewer credit — a return isn't a finished review.
  if (path === "/review/return-to-author") {
    const { sub_key, token, task_id, reason } = body;
    if (!sub_key || !token) return respond(400, { error: "sub_key and token required" }, { "Cache-Control": "no-store" });
    const returnReason = String(reason || "").trim();
    if (returnReason.length < 3) {
      return respond(400, { error: "A return reason is required" }, { "Cache-Control": "no-store" });
    }
    const taskId = String(task_id || "task-unknown").replace(/[^A-Za-z0-9_-]/g, "_");
    const returnedKey = `${REVIEW_PREFIX}returned/${b64url(sub_key)}.json`;
    const contentHash = reviewContentHash({ task_id: taskId, reason: returnReason.slice(0, 500) });
    // As with reject, a byte-identical retry must succeed after the first
    // request committed and removed its lock but lost the HTTP response.
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
      return respond(200, { ok: true, returned_key: returnedKey, idempotent: true }, { "Cache-Control": "no-store" });
    }
    let etag = await verifyLock(sub_key, token);
    if (!etag) return respond(409, { error: "Lock not held by you (it may have expired)" }, { "Cache-Control": "no-store" });
    const claimedAt = await lockClaimedAt(sub_key);
    etag = await beginFinalization(sub_key, token, reviewer, "returned", contentHash);
    if (!etag) return respond(409, { error: "Another edit or outcome is already being submitted" }, { "Cache-Control": "no-store" });
    let completedAt = new Date().toISOString();
    const returnedDoc = {
      sub_key,
      task_id: taskId,
      reason: returnReason.slice(0, 500),
      returned_by: reviewer,
      content_hash: contentHash,
      returned_at: completedAt,
    };
    const createdReturned = await tryConditionalWrite(() => s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: returnedKey,
        Body: JSON.stringify(returnedDoc, null, 2),
        ContentType: "application/json",
        IfNoneMatch: "*",
      })
    ));
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
      task_id: taskId,
      completed_at: completedAt,
      content_hash: contentHash,
      // Copied off the lock before it is deleted: the pair (claimed_at,
      // completed_at) is the only durable record of how long a review took.
      claimed_at: claimedAt,
    });
    if (done.target !== returnedKey || done.outcome !== "returned" || (done.content_hash && done.content_hash !== contentHash)) {
      return respond(409, { error: "This task was already finished by another reviewer" }, { "Cache-Control": "no-store" });
    }
    // Returns are not finished reviews — do not inflate reviewerTotals.
    await deleteLockIfUnchanged(sub_key, etag);
    return respond(200, { ok: true, returned_key: returnedKey }, { "Cache-Control": "no-store" });
  }

  return respond(404, { error: `Unknown review route ${path}` });
}

// ---------- handler ----------

export const handler = async (event) => {
  try {
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
    // complete before a task can enter the shared review queue.
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
