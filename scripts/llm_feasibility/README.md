# Apollo LLM feasibility pipeline

This pipeline performs a second, automated QA pass after human QC:

1. It reads the complete final-gold prompt and canonical rubrics from the authenticated reporting API.
2. It starts one independent, ephemeral Codex CLI process for each rubric. Each worker checks only its assigned rubric on the live public web.
3. It validates every worker response against a strict JSON schema and retries malformed output once by default.
4. When a search worker reports that a safe dynamic interaction is the only missing evidence, an isolated Playwright MCP worker may perform a logged-out, read-only browser escalation for that rubric. It may not create, submit, purchase, message, book, or mutate anything.
5. A separate overall-feasibility Codex process checks whether the complete sequence has a workable public-web path. It must preserve each worker's effective verdict.
6. An independent quality check asks only whether the task is coherent and high quality and whether every step is aligned with the original request, in scope, and fair to evaluate.
7. A deterministic gate prevents a pass when a step is impossible or unresolved, a check fails, the task is not coherent and high quality, a step is out of scope or unfair, or the complete public-web path does not pass.
8. For each non-possible or incompatible rubric, an independent live-web repair worker may propose at most three exact fragment edits. A separate non-browsing repair manager may propose at most three task-prompt edits. Tool failures produce retry guidance, missing author facts require human input, and replacement sources require inspected live URLs.
9. A different public-web check reviews each exact candidate revision. The orchestrator exposes only candidates independently marked `POSSIBLE` and alignment `PASS`; all others remain unresolved. Combined overall-feasibility and quality checks then verify the proposed task.
10. It writes the complete artifact to exactly one S3 location:
   - `v2-review/llm_pass/{base64url(task_id)}.{task_content_hash}.{pipeline_version}.json` only when every worker says `POSSIBLE` and the manager says `FEASIBLE`.
   - `v2-review/llm_fail/{base64url(task_id)}.{task_content_hash}.{pipeline_version}.json` for every other completed disposition, including worker errors.

The artifact contains the complete effective final-gold task snapshot, full prompt, canonical rubric text, independent evidence, manager synthesis, and `task_content_hash`. The reporting API can return it with `include=llm_reviews` or `include=full`.

The pipeline is strictly read-only with respect to submissions and final gold. It never edits, submits, approves, rejects, or promotes a task or rubric. Pipeline v19 creates a separate v11-schema review artifact with feedback plus a v3 `repair_plan`. It checks only task quality/coherence, overall feasibility, per-step alignment/fairness, and per-step public-web feasibility. It does not grade prose polish, difficulty, step distinctness, or a separate evergreen axis. It permits reasonable agent choices when a prompt asks the agent to find, compare, recommend, choose, or plan; a planning agent may choose an upcoming date/time and later steps may consume earlier outputs. The checker's own read-only limits are not task defects. Suggested text is derived by the orchestrator from exact edit operations, but `repair_plan.applied_automatically` and `repair_plan.source_changed` are always false. A candidate is not exposed unless a separate public-web check marks that exact revision `POSSIBLE` and alignment `PASS`. A whole-task prompt suggestion causes every step to be independently rechecked in that exact proposed context. The complete combined version must then pass the overall-feasibility and quality checks. Human-facing summaries are one or two plain-language sentences, no more than 360 characters.

Source choice is flexible unless the authored task explicitly requires one exact website. Google or another compatible public source may establish the requested information, and a rendered Google result may count when it directly displays it. A failed, blocked, or incomplete candidate site is not proof that the task is impossible. The checker must search beyond the first failed site and keep tool limitations separate from actual task defects.

An isolated browser render failure does not downgrade an otherwise supported common public-web flow. The search check must explicitly mark the browser request `limitation_only: true` and include direct `OK` factual verification or corroboration evidence. If the browser then errors, or returns `CHECKER_TOOL` with `task_blocker: false`, v19 records the limitation but treats the effective step verdict as `POSSIBLE`. Login, access, missing-data, and possible task defects are never promoted by this rule.

