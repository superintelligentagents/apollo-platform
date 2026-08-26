// Production smoke test for the complete one-appeal lifecycle. Creates one
// synthetic rejected task, appeals it, proves the fresh reviewer receives both
// anonymous reasons, rejects it a second time into rejected-twice/, verifies
// there is no third chance, then cleans up exactly.

import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { cleanRubrics, cleanTaskSnapshot, reportingTaskContentHash } from "../../backend/lambda_presign.js";

const require = createRequire(new URL("../../backend/package.json", import.meta.url));
const { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { DeleteItemCommand, DynamoDBClient } = require("@aws-sdk/client-dynamodb");

const REVIEW_KEY = process.env.E2E_V2_REVIEW_KEY || process.env.E2E_REVIEW_KEY || "";
if (!REVIEW_KEY) throw new Error("E2E_V2_REVIEW_KEY is required");
const BUCKET = process.env.E2E_BUCKET || "journeys-prolific";
const ENDPOINT = process.env.E2E_V2_REVIEW_ENDPOINT || "https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com";
const TABLE = process.env.E2E_DASHBOARD_TABLE || "apollo-dashboard-index";
const ROOT = "v2-review/";
const region = process.env.AWS_REGION || "us-east-1";
const s3 = new S3Client({ region });
const dynamo = new DynamoDBClient({ region });
const b64url = (value) => Buffer.from(String(value), "utf8").toString("base64url");
const check = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`✓ ${message}`);
};

