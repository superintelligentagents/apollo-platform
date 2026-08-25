---
name: review-live-web-feasibility
description: Check whether every Apollo task step can be completed on the live public web, explain problems in plain language, verify minimal suggested fixes, store read-only review artifacts in AWS, or expose those reviews through the reporting API.
---

# Review Live-Web Feasibility

Check four simple questions: is the complete task coherent and high quality; is the complete task workable on the current public web; does each step match what the original request asks for or fairly includes; and can each step be completed on the current public web? Use a logged-out browser only when a public interactive page must be inspected to answer those questions.

At task level, check only (1) coherent and high quality and (2) feasible overall. At step level, check only (1) aligned with the original request, in scope, and fair to evaluate and (2) feasible on the live public web. Do not score prose polish, verbosity, benchmark difficulty, step distinctness, or whether live answers stay the same over time. A task can enter `llm_pass` only when all four checks pass.

The default `POST_QC` mode is automated QA after human gold review. The explicit `--pre-qc` mode may inspect pending or in-review drafts early, but its results are advisory only and use isolated cache and S3 prefixes. PRE_QC never approves, rejects, promotes, or writes `llm_pass`/`llm_fail`; human QC must still produce final gold, after which POST_QC runs independently on the resulting content hash.

Every canonical step must receive exactly one independent website check and one alignment assessment. The whole task receives one quality assessment and one overall website assessment. A task cannot enter final `llm_pass` unless all steps can be completed, all steps fit the original request and are fair to evaluate, the task is coherent and high quality, the whole flow is workable, and the source is human-approved final gold. Pipeline v22 requires each passing step to cite exact original-request text and identify introduced requirements; it also fails closed when a scored step introduces a named app or service absent from the request. It retains a legacy evergreen field as `NOT_ASSESSED` for API compatibility but does not run or gate on a separate evergreen check. When a prompt asks the agent to find, compare, recommend, choose, or plan, allow a reasonable live choice to determine dependent dates, routes, prices, and steps. Dates, times, and other values produced by earlier steps are valid inputs to later steps.

Judge the requested information or action, not loyalty to one candidate website. If an exact website is not explicitly required, Google or another compatible public source is enough. A rendered Google result may count when it directly displays the requested information. A failed, blocked, or incomplete site does not make a task impossible when a reasonable alternate source provides the same result. Search beyond the first failed site and distinguish “this check could not verify it” from “an agent cannot do it.”

An isolated browser or tool render failure is not a task blocker when direct public evidence already establishes the relevant common service, data, and practical path. Record that failure as a checker limitation and retain `POSSIBLE`. The v22 orchestrator may promote a search `SHORTFALL` to effective `POSSIBLE` only when the search result explicitly marks `browser_verification.limitation_only: true`, includes direct `OK` factual verification/corroboration evidence, and the browser either errors or returns `CHECKER_TOOL` with `task_blocker: false`. Login, access, missing-data, and authored-task defects remain unresolved.

Regression rule: do not reject a Thorpe Park planning task solely because Queue Times lacks future-day per-ride averages. Queue Times publishes average queue time by ride, and Google or another compatible source may provide equivalent average-wait information. If the agent can choose the visit date and the task does not require a future prediction from one exact source, use the available average information and keep the task feasible.

## Write for human reviewers

Keep machine verdict fields unchanged because the API depends on them. Write every human-facing `summary`, `feedback`, `manager_note`, `reason`, concern, and blocker in plain language:

- Use one or two short sentences, no more than 360 characters total, and lead with the practical finding.
- Say “task,” “step,” “website,” and “page.” Do not say “rubric,” “live-web,” “worker,” “manager,” “shortfall,” “feasibility,” “compatibility,” “enumerable,” or “deterministically bounded.”
- Do not repeat enum values such as `POSSIBLE`, `IMPOSSIBLE`, `SHORTFALL`, `PASS`, or `FEASIBLE` in prose.
- Never say “critical.” Do not write a dependency essay or list every uncertain item when one concrete finding is enough.
- For a clear result, use the pattern: “An agent can complete this step. [What the checked page proves].”
- For a problem, use the pattern: “This step needs attention because [specific obstacle].” Then state what a person should verify or change.
- Explain one concrete issue once. Do not repeat the same point across summary, feedback, blockers, and task-level notes. A tool or access limitation is not proof that the task cannot be done.
- Name checked pages clearly. Keep implementation details, pipeline stages, confidence mechanics, and storage terminology out of reviewer-facing copy.