Regression example: do not reject a Thorpe Park planning task solely because Queue Times does not publish future-day per-ride averages. Queue Times publishes average queue time by ride, and Google or another compatible source may provide equivalent historical or typical wait information. If the agent can choose the visit date and no exact future prediction from one source is required, the task remains workable.

The three writable S3 prefixes are fixed in code to `v2-review/llm_pass`, `v2-review/llm_fail`, and `v2-review/llm_claims`. CLI overrides targeting submission, final-gold, or other prefixes are rejected before any model or AWS call.

This is internal automated QA. `LLM_PASS` does not replace human acceptance.

## Advisory reviews before human QC

Use `--pre-qc` to review pending or in-review drafts early. This mode has the same independent website, browser-escalation, overall-feasibility, and quality/alignment checks, but it is explicitly advisory:

- only workflow rows marked `pending` or `in_review` are accepted;
- local cache lives under `tasks/{task}/pre_qc/{content_hash}/`;
- clear results upload only to `v2-review/llm_pre_qc_pass/`;
- every other outcome uploads only to `v2-review/llm_pre_qc_attention/`;
- claims use `v2-review/llm_pre_qc_claims/`;
- no PRE_QC result can enter final `llm_pass`/`llm_fail`, edit a task, or decide human approval;
- a complete current-content result from a supported pipeline unlocks that task for human QC, including attention/fail findings that require a human decision; missing, stale, partial, and `PIPELINE_ERROR` results do not unlock it.

For large batches, `--task-workers` processes multiple tasks concurrently while `--workers` bounds rubric concurrency inside each task. Their product cannot exceed 32.

## Requirements

- Python 3.10 or newer
- Codex CLI 0.145 or a compatible newer version, already authenticated
- Node.js/npm with `npx`, used only for the pinned `@playwright/mcp@0.0.79` browser escalation
- AWS CLI credentials authorized only for:
  - `s3:GetObject` (including HeadObject requests) on `v2-review/llm_pass/*`, `v2-review/llm_fail/*`, and `v2-review/llm_claims/*`
  - `s3:PutObject` on the same prefixes
- A read-only Apollo reporting credential in `APOLLO_REPORTING_TOKEN`

The Codex workers do not receive the reporting token, S3 bucket variable, or any `AWS_*`/`APOLLO_*` environment variables. Search workers execute in isolated job directories with a read-only sandbox, approval disabled, repository rules and user configuration ignored, and native live-web search enabled. Browser workers receive only the explicit pinned Playwright MCP configuration, use a fresh logged-out browser context, and are bound by the no-side-effects schema. They never receive source journeys, email/calendar records, attachments, cookies, or AWS credentials. Codex stdout is not persisted because CLI errors can echo the authored prompt; only a short SHA-256 diagnostic identifier is retained in an in-memory error message.

## Dry run

First verify API parsing, pagination, hashes, and the number of Codex jobs without starting workers or touching AWS:

```bash
export APOLLO_REPORTING_URL='https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/reporting/tasks'
export APOLLO_REPORTING_TOKEN='retrieve-from-private-secret-store'

python3 scripts/llm_feasibility/run.py \
  --api-url "${APOLLO_REPORTING_URL}?status=approved&include=content,llm_reviews&limit=1&offset=0" \
  --plan
```

Expanded content is one task per API page. The runner follows `page.next_offset`, sets the next request's `offset`, and preserves the original `status`, `include`, and `limit` parameters.

## Run all approved, unreviewed tasks

```bash
export APOLLO_S3_BUCKET='your-private-apollo-bucket'

python3 scripts/llm_feasibility/run.py \
  --api-url "${APOLLO_REPORTING_URL}?status=approved&include=content,llm_reviews&limit=1&offset=0" \
  --s3-bucket "$APOLLO_S3_BUCKET" \
  --workers 6 \
  --timeout-seconds 900 \
  --workdir .work/llm_feasibility
```

