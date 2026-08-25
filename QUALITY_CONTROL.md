# Apollo quality-control architecture

Apollo uses four explicit QC stages. Each stage reads the prior artifacts and writes a new immutable record; no stage silently rewrites a submission.

The stages run independently in two queue families:

| App | API | Review root | Worker flag |
|---|---|---|---|
| Apollo V2 | `https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com` | `v2-review/` | `--queue v2` |
| Apollo PC | `https://t1ynh195m1.execute-api.us-east-1.amazonaws.com` | `pc-review/` | `--queue pc` |

In the table below, `{review-root}` means the root selected above. Workers validate task IDs against the selected queue before any model or AWS write.

1. **LLM pre-QC — task definition.** The Codex feasibility pipeline independently checks every rubric on the live public web, then a separate manager checks task coherence and whether every rubric is compatible with the prompt. Minimal repair text is advisory and is exposed only after independent verification.
2. **Human task QC — prompt and rubrics.** A task does not enter the claimable queue until a supported Codex PRE_QC run has completed every rubric for that exact content hash. A reviewer then sees the original submitted task, the advisory LLM result beside the matching rubric, and any verified minimal suggestion. The reviewer—not the LLM—edits or rejects the task. Approval stores both the original and final snapshots.
3. **Author sign-off — the author answers the review.** An approved task goes back to its author with both versions side by side, but no reviewer identity. They either accept it or amend it; an amendment becomes final gold without a second reviewer pass. This is a deliberate exception to reviewer-only final gold. The reviewer's audit stays intact and the replaced version is archived immutably. A rejected task likewise shows the reason and step notes anonymously, and its author may revise and appeal once; the appeal is routed to a different reviewer.
4. **Human trajectory QC — model behavior only.** After model runs are judged separately, the ingestion script packages the evaluator output with actions and screenshots. The human grader independently marks each rubric `Pass`, `Fail`, or `Unclear`, then gives the run one final grade: `Yes`, `No`, `Edit needed`, or `Needs rerun`. The last two require a short explanation of what must change. Prompt quality and rubric design are not scored here; `Edit needed` only routes a task/rubric defect discovered while judging the run back for correction.

## Where each judgment happens

| Stage | Runs in | Reads | Writes | Human UI |
|---|---|---|---|---|
| LLM pre-QC | Dedicated Codex CLI worker or operator VM, before human task QC | Pending authored prompt and canonical rubrics from the selected app's reporting API | `{review-root}/llm_pre_qc_pass/`, `{review-root}/llm_pre_qc_attention/`, and `{review-root}/llm_pre_qc_claims/` | Results appear beside the matching task and rubric in that app's Review workspace |
| Human task QC | Apollo V2 or Apollo PC in the reviewer's browser | Original submission plus completed current-content LLM pre-QC artifact | Immutable final-gold or rejection records under `{review-root}` | V2 `#/review-queue`; PC `#/review-task` |
| Author sign-off | Apollo V2 in the author's browser, after approval | Their own submission, reviewer final gold, and Codex artifact | Compact receipt under `v2-review/author-signoffs/` plus the complete author-approved final under `v2-review/author-approved/`; amendments archive the prior gold under `v2-review/finished-history/` before replacing it | V2 `#/my-tasks` |
| Author appeal | Apollo V2 in the author's browser, after a first rejection | Anonymous rejection reason and reviewer rubric notes | A new task revision carrying the author's appeal reason plus `v2-review/appeals/` routing marker | V2 `#/my-tasks` |
| LLM post-QC | Dedicated Codex CLI worker or operator VM, after human approval | Human-approved final gold | `{review-root}/llm_pass/`, `{review-root}/llm_fail/`, and `{review-root}/llm_claims/` | Matching reporting/admin API |
| Model run + Odysseys judge | Existing OSWorld runner/VM; outside Apollo | Final-gold prompt, rubrics, and the agent trajectory | The evaluator JSON and source run directory; Apollo never rewrites them | None until packaged |
| Trajectory packaging | The run VM or an ingestion worker | Judge JSON, `steps.jsonl`/`traj.jsonl`, and screenshots | `{review-root}/trajectory-runs/` and `{review-root}/trajectory-inbox/` | Matching Grade/trajectory workspace |
| Human trajectory QC | Apollo V2 or Apollo PC in the reviewer's browser | Immutable normalized run package; the stored LLM trajectory judgment is withheld from graders | `{review-root}/trajectory-judgments/`, `{review-root}/trajectory-done/`, and short-lived `{review-root}/trajectory-locks/` | V2 `#/trajectory-review`; PC `#/grade` |

The Codex feasibility worker should not run inside the browser or Lambda. It needs durable execution, live-web tooling, resumable local cache, and tightly scoped AWS write access. Apollo is the review surface and queue coordinator; the worker or VM is the model-execution surface.

## What the task reviewer sees

The advisory LLM panel shows two task-level axes:

- task coherence;
- live-web feasibility;

Every canonical rubric shows two traffic-light judgments: `Reachable` on the live web and `Compatible` with the task. Green means the relevant axis passed. Red means a concrete defect was found; amber means the LLM could not resolve it safely. Expanding a rubric shows the evidence, blockers, compatibility issues, and either an independently checked minimal revision or the reason no safe revision could be produced. A reviewer can copy a verified suggestion into the working copy with one explicit click. That click is a human edit: the LLM artifact never changes the source submission, final gold, or queue outcome.

