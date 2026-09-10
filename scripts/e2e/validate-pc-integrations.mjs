// Synthetic PC S3/admin/grading smoke test. Never claims a real participant's run.
// Every object created here is tracked and removed, including failure paths.
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareContext } from '../osworld_runner/prepare_pc_context.mjs';
const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');
const key = process.env.E2E_PC_REVIEW_KEY;
if (!key) throw new Error('E2E_PC_REVIEW_KEY required');
const endpoint = process.env.E2E_PC_REVIEW_ENDPOINT || 'https://t1ynh195m1.execute-api.us-east-1.amazonaws.com';
const bucket = process.env.E2E_BUCKET || 'journeys-prolific';
const dashboardTable = process.env.E2E_DASHBOARD_TABLE || 'apollo-dashboard-index';
const admin = process.env.E2E_ADMIN_EMAIL;
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const stamp = randomUUID().slice(0, 12), pid = `e2e-pc-${stamp}`;
const bundleId = `pc/${pid}/internal/bundle-${stamp}`;
const taskId = bundleId;
const localTaskId = `fixture-${stamp}`;
const authoredTaskId = `pc_${localTaskId}`;
const b64 = s => Buffer.from(s).toString('base64url');
const cleanup = new Set();
const check = (ok, label) => { if (!ok) throw new Error(`FAIL: ${label}`); console.log(`✓ ${label}`); };
async function post(path, body, expected = 200) {
  const res = await fetch(endpoint + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewKey: key, ...body }) });
  const value = await res.json();
  if (res.status !== expected) throw new Error(`${path}: expected ${expected}, got ${res.status}: ${JSON.stringify(value)}`);
  return value;
}
async function put(path, body, contentType = 'application/json') {
  cleanup.add(path);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: path, Body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), ContentType: contentType, IfNoneMatch: '*' }));
}
async function read(path) { const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: path })); return JSON.parse(await res.Body.transformToString()); }
async function upload(filename, value) {
  const presign = await post('/presign', { participantId: pid, studyId: 'internal', taskId, filename, contentType: 'application/json' });
  cleanup.add(presign.key);
  if (filename === 'manifest.json') cleanup.add(`pc-review/pc-bundles/${b64(presign.key)}`);
  if (filename.startsWith('review_task_')) cleanup.add(`pc-review/inbox/${b64(presign.key)}`);
  check(presign.key.startsWith(`prolific/journeys/${pid}/pc/`), `${filename}: scoped upload destination`);
  const form = new FormData(); for (const [name, value] of Object.entries(presign.fields)) form.append(name, String(value));
  form.append('file', new Blob([JSON.stringify(value)], { type: 'application/json' }), filename);
  const res = await fetch(presign.url, { method: 'POST', body: form });
  check(res.ok, `${filename}: signed S3 upload`);
  if (filename === 'manifest.json' || filename.startsWith('review_task_')) check(Boolean(presign.completion?.token), `${filename}: completion token returned`);
  if (presign.completion?.token) {
    const completed = await post('/upload/complete', {
      key: presign.key,
      token: presign.completion.token,
      expires_at: presign.completion.expires_at,
    });
    const expectedKind = filename === 'manifest.json' ? 'manifest' : 'review_task';
    check(completed.ok && completed.kind === expectedKind, `${filename}: upload completion indexed`);
  }
  return presign.key;
}
try {
  await post('/review/my-tasks', { reviewKey: 'invalid-fixture-key', participant_id: pid }, 401);
  await post('/presign', { participantId: pid, studyId: "internal", taskId: `v2/${pid}/internal/task-fixture123`, filename: 'long_task.json', contentType: 'application/json' }, 400);
  console.log('✓ PC rejects invalid review credentials and v2 uploads');
  const records = [{ record: { id: 'email-fixture', source: 'email', subject: 'Synthetic reservation', body_text: 'A fictional reservation for integration testing.', from: { name: 'Person A', email: 'person@example.test' }, to: [], date: '2026-09-08T12:00:00Z' } }];
  const recordPart = { schema_version: 'odyssey_personal_context_v1', bundle_id: bundleId, kind: 'email', part: 1, records };
  const recordKey = await upload('records_email.json', recordPart);
  check((await read(recordKey)).records[0].record.subject === 'Synthetic reservation', 'uploaded record bytes round-trip');
  const documents = [{ record: { id: 'document-fixture', source: 'documents', filename: 'resume.txt', title: 'Synthetic resume', mime_type: 'text/plain', size: 58, text: 'Synthetic candidate experience for integration testing.', page_count: null, timestamp: '2026-09-08T12:00:00Z' } }];
  const documentPart = { schema_version: 'odyssey_personal_context_v1', bundle_id: bundleId, kind: 'documents', part: 1, records: documents };
  const documentKey = await upload('records_documents.json', documentPart);
  check((await read(documentKey)).records[0].record.title === 'Synthetic resume', 'uploaded document text round-trips');
  const contextTask = { task_id: localTaskId, category: 'personal_lookup', task_title: 'Synthetic PC task', agent_request: 'Use the supplied synthetic reservation and resume to make a short plan.', difficulty: 'low', steps: [{ order: 1, title: 'Plan', description: 'Use the supplied reservation and resume.' }], success_criteria: ['The plan uses both supplied records.'], required_outputs: ['Short plan'], required_sources: ['email', 'documents'], referenced_record_ids: ['email-fixture', 'document-fixture'], expected_answer: 'Synthetic answer', notes: null };
  await upload('manifest.json', { schema_version: 'odyssey_personal_context_v1', bundle_id: bundleId, created_at: new Date().toISOString(), participant: { participant_id: pid, name: 'Synthetic fixture', email: 'fixture@example.test' }, parts: [{ kind: 'email', filename: 'records_email.json', record_count: 1, sha256: createHash('sha256').update(JSON.stringify(recordPart)).digest('hex') }, { kind: 'documents', filename: 'records_documents.json', record_count: 1, sha256: createHash('sha256').update(JSON.stringify(documentPart)).digest('hex') }], tasks: [contextTask], redaction: { items_edited: 0, auto_masks_applied: {} }, privacy_audit: { status: 'pass', blocking_findings: 0 } });
  await upload(`review_task_${localTaskId}.json`, {
    schema_version: 'odyssey_long_task_v2',
    task_id: authoredTaskId,
    mode: 'guided',
    created_at: new Date().toISOString(),
    participant: { participant_id: 'redacted', name: null, email: null },
    task: { task_title: contextTask.task_title, agent_request: contextTask.agent_request, difficulty: contextTask.difficulty, success_criteria: contextTask.success_criteria, required_outputs: contextTask.required_outputs, steps: contextTask.steps },
    provenance: { source_journeys: [], theme_suggestion: null, template: null, attached_urls: [] },
  });
  const contributions = await post('/review/contributions', { participantId: pid, reviewer: 'Synthetic fixture' });
  check(contributions.submitted === 1, 'completed task sidecar appears in contribution metrics');
  const contextDir = await mkdtemp(join(tmpdir(), 'apollo-pc-context-e2e-'));
  try {
    const prepared = await prepareContext({ taskId: authoredTaskId, creatorPid: pid, bucket, prefix: 'prolific/journeys/', region: process.env.AWS_REGION || 'us-east-1', outputDir: contextDir }, s3);
    const contextConfig = JSON.parse(await readFile(prepared.output, 'utf8'));
    check(prepared.record_count === 2 && contextConfig.record_count === 2, 'context provisioner selects only task-referenced email and document records');
    check(contextConfig.start_urls?.[0]?.startsWith('file:///tmp/apollo-pc-context-'), 'context provisioner creates an isolated VM page');
  } finally {
    await rm(contextDir, { recursive: true, force: true });
  }
  await post('/review/pc-admin', { admin_email: 'not-admin@example.test' }, 403);
  if (admin) {
    const summary = await post('/review/pc-admin', { admin_email: admin });
    check(summary.bundles.some(b => b.bundle_id === bundleId && b.email_count === 1 && b.document_count === 1), 'admin indexes uploaded email and document records');
    const detail = await post('/review/pc-admin', { admin_email: admin, action: 'detail', bundle_id: bundleId, kind: 'email' });
    check(detail.items[0].record.id === 'email-fixture', 'admin retrieves fixture record');
    cleanup.add(`pc-review/pc-edits/${b64(bundleId)}/email/${b64('email-fixture')}.json`);
    const save = await post('/review/pc-admin', { admin_email: admin, action: 'save', bundle_id: bundleId, kind: 'email', item_id: 'email-fixture', final_record: { ...records[0].record, subject: 'Reviewed synthetic reservation' }, base_revision_count: 0 });
    check(save.revision_count === 1, 'admin edits preserve revision count');
    check((await read(recordKey)).records[0].record.subject === 'Synthetic reservation', 'admin edits preserve original S3 upload');
    await post('/review/pc-admin', { admin_email: admin, action: 'save', bundle_id: bundleId, kind: 'email', item_id: 'email-fixture', final_record: records[0].record, base_revision_count: 0 }, 409);
    console.log('✓ admin rejects stale concurrent edits');
    const documentDetail = await post('/review/pc-admin', { admin_email: admin, action: 'detail', bundle_id: bundleId, kind: 'documents' });
    check(documentDetail.items[0].record.id === 'document-fixture', 'admin retrieves uploaded document text');
    cleanup.add(`pc-review/pc-edits/${b64(bundleId)}/documents/${b64('document-fixture')}.json`);
    const documentSave = await post('/review/pc-admin', { admin_email: admin, action: 'save', bundle_id: bundleId, kind: 'documents', item_id: 'document-fixture', final_record: { ...documents[0].record, title: 'Reviewed synthetic resume', text: 'Reviewed synthetic experience.', filename: 'must-not-change.txt' }, base_revision_count: 0 });
    check(documentSave.revision_count === 1, 'admin saves a document revision');
    const editedDocument = await post('/review/pc-admin', { admin_email: admin, action: 'detail', bundle_id: bundleId, kind: 'documents' });
    check(editedDocument.items[0].record.title === 'Reviewed synthetic resume' && editedDocument.items[0].record.filename === 'resume.txt', 'admin can edit document text while immutable metadata stays fixed');
    check((await read(documentKey)).records[0].record.title === 'Synthetic resume', 'document admin edits preserve original S3 upload');
    const taskDetail = await post('/review/admin', { admin_email: admin, action: 'detail', task_id: authoredTaskId });
    check(/^pc-[a-f0-9]{16}$/.test(taskDetail.item?.participant_id || ''), 'admin task detail uses a stable private annotator ID');
  } else console.log('SKIP admin read/edit: E2E_ADMIN_EMAIL not configured');
  const manifestKey = `pc-review/trajectory-runs/${b64(taskId)}/run-${stamp}/manifest.json`;
  const shotKey = manifestKey.replace('manifest.json', 'screen.png');
  await put(shotKey, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=', 'base64'), 'image/png');
  await put(manifestKey, { schema_version: 'apollo-trajectory-review-package-v1', run_id: `run-${stamp}`, task_id: taskId, creator_pid: pid, task_prompt: 'Inspect the synthetic reservation.', source: {}, rubrics: [{ rubric_id: 'R1', requirement: 'Reservation is visible.', verification: 'Inspect the record.', llm_status: 'FAILURE', llm_reasoning: 'MUST_NOT_REACH_GRADER' }], steps: [{ step_number: 1, action: 'Inspect fixture', response: 'Done', final: true, screenshot_path: 'screen.png' }] });
  await put(`pc-review/trajectory-inbox/${pid}/${b64(manifestKey)}`, manifestKey, 'text/plain');
  for (const path of [`trajectory-locks/${b64(manifestKey)}.json`, `trajectory-done/${b64(manifestKey)}`, `trajectory-judgments/${b64(manifestKey)}.json`]) cleanup.add('pc-review/' + path);
  const status = await post('/trajectory/status', { reviewer_pid: pid });
  check(status.claimable === 1, 'synthetic run is assigned only to its creator');
  const claim = await post('/trajectory/claim', { reviewer_pid: pid, reviewer: 'Synthetic fixture' });
  check(claim.manifest_key === manifestKey, 'creator claims exact synthetic run');
  check(!JSON.stringify(claim.run).includes('MUST_NOT_REACH_GRADER'), 'LLM judgment is hidden from graders');
  check((await fetch(claim.run.steps[0].screenshot_url)).ok, 'signed screenshot URL is readable');
  await post('/trajectory/release', { manifest_key: manifestKey, token: 'invalid' }, 409);
  await post('/trajectory/release', { manifest_key: manifestKey, token: claim.token });
  const again = await post('/trajectory/claim', { reviewer_pid: pid, reviewer: 'Synthetic fixture' });
  const body = { reviewer_pid: pid, reviewer: 'Synthetic fixture', manifest_key: manifestKey, token: again.token, judgment: { rubrics: [{ rubric_id: 'R1', human_verdict: 'SUCCESS', notes: 'Synthetic fixture verified.' }], trajectory: { overall_outcome: 'YES', notes: '' } } };
  await post('/trajectory/submit', { ...body, reviewer_pid: 'unassigned-fixture' }, 403);
  const result = await post('/trajectory/submit', body);
  check(result.overall_outcome === 'YES', 'human grade is stored');
  check((await post('/trajectory/submit', body)).idempotent === true, 'grade retry is idempotent');
  check((await read(result.judgment_key)).rubrics[0].human_verdict === 'SUCCESS', 'durable S3 judgment matches submitted verdict');
} finally {
  const failures=[];
  for (const path of [...cleanup].reverse()) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: path }));
      try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: path })); failures.push(path); }
      catch (error) { if (error.$metadata?.httpStatusCode !== 404) throw error; }
    } catch { failures.push(path); }
  }
  try {
    await dynamo.send(new DeleteItemCommand({ TableName: dashboardTable, Key: { scope: { S: 'pc' }, entity_key: { S: `TASK#${authoredTaskId}` } } }));
  } catch {
    failures.push(`dynamodb:${authoredTaskId}`);
  }
  if (failures.length) throw new Error(`Cleanup failed for fixture objects: ${failures.join(', ')}`);
  console.log(`✓ Removed and verified absence of ${cleanup.size} synthetic objects`);
}
