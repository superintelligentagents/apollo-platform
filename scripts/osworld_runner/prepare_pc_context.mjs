#!/usr/bin/env node
/** Build a private OSWorld setup from one redacted Apollo PC task bundle. */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../backend/package.json", import.meta.url));
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

export const CONTEXT_SCHEMA = "apollo-pc-osworld-context-v1";
const DEFAULT_BUCKET = "journeys-prolific";
const DEFAULT_PREFIX = "prolific/journeys/";
const CHUNK_SIZE = 48_000;

function text(value, limit = 20_000) {
  return String(value ?? "").trim().slice(0, limit);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function runId(taskId) {
  return `apollo_b64_${Buffer.from(taskId, "utf8").toString("base64url")}`;
}

function uploadedAt(key) {
  const match = /\/(\d{13})(?:-[A-Za-z0-9]+)?_[^/]+$/.exec(key);
  return match ? Number(match[1]) : 0;
}

function newestLogicalObject(keys, logicalFilename) {
  const suffix = `_${logicalFilename}`;
  return keys.filter((key) => key.endsWith(suffix)).sort((a, b) => uploadedAt(b) - uploadedAt(a) || b.localeCompare(a))[0] || null;
}

export function selectContextRecords(parts, referencedIds) {
  const wanted = new Set(referencedIds);
  const selected = [];
  for (const part of parts) {
    for (const entry of Array.isArray(part?.records) ? part.records : []) {
      const record = entry?.record;
      if (record && wanted.has(record.id)) selected.push(record);
    }
  }
  return selected;
}

export function buildContextHtml(taskId, task, records) {
  const rows = records.map((record, index) => {
    const source = text(record.source, 80) || "record";
    const title = text(record.subject || record.summary || record.title || record.merchant || `${source} ${index + 1}`, 500);
    const fields = Object.entries(record)
      .filter(([key, value]) => key !== "id" && key !== "source" && value != null && value !== "")
      .map(([key, value]) => `<dt>${escapeHtml(key.replaceAll("_", " "))}</dt><dd>${escapeHtml(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</dd>`)
      .join("");
    return `<article><p class="kind">${escapeHtml(source)}</p><h2>${escapeHtml(title)}</h2><dl>${fields}</dl></article>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Apollo PC context</title><style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f5f2eb;color:#17201c}main{max-width:980px;margin:auto;padding:40px}header{border-bottom:2px solid #17201c;margin-bottom:28px}article{background:#fff;border:1px solid #c9c3b8;padding:24px;margin:18px 0}h1,h2{line-height:1.15}.kind{font:12px ui-monospace,monospace;text-transform:uppercase;color:#58645e}dl{display:grid;grid-template-columns:180px 1fr;gap:8px 18px}dt{font-weight:700;text-transform:capitalize}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.notice{padding:12px;background:#e5eee7;border-left:4px solid #315e42}@media(max-width:650px){main{padding:20px}dl{grid-template-columns:1fr}}
</style></head><body><main><header><p class="kind">Private redacted context · ${escapeHtml(taskId)}</p><h1>${escapeHtml(task?.task_title || "Apollo PC task")}</h1><p>${escapeHtml(task?.agent_request || "")}</p></header><p class="notice">Use only these participant-selected, redacted records as personal context for the task.</p>${rows || "<p>No referenced records were supplied.</p>"}</main></body></html>`;
}

export function buildContextConfig(taskId, html) {
  const digest = createHash("sha256").update(html).digest("hex").slice(0, 16);
  const target = `/tmp/apollo-pc-context-${digest}.html`;
  const encoded = gzipSync(Buffer.from(html, "utf8")).toString("base64");
  const chunks = encoded.match(new RegExp(`.{1,${CHUNK_SIZE}}`, "g")) || [];
  const staging = `${target}.gz.b64`;
  const config = [
    { type: "command", parameters: { command: `umask 077; : > '${staging}'`, shell: true } },
    ...chunks.map((chunk) => ({ type: "command", parameters: { command: `printf '%s' '${chunk}' >> '${staging}'`, shell: true } })),
    {
      type: "execute_with_verification",
      parameters: {
        command: `base64 -d '${staging}' | gzip -d > '${target}' && rm -f '${staging}'`,
        shell: true,
        verification: { command_success: `test -s '${target}'` },
        max_wait_time: 15,
        check_interval: 1,
      },
    },
  ];
  return {
    schema_version: CONTEXT_SCHEMA,
    task_id: taskId,
    config,
    start_urls: [`file://${target}`],
    related_apps: ["chrome"],
    context_sha256: createHash("sha256").update(html).digest("hex"),
    record_count: null,
  };
}

async function listAll(s3, bucket, prefix) {
  const keys = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
    keys.push(...(page.Contents || []).map((entry) => entry.Key).filter(Boolean));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function getBytes(s3, bucket, key) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await response.Body.transformToByteArray());
}

async function getJson(s3, bucket, key) {
  return JSON.parse((await getBytes(s3, bucket, key)).toString("utf8"));
}

function parseArgs(argv) {
  const out = { bucket: DEFAULT_BUCKET, prefix: DEFAULT_PREFIX, region: process.env.AWS_REGION || "us-east-1", outputDir: ".work/pc-context" };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!value || !flag.startsWith("--")) throw new Error(`Invalid argument near ${flag || "end of command"}`);
    const name = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!["taskId", "creatorPid", "bucket", "prefix", "region", "outputDir", "profile"].includes(name)) throw new Error(`Unknown argument ${flag}`);
    out[name] = value;
  }
  if (!/^pc_[A-Za-z0-9_-]{1,140}$/.test(out.taskId || "")) throw new Error("--task-id must be a PC task ID such as pc_task-id");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(out.creatorPid || "")) throw new Error("--creator-pid is invalid");
  return out;
}

