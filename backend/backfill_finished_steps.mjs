import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const APPLY = process.argv.includes("--apply");
const BUCKET = process.env.S3_BUCKET || "journeys-prolific";
const UPLOAD_PREFIX = process.env.UPLOAD_PREFIX || "prolific/journeys/";
const REVIEW_PREFIX = process.env.REVIEW_PREFIX || "v2-review/";
const MIGRATION = "2026-08-06-finished-steps";
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

async function list(prefix) {
  const objects = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    objects.push(...(page.Contents ?? []));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

async function read(key) {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const text = await response.Body.transformToString();
  return { json: JSON.parse(text), text, etag: response.ETag };
}

function reviewedCriteria(finished) {
  const rows = Array.isArray(finished.review?.rubrics) ? finished.review.rubrics : [];
  return new Set(rows.flatMap((row) => [row?.original, row?.text, row?.final]).filter(Boolean));
}

function snapshot(task) {
  return {
    task_title: task.task_title,
    agent_request: task.agent_request,
    difficulty: task.difficulty,
    success_criteria: Array.isArray(task.success_criteria) ? task.success_criteria : [],
    steps: Array.isArray(task.steps) ? task.steps : [],
  };
}

async function sourceFor(taskId) {
  const [, participantId] = String(taskId).split("/");
  if (!participantId || !String(taskId).startsWith("v2/")) return null;
  const objects = (await list(`${UPLOAD_PREFIX}${participantId}/${taskId}/`))
    .filter((object) => object.Key?.endsWith("long_task.json"))
    .sort((a, b) => String(b.Key).localeCompare(String(a.Key)));
  return objects[0]?.Key ? read(objects[0].Key) : null;
}

const finishedObjects = await list(`${REVIEW_PREFIX}finished/`);
const results = [];
for (const object of finishedObjects) {
  const key = object.Key;
  if (!key?.endsWith(".json")) continue;
  const finishedRecord = await read(key);
  const finished = finishedRecord.json;
  if (Array.isArray(finished.task?.steps) && finished.task.steps.length) continue;
  const sourceRecord = await sourceFor(finished.task_id);
  const sourceTask = sourceRecord?.json?.task;
  const sourceSteps = Array.isArray(sourceTask?.steps) ? sourceTask.steps : [];
  if (!sourceSteps.length) continue;

  const sourceCriteria = Array.isArray(sourceTask.success_criteria) ? sourceTask.success_criteria : [];
  const retainedCriteria = reviewedCriteria(finished);
  let selectedSteps = sourceSteps;
  if (sourceCriteria.length === sourceSteps.length && retainedCriteria.size) {
    selectedSteps = sourceSteps.filter((_, index) => retainedCriteria.has(sourceCriteria[index]));
  }
  if (!selectedSteps.length) {
    results.push({ key, task_id: finished.task_id, status: "skipped", reason: "review removed every mapped step" });
    continue;
  }

  const updated = structuredClone(finished);
  updated.task.steps = selectedSteps;
  updated.review ??= {};
  updated.review.original ??= snapshot(sourceTask);
  updated.review.final ??= snapshot(updated.task);
  updated.review.final.steps = selectedSteps;
  updated.review.steps_recovered = {
    migration: MIGRATION,
    recovered_at: new Date().toISOString(),
    source_step_count: sourceSteps.length,
    final_step_count: selectedSteps.length,
    preserved_reviewer_removals: sourceSteps.length - selectedSteps.length,
  };

  if (APPLY) {
    const backupKey = `${REVIEW_PREFIX}migration-backups/${MIGRATION}/${key.slice(`${REVIEW_PREFIX}finished/`.length)}`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: backupKey,
      Body: finishedRecord.text,
      ContentType: "application/json",
      IfNoneMatch: "*",
    }));
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(updated, null, 2),
      ContentType: "application/json",
      IfMatch: finishedRecord.etag,
    }));
  }
  results.push({
    key,
    task_id: finished.task_id,
    status: APPLY ? "updated" : "would-update",
    source_steps: sourceSteps.length,
    final_steps: selectedSteps.length,
    preserved_reviewer_removals: sourceSteps.length - selectedSteps.length,
  });
}

console.log(JSON.stringify({ apply: APPLY, scanned: finishedObjects.length, results }, null, 2));
