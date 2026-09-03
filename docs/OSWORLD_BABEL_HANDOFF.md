# OSWorld runner on Babel — session handoff (2026-09-03)

State of the OSWorld trajectory campaign after porting the runner to CMU's Babel
cluster and adding an OpenAI agent backend. Everything below is on branch
`apptainer-provider`.

## Where the corpus stands

| | |
|---|---|
| Approved tasks (v2 reporting API) | 1,761 |
| Tasks with ≥1 trajectory | 1,591 |
| `gpt-5.6-luna` coverage | **1,589 — complete, 0 runnable remaining** |
| Meta `super_nova_ext` coverage | 325 |
| Not yet runnable | 172, still awaiting author sign-off |
| Human review status | all `pending` — nothing graded yet |

Quality: luna avg rubric **0.559** (195 perfect, 130 zero); Meta avg **0.658**
(80 perfect, 21 zero) on its smaller slice. Luna averages ~21 steps/task vs
Meta's ~58 — it tends to answer research tasks from search snippets instead of
visiting primary sources, which is the dominant failure mode.

Measured cost: **$142.61** for 1,188 trajectories ($0.118/task; agent $50.47 at
90 % prompt-cache hit, judge $92.14). The judge is consistently ~2× the agent
because every rubric re-sends the trajectory plus screenshots uncached.

## What is NOT deployed

**The backend API changes are code-only.** Verified against production on
2026-09-03: the new fields are absent, `include=content` still caps at 10 rows,
and `include=screenshots` returns nothing. They ship in `backend/lambda_presign.js`
and need a Lambda deploy to **both** production functions:

- v2 — `https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com`
- PC — `https://t1ynh195m1.execute-api.us-east-1.amazonaws.com`

Before deploying, note two things:

1. `docs/TURING_HANDOFF.md` requires treating this as a privileged operation and
   verifying the deployed source hash first, so the deploy does not silently
   overwrite a version that differs from this branch.
2. `lambda_presign.js` imports `@aws-sdk/s3-presigned-post` and
   `@aws-sdk/s3-request-presigner`. Node Lambda runtimes bundle the SDK v3 core
   clients but not necessarily those two helpers — **inspect how the live
   function is packaged (zip with `node_modules`?) before pushing source alone**,
   or the function will break at import time.

Verify after deploying:

```bash
# rows should carry the coverage counts
curl -sS --get -H "Authorization: Bearer $APOLLO_REPORTING_TOKEN" \
  --data-urlencode "limit=1" "$BASE/reporting/trajectories" | jq '.trajectories[0] | {llm_judge_errors, llm_rubrics_total, llm_rubrics_scored}'
# content pages should return up to 50
curl -sS --get -H "Authorization: Bearer $APOLLO_REPORTING_TOKEN" \
  --data-urlencode "include=content" --data-urlencode "limit=50" "$BASE/reporting/trajectories" | jq '.page.returned'
# steps should carry presigned screenshot_url
curl -sS --get -H "Authorization: Bearer $APOLLO_REPORTING_TOKEN" \
  --data-urlencode "include=screenshots" --data-urlencode "limit=1" "$BASE/reporting/trajectories" | jq '.trajectories[0].manifest.steps[0].screenshot_url'
```

Tests: `cd backend && node --test lambda_presign.test.js` (100 pass).

## API changes in this branch (requested by Kyle Waters)

1. **Judge coverage on every row** — `llm_judge_errors`, `llm_rubrics_total`,
   `llm_rubrics_scored`. `llm_average_rubric_score` is the mean over rubrics the
   judge actually scored; an `ERROR` rubric is dropped from that denominator, so
   a run with 4 errors and 1 pass reported `1.0`. `llm_perfect` is stricter (every
   rubric scored *and* passed) and is the trustworthy pass signal — the two are
   not interchangeable. Four known examples: runs `3bcd259c`, `a3001eaa`,
   `e38f970b`, `ff3e7c3b`.
2. **`include=content` page cap 10 → 50** (25 with screenshots). Plain metadata
   paging is unchanged at 1,000 with `page.next_offset`.