Rows already marked `passed` or `needs_attention` by the API are skipped. A stale review is processed again because the API reports it as `stale`. Use `--include-reviewed` only for an intentional audit rerun.

## Run one task

URL-encode the task ID when constructing the URL. This shell form delegates encoding to Python:

```bash
task_id='v2/alice/internal/task-12345678'
task_url="$(TASK_ID="$task_id" python3 -c 'import os, urllib.parse; print(os.environ["APOLLO_REPORTING_URL"] + "?" + urllib.parse.urlencode({"task_id": os.environ["TASK_ID"], "include": "full"}))')"

python3 scripts/llm_feasibility/run.py \
  --api-url "$task_url" \
  --s3-bucket "$APOLLO_S3_BUCKET" \
  --workers 6
```

Alternatively, call the API with `curl`, save the JSON, and use `--input response.json --no-upload` for a local inspection run.

## Content hash contract

For API input, the runner copies `tasks[].content.task_content_hash` byte-for-byte into the final artifact. It does not recompute or reinterpret that value.

The API computes this lowercase SHA-256 from stable JSON of:

```text
{
  task: final task when present, otherwise original task,
  rubrics: canonical rubrics mapped to
    {rubric_id, kind, source_index, title, text: final rubric text}
}
```

For local fixtures that do not include the API hash, the runner computes a deterministic fallback SHA-256 over canonical JSON with sorted keys and compact separators:

```text
{task_id, effective_task, prompt, rubrics: [{rubric_id, criterion, critical}]}
```

The fallback exists for development and tests. Production should always use the API-provided hash so stale reviews can be detected against the applicable state: the pending/in-review draft for PRE_QC or final gold for POST_QC.

## Resuming and concurrency

- `--workers` bounds simultaneous Codex rubric processes within one task to 1–16. The default is 6.
- `--task-workers` bounds simultaneously reviewed tasks to 1–8. The default is 1, and `--workers * --task-workers` may not exceed 32.
- Rubric outputs, optional browser outputs, both independent manager outputs, and final artifacts are validated before being cached.
- Reruns reuse only validated files under `.work/llm_feasibility/tasks/<task>/<hash>/` for POST_QC or `.work/llm_feasibility/tasks/<task>/pre_qc/<hash>/` for PRE_QC.
- A per-task directory lock prevents two local orchestrators from processing the same task state concurrently. Stale locks are reclaimed only after the configured timeout.
- Before writing a result, the runner conditionally creates `v2-review/llm_claims/{base64url(task_id)}.{task_content_hash}.{pipeline_version}.json`. Its hash and status metadata prevent concurrent runs for the same task state from placing it in both pass and fail. The discoverable pass/fail artifact is written only after that claim succeeds.
- S3 claim and artifact writes use `If-None-Match: *`. Concurrent writers cannot overwrite one another.
- Existing S3 objects are accepted only when their `task-content-hash` metadata matches the current API hash. Content- and pipeline-versioned keys keep prior reviews immutable while allowing changed gold or a newer pipeline to produce a new review.
- The pipeline never deletes or modifies human submissions or final-gold objects.
- A runtime invariant compares the source snapshot before and after every run and fails the review if it changed.

## Verdict rules

Search/browser worker verdicts:

- `POSSIBLE`: a direct, inspected, public evidence path supports the complete rubric.
- `SHORTFALL`: the rubric is partly checkable, but access or ambiguity prevents full verification. A search worker can request browser escalation only when safe logged-out interaction could resolve that exact gap.
- `IMPOSSIBLE`: the requirement itself is contradictory, unavailable across reasonable compatible sources, unsafe, login-only, or explicitly depends on an essential dead source. One failed optional site or an access limitation is not enough.

Manager dispositions:

- `FEASIBLE`: every rubric is possible, adequately evidenced, and jointly coherent.
- `NOT_FEASIBLE`: an essential step is impossible or the complete sequence has no workable path.
- `NEEDS_HUMAN_REVIEW`: evidence is weak, a worker failed, a shortfall remains, or the reviews conflict.

