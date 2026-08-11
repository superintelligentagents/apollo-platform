// Production, non-destructive queue validation for Apollo v2 + Apollo PC.
// Creates one disposable review-safe task for each app, proves the author
// cannot claim it, proves a different participant can, releases every lock,
// then deletes all disposable S3 objects and markers.

import { spawnSync } from "node:child_process";
import {
  cleanRubrics,
  cleanTaskSnapshot,
  reportingTaskContentHash,
} from "../../backend/lambda_presign.js";

const ENDPOINT = process.env.E2E_REVIEW_ENDPOINT || "https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com";
const BUCKET = process.env.E2E_BUCKET || "journeys-prolific";
const REVIEW_KEY = process.env.E2E_REVIEW_KEY;
if (!REVIEW_KEY) throw new Error("E2E_REVIEW_KEY is required");

const b64url = (value) => Buffer.from(value).toString("base64url");
const check = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`✓ ${message}`);
};

async function post(path, body) {
  const response = await fetch(`${ENDPOINT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function uploadReviewTask(app, pid, marker) {
  const isPc = app === "pc";
  const taskId = isPc
    ? `pc/${pid}/internal/bundle-${marker}`
    : `v2/${pid}/internal/task-${marker}`;
  const filename = isPc ? `review_task_task-${marker}.json` : "long_task.json";
  const payload = {
    schema_version: "odyssey_long_task_v2",
    task_id: `${app}-${marker}`,
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
      task_title: `CROSS-APP-QUEUE-${app}-${marker}`,
      agent_request: "Verify that this disposable task is visible only to a different reviewer and release it without approving.",
      task_summary: null,
      difficulty: "high",
      site_scope: [],
      success_criteria: ["A different participant can claim this task."],
      must_visit_or_reach: [],
      required_outputs: [],
      notes: null,
      time_span: { start: null, end: null },
      steps: [{ order: 0, title: "Verify", description: "Claim as a different participant, then release the task." }],
    },
    provenance: { source_journeys: [], theme_suggestion: null, template: null, attached_urls: [] },
  };
  const body = JSON.stringify(payload);

  const presign = await post("/presign", {
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
  if (!uploaded.ok) throw new Error(`S3 upload failed: ${uploaded.status}`);
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

function uploadCompletedAudit(payload) {
  const original = cleanTaskSnapshot(payload.task);
  const rubrics = cleanRubrics(null, original, null);
  const contentHash = reportingTaskContentHash(original, null, rubrics);
  const taskId = String(payload.task_id);
  const auditKey = `v2-review/llm_pre_qc_pass/${b64url(taskId)}.${contentHash}.apollo-llm-feasibility-v19.json`;
  putS3Json(auditKey, {
    schema_version: "apollo-llm-feasibility-artifact-v10",
    pipeline_version: "apollo-llm-feasibility-v19",
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
      review: { verdict: "POSSIBLE", summary: "Disposable concurrency check completed." },
    })),
    manager_review: { disposition: "FEASIBLE", summary: "Disposable concurrency check completed." },
  });
  return auditKey;
}

async function release(claim) {
  if (!claim?.sub_key || !claim?.token) return;
  await post("/review/release", {
    reviewKey: REVIEW_KEY,
    sub_key: claim.sub_key,
    token: claim.token,
  }).catch(() => {});
}

function deleteS3(key) {
  if (!key) return;
  spawnSync("aws", ["s3api", "delete-object", "--bucket", BUCKET, "--key", key], { stdio: "ignore" });
}

function s3Exists(key) {
  if (!key) return false;
  return spawnSync("aws", ["s3api", "head-object", "--bucket", BUCKET, "--key", key], { stdio: "ignore" }).status === 0;
}

async function validate(app) {
  const stamp = Date.now().toString(36);
  const marker = `${stamp}-${app}`;
  // Lexically early participant id makes the disposable item the first
  // unlocked eligible task for the other-user claim.
  const authorPid = `0000-e2e-${app}-${stamp}`.slice(0, 40).replace(/-$/, "0");
  const otherPid = `other-e2e-${app}-${stamp}`.slice(0, 40).replace(/-$/, "0");
  const held = [];
  let sourceKey = "";
  let auditKey = "";
  try {
    const baseline = await post("/review/status", { reviewKey: REVIEW_KEY, reviewer_pid: otherPid });
    const uploaded = await uploadReviewTask(app, authorPid, marker);
    sourceKey = uploaded.sourceKey;
    auditKey = uploadCompletedAudit(uploaded.payload);
    const expectedSegment = app === "pc"
      ? `/${authorPid}/pc/${authorPid}/internal/bundle-${marker}/`
      : `/${authorPid}/v2/${authorPid}/internal/task-${marker}/`;
    check(sourceKey.includes(expectedSegment), `${app}: submission uses its unique app-specific S3 folder`);

    const authorStatus = await post("/review/status", { reviewKey: REVIEW_KEY, reviewer_pid: authorPid });
    check(Number(authorStatus.own_pending) >= 1, `${app}: author sees the task counted as own, not claimable`);

    const selfClaim = await post("/review/claim", {
      reviewKey: REVIEW_KEY,
      reviewer: `e2e-self-${app}-${stamp}`,
      reviewer_pid: authorPid,
    });
    check(selfClaim.sub_key !== sourceKey, `${app}: server never returns the author's own task`);
    if (selfClaim.sub_key) held.push(selfClaim);
    const otherStatus = await post("/review/status", { reviewKey: REVIEW_KEY, reviewer_pid: otherPid });
    check(Number(otherStatus.pending) >= Number(baseline.pending) + 1, `${app}: completed audit adds the task to another participant's ready queue`);
  } finally {
    await Promise.allSettled(held.map(release));
    // Clean only artifacts created by this run. Locks are deleted as a
    // fallback if the release request itself was interrupted.
    for (const claim of held) deleteS3(`v2-review/locks/${b64url(claim.sub_key)}.json`);
    if (sourceKey) {
      const inboxKey = `v2-review/inbox/${b64url(sourceKey)}`;
      const lockKey = `v2-review/locks/${b64url(sourceKey)}.json`;
      deleteS3(sourceKey);
      deleteS3(inboxKey);
      deleteS3(lockKey);
      deleteS3(auditKey);
      check(!s3Exists(sourceKey), `${app}: disposable submission file removed from S3`);
      check(!s3Exists(inboxKey), `${app}: disposable inbox marker removed from S3`);
      check(!s3Exists(lockKey), `${app}: disposable review lock removed from S3`);
      check(!s3Exists(auditKey), `${app}: disposable live-audit artifact removed from S3`);
    }
  }
  return sourceKey;
}

