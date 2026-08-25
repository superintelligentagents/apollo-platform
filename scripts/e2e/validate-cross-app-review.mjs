// Production, non-destructive queue-isolation validation for Apollo v2 + PC.
// It creates one disposable task per app, proves only that app's queue count
// changes, verifies self-review exclusion, then removes every created object.

import { spawnSync } from "node:child_process";
import {
  cleanRubrics,
  cleanTaskSnapshot,
  reportingTaskContentHash,
} from "../../backend/lambda_presign.js";

const BUCKET = process.env.E2E_BUCKET || "journeys-prolific";
const SHARED_KEY = process.env.E2E_REVIEW_KEY || "";
const APPS = {
  v2: {
    endpoint: process.env.E2E_V2_REVIEW_ENDPOINT || "https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com",
    reviewKey: process.env.E2E_V2_REVIEW_KEY || SHARED_KEY,
    reviewRoot: "v2-review",
  },
  pc: {
    endpoint: process.env.E2E_PC_REVIEW_ENDPOINT || "https://t1ynh195m1.execute-api.us-east-1.amazonaws.com",
    reviewKey: process.env.E2E_PC_REVIEW_KEY || SHARED_KEY,
    reviewRoot: "pc-review",
  },
};

for (const [app, config] of Object.entries(APPS)) {
  if (!config.reviewKey) {
    throw new Error(`E2E_${app.toUpperCase()}_REVIEW_KEY is required (or set E2E_REVIEW_KEY when both deployments use the same key)`);
  }
}

const b64url = (value) => Buffer.from(value).toString("base64url");
const check = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`✓ ${message}`);
};

async function post(app, path, body) {
  const config = APPS[app];
  const response = await fetch(`${config.endpoint}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${app} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function reviewStatus(app, reviewerPid) {
  return post(app, "/review/status", {
    reviewKey: APPS[app].reviewKey,
    reviewer_pid: reviewerPid,
  });
}

async function uploadReviewTask(app, pid, marker) {
  const isPc = app === "pc";
  const taskId = isPc
    ? `pc/${pid}/internal/bundle-${marker}`
    : `v2/${pid}/internal/task-${marker}`;
  const filename = isPc ? `review_task_task-${marker}.json` : "long_task.json";
  const payload = {
    schema_version: "odyssey_long_task_v2",
    task_id: isPc ? `pc_${marker}` : taskId,
    mode: "guided",
    created_at: new Date().toISOString(),
    app: { name: isPc ? "apollo-pc" : "apollo-v2", version: "e2e", platform: "web" },
    participant: {
      kind: "internal",
      participant_id: isPc ? "redacted" : pid,
      session_id: null,
      name: null,
      email: null,
      consent: { version: "e2e", accepted_at: new Date().toISOString() },
    },
    task: {
      task_title: `QUEUE-ISOLATION-${app}-${marker}`,
      agent_request: "Verify that this disposable task enters only its application's review queue.",
      task_summary: null,
      difficulty: "high",
      site_scope: [],
      success_criteria: ["The task is visible only in the intended application queue."],
      must_visit_or_reach: [],
      required_outputs: [],
      notes: null,
      time_span: { start: null, end: null },
      steps: [{ order: 0, title: "Verify", description: "Check the intended queue and remove the disposable task." }],
    },
    provenance: { source_journeys: [], theme_suggestion: null, template: null, attached_urls: [] },
  };
  const body = JSON.stringify(payload);
  const presign = await post(app, "/presign", {
    participantId: pid,
    studyId: "internal",
    taskId,
    filename,
    contentType: "application/json",
  });
  const form = new FormData();
  for (const [key, value] of Object.entries(presign.fields)) form.append(key, String(value));
  form.append("file", new Blob([body], { type: "application/json" }), filename);
  const uploaded = await fetch(presign.url, { method: "POST", body: form });
  if (!uploaded.ok) throw new Error(`${app} S3 upload failed: ${uploaded.status}`);
  return { sourceKey: String(presign.key), payload };
}

function putS3Json(key, value) {
  const written = spawnSync(
    "aws",
    ["s3", "cp", "-", `s3://${BUCKET}/${key}`, "--content-type", "application/json", "--only-show-errors"],
    { input: JSON.stringify(value), encoding: "utf8" }
  );
  if (written.status !== 0) throw new Error(`Could not write disposable audit artifact: ${written.stderr || written.stdout}`);
}

