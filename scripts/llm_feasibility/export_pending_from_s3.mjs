#!/usr/bin/env node

// Build a local, authored-content-only PRE_QC input without retrieving or
// exposing the production reporting bearer token. The backend sanitizer is the
// single source of truth: browsing journeys, PC records, attachments, consent,
// aliases, expected answers, and source S3 keys are never written here.

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { adminDashboard } from "../../backend/lambda_presign.js";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const status = argument("--status", "pending");
if (!new Set(["pending", "in_review"]).has(status)) {
  throw new Error("--status must be pending or in_review for a PRE_QC export");
}
if (!process.env.S3_BUCKET) throw new Error("S3_BUCKET is required");

const output = resolve(argument("--output", ".work/llm_feasibility/pre_qc_input.json"));
const dashboard = await adminDashboard();
const tasks = dashboard.items
  .filter((item) => item.status === status)
  .map((item) => ({
    task_id: item.task_id,
    status: item.status,
    llm_review_status: item.llm_review_status,
    llm_review_stage: item.llm_review_stage,
    llm_review_stale: item.llm_review_stale,
    content: {
      task_content_hash: item.task_content_hash,
      original: item.original,
      final: item.final,
      rubrics: item.rubrics,
      human_review: item.human_review,
    },
  }));

const payload = {
  schema_version: "apollo-pre-qc-input-v1",
  generated_at: new Date().toISOString(),
  tasks,
};
await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

const rubricCount = tasks.reduce((sum, task) => sum + task.content.rubrics.length, 0);
console.log(JSON.stringify({ output, status, tasks: tasks.length, rubrics: rubricCount }, null, 2));
