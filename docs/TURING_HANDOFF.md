# Turing maintainer handoff

## Access to request

Repository access alone does not grant production access. A maintainer may need some or all of:

1. Read access to the private GitHub repository.
2. Apollo reviewer/admin access through the server-side email allowlist.
3. Vercel project access for `apollo-v2-site` and `apollo-pc-site` if deploying frontends.
4. A least-privilege AWS role for the required job.
5. A model-provider credential for approved QC/model runs.
6. A separate read-only reporting token for internal reporting.

Share credentials through the approved secret manager, never GitHub, Slack, screenshots, or browser bundles.

## First checkout

```bash
git clone https://github.com/superintelligentagents/apollo-platform.git
cd apollo-platform

npm install --prefix backend
npm install --prefix apollo-v2
npm install --prefix apollo-pc

python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r scripts/trajectory_review/requirements.txt
```

The production URLs are:

- Apollo V2: https://apollo-v2-site.vercel.app
- Apollo PC: https://apollo-pc-site.vercel.app

## Quality-control order

1. An annotator submits an immutable task and its rubric steps.
2. The Codex feasibility pipeline checks the exact content hash. Until this completes, the task is not claimable for human QC.
3. A different person reviews the full request, Codex feedback, and every rubric. Human edits create a separate final-gold snapshot; the original remains unchanged.
4. An agent model runs the approved task outside Apollo.
5. The trajectory tooling judges and packages the run for Apollo.
6. A human independently grades each rubric and the overall trajectory. Apollo hides the LLM trajectory verdict until the human submits.

See `QUALITY_CONTROL.md` and `docs/APOLLO_FLOW.md` for the storage prefixes, concurrency model, API fields, and operational commands.

## Codex feasibility check

The source of truth is `.agents/skills/review-live-web-feasibility/SKILL.md`. It checks only:

- whether the full task is coherent, high quality, and possible on the public web;
- whether each rubric matches the request and is possible on the public web.

It accepts a compatible public source when the task does not require one exact website. It does not rewrite tasks. Suggestions are separate, advisory artifacts and must be explicitly adopted by a human reviewer.

For a safe dry run:

```bash
python3 scripts/llm_feasibility/run.py \
  --input /path/to/sanitized_tasks.json \
  --pre-qc \
  --plan \
  --no-upload
```

Never send browsing history, Apollo PC email/calendar data, attachments, cookies, participant metadata, or credentials to the model.

## Trajectory judging

The judge accepts current Odysseys run directories and `run_full_trajectory_per_rubric.py`-style results. Plan mode validates inputs and AWS access without model calls or writes:

```bash
python3 scripts/trajectory_review/run.py \
  --runs-dir /path/to/osworld-runs \
  --task-source-json /path/to/tasks.json \
  --model gemini-3.1-flash-lite-preview \
  --plan --prod
```

Use `scripts/trajectory_review/prepare.py` to publish already-generated evaluator output. Human grades are written separately from run packages and LLM judgments.

## Deployment

The current Vercel sites were deployed from local production builds, not from an automatic GitHub build. Workspace dependencies make local prebuilt deployment the supported path. Follow each app README exactly and keep `VITE_REVIEW_KEY` in the approved deploy environment only.

The backend is the `journeys-presign` Lambda. Treat backend deployment as a separate privileged operation. Verify tests and the deployed source hash before changing production.

## Required checks before a PR

```bash
npm test --prefix backend
npm run typecheck --prefix apollo-v2
npm test --prefix apollo-v2 -- --run
npm run typecheck --prefix apollo-pc
npm test --prefix apollo-pc -- --run
python3 -m unittest scripts.llm_feasibility.test_run
python3 -m unittest discover -s scripts/trajectory_review -p 'test_*.py'
```

Confirm `git status --ignored` does not expose `.env` files, `.work/`, `.vercel/`, build output, participant data, browser logs, or extension signing material.
