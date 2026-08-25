#!/usr/bin/env node

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

async function listAll(client, bucket, prefix) {
  const output = [];
  let ContinuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken,
      MaxKeys: 1000,
    }));
    output.push(...(page.Contents || []));
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return output;
}

async function readJson(client, bucket, key) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse(await response.Body.transformToString());
}

const scope = argument("--scope");
const tableName = argument("--table", process.env.DASHBOARD_TABLE || "apollo-dashboard-index");
const bucket = argument("--bucket", process.env.S3_BUCKET || "journeys-prolific");
const write = process.argv.includes("--write");
if (!["v2", "pc"].includes(scope)) throw new Error("Use --scope v2 or --scope pc.");

const reviewPrefix = scope === "v2" ? "v2-review/" : "pc-review/";
process.env.REVIEW_PREFIX = reviewPrefix;
process.env.S3_BUCKET = bucket;
process.env.DASHBOARD_TABLE = tableName;

const {
  currentReviewerLlmCandidates,
  isCompletedReviewerPreQcArtifact,
  loadAdminDashboard,
  parseLlmReviewArtifactKey,
  selectLlmReviewArtifact,
} = await import(new URL(`./lambda_presign.js?audit-backfill=${scope}-${Date.now()}`, import.meta.url).href);

const region = process.env.AWS_REGION || "us-east-1";
const s3 = new S3Client({ region });
const dashboardDb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});
const dashboard = await loadAdminDashboard();
const [passed, attention] = await Promise.all([
  listAll(s3, bucket, `${reviewPrefix}llm_pre_qc_pass/`),
  listAll(s3, bucket, `${reviewPrefix}llm_pre_qc_attention/`),
]);
const candidates = [];
for (const [objects, status, prefix] of [
  [passed, "pre_qc_passed", `${reviewPrefix}llm_pre_qc_pass/`],
  [attention, "pre_qc_attention", `${reviewPrefix}llm_pre_qc_attention/`],
]) {
  for (const object of objects) {
    const parsed = parseLlmReviewArtifactKey(object.Key, prefix, status, object.LastModified, "PRE_QC");
    if (parsed) candidates.push(parsed);
  }
}

const applicable = currentReviewerLlmCandidates(candidates);
const plans = dashboard.items.map((item) => {
  const selected = selectLlmReviewArtifact(
    applicable.filter((candidate) => candidate.taskId === item.task_id),
    item.task_content_hash,
  );
  return { item, selected: selected?.contentHash === item.task_content_hash ? selected : null };
});
console.log(JSON.stringify({
  mode: write ? "write" : "plan",
  scope,
  source_tasks: dashboard.items.length,
  current_artifact_candidates: plans.filter((plan) => plan.selected).length,
  s3_task_writes: 0,
  s3_review_writes: 0,
}, null, 2));
if (!write) process.exit(0);

let complete = 0;
let incomplete = 0;
let hashes = 0;
for (let offset = 0; offset < plans.length; offset += 25) {
  const results = await Promise.all(plans.slice(offset, offset + 25).map(async ({ item, selected }) => {
    let artifact = null;
    let isComplete = false;
    if (selected) {
      artifact = await readJson(s3, bucket, selected.key).catch(() => null);
      isComplete = isCompletedReviewerPreQcArtifact(artifact);
    }
    const names = { "#entity": "entity_key" };
    const values = {
      ":hash": item.task_content_hash,
      ":indexed": new Date().toISOString(),
    };
    let update = "SET task_content_hash = :hash, pre_qc_indexed_at = :indexed";
    if (selected) {
      Object.assign(values, {
        ":artifact": selected.key,
        ":reviewHash": selected.contentHash,
        ":version": Number(selected.pipelineVersion) || 0,
        ":status": String(artifact?.status || ""),
        ":complete": isComplete,
      });
      update += ", pre_qc_artifact_key = :artifact, pre_qc_task_content_hash = :reviewHash, pre_qc_pipeline_version = :version, pre_qc_status = :status, pre_qc_complete = :complete";
    }
    await dashboardDb.send(new UpdateCommand({
      TableName: tableName,
      Key: { scope, entity_key: `TASK#${item.task_id}` },
      ConditionExpression: "attribute_exists(#entity)",
      UpdateExpression: update,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return { selected: Boolean(selected), complete: isComplete };
  }));
  hashes += results.length;
  complete += results.filter((result) => result.complete).length;
  incomplete += results.filter((result) => result.selected && !result.complete).length;
}

console.log(JSON.stringify({
  verified: true,
  scope,
  task_hashes_indexed: hashes,
  completed_pre_qc_indexed: complete,
  incomplete_pre_qc_indexed: incomplete,
  s3_task_writes: 0,
  s3_review_writes: 0,
}, null, 2));