This skill is strictly read-only with respect to authored tasks and rubrics. Never edit, submit, approve, reject, promote, or otherwise mutate an original submission or final-gold task. It may create a separate review artifact containing feedback and an advisory repair plan. A repair plan may suggest at most three exact fragment edits per defective rubric and three for the whole-task prompt. Every unrelated character must remain unchanged. The orchestrator derives suggested text from those operations and rejects broad rewrites. A rubric may need repair because it is infeasible, incompatible, or both. `llm_pass` and `llm_fail` are review-artifact classifications, not task mutations.

Treat repair generation and repair publication as separate stages. A candidate revision is internal until another independent live-web worker evaluates the exact proposed rubric in the proposed combined task and returns both `POSSIBLE` with direct evidence and compatibility `PASS`. Suppress the candidate text and edit operations when either axis fails, needs human review, or errors. A whole-task prompt suggestion requires every rubric—including otherwise unchanged rubrics—to be independently rechecked in that exact proposed context; fall back to the original prompt if any one fails. Expose it only when a combined-task feasibility manager returns `FEASIBLE` and the coherence manager returns `PASS`. Never label an unresolved candidate as a revised task.

Distinguish task defects from verifier limitations. A wrong or dead named source may be replaced only with a live, directly inspected source supporting the same step. A transient outage, bot block, browser failure, or read-only worker limitation must yield `RETRY_VERIFICATION`, not a task edit. Missing personal or author-supplied facts must yield `HUMAN_INPUT_REQUIRED`; never invent them. Use `HUMAN_REVIEW_REQUIRED` when no minimal repair clearly preserves intent.

Do not override the review S3 prefixes. The runner rejects any attempt to target source-task, human-QC, or other prefixes before starting Codex or AWS writes.

## Establish prerequisites

1. Resolve the repository root with `git rev-parse --show-toplevel` and use `scripts/llm_feasibility/run.py` from that root.
2. Run `codex login status`. Stop if it is not authenticated. Confirm `npx` is available when browser escalation is enabled.
3. Confirm `APOLLO_REPORTING_TOKEN` is set without printing it. When a production reporting credential is intentionally unavailable, PRE_QC may instead use `export_pending_from_s3.mjs`; that exporter calls the backend sanitizer and writes only authored task content, canonical rubrics, task IDs, hashes, and workflow status.
4. For uploads, confirm `APOLLO_S3_BUCKET` and the intended AWS identity with a read-only identity check. Use a dedicated, least-privilege runner in AWS; never copy a local ChatGPT credential store to AWS.
5. Read `backend/REPORTING_API.md` before changing API fields or storage prefixes.

The pipeline must receive only authored task fields. Never send browsing journeys, Apollo PC mail/calendar data, participant consent, attachments, cookies, expected answers, reporting credentials, or AWS credentials into Codex prompts or worker environments.

## Run pending drafts as advisory PRE_QC

Create one sanitized local batch from the queue, inspect its counts, and plan before invoking Codex:

```bash
S3_BUCKET=journeys-prolific node scripts/llm_feasibility/export_pending_from_s3.mjs \
  --status pending \
  --output .work/llm_feasibility/pre_qc_input.json

python3 scripts/llm_feasibility/run.py \
  --input .work/llm_feasibility/pre_qc_input.json \
  --pre-qc \
  --plan \
  --no-upload
```

After a local pilot, publish the resumable batch with bounded task and rubric concurrency:

```bash
python3 scripts/llm_feasibility/run.py \
  --input .work/llm_feasibility/pre_qc_input.json \
  --pre-qc \
  --task-workers 4 \
  --workers 4 \
  --s3-bucket "$APOLLO_S3_BUCKET"
```

PRE_QC clear results are written only to `v2-review/llm_pre_qc_pass/`; all other PRE_QC outcomes go only to `v2-review/llm_pre_qc_attention/`. Claims use `v2-review/llm_pre_qc_claims/`. Cache files live below each task's `pre_qc/` directory. Never copy a PRE_QC object into final pass/fail prefixes.

## Plan before invoking models

Validate API access and normalized rubric counts without invoking Codex or AWS writes:

```bash
python3 scripts/llm_feasibility/run.py \
  --api-url 'https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/reporting/tasks?status=approved&include=full' \
  --plan \
  --no-upload
```

Inspect the reported task count, rubric count, and content hashes. Steps are canonical rubric items; use legacy success criteria only for tasks with no authored steps. Do not merge independent rubrics into one worker assignment.

## Run a pilot

Start with one exact approved task and keep artifacts local:

```bash
python3 scripts/llm_feasibility/run.py \
  --api-url 'https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/reporting/tasks?status=approved&include=full' \
  --task-id 'REPLACE_WITH_EXACT_TASK_ID' \
  --workers 4 \
  --no-upload
```

Inspect `.work/llm_feasibility/tasks/` and confirm:

