// Set up or clean a deterministic rejected-task fixture for browser testing
// the deployed My Tasks appeal form. Never use a non-e2e id.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../backend/package.json", import.meta.url));
const { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { DeleteItemCommand, DynamoDBClient } = require("@aws-sdk/client-dynamodb");

const action = process.argv[2];
const fixtureId = String(process.argv[3] || "").toLowerCase();
if (!['setup', 'cleanup'].includes(action) || !/^e2e-[a-z0-9-]{4,30}$/.test(fixtureId)) {
  throw new Error("Usage: node fixture-author-appeal-ui.mjs setup|cleanup e2e-<id>");
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
const rejectedKey = `${ROOT}rejected/${safeTaskId}_${createHash("sha256").update(sourceKey).digest("hex").slice(0, 16)}.json`;

async function putJson(key, value) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(value, null, 2),
    ContentType: "application/json",
    IfNoneMatch: "*",
  }));
}

async function listAll(prefix) {
  const keys = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    keys.push(...(page.Contents ?? []).map((item) => item.Key).filter(Boolean));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

if (action === "setup") {
  const task = {
    task_title: "Live deployed appeal UI verification",
    agent_request: "Compare current public documentation from three first-party sources and produce a sourced implementation summary.",
    difficulty: "high",
    site_scope: [],
    success_criteria: [
      "Three first-party sources are compared.",
      "Regional exceptions are supported by citations.",
    ],
    must_visit_or_reach: ["https://docs.example.com/current-requirements"],
    required_outputs: ["Sourced implementation summary"],
    notes: "Use only current first-party documentation.",
    steps: Array.from({ length: 14 }, (_, index) => ({
      order: index + 1,
      title: `Original step ${index + 1}`,
      description: `Complete verification activity ${index + 1} and cite the supporting first-party source.`,
    })),
    metadata: { region: "GLOBAL", subjects: ["Other > Other"] },
  };
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
      name: "Live UI E2E",
      email,
      consent: { version: "e2e", accepted_at: now },
    },
    task,
    provenance: { source_journeys: [], theme_suggestion: null, template: null, attached_urls: [] },
  });
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: inboxKey, Body: sourceKey, ContentType: "text/plain", IfNoneMatch: "*" }));
  await putJson(rejectedKey, {
    source_key: sourceKey,
    task_id: safeTaskId,
    rejected_by: "Hidden E2E Reviewer",
    rejected_by_pid: `reviewer-${fixtureId}`.slice(0, 40).replace(/-$/, "0"),
    reason: "The reviewer believed the source-verification requirement needed additional clarification before approval.",
    review: { rubrics: [] },
    review_content_hash: `rejection-${fixtureId}`,
    rejected_at: now,
  });
  await putJson(doneKey, {
    target: rejectedKey,
    outcome: "rejected",
    reviewer: "Hidden E2E Reviewer",
    reviewer_pid: `reviewer-${fixtureId}`.slice(0, 40).replace(/-$/, "0"),
    task_id: safeTaskId,
    completed_at: now,
  });
  console.log(JSON.stringify({ email, participant_id: participantId, source_key: sourceKey, task_id: rawTaskId }, null, 2));
} else {
  const sourceKeys = await listAll(`${taskDir}/`);
  const exactKeys = new Set([sourceKey, inboxKey, doneKey, rejectedKey]);
  for (const key of sourceKeys) {
    exactKeys.add(key);
    exactKeys.add(`${ROOT}inbox/${b64url(key)}`);
    exactKeys.add(`${ROOT}done/${b64url(key)}`);
    exactKeys.add(`${ROOT}appeals/${b64url(key)}.json`);
    exactKeys.add(`${ROOT}locks/${b64url(key)}.json`);
  }
  for (const key of exactKeys) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
  }
  await dynamo.send(new DeleteItemCommand({
    TableName: TABLE,
    Key: { scope: { S: "v2" }, entity_key: { S: `TASK#${rawTaskId}` } },
  })).catch(() => {});
  console.log(JSON.stringify({ cleaned: true, task_id: rawTaskId, objects_considered: exactKeys.size }, null, 2));
}
