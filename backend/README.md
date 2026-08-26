# Apollo upload and review API

`lambda_presign.js` is the reviewed source deployed to two production Lambdas. It issues encrypted S3 presigned POSTs and implements task review, trajectory review, administration, and read-only reporting. `server.js` is the smaller local Express adapter for upload development.

## Production deployments

| App | Lambda | API base | `APP_SCOPE` | `REVIEW_PREFIX` | IAM role |
|---|---|---|---|---|---|
| V2/legacy | `journeys-presign` | `https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com` | `primary` | `v2-review/` | `journeys-presign-role` |
| PC | `journeys-pc-presign` | `https://t1ynh195m1.execute-api.us-east-1.amazonaws.com` | `pc` | `pc-review/` | `journeys-pc-presign-role` |

The source zip must be identical, but configuration and roles must remain separate. `primary` accepts legacy and valid `v2/*` uploads and rejects `pc/*`; `pc` accepts only valid `pc/*` uploads. IAM adds a second boundary: the V2 role explicitly denies PC objects, while the PC role can access only PC uploads and `pc-review/*`.

Policy documents are versioned in [`iam/`](iam/). See [`../docs/APOLLO_PLATFORM_README.md`](../docs/APOLLO_PLATFORM_README.md) for the deployment and production-validation checklist.

## Local setup

```bash
cd backend
cp .env.example .env
npm install
npm start
```

Important variables:

- `S3_BUCKET`, `UPLOAD_PREFIX`, `MAX_FILE_BYTES`, `AWS_REGION`
- `ALLOWED_ORIGIN` — comma-separated allowed origins
- `APP_SCOPE` — use `primary`, `v2`, or `pc`; never use an unrestricted value in production
- `REVIEW_PREFIX` — `v2-review/` or `pc-review/`, matching the app scope
- `REVIEW_KEY` — browser review API credential
- `REPORTING_KEY` / `REPORTING_KEYS` — server-side read-only reporting credentials; never place these in a browser bundle
- `ADMIN_EMAILS` — normalized allowlist for the admin view
- `DASHBOARD_TABLE` — optional additive DynamoDB dashboard index. S3 remains
  authoritative and the API automatically falls back to it when the table is
  disabled, unready, or unavailable.

## Dashboard index

The team dashboard uses an encrypted, on-demand DynamoDB index so list and
filter requests do not hydrate every task body from S3. The index contains
only compact task metadata and S3 object keys; full task prompts and rubrics
are still read from their exact immutable S3 objects when an admin opens a
row. V2 and PC use separate partition keys and IAM `LeadingKeys` conditions.

Create the table from `iam/dashboard-index-table.json`, enable point-in-time
recovery, and attach the matching partition policy in `iam/` to each Lambda
role. Backfill is read-only with respect to S3 and defaults to a plan:

```bash
node backfill_dashboard_index.mjs --scope v2 --table apollo-dashboard-index
node backfill_dashboard_index.mjs --scope v2 --table apollo-dashboard-index --write
node backfill_dashboard_index.mjs --scope pc --table apollo-dashboard-index --write
node backfill_dashboard_audit_index.mjs --scope v2 --table apollo-dashboard-index
node backfill_dashboard_audit_index.mjs --scope v2 --table apollo-dashboard-index --write
```

The script refuses duplicate task IDs, verifies key fields after writing, and
writes the `META.ready` marker last. Do not set `DASHBOARD_TABLE` on a Lambda
until parity verification passes. New V2 uploads register only after S3 has
accepted the task; dashboard refreshes also reconcile missing/newer inbox
markers without rewriting source objects.

The audit backfill stores only the current task content hash and the identity,
status, and completeness of its immutable PRE_QC artifact. It reads and
validates the artifact before marking a task claimable and reports zero S3
writes. `/review/status` and `/review/claim` reconcile newly published audit
artifacts into the same scope-isolated index; a missing, stale, incomplete, or
`PIPELINE_ERROR` artifact still cannot unlock human review. Any index error
falls back to the complete S3 validation path.

Use separate local processes with different ports if V2 and PC must be exercised simultaneously; one process has one scope and one review prefix.

## Presign endpoint

`POST /presign`

```json
{
  "participantId": "alice",
  "studyId": "internal",
  "taskId": "v2/alice/internal/task-example123",
  "filename": "long_task.json",
  "contentType": "application/json"
}
```

The response contains `url`, multipart `fields`, and the exact S3 `key`. Clients must include every returned field and the file in a multipart POST. Production presigns require S3 server-side encryption (`AES256`).

PC uses `pc/{participant}/internal/bundle-{id}` task IDs and a strict filename allowlist. Only privacy-safe `review_task_*.json` sidecars create PC task-review markers; bundle manifests and records never enter the human task queue.

## Other routes

- Explicit POST task-review routes live under `/review/*`.
- Explicit POST trajectory-review routes live under `/trajectory/*`.
- Bearer-authenticated read-only reporting lives at `GET /reporting/tasks` and `GET /reporting/trajectories`; see [`REPORTING_API.md`](REPORTING_API.md).
- Unknown routes and non-supported methods are rejected.

## Tests

```bash
npm test
```

The suite covers scope isolation, self-review exclusion, queue admission, concurrent claims, idempotent finalization, immutable edits, PII-safe PC indexing, reporting, and trajectory judgment normalization.

## Historical rejection appeals

Rejections created before reviewer PID attribution cannot be appealed safely: the queue cannot prove that the second review goes to a different person. Plan the conditional V2 backfill first, then write only uniquely resolved mappings (optionally supplying a reviewed, ignored override file):

```bash
node backfill_rejected_reviewer_pids.mjs
node backfill_rejected_reviewer_pids.mjs --write
node backfill_rejected_reviewer_pids.mjs --write --overrides /path/to/reviewer-pid-overrides.json
```

The script backs up each original rejection under `v2-review/migration-backups/rejected-reviewer-pids/`, never overwrites an existing PID, writes under the source ETag, and re-reads every changed object. Unmatched or ambiguous reviewers remain unmodified and non-appealable.

## Author-approved final tasks

Every new author acceptance or amendment writes a self-contained final task to `v2-review/author-approved/{task_id}.json` in addition to its compact sign-off receipt. Backfill existing sign-offs with a dry run first:

```bash
node backfill_author_approved_finals.mjs
node backfill_author_approved_finals.mjs --write
```

The backfill requires the receipt hash to match current final gold, uses conditional S3 writes, and verifies every stored object.

## Author-loop dashboard metrics

The admin dashboard includes a dedicated Author QC round summary: approved
tasks still awaiting the author, accepted unchanged, edited and finalized by
the author, completion rate, and the accepted/amended/waiting split among
approvals the human reviewer changed. The admin-only Author quality tab also
reports those fields per author alongside final approval rate (approved divided
by approved plus rejected), appealed tasks, terminal second rejections, and
non-appeal author requeues. Trainer-facing dashboards do not expose this
rollup.

An appeal rejected by its fresh second reviewer writes its immutable terminal
outcome under `v2-review/rejected-twice/` plus the appeal revision's normal
`v2-review/done/` marker. The author sees the final feedback but receives no
further appeal action. Re-run the V2 dashboard index backfill after deploying
these fields so historical appeal lineage is reflected in DynamoDB.
