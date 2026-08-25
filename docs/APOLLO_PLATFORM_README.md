# Apollo platform operations

This is the shortest path to developing, testing, deploying, and operating Apollo V2 and Apollo PC. The two apps share reviewed backend source but have separate production APIs, IAM roles, upload scopes, and review queues.

## Production map

| App | Site | Lambda | API base | Upload scope | Review root |
|---|---|---|---|---|---|
| V2 | https://apollo-v2-site.vercel.app | `journeys-presign` | `https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com` | `APP_SCOPE=primary` (legacy + V2; rejects PC) | `v2-review/` |
| PC | https://apollo-pc-site.vercel.app | `journeys-pc-presign` | `https://t1ynh195m1.execute-api.us-east-1.amazonaws.com` | `APP_SCOPE=pc` | `pc-review/` |

Both use bucket `journeys-prolific` in `us-east-1` and handler `lambda_presign.handler`.

The IAM roles are intentionally separate:

- `journeys-presign-role` can access legacy/V2 uploads and `v2-review/*`; it explicitly denies PC upload objects.
- `journeys-pc-presign-role` can access only `prolific/journeys/*/pc/*` and `pc-review/*`.

Versioned policy documents live in [`../backend/iam/`](../backend/iam/). Do not merge the roles or point either frontend at the other API.

## Install and test

Use Node 20+ and Python 3.11+.

```bash
npm install --prefix backend
npm install --prefix apollo-v2
npm install --prefix apollo-pc

npm test --prefix backend

npm run typecheck --prefix apollo-v2
npm test --prefix apollo-v2
npm run build:web --prefix apollo-v2

npm run typecheck --prefix apollo-pc
npm test --prefix apollo-pc
npm run build:web --prefix apollo-pc

python3 -m unittest discover -s scripts/llm_feasibility -p 'test_*.py'
python3 -m unittest discover -s scripts/trajectory_review -p 'test_*.py'
```

## Local web development

Start the local backend once:

```bash
cp backend/.env.example backend/.env
# Fill local AWS/config values. Keep APP_SCOPE=primary for V2 or set it to pc for a PC-only backend.
npm start --prefix backend
```

Then run one client:

```bash
VITE_PRESIGN_ENDPOINT=http://localhost:4000/presign npm run dev:web --prefix apollo-v2
VITE_PRESIGN_ENDPOINT=http://localhost:4000/presign npm run dev:web --prefix apollo-pc
```

V2 listens on port 5180; PC listens on 5181. Do not put reporting credentials or AWS credentials into a `VITE_*` variable because Vite embeds those values in the browser bundle.

## Queue operations

Task pre-QC must use the matching reporting API and queue:

```bash
# V2
python3 scripts/llm_feasibility/run.py \
  --api-url 'https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/reporting/tasks?status=pending&include=content,llm_reviews&limit=1&offset=0' \
  --s3-bucket journeys-prolific \
  --queue v2 --pre-qc --task-workers 4 --workers 6

# PC
python3 scripts/llm_feasibility/run.py \
  --api-url 'https://t1ynh195m1.execute-api.us-east-1.amazonaws.com/reporting/tasks?status=pending&include=content,llm_reviews&limit=1&offset=0' \
  --s3-bucket journeys-prolific \
  --queue pc --pre-qc --task-workers 4 --workers 6
```

Supply `APOLLO_REPORTING_TOKEN` from the private secret store. The runner rejects PC task IDs in the V2 queue and non-PC task IDs in the PC queue before any model or AWS write.

Publish trajectory runs the same way:

```bash
# Use --queue v2 for V2 or --queue pc for PC.
python3 scripts/trajectory_review/run.py \
  --runs-dir /path/to/runs \
  --task-source-json /path/to/tasks.json \
  --model gemini-3.1-flash-lite-preview \
  --queue pc --plan --prod

python3 scripts/trajectory_review/run.py \
  --runs-dir /path/to/runs \
  --task-source-json /path/to/tasks.json \
  --model gemini-3.1-flash-lite-preview \
  --queue pc --num-workers 8 --prod
```

`--plan --prod` validates assignments and AWS access without model calls or writes. The publisher rejects cross-queue task IDs before upload.

## Deploy the backend

`backend/lambda_presign.js` is the source of truth for both Lambdas. The checked-in `backend/lambda_presign.zip` is historical and must not be deployed directly.

