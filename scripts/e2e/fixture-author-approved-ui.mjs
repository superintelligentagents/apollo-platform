// Set up or clean a deterministic reviewer-edited approved task for live
// browser testing of the deployed My Tasks author sign-off/amendment UI.
// Never use a non-e2e id.

import { createRequire } from "node:module";

const require = createRequire(new URL("../../backend/package.json", import.meta.url));
const { DeleteObjectCommand, PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { DeleteItemCommand, DynamoDBClient } = require("@aws-sdk/client-dynamodb");

const action = process.argv[2];
const fixtureId = String(process.argv[3] || "").toLowerCase();
if (!["setup", "cleanup"].includes(action) || !/^e2e-[a-z0-9-]{4,30}$/.test(fixtureId)) {
  throw new Error("Usage: node fixture-author-approved-ui.mjs setup|cleanup e2e-<id>");
}

const BUCKET = process.env.E2E_BUCKET || "journeys-prolific";
const TABLE = process.env.E2E_DASHBOARD_TABLE || "apollo-dashboard-index";
const REGION = process.env.AWS_REGION || "us-east-1";
const ROOT = "v2-review/";
const s3 = new S3Client({ region: REGION });
const dynamo = new DynamoDBClient({ region: REGION });
const slugify = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const b64url = (value) => Buffer.from(String(value), "utf8").toString("base64url");

const email = `live-ui-${fixtureId}@example.com`;
const participantId = slugify(email);
const rawTaskId = `v2/${participantId}/internal/task-${fixtureId}`;
const safeTaskId = rawTaskId.replace(/[^A-Za-z0-9_-]/g, "_");
const taskDir = `prolific/journeys/${participantId}/${rawTaskId}`;
const sourceKey = `${taskDir}/${fixtureId}_long_task.json`;
const inboxKey = `${ROOT}inbox/${b64url(sourceKey)}`;
const doneKey = `${ROOT}done/${b64url(sourceKey)}`;
const finishedKey = `${ROOT}finished/${safeTaskId}.json`;
const historyKey = `${ROOT}finished-history/${safeTaskId}/001.json`;
const signoffKey = `${ROOT}author-signoffs/${b64url(sourceKey)}.json`;
const authorApprovedKey = `${ROOT}author-approved/${safeTaskId}.json`;
const mutationLockKey = `${ROOT}author-mutation-locks/${b64url(taskDir)}.json`;

async function putJson(key, value) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(value, null, 2),
    ContentType: "application/json",
    IfNoneMatch: "*",
  }));
}

const originalTask = {
  task_title: "Original production launch audit",
  agent_request: "Review three public pages and summarize the launch requirements.",
  difficulty: "medium",
  site_scope: [],
  success_criteria: ["Three public sources are compared."],
  must_visit_or_reach: [],
  required_outputs: ["Launch summary"],
  notes: null,
  steps: [
    { order: 1, title: "Collect sources", description: "Open three public pages." },
    { order: 2, title: "Compare evidence", description: "Compare the requirements on those pages." },
    { order: 3, title: "Write summary", description: "Write a short summary." },
  ],
  metadata: { region: "GLOBAL", subjects: ["Other > Other"] },
};

const finalTask = {
  ...originalTask,
  task_title: "Production launch readiness audit",
  agent_request: "Review three current first-party public pages, compare their launch requirements, and produce a cited implementation summary.",
  difficulty: "high",
  success_criteria: [
    "Every launch requirement is supported by a first-party citation.",
    "Regional exceptions and conflicts are explicitly resolved.",
  ],
  must_visit_or_reach: [
    "https://docs.example.com/launch-requirements",
    "https://docs.example.com/regional-availability",
  ],
  required_outputs: ["Cited launch-requirements matrix", "Implementation summary"],
  notes: "Use documentation current on the review date and call out unresolved caveats.",
  steps: [
    { order: 1, title: "Collect first-party sources", description: "Open three current first-party pages and record each URL and access date." },
    { order: 2, title: "Compare launch requirements", description: "Compare prerequisites, regional constraints, and any documented exceptions." },
    { order: 3, title: "Write a cited summary", description: "Write an implementation summary with inline citations to all three sources." },
  ],
};

if (action === "setup") {
  const now = new Date().toISOString();
  await putJson(sourceKey, {
    schema_version: "odyssey_long_task_v2",
    task_id: rawTaskId,
    mode: "guided",
    created_at: now,
    app: { name: "Apollo", version: "e2e", platform: "web" },
    participant: {
      kind: "internal",
      participant_id: participantId,
      session_id: null,
      name: "Live UI Approved E2E",
      email,
      consent: { version: "e2e", accepted_at: now },
    },
    task: originalTask,
    provenance: { source_journeys: [], theme_suggestion: null, template: null, attached_urls: [] },
  });
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: inboxKey, Body: sourceKey, ContentType: "text/plain", IfNoneMatch: "*" }));
  const review = {
    title_edited: true,
    request_edited: true,
    evergreen_verified: true,
    rubrics: finalTask.steps.map((step, index) => ({
      kind: "step",
      source_index: index,
      title: step.title,
      original: originalTask.steps[index].description,
      final: step.description,
      changed: true,
      checked: true,
    })),
  };
  const reviewContentHash = `approved-review-${fixtureId}`;
  await putJson(finishedKey, {
    schema_version: "odyssey_long_task_v2_reviewed",
    task_id: rawTaskId,
    mode: "guided",
    task: finalTask,
    review,
    review_content_hash: reviewContentHash,
    reviewed_by: "Hidden Approved E2E Reviewer",
    reviewer_pid: `reviewer-${fixtureId}`.slice(0, 40).replace(/-$/, "0"),
    claimed_at: now,
    finished_at: now,
  });
  await putJson(doneKey, {
    target: finishedKey,
    outcome: "approved",
    reviewer: "Hidden Approved E2E Reviewer",
    reviewer_pid: `reviewer-${fixtureId}`.slice(0, 40).replace(/-$/, "0"),
    task_id: safeTaskId,
    completed_at: now,
    content_hash: reviewContentHash,
    claimed_at: now,
  });
  console.log(JSON.stringify({ email, participant_id: participantId, source_key: sourceKey, task_id: rawTaskId, finished_key: finishedKey }, null, 2));
} else {
  const keys = [sourceKey, inboxKey, doneKey, finishedKey, historyKey, signoffKey, authorApprovedKey, mutationLockKey];
  for (const key of keys) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
  }
  await dynamo.send(new DeleteItemCommand({
    TableName: TABLE,
    Key: { scope: { S: "v2" }, entity_key: { S: `TASK#${rawTaskId}` } },
  })).catch(() => {});
  console.log(JSON.stringify({ cleaned: true, task_id: rawTaskId, objects_considered: keys.length }, null, 2));
}