export async function prepareContext(args, client = null) {
  if (args.profile) process.env.AWS_PROFILE = args.profile;
  const s3 = client || new S3Client({ region: args.region });
  const root = `${args.prefix}${args.creatorPid}/pc/${args.creatorPid}/internal/`;
  const allKeys = await listAll(s3, args.bucket, root);
  const sidecars = [];
  for (const key of allKeys.filter((candidate) => /_review_task_[^/]+\.json$/.test(candidate))) {
    const source = await getJson(s3, args.bucket, key);
    if (source?.task_id === args.taskId) sidecars.push({ key, source });
  }
  sidecars.sort((a, b) => uploadedAt(b.key) - uploadedAt(a.key) || b.key.localeCompare(a.key));
  const sidecar = sidecars[0];
  if (!sidecar) throw new Error(`No uploaded sidecar found for ${args.taskId}`);
  const bundlePrefix = sidecar.key.slice(0, sidecar.key.lastIndexOf("/") + 1);
  const bundleKeys = allKeys.filter((key) => key.startsWith(bundlePrefix));
  const manifestKey = newestLogicalObject(bundleKeys, "manifest.json");
  if (!manifestKey) throw new Error(`Bundle manifest is missing for ${args.taskId}`);
  const manifest = await getJson(s3, args.bucket, manifestKey);
  if (manifest?.schema_version !== "odyssey_personal_context_v1" || manifest?.participant?.participant_id !== args.creatorPid) {
    throw new Error("Bundle manifest identity or schema does not match the requested task");
  }
  let tasks = Array.isArray(manifest.tasks) ? manifest.tasks : [];
  if (!tasks.length) {
    const taskKey = newestLogicalObject(bundleKeys, "tasks.json");
    if (!taskKey) throw new Error("Bundle task payload is missing");
    tasks = await getJson(s3, args.bucket, taskKey);
  }
  const task = tasks.find((candidate) => `pc_${candidate?.task_id}` === args.taskId);
  if (!task) throw new Error(`Private bundle has no task matching ${args.taskId}`);
  const parts = [];
  for (const descriptor of Array.isArray(manifest.parts) ? manifest.parts : []) {
    if (!String(descriptor?.filename || "").startsWith("records_")) continue;
    const partKey = newestLogicalObject(bundleKeys, descriptor.filename);
    if (!partKey) throw new Error(`Bundle part is missing: ${descriptor.filename}`);
    const bytes = await getBytes(s3, args.bucket, partKey);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== descriptor.sha256) throw new Error(`Bundle part hash mismatch: ${descriptor.filename}`);
    parts.push(JSON.parse(bytes.toString("utf8")));
  }
  const referenced = Array.isArray(task.referenced_record_ids) ? task.referenced_record_ids : [];
  const records = selectContextRecords(parts, referenced);
  if (!records.length) throw new Error(`Task ${args.taskId} has no readable referenced records`);
  const html = buildContextHtml(args.taskId, task, records);
  const config = { ...buildContextConfig(args.taskId, html), record_count: records.length };
  const outputDir = resolve(args.outputDir);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const output = resolve(outputDir, `${runId(args.taskId)}.json`);
  await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(output, 0o600);
  return { output, task_id: args.taskId, record_count: records.length, context_sha256: config.context_sha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareContext(parseArgs(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(`error: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
