#!/usr/bin/env node

// Backfill stable reviewer ids onto legacy rejection records so an author's
// one appeal can be routed away from the person who rejected it. Dry-run is
// the default. Writes are conditional on the ETag read during this run.

import { readFileSync } from "node:fs";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

const VALID_PID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const bucket = argument("--bucket", process.env.S3_BUCKET || "journeys-prolific");
const reviewPrefix = argument("--review-prefix", "v2-review/").replace(/^\/+/, "").replace(/\/?$/, "/");
const write = process.argv.includes("--write");
const overridePath = argument("--overrides");
const concurrency = Math.min(25, Math.max(1, Number(argument("--concurrency", "10")) || 10));

if (reviewPrefix !== "v2-review/") {
  throw new Error("This migration is intentionally limited to --review-prefix v2-review/.");
}

let overrides = {};
if (overridePath) {
  overrides = JSON.parse(readFileSync(overridePath, "utf8"));
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Override file must be a JSON object mapping reviewer display names to participant ids.");
  }
  overrides = Object.fromEntries(Object.entries(overrides).map(([name, pid]) => {
    const normalizedPid = String(pid || "").trim().toLowerCase();
    if (!normalizeName(name) || !VALID_PID.test(normalizedPid)) {
      throw new Error("Every override must have a non-empty reviewer name and a valid participant id.");
    }
    return [normalizeName(name), normalizedPid];
  }));
}

process.env.S3_BUCKET = bucket;
process.env.REVIEW_PREFIX = reviewPrefix;
process.env.APP_SCOPE = "primary";
// Force the source-of-truth S3 scan. This migration never writes DynamoDB.
process.env.DASHBOARD_TABLE = "";

const moduleUrl = new URL(`./lambda_presign.js?rejection-pid-backfill=${Date.now()}`, import.meta.url);
const { loadAdminDashboard } = await import(moduleUrl.href);
const dashboard = await loadAdminDashboard();
const client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

const pidsByName = new Map();
const knownPids = new Set();
for (const item of dashboard.items || []) {
  const pid = String(item?.participant_id || "").trim().toLowerCase();
  const name = normalizeName(item?.participant_name);
  if (!VALID_PID.test(pid)) continue;
  knownPids.add(pid);
  if (!name) continue;
  if (!pidsByName.has(name)) pidsByName.set(name, new Set());
  pidsByName.get(name).add(pid);
}
for (const pid of Object.values(overrides)) {
  if (!knownPids.has(pid)) throw new Error("An override participant id does not exist in the V2 source corpus.");
}

async function readJson(key) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await response.Body.transformToString();
  return { json: JSON.parse(text), etag: response.ETag };
}

async function writeJson(key, json, etag) {
  if (!etag) throw new Error(`Missing ETag for ${key}`);
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(json, null, 2),
    ContentType: "application/json",
    IfMatch: etag,
  }));
}

async function backupOriginal(key, json) {
  const name = key.slice(`${reviewPrefix}rejected/`.length);
  const backupKey = `${reviewPrefix}migration-backups/rejected-reviewer-pids/${name}`;
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: backupKey,
      Body: JSON.stringify(json, null, 2),
      ContentType: "application/json",
      IfNoneMatch: "*",
    }));
    return true;
  } catch (error) {
    const code = error?.$metadata?.httpStatusCode;
    if (![409, 412].includes(code) && error?.name !== "PreconditionFailed" && error?.name !== "ConditionalRequestConflict") {
      throw error;
    }
    const existing = await readJson(backupKey);
    if (JSON.stringify(existing.json) !== JSON.stringify(json)) {
      throw new Error(`A different migration backup already exists for ${key}`);
    }
    return false;
  }
}

async function mapOne(item) {
  const target = String(item.done_target || "");
  if (!target.startsWith(`${reviewPrefix}rejected/`)) return { status: "not_current_rejection" };
  const rejection = await readJson(target);
  const existing = String(rejection.json?.rejected_by_pid || "").trim().toLowerCase();
  if (VALID_PID.test(existing)) return { status: "already_present" };
  const reviewerName = normalizeName(rejection.json?.rejected_by || item.reviewer);
  const override = overrides[reviewerName] || "";
  const candidates = pidsByName.get(reviewerName) || new Set();
  const pid = override || (candidates.size === 1 ? [...candidates][0] : "");
  if (!pid) return { status: candidates.size > 1 ? "ambiguous" : "unmatched" };
  if (!write) return { status: override ? "planned_override" : "planned_unique" };

  const backupWritten = await backupOriginal(target, rejection.json);
  await writeJson(target, { ...rejection.json, rejected_by_pid: pid }, rejection.etag);
  const verified = await readJson(target);
  if (verified.json?.rejected_by_pid !== pid) throw new Error(`Verification failed for ${target}`);
  return { status: override ? "written_override" : "written_unique", backupWritten };
}

const rejectedItems = (dashboard.items || []).filter((item) => item.status === "rejected" && item.done_target);
const results = [];
for (let offset = 0; offset < rejectedItems.length; offset += concurrency) {
  results.push(...(await Promise.all(rejectedItems.slice(offset, offset + concurrency).map(mapOne))));
}
const counts = results.reduce((out, result) => {
  out[result.status] = (out[result.status] || 0) + 1;
  if (result.backupWritten) out.backups_written = (out.backups_written || 0) + 1;
  return out;
}, {});

console.log(JSON.stringify({
  mode: write ? "write" : "plan",
  bucket,
  review_prefix: reviewPrefix,
  current_rejections: rejectedItems.length,
  reviewer_names_with_multiple_pids: [...pidsByName.values()].filter((pids) => pids.size > 1).length,
  overrides_supplied: Object.keys(overrides).length,
  counts,
}, null, 2));