3. **`include=screenshots`** — presigned `screenshot_url` (1 h) per step, reusing
   the review UI's signing, prefix-guarded so a crafted `screenshot_path` cannot
   sign outside its own run directory. Implies `include=content`.
4. **No code needed for per-rubric verdicts** — they were always in
   `manifest.rubrics[]` under `include=content` (`rubric_id`, `llm_status`,
   `llm_score`, `llm_reasoning`). `osworld_task.apollo.rubrics[]` is the criteria
   export and carries no verdicts. Documented in `backend/REPORTING_API.md`.

**Open, deliberately not changed:** `manifest_key` base64url-decodes to
`v2/<trainer-email>/internal/task-…`, so participant identity rides along in
every reporting row. The encoding is load-bearing for the S3 layout and the
creator-scoped inbox; a `run_id`-keyed alias for external consumers would fix it.

## Running the fleet

```bash
cd /home/ljang/apollo-platform
EX=$(/home/ljang/odysseys/osworld_runner/scripts/babel/_kvm_exclude.sh)
E="OSWORLD_SHARD_COUNT=14,OSWORLD_CONCURRENCY=8,OSWORLD_AGENT_BACKEND=openai,\
OSWORLD_OPENAI_MODEL=gpt-5.6-luna,OSWORLD_JUDGE_MODEL=gpt-5.6-luna,\
OSWORLD_WORK_ROOT_PREFIX=<prefix>,OSWORLD_DEDUPE_BY_MODEL=1"
for i in 0 1 2 3 4 5 6 7; do sbatch $EX --partition=general --job-name=apollo-<name> \
  --export=ALL,$E,OSWORLD_SHARD_INDEX=$i scripts/osworld_runner/babel_queue.sbatch; done
for i in 8 9 10 11 12 13; do sbatch $EX --partition=russ-lab --qos=russ_lab_qos --time=3-00:00:00 \
  --job-name=apollo-<name> --export=ALL,$E,OSWORLD_SHARD_INDEX=$i scripts/osworld_runner/babel_queue.sbatch; done
# self-healing watchdog (resubmits dead shards)
BACKEND=openai OPENAI_MODEL=gpt-5.6-luna JUDGE_MODEL=gpt-5.6-luna CONC=8 \
  PREFIX=<prefix> JOBNAME=apollo-<name> DEDUPE=1 \
  nohup bash /data/user_data/ljang/apollo-osworld/watchdog.sh &
```

Max non-preemptible parallelism is **14 jobs × 8 VMs = 112 concurrent** — both
`normal` and `russ_lab_qos` cap at 8 GPUs per user and they stack; every job on
`general` must request `--gres=gpu:1`. `OSWORLD_MAX_BATCHES=<n>` bounds a run
(shards stop at `batch_limit`). Infrastructure paths, secrets and cluster quirks
are in the operator's `apollo-osworld-babel-setup` note.

## Defaults changed in this branch

| Setting | Was | Now | Why |
|---|---|---|---|
| Judge screenshots | 12 evenly sampled | **all** (`--judge-max-images 0`) | matches the canonical Odysseys judge; the sample was a Meta request-size concession |
| Judge implementation | in-tree `judge.py` | **canonical** (`--judge-impl canonical`) | runs Odysseys' own `run_full_trajectory_per_rubric.py`, SHA-256 pinned |
| Browser start tabs | task `site_scope` | **google.com** (`--start-url-mode google`) | 132 of 200 Odysseys configs start at Google |

All three are one flag/env var to revert. **Results produced under these
defaults are not directly comparable with the existing 1,917 trajectories**,
which were recorded with sampled screenshots, the in-tree judge, and site_scope
start tabs.

### Canonical judge

`scripts/trajectory_review/canonical_judge.py` fetches
`ljang0/Odysseys@837814633ef9:scripts/python/run_full_trajectory_per_rubric.py`,
verifies SHA-256 `736c3c20…`, and runs it verbatim. Three adaptations live
around the file, never inside it:

- **Task source** — canonical wants Odysseys JSON (`confirmed_task`, `level`,
  `rubrics` as a dict); Apollo rows are converted via `judge.normalize_task`.