- exactly one validated search-worker result exists per rubric;
- browser escalation runs only for a search-worker `SHORTFALL` with explicit target URLs and safe actions, uses the pinned Playwright MCP in an isolated logged-out context, and records `side_effects: NONE`;
- an optional browser `ERROR` or `CHECKER_TOOL` limitation does not downgrade a directly supported common public-web path; its error remains recorded in the artifact while the effective step verdict is `POSSIBLE`;
- every `POSSIBLE` verdict has a directly inspected destination URL and states what it proves;
- access limitations are explicit rather than silently treated as success;
- the feasibility manager accounts for every rubric exactly once and does no new research;
- `manager_review.quality_review` is the legacy container name for the combined task coherence/high-quality check and one alignment/fairness verdict per canonical step;
- every step quality assessment has one to three exact `request_support` excerpts when it passes, and an explicit `introduced_requirements` list;
- `manager_review.evergreen_review.verdict` is `NOT_ASSESSED` in v22 and does not affect the gate;
- the deterministic gate refuses pass when any check errors, evidence is weak, a step remains unresolved, the task is not coherent and high quality, or any step is out of scope or unfair to evaluate; an `IMPOSSIBLE` step becomes a task failure only when the overall check confirms the whole task is not workable;
- the artifact content hash matches `content.task_content_hash` from the API.
- `feedback.task` contains only whole-task feedback and `feedback.rubrics[]` contains only rubric-specific feedback;
- `repair_plan.applied_automatically` and `repair_plan.source_changed` are both false; exact edit operations preserve task flow, every exposed source replacement includes a directly inspected live URL, and every exposed rubric suggestion has `verified_possible: true` plus a completed independent `POSSIBLE` and quality-`PASS` verification;
- `repair_plan.projected_task_status` is `POSSIBLE` only when every rubric projects possible, `projected_feasibility_review.disposition` is `FEASIBLE`, and the projected coherence review passes; unresolved candidates expose no proposed task prompt;
- the artifact's copied source snapshot exactly matches the API input and the original/final-gold S3 objects were not written.

Native search verifies public information paths, but it does not always prove click-level usability of dynamic forms. The pipeline may escalate that narrow gap to its pinned isolated Playwright check. Leave access, login, missing-data, and possible task defects unresolved when safe logged-out interaction cannot establish the path. Do not downgrade a directly supported ordinary public-web flow merely because the isolated browser fails to render it. The orchestrator, not the model, binds task and step routing IDs, clears inactive browser fields, and applies the narrow non-blocking checker-limitation rule. Pipeline v22 runs an independent repair check for a step that cannot be completed or does not fit the task, followed by a non-browsing whole-task check. It separates checker limits from benchmark-agent actions, allows compatible alternate sources, allows choices delegated to the agent, and follows dependencies across ordered steps. These outputs remain suggestions and do not change the source snapshot or human-QC state.

## Publish a batch

After the pilot is sound, omit `--no-upload` and provide the bucket:

```bash
python3 scripts/llm_feasibility/run.py \
  --api-url 'https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/reporting/tasks?status=approved&include=full' \
  --workers 6 \
  --s3-bucket "$APOLLO_S3_BUCKET"
```

The run is resumable and content-addressed. A validated rubric result is reused only for the same task content hash. Concurrent pipeline processes use task locks and immutable writes under `v2-review/` so they cannot overwrite a different review. The runner has no code path that writes the original task, final-gold task, review queue, or human-QC outcome.

Publish only a task whose deterministic result is a complete manager-approved pass to:

```text
v2-review/llm_pass/{base64url(task_id)}.{task_content_hash}.{pipeline_version}.json
```

Publish failures, unresolved shortfalls, worker/browser errors, and human-verification needs to:

```text
v2-review/llm_fail/{base64url(task_id)}.{task_content_hash}.{pipeline_version}.json
```

Never place a partial, uncertain, stale, or human-attention result in `llm_pass`.

## Verify through the API

Request the exact task with `include=full`. Confirm that `llm_review_stage`, `llm_review_status`, `llm_feedback`, `llm_repair_plan`, `llm_evergreen_review`, the complete `llm_review`, the overall decision, every step result, evidence URLs, and `stale: false` are visible. Confirm again that `llm_repair_plan.applied_automatically` and `.source_changed` are false. Pending/in-review rows must say `PRE_QC`; approved rows must select only `POST_QC`. If `stale` is true, rerun the read-only review; do not relabel or change the task.

Report counts for pass, fail, needs-human-review, pipeline errors, and any rubrics that require browser verification. Keep reasoning summaries concise and structured; do not retain raw chain-of-thought or Codex event logs in the reporting API.
