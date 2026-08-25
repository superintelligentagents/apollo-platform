// Build self-contained v2-review/author-approved/ final tasks from existing
// author sign-off receipts. Dry-run by default; pass --write to persist.

import { createRequire } from "node:module";
import {
  authorApprovedFinalMatches,
  authorApprovedKeyFor,
  buildAuthorApprovedFinal,
} from "./lambda_presign.js";

const require = createRequire(import.meta.url);
const {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");

const WRITE = process.argv.includes("--write");
const BUCKET = process.env.AUTHOR_APPROVED_BUCKET || "journeys-prolific";
const REGION = process.env.AWS_REGION || "us-east-1";
const REVIEW_PREFIX = process.env.AUTHOR_APPROVED_REVIEW_PREFIX || "v2-review/";
const SIGNOFF_PREFIX = `${REVIEW_PREFIX}author-signoffs/`;
const s3 = new S3Client({ region: REGION });
const b64url = (value) => Buffer.from(String(value), "utf8").toString("base64url");

async function listAll(prefix) {
  const keys = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: 1_000,
    }));
    keys.push(...(page.Contents ?? []).map((item) => item.Key).filter(Boolean));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function readJson(key) {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return { json: JSON.parse(await response.Body.transformToString()), etag: response.ETag };
}

async function readOptional(key) {
  try {
    return await readJson(key);
  } catch (error) {
    const code = error?.$metadata?.httpStatusCode;
    if (code === 404 || error?.name === "NoSuchKey" || error?.name === "NotFound") return null;
    throw error;
  }
}

async function buildOne(signoffKey) {
  const receipt = (await readJson(signoffKey)).json;
  const subKey = String(receipt.sub_key || "");
  if (!subKey) return { status: "invalid_receipt" };
  const done = (await readOptional(`${REVIEW_PREFIX}done/${b64url(subKey)}`))?.json;
  if (done?.outcome !== "approved" || !done.target) return { status: "not_currently_approved" };
  const finished = (await readOptional(done.target))?.json;
  if (!finished) return { status: "missing_final_gold" };
  const receiptHash = String(receipt.acknowledged_content_hash || "");
  if (receiptHash && receiptHash !== String(finished.review_content_hash || "")) {
    return { status: "stale_receipt" };
  }
  const taskId = String(receipt.task_id || done.task_id || "");
  const document = buildAuthorApprovedFinal({
    finished,
    finalGoldKey: done.target,
    subKey,
    taskId,
    participantId: receipt.participant_id,
    action: receipt.action,
    approvedAt: receipt.signed_off_at,
  });
  if (!document) return { status: "invalid_final_gold" };
  const key = authorApprovedKeyFor(taskId);
  const existing = await readOptional(key);
  if (existing && authorApprovedFinalMatches(existing.json, document)) return { status: "already_current" };
  const existingAuthor = String(existing?.json?.author_approval?.participant_id || "");
  if (existingAuthor && existingAuthor !== String(receipt.participant_id || "")) {
    return { status: "participant_conflict" };
  }
  if (!WRITE) return { status: existing ? "would_update" : "would_create" };
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(document, null, 2),
    ContentType: "application/json",
    ...(existing ? { IfMatch: existing.etag } : { IfNoneMatch: "*" }),
  }));
  const verified = (await readJson(key)).json;
  if (!authorApprovedFinalMatches(verified, document)) throw new Error(`Verification failed for ${key}`);
  return { status: existing ? "updated" : "created" };
}

const signoffKeys = await listAll(SIGNOFF_PREFIX);
const counts = {};
for (let offset = 0; offset < signoffKeys.length; offset += 10) {
  const results = await Promise.all(signoffKeys.slice(offset, offset + 10).map(async (key) => {
    try {
      return await buildOne(key);
    } catch (error) {
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }));
  for (const result of results) {
    counts[result.status] = (counts[result.status] || 0) + 1;
    if (result.error) console.error(result.error);
  }
}

console.log(JSON.stringify({
  mode: WRITE ? "write" : "dry-run",
  bucket: BUCKET,
  signoffs: signoffKeys.length,
  counts,
}, null, 2));
if (counts.error) process.exitCode = 1;