When browser escalation completes, its validated verdict normally becomes the step's effective verdict; otherwise the search verdict normally remains effective. The narrow exception is a search result with direct factual public-path evidence and `limitation_only: true`: a browser execution error or `CHECKER_TOOL`/non-blocker result preserves effective `POSSIBLE` while retaining the error as a limitation. Any other check error becomes `PIPELINE_ERROR`, any effective `SHORTFALL` becomes `NEEDS_HUMAN_REVIEW`, and an `IMPOSSIBLE` step becomes `LLM_FAIL` only when the overall check confirms `NOT_FEASIBLE`. Only all-effective-`POSSIBLE`, overall `FEASIBLE`, and quality/alignment `PASS` becomes `LLM_PASS`.

Legacy pipeline versions used these evergreen verdicts:

- `EVERGREEN`: a competent agent can complete the task and a reviewer can objectively judge it whenever it is attempted. Prices, availability, schedules, live status, rankings, and the latest published data may change; the answer does not need to remain identical.
- `NOT_EVERGREEN`: time can make the instructions ambiguous, impossible, or unjudgeable—for example, a fixed answer for an unspecified dated occurrence, a one-time source after it expires, or a hard-coded expected value for a live query.
- `NEEDS_HUMAN_REVIEW`: whether the task remains runnable and judgeable at different execution times is genuinely ambiguous.

Words such as `today`, `current`, `latest`, and `recent` are not automatic failures. They are acceptable when they resolve at execution time and the rubric evaluates the contemporaneous evidence. Mutable facts alone are never sufficient reason for `NOT_EVERGREEN`.

Pipeline v19 retains the legacy evergreen field as `NOT_ASSESSED` for API compatibility, but it does not invoke an evergreen model worker and the field does not affect pass/fail. Live, current, latest, price, schedule, and availability tasks are not rejected merely because their answers change.

Feedback fields:

- `manager_review.task_feedback` and `feedback.task`: optional feedback about the complete task.
- `rubric_reviews[].review.rubric_feedback`, `rubric_reviews[].browser_review.review.rubric_feedback`, and `feedback.rubrics[]`: optional feedback scoped to one rubric. Browser feedback takes precedence when that escalation completed.
- `manager_review.quality_review` is the legacy container name for the v19 combined task coherence/high-quality check and one alignment/fairness verdict per canonical step.
- `repair_plan` contains advisory exact edit operations and independently verified suggested text. `projected_task_status: POSSIBLE` requires every proposed step to be possible and alignment-passing and the combined proposed version to pass overall-feasibility and quality review. The plan is never applied automatically and never replaces `source`.
- A verifier/tool outage yields `RETRY_VERIFICATION`, not rewritten task text. Missing author-supplied facts yield `HUMAN_INPUT_REQUIRED`, not invented defaults.

## Tests

```bash
python3 -m unittest -v scripts.llm_feasibility.test_run
python3 -m py_compile scripts/llm_feasibility/run.py
python3 -m json.tool scripts/llm_feasibility/schemas/rubric_review.schema.json >/dev/null
python3 -m json.tool scripts/llm_feasibility/schemas/browser_review.schema.json >/dev/null
python3 -m json.tool scripts/llm_feasibility/schemas/feasibility_manager.schema.json >/dev/null
python3 -m json.tool scripts/llm_feasibility/schemas/evergreen_review.schema.json >/dev/null
python3 -m json.tool scripts/llm_feasibility/schemas/quality_review.schema.json >/dev/null
python3 -m json.tool scripts/llm_feasibility/schemas/manager_review.schema.json >/dev/null
python3 -m json.tool scripts/llm_feasibility/schemas/rubric_repair.schema.json >/dev/null
python3 -m json.tool scripts/llm_feasibility/schemas/rubric_repair_verification.schema.json >/dev/null
python3 -m json.tool scripts/llm_feasibility/schemas/task_repair_manager.schema.json >/dev/null
python3 -m json.tool scripts/llm_feasibility/schemas/final_artifact.schema.json >/dev/null
```
