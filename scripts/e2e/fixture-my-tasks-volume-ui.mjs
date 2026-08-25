// Set up or clean a deterministic 205-task author account for live verification
// of My Tasks pagination and post-sign-off position retention. Never use a
// non-e2e fixture id.

import { createRequire } from "node:module";

const require = createRequire(new URL("../../backend/package.json", import.meta.url));
const {
  DeleteObjectsCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { DeleteItemCommand, DynamoDBClient } = require("@aws-sdk/client-dynamodb");

const action = process.argv[2];
const fixtureId = String(process.argv[3] || "").toLowerCase();
if (!["setup", "cleanup"].includes(action) || !/^e2e-[a-z0-9-]{4,24}$/.test(fixtureId)) {
  throw new Error("Usage: node fixture-my-tasks-volume-ui.mjs setup|cleanup e2e-<id>");
}

const BUCKET = process.env.E2E_BUCKET || "journeys-prolific";
const TABLE = process.env.E2E_DASHBOARD_TABLE || "apollo-dashboard-index";
const REGION = process.env.AWS_REGION || "us-east-1";
const ROOT = "v2-review/";
const TASK_COUNT = 205;
const s3 = new S3Client({ region: REGION });
const dynamo = new DynamoDBClient({ region: REGION });
const slugify = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const b64url = (value) => Buffer.from(String(value), "utf8").toString("base64url");

const email = `live-ui-${fixtureId}@example.com`;
const participantId = slugify(email);

function fixtureAt(index) {
  const suffix = String(index + 1).padStart(3, "0");
  const rawTaskId = `v2/${participantId}/internal/task-${fixtureId}-${suffix}`;
  const safeTaskId = rawTaskId.replace(/[^A-Za-z0-9_-]/g, "_");
  const taskDir = `prolific/journeys/${participantId}/${rawTaskId}`;
  const sourceKey = `${taskDir}/${fixtureId}-${suffix}_long_task.json`;
  return {
    index,
    suffix,
    rawTaskId,
    safeTaskId,
    sourceKey,
    inboxKey: `${ROOT}inbox/${b64url(sourceKey)}`,
    doneKey: `${ROOT}done/${b64url(sourceKey)}`,
    finishedKey: `${ROOT}finished/${safeTaskId}.json`,
    historyKey: `${ROOT}finished-history/${safeTaskId}/001.json`,
    signoffKey: `${ROOT}author-signoffs/${b64url(sourceKey)}.json`,
    authorApprovedKey: `${ROOT}author-approved/${safeTaskId}.json`,
    mutationLockKey: `${ROOT}author-mutation-locks/${b64url(taskDir)}.json`,
  };
}

async function pooled(values, concurrency, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < values.length) {
      const value = values[cursor];
      cursor += 1;
      await worker(value);
    }
  }));
}

async function putJson(key, value) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(value),
    ContentType: "application/json",
    IfNoneMatch: "*",
  }));
}

async function deleteKeys(keys) {
  for (let index = 0; index < keys.length; index += 1000) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: keys.slice(index, index + 1000).map((Key) => ({ Key })), Quiet: true },
    }));
  }
}

const fixtures = Array.from({ length: TASK_COUNT }, (_, index) => fixtureAt(index));

if (action === "setup") {
  const baseTime = Date.now() - TASK_COUNT * 60_000;
  await pooled(fixtures, 20, async (fixture) => {
    const createdAt = new Date(baseTime + fixture.index * 60_000).toISOString();
    const task = {
      task_title: `Volume sign-off task ${fixture.suffix}`,
      agent_request: `Verify pagination retention for production task ${fixture.suffix}.`,
      difficulty: "medium",
      site_scope: [],
      success_criteria: ["The result is supported by a first-party source."],
      must_visit_or_reach: ["https://example.com/volume-verification"],
      required_outputs: ["A concise verification note"],
      notes: `Temporary live-volume fixture ${fixture.suffix}.`,
      steps: [{ order: 1, title: "Verify the source", description: "Open the source and record the result." }],
      metadata: { region: "GLOBAL", subjects: ["Other > Other"] },
    };
    const source = {
      schema_version: "odyssey_long_task_v2",
      task_id: fixture.rawTaskId,
      mode: "guided",
      created_at: createdAt,
      app: { name: "Apollo", version: "e2e", platform: "web" },
      participant: {
        kind: "internal",
        participant_id: participantId,
        session_id: null,
        name: "Live UI Volume E2E",
        email,
        consent: { version: "e2e", accepted_at: createdAt },
      },
      task,
      provenance: { source_journeys: [], theme_suggestion: null, template: null, attached_urls: [] },
    };
    const reviewerPid = `reviewer-${fixtureId}`.slice(0, 40).replace(/-$/, "0");
    const reviewHash = `volume-${fixtureId}-${fixture.suffix}`;
    await putJson(fixture.sourceKey, source);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: fixture.inboxKey,
      Body: fixture.sourceKey,
      ContentType: "text/plain",
      IfNoneMatch: "*",
    }));
    await putJson(fixture.finishedKey, {
      schema_version: "odyssey_long_task_v2_reviewed",
      task_id: fixture.rawTaskId,
      mode: "guided",
      task,
      review: {
        title_edited: false,
        request_edited: false,
        evergreen_verified: true,
        rubrics: [{
          kind: "step",
          source_index: 0,
          title: task.steps[0].title,
          original: task.steps[0].description,
          final: task.steps[0].description,
          changed: false,
          checked: true,
        }],
      },
      review_content_hash: reviewHash,
      reviewed_by: "Hidden Volume E2E Reviewer",
      reviewer_pid: reviewerPid,
      claimed_at: createdAt,
      finished_at: createdAt,
    });
    await putJson(fixture.doneKey, {
      target: fixture.finishedKey,
      outcome: "approved",
      reviewer: "Hidden Volume E2E Reviewer",
      reviewer_pid: reviewerPid,
      task_id: fixture.safeTaskId,
      completed_at: createdAt,
      content_hash: reviewHash,
      claimed_at: createdAt,
    });
  });
  console.log(JSON.stringify({
    email,
    participant_id: participantId,
    task_count: TASK_COUNT,
    expected_pages_at_200: 2,
  }, null, 2));
} else {
  const keys = fixtures.flatMap((fixture) => [
    fixture.sourceKey,
    fixture.inboxKey,
    fixture.doneKey,
    fixture.finishedKey,
    fixture.historyKey,
    fixture.signoffKey,
    fixture.authorApprovedKey,
    fixture.mutationLockKey,
  ]);
  await deleteKeys(keys);
  await pooled(fixtures, 20, async (fixture) => {
    await dynamo.send(new DeleteItemCommand({
      TableName: TABLE,
      Key: { scope: { S: "v2" }, entity_key: { S: `TASK#${fixture.rawTaskId}` } },
    })).catch(() => {});
  });
  console.log(JSON.stringify({ cleaned: true, task_count: TASK_COUNT, objects_considered: keys.length }, null, 2));
}
