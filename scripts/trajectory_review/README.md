# Trajectory judge and human-review ingestion

This directory is self-contained. Kyle does not need a separate Odysseys checkout to judge recorded runs.

- `judge.py` independently checks every rubric against the complete action history and screenshots.
- `prepare.py` converts compatible judge results into immutable Apollo review packages.
- `run.py` is the recommended one-command local/production entrypoint: judge, validate, package, and optionally enqueue in AWS.
- `Dockerfile` provides the same entrypoint for a dedicated EC2, ECS, or AWS Batch worker.

The model judge is advisory. Human reviewers remain the final arbiter in Apollo.

## Install locally

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r scripts/trajectory_review/requirements.txt
cp scripts/trajectory_review/.env.example .env
```

Put either `GEMINI_API_KEY` or `OPENAI_API_KEY` in the ignored `.env`. Never pass model keys on the command line or bake them into a container.

## Input contract

`--runs-dir` may be one run directory or a tree containing `steps.jsonl`/`traj.jsonl`. By default a run must also contain a numeric `result.txt`; use `--include-incomplete` only intentionally.

`--task-source-json` accepts either:

- the Odysseys task array (`task_id`, `confirmed_task`, `rubrics`); or
- the Apollo reporting API `include=full` response (`tasks[]` with `content.final` and `content.rubrics`).

Run-directory names must resolve to IDs present in the task source. Assignment validation happens before any model call.

## Plan without model calls or writes

```bash
python3 scripts/trajectory_review/run.py \
  --runs-dir /path/to/osworld-runs \
  --task-source-json /path/to/tasks.json \
  --model gemini-3.1-flash-lite-preview \
  --plan
```

Add `--prod` to the plan to also verify the active AWS identity and production bucket access. It still performs no write.

## Run locally

```bash
python3 scripts/trajectory_review/run.py \
  --runs-dir /path/to/osworld-runs \
  --task-source-json /path/to/tasks.json \
  --model gemini-3.1-flash-lite-preview \
  --num-workers 4
```

Results and packages are written below `.work/trajectory_review/`. The output is resumable and reused only when judge version, provider, model, task, trajectory bytes, and referenced screenshots are unchanged.

For OpenAI, use `--provider openai --model MODEL_NAME` and set `OPENAI_API_KEY`.

## Run and publish to production

Use an instance/task role with [the write-only policy](aws/runner-policy.json), plus permission for `sts:GetCallerIdentity`. Then run:

```bash
python3 scripts/trajectory_review/run.py \
  --runs-dir /path/to/osworld-runs \
  --task-source-json /path/to/tasks.json \
  --model gemini-3.1-flash-lite-preview \
  --num-workers 8 \
  --prod
```

`--prod` is an explicit shortcut for `--s3-bucket journeys-prolific`. Upload order is screenshots, manifest, then inbox marker, so a partial package never becomes claimable. The role has no write permission to submissions, final gold, LLM task-QC artifacts, or human judgments.

Container build/run:

```bash
docker build -f scripts/trajectory_review/Dockerfile -t apollo-trajectory-judge .
docker run --rm \
  -e GEMINI_API_KEY \
  -e AWS_REGION=us-east-1 \
  -v /path/to/osworld-runs:/runs:ro \
  -v /path/to/tasks.json:/input/tasks.json:ro \
  apollo-trajectory-judge \
  --runs-dir /runs --task-source-json /input/tasks.json --prod
```

In AWS, inject the model key through the task secret mechanism and use an IAM role for AWS access. Do not put either credential in the image.

## Existing Odysseys evaluator output

`prepare.py` is the bridge between Odysseys model runs and Apollo's human trajectory grader. It accepts the JSON written by [`run_full_trajectory_per_rubric.py`](https://github.com/ljang0/Odysseys/blob/main/scripts/python/run_full_trajectory_per_rubric.py), reads each referenced `steps.jsonl` or `traj.jsonl`, and produces a portable review package with:

- the complete task prompt and every rubric/verifier;
- the LLM judge's score and reasoning for each rubric;
- the normalized action and response stream;
- copied screenshots in chronological order;
- hashes that identify the exact evaluator result and trajectory source.

The upstream run and evaluator output are never edited.

## Prepare locally

```bash
python3 scripts/trajectory_review/prepare.py \
  --eval-results /path/to/eval_results_full_traj_per_rubric.json \
  --runs-root /optional/base/for/relative/run_dirs \
  --output-dir .work/trajectory_review
```

Inspect `.work/trajectory_review/prepare-summary.json`. Bad or incomplete runs are listed under `skipped`; they are not silently queued.

For a small production experiment, select exact task IDs without changing the evaluator JSON:

```bash
python3 scripts/trajectory_review/prepare.py \
  --eval-results /path/to/eval_results_full_traj_per_rubric.json \
  --runs-root /path/to/bundle \
  --task-id TASK_ID_ONE \
  --task-id TASK_ID_TWO \
  --agent Skyvern \
  --model 'Claude Opus 5' \
  --run-label 'official judge pilot' \
  --output-dir .work/trajectory_review_sample \
  --s3-bucket journeys-prolific
```

`--limit N` may be combined with `--task-id` or used alone. Selection preserves evaluator order, and the source evaluator output is read-only.

For reliable Lambda and browser delivery, a package is rejected rather than truncated when it exceeds 500 steps, 100 rubrics, or a 4 MB manifest. Screenshot files are separate objects and do not count toward the manifest limit.

## Publish to Apollo

Use AWS credentials that can write only `v2-review/trajectory-runs/*` and `v2-review/trajectory-inbox/*`:

```bash
python3 scripts/trajectory_review/prepare.py \
  --eval-results /path/to/eval_results_full_traj_per_rubric.json \
  --output-dir .work/trajectory_review \
  --s3-bucket journeys-prolific
```

Screenshots upload first, `manifest.json` is created with an S3 `If-None-Match: *` guard, and the inbox marker is written last. A partially uploaded package therefore never becomes claimable, and an existing immutable manifest cannot be overwritten. The manifest key is deterministic for the exact evaluator result, trajectory bytes, screenshots, and run metadata, so rerunning the command does not create duplicate review units.

Apollo stores human decisions separately under `v2-review/trajectory-judgments/*`; neither the package, model run, task, nor LLM judgment is modified.

The human Grade tab deliberately does not display the packaged LLM score or reasoning. It shows the task and rubric/verifier only as reference, then records one independent `SUCCESS`, `FAILURE`, or `UNJUDGEABLE` verdict for every rubric. The final run-level grade is `YES`, `NO`, `EDIT_NEEDED`, or `NEEDS_RERUN`; the last two require a short explanation of the edit or rerun. The LLM fields remain available to authenticated reporting clients for agreement analysis after grading.

## Tests

```bash
python3 -m unittest discover -s scripts/trajectory_review -p 'test_*.py'
python3 -m py_compile scripts/trajectory_review/judge.py scripts/trajectory_review/run.py scripts/trajectory_review/prepare.py
```

An unavailable provider or malformed model response is stored as an LLM judge `ERROR`, not mislabeled as a trajectory failure. That error remains available in the reporting data but is withheld from the human grader to avoid bias.