async function post(path, body) {
  const response = await fetch(`${ENDPOINT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewKey: REVIEW_KEY, ...body }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function putJson(key, value) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(value, null, 2), ContentType: "application/json", IfNoneMatch: "*" }));
}
async function readJson(key) {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return JSON.parse(await response.Body.transformToString());
}
async function remove(key) {
  if (key) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
}

const stamp = `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`.toLowerCase();
const authorPid = `e2e-appeal-author-${stamp}`.slice(0, 40).replace(/-$/, "0");
const rejecterPid = `e2e-rejecter-${stamp}`.slice(0, 40).replace(/-$/, "0");
const secondPid = `e2e-second-${stamp}`.slice(0, 40).replace(/-$/, "0");
const rawTaskId = `v2/${authorPid}/internal/task-${stamp}`;
const safeTaskId = rawTaskId.replace(/[^A-Za-z0-9_-]/g, "_");
const sourceKey = `prolific/journeys/${authorPid}/${rawTaskId}/${Date.now()}-${randomUUID().slice(0, 8)}_long_task.json`;
const inboxKey = `${ROOT}inbox/${b64url(sourceKey)}`;
const doneKey = `${ROOT}done/${b64url(sourceKey)}`;
const rejectedKey = `${ROOT}rejected/${safeTaskId}_${createHash("sha256").update(sourceKey).digest("hex").slice(0, 16)}.json`;
const mutationLockKey = `${ROOT}author-mutation-locks/${b64url(sourceKey.slice(0, sourceKey.lastIndexOf("/")))}.json`;
const cleanup = new Set([sourceKey, inboxKey, doneKey, rejectedKey, mutationLockKey]);
const appealReason = "The rejected prompt already names the market, time period, and first-party verification requirements.";
const firstRejectionReason = "The request lacks a market, time period, and first-party verification requirements.";
const secondRejectionReason = "The appeal still does not make the requested comparison verifiable enough for final acceptance.";

const task = {
  task_title: "Synthetic appeal routing verification",
  agent_request: "Compare current offers and write a summary for this disposable test.",
  difficulty: "high",
  site_scope: [],
  success_criteria: ["Offers are compared."],
  must_visit_or_reach: [],
  required_outputs: ["Summary"],
  notes: null,
  steps: [{ order: 1, title: "Compare", description: "Compare the offers." }],
  metadata: { region: "GLOBAL", subjects: ["Other > Other"] },
};
const source = {
  schema_version: "odyssey_long_task_v2",
  task_id: rawTaskId,
  mode: "guided",
  created_at: new Date().toISOString(),
  participant: { participant_id: authorPid, name: "Synthetic Appeal Author", email: "", consent: { version: "e2e", accepted_at: new Date().toISOString() } },
  task,
  provenance: { source_journeys: [], theme_suggestion: null, template: null, attached_urls: [] },
};

try {
  await putJson(sourceKey, source);
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: inboxKey, Body: sourceKey, ContentType: "text/plain", IfNoneMatch: "*" }));
  await putJson(rejectedKey, {
    source_key: sourceKey,
    task_id: safeTaskId,
    rejected_by: "Synthetic Rejecter",
    rejected_by_pid: rejecterPid,
    reason: firstRejectionReason,
    review: { rubrics: [{ rubric_id: "rubric-1", kind: "step", title: "Compare", original: "Compare the offers.", final: "Specify a market and verify every offer on first-party pages.", changed: true, checked: false }] },
    review_content_hash: `e2e-rejection-${stamp}`,
    rejected_at: new Date().toISOString(),
  });
  await putJson(doneKey, { target: rejectedKey, outcome: "rejected", reviewer: "Synthetic Rejecter", reviewer_pid: rejecterPid, task_id: safeTaskId, completed_at: new Date().toISOString() });

  const list = await post("/review/my-tasks", { participant_id: authorPid, offset: 0, limit: 10 });
  check(list.items?.[0]?.can_appeal === true, "verified rejection offers one appeal");
  const feedback = await post("/review/my-task-feedback", { participant_id: authorPid, sub_key: sourceKey });
  check(feedback.rejection_feedback?.rubrics?.length === 1, "author receives step-level rejection feedback");
  check((feedback.history || []).filter((entry) => entry.event === "rejected").every((entry) => !entry.by), "rejection history remains anonymous");

  const appealed = await post("/review/author-edit", {
    participant_id: authorPid,
    sub_key: sourceKey,
    edit_started_at: new Date().toISOString(),
    appeal_reason: appealReason,
    // Deliberately unchanged: an author may challenge a mistaken rejection
    // with a rationale even when the task itself should not be rewritten.
    edited: task,
  });
  check(appealed.appeal === true && appealed.queued === true, "author revision is queued as an appeal");
  const appealSourceKey = appealed.new_sub_key;
  const appealInboxKey = `${ROOT}inbox/${b64url(appealSourceKey)}`;
  const appealMarkerKey = `${ROOT}appeals/${b64url(appealSourceKey)}.json`;
  cleanup.add(appealSourceKey);
  cleanup.add(appealInboxKey);
  cleanup.add(appealMarkerKey);
  const [appealSource, appealMarker] = await Promise.all([readJson(appealSourceKey), readJson(appealMarkerKey)]);
  check(appealSource.appeal_of_sub_key === sourceKey, "appeal lineage points to the rejected revision");
  check(appealSource.appeal_rejection_reason === firstRejectionReason, "fresh reviewer receives the anonymous earlier rejection reason");
  check(appealSource.appeal_reason === appealReason, "appeal source carries the author's rationale for the fresh reviewer");
  check(appealSource.task.agent_request === task.agent_request, "a reason-only appeal may preserve the original task text");
  check(appealMarker.rejected_by_pid === rejecterPid, "appeal marker carries the rejecter PID");

  const original = cleanTaskSnapshot(appealSource.task);
  const rubrics = cleanRubrics(null, original, null);
  const contentHash = reportingTaskContentHash(original, null, rubrics);
  const auditKey = `${ROOT}llm_pre_qc_pass/${b64url(rawTaskId)}.${contentHash}.apollo-llm-feasibility-v22.json`;
  cleanup.add(auditKey);
  const beforeRejecter = await post("/review/status", { reviewer_pid: rejecterPid });
  const beforeSecond = await post("/review/status", { reviewer_pid: secondPid });
  await putJson(auditKey, {
    schema_version: "apollo-llm-feasibility-artifact-v11",
    pipeline_version: "apollo-llm-feasibility-v22",
    task_id: rawTaskId,
    task_content_hash: contentHash,
    status: "LLM_PASS",
    passed: true,
    source: { rubrics: rubrics.map((rubric, index) => ({ rubric_id: `rubric-${index + 1}`, criterion: rubric.final, critical: true })) },
    rubric_reviews: rubrics.map((_, index) => ({ rubric_id: `rubric-${index + 1}`, status: "COMPLETED", effective_verdict: "POSSIBLE", review: { verdict: "POSSIBLE" } })),
    manager_review: { disposition: "FEASIBLE" },
  });
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  const afterRejecter = await post("/review/status", { reviewer_pid: rejecterPid });
  const afterSecond = await post("/review/status", { reviewer_pid: secondPid });
  check(Number(afterRejecter.pending) === Number(beforeRejecter.pending), "rejecting reviewer is not offered the appeal");
  check(Number(afterSecond.pending) === Number(beforeSecond.pending) + 1, "a different reviewer is offered the appeal");

  // Take a disposable lock directly so this test cannot accidentally claim or
  // decide a real queue item. The reject endpoint still performs its normal
  // token, freshness, mutation-lock, finalization, and idempotency checks.
  const secondReviewer = "Synthetic Second Reviewer";
  const appealLockKey = `${ROOT}locks/${b64url(appealSourceKey)}.json`;
  const appealDoneKey = `${ROOT}done/${b64url(appealSourceKey)}`;
  const appealToken = randomUUID();
  const rejectedTwiceKey = `${ROOT}rejected-twice/${safeTaskId}_${createHash("sha256").update(appealSourceKey).digest("hex").slice(0, 16)}.json`;
  const secondReviewerCreditKey = `${ROOT}credits/${b64url(secondReviewer.toLowerCase())}/rejected/${createHash("sha256").update(appealSourceKey).digest("hex")}.json`;
  cleanup.add(appealLockKey);
  cleanup.add(appealDoneKey);
  cleanup.add(rejectedTwiceKey);
  cleanup.add(secondReviewerCreditKey);
  await putJson(appealLockKey, {
    reviewer: secondReviewer,
    reviewer_pid: secondPid,
    token: appealToken,
    claimed_at: new Date().toISOString(),
  });
  const terminal = await post("/review/reject", {
    reviewer: secondReviewer,
    reviewer_pid: secondPid,
    sub_key: appealSourceKey,
    token: appealToken,
    task_id: rawTaskId,
    reason: secondRejectionReason,
  });
  check(terminal.terminal_rejection === true, "second rejection is marked terminal");
  check(terminal.rejected_key === rejectedTwiceKey, "second rejection is stored under rejected-twice/");
  const terminalDoc = await readJson(rejectedTwiceKey);
  check(terminalDoc.terminal_rejection === true && terminalDoc.appeal_number === 1, "terminal record preserves appeal lineage");

  const terminalList = await post("/review/my-tasks", { participant_id: authorPid, offset: 0, limit: 10 });
  const terminalItem = terminalList.items?.find((item) => item.sub_key === appealSourceKey);
  check(terminalItem?.status === "rejected", "author sees the final rejection feedback");
  check(terminalItem?.rejection_count === 2, "author history counts both independent rejections");
  check(terminalItem?.can_appeal === false, "author receives no further appeal chance");
} finally {
  for (const key of [...cleanup].reverse()) await remove(key);
  await dynamo.send(new DeleteItemCommand({
    TableName: TABLE,
    Key: { scope: { S: "v2" }, entity_key: { S: `TASK#${rawTaskId}` } },
  })).catch(() => {});
}

console.log("Author appeal validation complete; synthetic artifacts removed.");