const v2SourceKey = await validate("v2");
const pcSourceKey = await validate("pc");
check(v2SourceKey !== pcSourceKey, "v2 and PC submissions have distinct S3 object keys");
check(v2SourceKey.includes("/v2/") && !v2SourceKey.includes("/pc/"), "v2 submission stays in the v2 namespace");
check(pcSourceKey.includes("/pc/") && !pcSourceKey.includes("/v2/"), "PC submission stays in the PC namespace");

const raceStamp = Date.now().toString(36);
const raceArtifacts = [];
for (const [app, suffix] of [["v2", "a"], ["pc", "b"]]) {
  const marker = `${raceStamp}-race-${suffix}`;
  const authorPid = `0000-e2e-race-${suffix}-${raceStamp}`.slice(0, 40).replace(/-$/, "0");
  const uploaded = await uploadReviewTask(app, authorPid, marker);
  raceArtifacts.push({
    sourceKey: uploaded.sourceKey,
    auditKey: uploadCompletedAudit(uploaded.payload),
  });
}

const raceReviewers = [
  { reviewer: `e2e-race-a-${raceStamp}`, reviewer_pid: `e2e-race-a-${raceStamp}` },
  { reviewer: `e2e-race-b-${raceStamp}`, reviewer_pid: `e2e-race-b-${raceStamp}` },
];
let raceClaims = [];
try {
  let raceReady = false;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const status = await post("/review/status", { reviewKey: REVIEW_KEY, reviewer_pid: raceReviewers[0].reviewer_pid });
    if (Number(status.pending) >= 2) {
      raceReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  check(raceReady, "two audited disposable tasks become claimable");

  raceClaims = await Promise.all(raceReviewers.map((reviewer) => post("/review/claim", {
    reviewKey: REVIEW_KEY,
    ...reviewer,
  })));
  check(Boolean(raceClaims[0].sub_key && raceClaims[1].sub_key), "two reviewers can claim concurrently");
  check(raceClaims[0].sub_key !== raceClaims[1].sub_key, "concurrent reviewers never receive the same task");
} finally {
  await Promise.allSettled(raceClaims.map(release));
  for (const artifact of raceArtifacts) {
    deleteS3(artifact.sourceKey);
    deleteS3(`v2-review/inbox/${b64url(artifact.sourceKey)}`);
    deleteS3(`v2-review/locks/${b64url(artifact.sourceKey)}.json`);
    deleteS3(artifact.auditKey);
  }
}
console.log("Cross-app review queue validation complete; disposable artifacts removed.");