The current v22 check asks only whether the task is coherent and high quality, whether it is feasible overall, and whether each rubric is both aligned with the request and feasible on the public web. Each passing step must quote exact request text that authorizes it, list no introduced requirements, and may not introduce an unrequested named app or service. A single unavailable site is not a task failure when the prompt permits equivalent information from another reasonable source. It does not reject tasks for an optional date/time a planning agent can choose, intermediate values supplied by earlier steps, or limitations of the read-only verifier.

Reviewer guidance and queue admission currently accept only v22-or-newer artifacts for the exact current content hash. `LLM_PASS`, `LLM_FAIL`, and `NEEDS_HUMAN_REVIEW` are completed audits and enter human QC; a missing, stale, partial, or `PIPELINE_ERROR` artifact remains in **waiting for Codex check** and cannot be claimed. Older artifacts remain immutable in reporting history but do not unlock the task or appear as current advice until that task is rerun.

## Why Codex runs outside the website

The easiest safe setup is a dedicated operator VM or scheduled worker using the existing Codex CLI skill. Apollo displays results and queue state, but the browser bundle never receives model keys, reporting credentials, AWS credentials, or Codex access. A website-triggered model run would still need a durable worker behind it; it would add secrets and failure modes without improving the reviewer workflow.

Run task pre-QC from an authenticated worker:

```bash
export APOLLO_REPORTING_URL='https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/reporting/tasks'
export APOLLO_REPORTING_TOKEN='retrieve-from-private-secret-store'
export APOLLO_S3_BUCKET='journeys-prolific'

python3 scripts/llm_feasibility/run.py \
  --api-url "${APOLLO_REPORTING_URL}?status=pending&include=content,llm_reviews&limit=1&offset=0" \
  --s3-bucket "$APOLLO_S3_BUCKET" \
  --queue v2 \
  --pre-qc \
  --task-workers 4 \
  --workers 6
```

Run the repo-local trajectory judge and publisher on the OSWorld/Odysseys worker. This replaces the need for a separate Odysseys source checkout while keeping compatibility with its evaluator output:

```bash
python3 scripts/trajectory_review/run.py \
  --runs-dir /path/to/osworld-runs \
  --task-source-json /path/to/tasks.json \
  --model gemini-3.1-flash-lite-preview \
  --queue v2 \
  --plan --prod

python3 scripts/trajectory_review/run.py \
  --runs-dir /path/to/osworld-runs \
  --task-source-json /path/to/tasks.json \
  --model gemini-3.1-flash-lite-preview \
  --queue v2 \
  --num-workers 8 --prod
```

Use `--queue pc` for PC trajectories. Task pre-QC likewise uses the PC reporting
API and `--queue pc`, so neither worker can write into Apollo v2's QC folders.

The first command validates assignments and AWS access without model calls or writes. The second judges, validates, packages, and publishes. Model/API errors remain an explicit amber `ERROR` state and never masquerade as a trajectory failure.

Existing output from Odysseys' `run_full_trajectory_per_rubric.py` can still be published directly with `scripts/trajectory_review/prepare.py`.

```bash
python3 scripts/trajectory_review/prepare.py \
  --eval-results /path/to/eval_results_full_traj_per_rubric.json \
  --runs-root /path/to/osworld/runs \
  --output-dir .work/trajectory_review \
  --queue v2 \
  --s3-bucket journeys-prolific
```

## Concurrency and data ownership

- Task QC and trajectory QC have separate inbox, lock, done, and result prefixes.
- Claims use conditional S3 writes. Only one reviewer wins; expired locks can be taken over with an ETag compare-and-swap.
- Finalization is idempotent and content-hashed. Conflicting judgments return `409` instead of overwriting another reviewer.
- Reviewers are not offered runs for Apollo v2 tasks whose participant ID matches their own.
- Original submissions, final-gold edits, LLM feasibility reviews, normalized run packages, and human trajectory judgments remain separate and auditable.
- An author amendment replaces `v2-review/finished/{task_id}.json` under an ETag compare-and-swap, but only after the version it supersedes has been written to `v2-review/finished-history/` with a conditional create. The reviewer's `review` block and `reviewed_by` are carried through untouched for internal audit, but author-facing endpoints never return reviewer identity. `revision_count` only increases. One object per task stays under `finished/`, so the approved count keeps counting tasks.
- An author may appeal a rejection once and must explain why. The appeal is an ordinary revision in the same task directory and passes the Codex gate again like any other; it may preserve the original task text when the author is challenging the decision itself. `/review/claim` will not offer it to the reviewer who rejected it, and the fresh reviewer sees the author's reason.

S3 has virtual prefixes rather than physical directories. Folder-marker objects may make empty prefixes visible in the AWS console, but correctness never depends on them; writers create the real prefix contents atomically when work arrives.

## External reporting

- `GET /reporting/tasks` returns task creation, human task QC, full prompts/rubrics, and LLM feasibility reviews when explicitly requested.
- `GET /reporting/trajectories` returns model-run queue state and the human final outcome (`YES`, `NO`, `EDIT_NEEDED`, or `NEEDS_RERUN`). Add `include=full` to return the normalized run package and complete per-rubric human judgment; full pages are capped at 10. The reporting API retains the separate LLM judge output for analysis, but Apollo does not show it to a grader before submission.

Both endpoints require a bearer reporting credential. Never commit or put reporting tokens in a browser bundle.