function uploadCompletedAudit(app, payload) {
  const original = cleanTaskSnapshot(payload.task);
  const rubrics = cleanRubrics(null, original, null);
  const contentHash = reportingTaskContentHash(original, null, rubrics);
  const taskId = String(payload.task_id);
  const root = APPS[app].reviewRoot;
  const auditKey = `${root}/llm_pre_qc_pass/${b64url(taskId)}.${contentHash}.apollo-llm-feasibility-v22.json`;
  putS3Json(auditKey, {
    schema_version: "apollo-llm-feasibility-artifact-v11",
    pipeline_version: "apollo-llm-feasibility-v22",
    task_id: taskId,
    task_content_hash: contentHash,
    status: "LLM_PASS",
    passed: true,
    source: {
      rubrics: rubrics.map((rubric, index) => ({
        rubric_id: `rubric-${index + 1}`,
        criterion: rubric.final,
        critical: true,
      })),
    },
    rubric_reviews: rubrics.map((_, index) => ({
      rubric_id: `rubric-${index + 1}`,
      status: "COMPLETED",
      effective_verdict: "POSSIBLE",
      review: { verdict: "POSSIBLE", summary: "Disposable queue-isolation check completed." },
    })),
    manager_review: { disposition: "FEASIBLE", summary: "Disposable queue-isolation check completed." },
  });
  return auditKey;
}

function deleteS3(key) {
  if (!key) return;
  spawnSync("aws", ["s3api", "delete-object", "--bucket", BUCKET, "--key", key], { stdio: "ignore" });
}

function s3Exists(key) {
  if (!key) return false;
  return spawnSync("aws", ["s3api", "head-object", "--bucket", BUCKET, "--key", key], { stdio: "ignore" }).status === 0;
}

async function waitForQueueDelta(app, reviewerPid, baselinePending) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const status = await reviewStatus(app, reviewerPid);
    if (Number(status.pending) >= baselinePending + 1) return status;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${app}: disposable task did not become claimable within 15 seconds`);
}

async function validate(app) {
  const otherApp = app === "pc" ? "v2" : "pc";
  const stamp = Date.now().toString(36);
  const marker = `${stamp}-${app}`;
  const authorPid = `0000-e2e-${app}-${stamp}`.slice(0, 40).replace(/-$/, "0");
  const otherPid = `other-e2e-${app}-${stamp}`.slice(0, 40).replace(/-$/, "0");
  const baseline = await reviewStatus(app, otherPid);
  const otherBaseline = await reviewStatus(otherApp, otherPid);
  let sourceKey = "";
  let auditKey = "";
  try {
    const uploaded = await uploadReviewTask(app, authorPid, marker);
    sourceKey = uploaded.sourceKey;
    auditKey = uploadCompletedAudit(app, uploaded.payload);
    const expectedSegment = app === "pc"
      ? `/${authorPid}/pc/${authorPid}/internal/bundle-${marker}/`
      : `/${authorPid}/v2/${authorPid}/internal/task-${marker}/`;
    check(sourceKey.includes(expectedSegment), `${app}: upload uses its app-specific S3 folder`);

    const ready = await waitForQueueDelta(app, otherPid, Number(baseline.pending));
    check(Number(ready.pending) >= Number(baseline.pending) + 1, `${app}: its own ready queue increases`);
    const authorStatus = await reviewStatus(app, authorPid);
    check(Number(authorStatus.own_pending) >= 1, `${app}: author sees the task as own and excluded`);
    const isolated = await reviewStatus(otherApp, otherPid);
    check(Number(isolated.pending) === Number(otherBaseline.pending), `${app}: the other application's queue is unchanged`);
  } finally {
    const root = APPS[app].reviewRoot;
    if (sourceKey) {
      const inboxKey = `${root}/inbox/${b64url(sourceKey)}`;
      const lockKey = `${root}/locks/${b64url(sourceKey)}.json`;
      deleteS3(sourceKey);
      deleteS3(inboxKey);
      deleteS3(lockKey);
      deleteS3(auditKey);
      check(!s3Exists(sourceKey), `${app}: disposable submission removed`);
      check(!s3Exists(inboxKey), `${app}: disposable inbox marker removed`);
      check(!s3Exists(lockKey), `${app}: disposable review lock removed`);
      check(!s3Exists(auditKey), `${app}: disposable pre-QC artifact removed`);
    }
  }
  return sourceKey;
}

const v2SourceKey = await validate("v2");
// `/review/status` intentionally caches queue listings for 10 seconds. Let the
// V2 cleanup become the baseline before the PC phase compares V2 again; without
// this, the expected post-cleanup decrease is misreported as cross-app drift.
await new Promise((resolve) => setTimeout(resolve, 11_000));
const pcSourceKey = await validate("pc");
check(v2SourceKey !== pcSourceKey, "v2 and PC use distinct object keys");
check(v2SourceKey.includes("/v2/") && !v2SourceKey.includes("/pc/"), "v2 stays in the v2 namespace");
check(pcSourceKey.includes("/pc/") && !pcSourceKey.includes("/v2/"), "PC stays in the PC namespace");
console.log("Cross-app queue-isolation validation complete; disposable artifacts removed.");
