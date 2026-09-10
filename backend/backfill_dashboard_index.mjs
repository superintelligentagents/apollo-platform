#!/usr/bin/env node

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

async function writeBatchFully(client, tableName, records) {
  let pending = records.map((Item) => ({ PutRequest: { Item } }));
  let attempt = 0;
  while (pending.length) {
    const response = await client.send(new BatchWriteCommand({
      RequestItems: { [tableName]: pending },
    }));
    pending = response.UnprocessedItems?.[tableName] || [];
    if (pending.length) {
      attempt += 1;
      if (attempt > 8) throw new Error(`${pending.length} index records remained unprocessed.`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 100 * 2 ** attempt)));
    }
  }
}

async function deleteBatchFully(client, tableName, records) {
  let pending = records.map((record) => ({ DeleteRequest: { Key: { scope: record.scope, entity_key: record.entity_key } } }));
  let attempt = 0;
  while (pending.length) {
    const response = await client.send(new BatchWriteCommand({
      RequestItems: { [tableName]: pending },
    }));
    pending = response.UnprocessedItems?.[tableName] || [];
    if (pending.length) {
      attempt += 1;
      if (attempt > 8) throw new Error(`${pending.length} stale author index records remained unprocessed.`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 100 * 2 ** attempt)));
    }
  }
}

async function queryRecords(client, tableName, scope, prefix) {
  const records = [];
  let ExclusiveStartKey;
  do {
    const response = await client.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "#scope = :scope AND begins_with(#entity, :task)",
      ExpressionAttributeNames: { "#scope": "scope", "#entity": "entity_key" },
      ExpressionAttributeValues: { ":scope": scope, ":task": prefix },
      ExclusiveStartKey,
      ConsistentRead: true,
    }));
    records.push(...(response.Items || []));
    ExclusiveStartKey = response.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return records;
}

const scope = argument("--scope");
const tableName = argument("--table", process.env.DASHBOARD_TABLE || "apollo-dashboard-index");
const bucket = argument("--bucket", process.env.S3_BUCKET || "journeys-prolific");
const write = process.argv.includes("--write");
if (!["v2", "pc"].includes(scope)) {
  throw new Error("Use --scope v2 or --scope pc.");
}

process.env.REVIEW_PREFIX = scope === "v2" ? "v2-review/" : "pc-review/";
process.env.S3_BUCKET = bucket;
// Force the source scan during backfill. The table is written only by this
// script, and S3 is read-only throughout.
process.env.DASHBOARD_TABLE = "";

const moduleUrl = new URL(`./lambda_presign.js?backfill=${scope}-${Date.now()}`, import.meta.url);
const {
  buildAuthorDashboardIndexRecord,
  buildDashboardIndexRecord,
  dashboardIndexScope,
  loadAdminDashboard,
} = await import(moduleUrl.href);
const dashboard = await loadAdminDashboard();
const indexedAt = new Date().toISOString();
const records = dashboard.items.map((item) => buildDashboardIndexRecord(item, dashboardIndexScope(), indexedAt));
if (records.some((record) => !record)) throw new Error("At least one S3 task could not be converted to an index record.");
const uniqueKeys = new Set(records.map((record) => record.entity_key));
if (uniqueKeys.size !== records.length) {
  throw new Error(`Index key collision: ${records.length - uniqueKeys.size} duplicate task id(s).`);
}
const authorRecords = records.map((record) => buildAuthorDashboardIndexRecord(record));
if (authorRecords.some((record) => !record)) throw new Error("At least one task has no valid author index key.");

const statusCounts = records.reduce((counts, record) => {
  counts[record.status] = (counts[record.status] || 0) + 1;
  return counts;
}, {});
console.log(JSON.stringify({
  mode: write ? "write" : "plan",
  scope,
  table: tableName,
  source_total: dashboard.total,
  converted: records.length,
  author_records: authorRecords.length,
  status_counts: statusCounts,
  s3_writes: 0,
}, null, 2));
if (!write) process.exit(0);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" }), {
  marshallOptions: { removeUndefinedValues: true },
});
const existingAuthors = await queryRecords(client, tableName, scope, "AUTHOR#");
const expectedAuthorKeys = new Set(authorRecords.map((record) => record.entity_key));
const staleAuthors = existingAuthors.filter((record) => !expectedAuthorKeys.has(record.entity_key));
for (const batch of chunks(staleAuthors, 25)) await deleteBatchFully(client, tableName, batch);
for (const batch of chunks([...records, ...authorRecords], 25)) await writeBatchFully(client, tableName, batch);
await client.send(new PutCommand({
  TableName: tableName,
  Item: {
    scope,
    entity_key: "META",
    entity_type: "META",
    ready: true,
    expected_count: records.length,
    backfilled_at: indexedAt,
    indexed_at: indexedAt,
  },
}));
await client.send(new PutCommand({
  TableName: tableName,
  Item: {
    scope,
    entity_key: "AUTHOR_META",
    entity_type: "META",
    ready: true,
    expected_count: authorRecords.length,
    backfilled_at: indexedAt,
    indexed_at: indexedAt,
  },
}));

const [stored, storedAuthors] = await Promise.all([
  queryRecords(client, tableName, scope, "TASK#"),
  queryRecords(client, tableName, scope, "AUTHOR#"),
]);
const expected = new Map(records.map((record) => [record.entity_key, record]));
const mismatches = stored.filter((record) => {
  const source = expected.get(record.entity_key);
  return !source || [
    "task_id",
    "source_key",
    "status",
    "participant_id",
    "submitted_at",
    "done_target",
    "original_title",
    "final_title",
    "appeal_number",
    "author_revision_number",
    "author_requeue_count",
    "author_requeued_at",
    "signoff_action",
  ].some((field) => (record[field] ?? null) !== (source[field] ?? null));
});
if (stored.length !== records.length || storedAuthors.length !== authorRecords.length || mismatches.length) {
  throw new Error(`Index parity failed: expected ${records.length}/${authorRecords.length}, stored ${stored.length}/${storedAuthors.length}, mismatches ${mismatches.length}.`);
}
console.log(JSON.stringify({
  verified: true,
  scope,
  stored: stored.length,
  author_records: storedAuthors.length,
  stale_author_records_removed: staleAuthors.length,
  mismatches: 0,
  meta_written_last: true,
  s3_writes: 0,
}, null, 2));
