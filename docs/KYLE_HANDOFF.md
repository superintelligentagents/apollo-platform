# Maintainer handoff

## Current shareability status

`superintelligentagents/apollo-platform` is the public, code-only source of truth for Apollo V2, Apollo PC, the review backend, and QC workers. Its complete Git history has been checked for credentials and participant artifacts. The Chrome extension public key in `manifest.json` is intentionally public; its private signing key is ignored and must never be committed.

The older internal `superintelligentagents/apollo` repository also contains legacy applications and data tooling. Do not copy its datasets, browsing exports, local work directories, audit artifacts, or generated extension packages into this repository.

No production credential or participant data should be sent through GitHub.

## Access Kyle needs separately

1. GitHub write access to `superintelligentagents/apollo-platform`.
2. Read-only Apollo reporting API credential for internal reporting.
3. AWS role access appropriate to the job:
   - V2 trajectory runners: only `scripts/trajectory_review/aws/runner-policy.json` plus `sts:GetCallerIdentity`;
   - PC trajectory runners: only `scripts/trajectory_review/aws/pc-runner-policy.json` plus `sts:GetCallerIdentity`;
   - deployers: separately approved Lambda/Vercel permissions.
4. A model provider key injected locally or through the AWS workload secret mechanism.
5. Apollo admin/reviewer access through the existing email allowlist.

Do not send the Chrome extension private signing key, review key, reporting token, AWS access keys, model keys, local `.env` files, `.work/`, or browser automation logs through GitHub.

## First local setup

```bash
git clone https://github.com/superintelligentagents/apollo-platform.git
cd apollo-platform

npm install --prefix backend
npm install --prefix apollo-v2

python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r scripts/trajectory_review/requirements.txt
```

Run the validation suites:

```bash
node --test backend/lambda_presign.test.js
npm run typecheck --prefix apollo-v2
npm test --prefix apollo-v2 -- --run
python3 -m unittest scripts.llm_feasibility.test_run
python3 -m unittest discover -s scripts/trajectory_review -p 'test_*.py'
```

## Important entrypoints

- `QUALITY_CONTROL.md`: ownership, S3 layout, and operational order.
- `docs/APOLLO_FLOW.md`: end-to-end product flow.
- `.agents/skills/review-live-web-feasibility/SKILL.md`: task/rubric LLM QC contract.
- `scripts/llm_feasibility/run.py`: task/rubric PRE_QC and POST_QC.
- `scripts/trajectory_review/run.py`: local/production trajectory judge and AWS publisher.
- `scripts/trajectory_review/prepare.py`: compatibility ingestion for existing Odysseys output.
- `backend/REPORTING_API.md`: external reporting contract.

## Release discipline

- Work on a branch and review the complete diff; the local workspace may contain unrelated uncommitted work.
- Run `git status --ignored` and confirm private/local artifacts remain ignored.
- Never bake `REVIEW_KEY`, `REPORTING_KEY`, provider keys, or AWS keys into web builds, containers, examples, screenshots, or test fixtures.
- Deploy the Lambda and Apollo site only after their test suites pass and compare the deployed Lambda source hash with the intended local file.
