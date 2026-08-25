// Production smoke test for the real-S3 author acknowledgement/amendment path.
// Creates one synthetic approved task, accepts it, amends it, verifies the
// archive and receipt, then removes every exact object in `finally` cleanup.

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../backend/package.json", import.meta.url));
const { DeleteItemCommand, DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");

const REVIEW_KEY = process.env.E2E_V2_REVIEW_KEY || process.env.E2E_REVIEW_KEY || "";
if (!REVIEW_KEY) throw new Error("E2E_V2_REVIEW_KEY is required");

const BUCKET = process.env.E2E_BUCKET || "journeys-prolific";
const DASHBOARD_TABLE = process.env.E2E_DASHBOARD_TABLE || "apollo-dashboard-index";
const ENDPOINT = process.env.E2E_V2_REVIEW_ENDPOINT || "https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com";
const ROOT = "v2-review/";
const region = process.env.AWS_REGION || "us-east-1";
const dynamo = new DynamoDBClient({ region });
const s3 = new S3Client({ region });
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
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(value, null, 2),
    ContentType: "application/json",
    IfNoneMatch: "*",
  }));
}

async function readJson(key) {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return JSON.parse(await response.Body.transformToString());
}

async function remove(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
}

const stamp = `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`.toLowerCase();
const authorPid = `e2e-author-${stamp}`.slice(0, 40).replace(/-$/, "0");
const rawTaskId = `v2/${authorPid}/internal/task-${stamp}`;
const safeTaskId = rawTaskId.replace(/[^A-Za-z0-9_-]/g, "_");
const sourceKey = `prolific/journeys/${authorPid}/${rawTaskId}/${Date.now()}-${randomUUID().slice(0, 8)}_long_task.json`;
const inboxKey = `${ROOT}inbox/${b64url(sourceKey)}`;
const doneKey = `${ROOT}done/${b64url(sourceKey)}`;
const finishedKey = `${ROOT}finished/${safeTaskId}.json`;
const historyKey = `${ROOT}finished-history/${safeTaskId}/001.json`;
const signoffKey = `${ROOT}author-signoffs/${b64url(sourceKey)}.json`;
const authorApprovedKey = `${ROOT}author-approved/${safeTaskId}.json`;
const mutationLockKey = `${ROOT}author-mutation-locks/${b64url(sourceKey.slice(0, sourceKey.lastIndexOf("/")))}.json`;
const createdKeys = [sourceKey, inboxKey, doneKey, finishedKey, historyKey, signoffKey, authorApprovedKey, mutationLockKey];

const originalTask = {
  task_title: "Synthetic author-loop verification",
  agent_request: "Compare three current first-party web sources and produce a verified summary for this disposable smoke test.",
  difficulty: "high",
  site_scope: [],
  success_criteria: ["Three sources are compared."],
  must_visit_or_reach: [],
  required_outputs: ["Verified summary"],
  notes: null,
  steps: [{ order: 1, title: "Compare", description: "Compare three current first-party sources." }],
  metadata: { region: "GLOBAL", subjects: ["Other > Other"] },
};
const source = {
  schema_version: "odyssey_long_task_v2",
  task_id: rawTaskId,
  mode: "guided",
  created_at: new Date().toISOString(),
  participant: { participant_id: authorPid, name: "Synthetic Author", email: "", consent: { version: "e2e", accepted_at: new Date().toISOString() } },
  task: originalTask,
  provenance: { source_journeys: [], theme_suggestion: null, template: null, attached_urls: [] },
};
const finalGold = {
  schema_version: "odyssey_long_task_v2_reviewed",
  task_id: rawTaskId,
  mode: "guided",
  task: originalTask,
  review: { title_edited: false, request_edited: false, rubrics: [], evergreen_verified: true },
  review_content_hash: `e2e-original-${stamp}`,
  reviewed_by: "Synthetic Reviewer",
  reviewer_pid: `e2e-reviewer-${stamp}`.slice(0, 40).replace(/-$/, "0"),
  finished_at: new Date().toISOString(),
};

try {
  await putJson(sourceKey, source);
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: inboxKey, Body: sourceKey, ContentType: "text/plain", IfNoneMatch: "*" }));
  await putJson(finishedKey, finalGold);
  await putJson(doneKey, {
    target: finishedKey,
    outcome: "approved",
    reviewer: finalGold.reviewed_by,
    reviewer_pid: finalGold.reviewer_pid,
    task_id: safeTaskId,
    completed_at: finalGold.finished_at,
    content_hash: finalGold.review_content_hash,
  });

  const before = await post("/review/my-tasks", { participant_id: authorPid, offset: 0, limit: 10 });
  check(before.items?.[0]?.needs_signoff === true, "approved synthetic task enters the sign-off queue");
  check(!Object.prototype.hasOwnProperty.call(before.items?.[0] ?? {}, "reviewed_by"), "author task list withholds reviewer identity");

  const feedback = await post("/review/my-task-feedback", { participant_id: authorPid, sub_key: sourceKey });
  check(Boolean(feedback.human_review), "author receives the approved original-versus-final review");
  check(!Object.prototype.hasOwnProperty.call(feedback.human_review ?? {}, "reviewed_by"), "approved feedback withholds reviewer identity");
  check((feedback.history ?? []).every((entry) => !entry.by), "author history withholds reviewer identity");

  const accepted = await post("/review/author-signoff", {
    participant_id: authorPid,
    sub_key: sourceKey,
    opened_at: new Date().toISOString(),
  });
  check(accepted.action === "accepted", "author acceptance writes a sign-off receipt");
  check(accepted.author_approved_key === authorApprovedKey, "author acceptance names the final author-approved object");
  const acceptedFinal = await readJson(authorApprovedKey);
  check(acceptedFinal.author_approval?.action === "accepted", "accepted final is stored under author-approved");
  check(acceptedFinal.task?.agent_request === originalTask.agent_request, "accepted final contains the complete approved task");

  const amendedRequest = `${originalTask.agent_request} The author added this sentence after review.`;
  const amended = await post("/review/author-amend", {
    participant_id: authorPid,
    sub_key: sourceKey,
    opened_at: new Date().toISOString(),
    edited: {
      ...originalTask,
      agent_request: amendedRequest,
    },
  });
  check(amended.revision_count === 2, "author amendment creates revision two");

  const [archive, current, receipt, authorFinal] = await Promise.all([
    readJson(historyKey),
    readJson(finishedKey),
    readJson(signoffKey),
    readJson(authorApprovedKey),
  ]);
  check(archive.review_content_hash === finalGold.review_content_hash, "reviewer gold is preserved in finished-history");
  check(current.task?.agent_request === amendedRequest && current.amended_by === authorPid, "author version becomes current final gold");
  check(receipt.action === "amended", "amendment upgrades the sign-off receipt");
  check(authorFinal.author_approval?.action === "amended", "author-approved final advances to the amendment");
  check(authorFinal.task?.agent_request === amendedRequest, "author-approved final contains the author's last version");
} finally {
  for (const key of createdKeys.reverse()) await remove(key);
  await dynamo.send(new DeleteItemCommand({
    TableName: DASHBOARD_TABLE,
    Key: {
      scope: { S: "v2" },
      entity_key: { S: `TASK#${rawTaskId}` },
    },
  })).catch(() => {});
}

console.log("Author sign-off/amend validation complete; synthetic artifacts removed.");