1. Run backend and worker tests.
2. Download the current live Lambda package with `aws lambda get-function`.
3. Replace only `lambda_presign.js` in that package and re-zip it.
4. Update `journeys-presign`, wait for success, then update `journeys-pc-presign` with the identical zip.
5. Verify both functions have the same `CodeSha256` but different roles, `APP_SCOPE`, and `REVIEW_PREFIX` values.
6. Verify `/presign` rejects a valid PC-shaped request on the V2 API and rejects a valid V2-shaped request on the PC API.
7. Run `scripts/e2e/validate-cross-app-review.mjs`; it adds disposable audited tasks, proves only the intended queue changes, and removes every created object.

The admin dashboard can additionally use `apollo-dashboard-index`. It is an
additive cache, not a migration: S3 remains the source of truth and detail
requests read the exact existing S3 source/final objects. Create it with
`backend/iam/dashboard-index-table.json`, enable point-in-time recovery, attach
the scope-specific IAM policies, run `backend/backfill_dashboard_index.mjs`
for both scopes, and set `DASHBOARD_TABLE` only after the backfill reports zero
mismatches. The API falls back to the S3 dashboard reader if the table is
missing, not marked ready, or cannot be read.

For V2 human-QC admission, run
`backend/backfill_dashboard_audit_index.mjs --scope v2 --write` after the task
index backfill. It validates current PRE_QC artifacts and adds only their
content-addressed readiness state to DynamoDB. New artifacts are reconciled by
the API, while missing, stale, partial, and pipeline-error results remain
unclaimable. This optimization never writes task, final-gold, queue, or audit
objects in S3.

The local Express adapter in `backend/server.js` mirrors upload validation but is not the production review service.

## Deploy a web client

Apollo V2 uses Vercel's native Git integration. The `apollo-v2-site` project is
connected to `superintelligentagents/apollo-platform`; its production branch is
`main`, root directory is `apollo-v2`, install command is `npm ci`, build command
is `npm run build:web`, and output directory is `web/dist`. `VITE_REVIEW_KEY` is
stored only in Vercel's Production and Preview environments. A merge to `main`
therefore builds and deploys the checked-in V2 source without committing a key.

Pull requests run `.github/workflows/apollo-v2-ci.yml` before merge. The job
typechecks, tests, and performs a production-shaped Vite build with a non-secret
placeholder key; Vercel injects the real production value only during deploy.

For an emergency manual fallback, build locally and deploy the generated static
files with Vercel's Build Output API:

```bash
# Example: PC (Apollo V2 also provides web/deploy_prod.sh)
npm run build:web --prefix apollo-pc
deploy_root=$(mktemp -d)
mkdir -p "$deploy_root/.vercel/output/static"
cp -R apollo-pc/web/dist/. "$deploy_root/.vercel/output/static/"
printf '{\n  "version": 3\n}\n' > "$deploy_root/.vercel/output/config.json"
cd "$deploy_root"
npx vercel link --yes --project apollo-pc-site
npx vercel deploy --prebuilt --prod
```

V2 builds must use the V2 presign endpoint/review key. PC builds must use the PC presign endpoint/review key. After deployment, inspect the built asset or browser network calls to ensure only the intended API hostname is present.

## Safe production validation

- Prefer status/reporting reads and synthetic/disposable records.
- Never approve or reject an unknown queue item during a test.
- Never upload real participant exports through an automated test.
- If a test creates S3 objects, record their exact keys and delete only those exact keys in `finally` cleanup.
- Confirm both queue counts before and after cross-app validation.

## Security and privacy

The repository may contain source and synthetic fixtures only. It must not contain participant exports, email/calendar records, browsing history, model-run screenshots, browser logs, production API keys, reviewer/reporting tokens, model-provider keys, or extension signing keys.

PC uploads are privacy-audited client-side, but the server still treats them as sensitive. Review task sidecars contain authored task text only—no identity, raw records, aliases, referenced record IDs, or expected answers. Full PC bundles never enter the task-review queue.

See [`../apollo-pc/PRIVACY_BASELINE.md`](../apollo-pc/PRIVACY_BASELINE.md), [`../QUALITY_CONTROL.md`](../QUALITY_CONTROL.md), and [`APOLLO_FLOW.md`](APOLLO_FLOW.md).