- **Run-dir keying** — canonical's `infer_task_id()` only recognises hex-hash
  directory names, so the task source is keyed by Apollo's `apollo_b64_…`
  directory name and mapped back afterwards.
- **Judge errors** — canonical records a provider/parser failure as
  `success: false`, indistinguishable from agent failure. Its error reasoning is
  prefixed, so those rows are restored to `judge_status: ERROR` with a null score
  and excluded from the average. **Do not drop this**: without it, judge outages
  silently become agent failures.

Validated on Kyle's task: canonical on all 33 screenshots agreed with the
in-tree judge's 12-frame sample on **10/10 rubrics**.

## Reliability fixes worth keeping

Each cost real fleet time before it was found:

- `command_base()` in `run_queue.py` began with `return [...]`; flags appended
  after it were **dead code**, so `--dedupe-by-model` and
  `--exclude-task-ids-file` never reached `run.py` for hours. Always verify a new
  flag reaches the child: `command_base(parser().parse_args([...]), Path())`.
- A single transient S3 failure used to void an entire batch. `prepare.py` now
  retries AWS uploads 4× with backoff (keys are content-addressed, so retrying is safe).
- A batch that published nothing left a `prepare-summary.json` with `prepared: []`,
  which made `recover_published_batches` raise on **every** restart — wedging the
  shard permanently. It now records the batch and continues.
- A fetch reporting "no author-signed tasks" is only treated as `complete` when
  the queue's own count agrees; otherwise it errors loudly. A child launched with
  different selection flags used to silently mark a shard done with work left.
- The watchdog mapped jobs → shards with `sacct -o SubmitLine%N`, which truncates
  and drops the trailing `SHARD_INDEX`; it now uses `scontrol`. It also must pass
  `--job-name`, or its resubmissions vanish under the sbatch default.
- Slurm's `launch_failed_requeued_held` state never self-schedules — needs
  `scontrol release`.
- Agent retry policy is governed in `muse_spark_launcher.py` (no retry on 4xx,
  `Retry-After`/backoff on 429, fleet-wide block marker on 403). **This exists
  because retry amplification got the Meta key blocked** — see below.

## Meta key: blocked

`super_nova_ext` (secret `MetaSecret-5u6l3xwWXGqj`) returns **403 `user_blocked`**
("repeated policy violations") on all generation endpoints since 2026-09-01
19:14 EDT. `GET /v1/models` still returns 200 and lists the model, so the key
authenticates and is entitled — this is a user-level generation block that needs
Meta support to lift, not a timed expiry. Cause: at 84 concurrent agents the
output-token rate limit was breached and the agent's retry loop amplified it into
~780 rate-limit hits in an hour. All Meta traffic has been stopped since 19:50;
probing was stopped at the operator's request. Safe operating point for that key
if it is restored: **≤56 concurrent agents**.

## Suggested next steps

1. Deploy the backend change (above) — Kyle is blocked on the coverage fields.
2. Human review: 1,917 trajectories are `pending`, concentrated in
   `vaibhav-p2` (164), `onkar-y` (148), `pratik-p5` (147), `sufiyan-k` (135)
   across 26 authors. Kyle has 1.
3. Decide on the Google-start default. Evidence is one task: the site_scope run
   scored 0.0 in 33 steps and never opened the required page; the Google-start
   re-run scored 0.2 in 86 steps and did open it. Suggestive, not conclusive —
   **20–30 tasks in both modes (~$10) would settle it**.
4. Rubric staleness. Trajectory grading is working as designed, but rubrics that
   hardcode live values go stale: Kyle's task expects a 7:39 PM departure where
   JetBlue now shows 7:05 PM, and a 59.46 % on-time rate where the agent found
   73.12 %. Rubrics phrased as actions ("navigate to X", "filter to Y") stay
   durable; rubrics embedding data values expire. Zero-score rates vary hugely by
   author (`shahzan-t` 58 %, `abhinav-m` 27 %, `tolani-a` 27 % vs `pratik-p5`,
   `aashna-j`, `shaheer-a` at 0 %), which is worth investigating on the authoring side.
5. The 172 sign-off-pending tasks become runnable as authors accept; one fleet
   run sweeps them up.
