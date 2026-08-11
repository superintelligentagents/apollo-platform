# Internal task reporting API

Read-only JSON feed for Apollo V2 and Apollo PC task creation, human QC, full authored task content, and automated live-web feasibility reviews.

## Authentication

Send a bearer token in the `Authorization` header. The shared token is stored as `REPORTING_KEY`; individually revocable tokens are stored in the comma-separated `REPORTING_KEYS` Lambda variable.

```bash
export APOLLO_REPORTING_TOKEN='replace-with-your-issued-token'
export APOLLO_REPORTING_URL='https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/reporting/tasks'

curl -sS \
  -H "Authorization: Bearer $APOLLO_REPORTING_TOKEN" \
  "$APOLLO_REPORTING_URL"
```

Never put a token in a URL, browser bundle, spreadsheet, source control, or Codex worker prompt. Responses use `Cache-Control: no-store`.

## Views

The default response remains the lightweight `odyssey_internal_reporting_v1` contract. It contains aggregate counts, per-user counts, and task workflow metadata, but no authored task text.

Use `include` to opt into schema `odyssey_internal_reporting_v2`:

- `include=content` adds the complete original submission, final gold, canonical rubrics, original-versus-final rubric edits, human-QC flags, and task content hash.
- `include=llm_reviews` adds the best applicable LLM feasibility artifact, when one exists. The API first selects an artifact whose content hash matches the applicable task state (the pending/in-review draft for PRE_QC or final gold for POST_QC), then the highest numeric pipeline version, then the newest timestamp.
- `include=full` adds both.

Responses containing full authored content return one row per page so even the largest allowed task is never silently truncated or pushed over API Gateway's response limit. LLM-review-only responses accept up to 25 rows, and lightweight responses accept up to 1,000 rows. Follow `page.next_offset` until it is `null`. LLM artifact bodies are fetched only for the already-filtered rows on the requested page; the default lightweight feed never hydrates them.

### One complete task

```bash
task_id='v2/alice/internal/task-12345678'
curl -sS --get \
  -H "Authorization: Bearer $APOLLO_REPORTING_TOKEN" \
  --data-urlencode "task_id=$task_id" \
  --data-urlencode "include=full" \
  "$APOLLO_REPORTING_URL"
```

### Approved tasks for the LLM feasibility pipeline

```bash
curl -sS --get \
  -H "Authorization: Bearer $APOLLO_REPORTING_TOKEN" \
  --data-urlencode "status=approved" \
  --data-urlencode "include=content,llm_reviews" \
  --data-urlencode "limit=1" \
  --data-urlencode "offset=0" \
  "$APOLLO_REPORTING_URL"
```

Supported `status` values are `pending`, `in_review`, `approved`, and `rejected`.

## Expanded task shape

Each expanded task row includes:

```json
{
  "task_id": "v2/alice/internal/task-12345678",
  "status": "approved",
  "llm_review_status": "passed",
  "llm_review_stage": "POST_QC",
  "content": {
    "task_content_hash": "64-character sha256",
    "original": {
      "title": "Original title",
      "request": "Complete original prompt",
      "criteria": [],
      "steps": []
    },
    "final": {
      "title": "Human-reviewed title",
      "request": "Complete final-gold prompt",
      "criteria": [],
      "steps": []
    },
    "rubrics": [
      {
        "rubric_id": "rubric-1",
        "kind": "step",
        "source_index": 0,
        "title": "Find the source",
        "original": "Complete original step text",
        "final": "Complete edited step text",
        "changed": true,
        "checked": true
      }
    ],
    "human_review": {
      "evergreen_verified": true,
      "title_edited": true,
      "request_edited": true
    }
  },
  "llm_review": {
    "schema_version": "apollo-llm-feasibility-artifact-v10",
    "task_id": "v2/alice/internal/task-12345678",
    "task_content_hash": "64-character sha256",
    "status": "LLM_PASS",
    "rubric_reviews": [],
    "manager_review": {},
    "stale": false
  },
  "llm_review_result": "LLM_PASS",
  "llm_manager_disposition": "FEASIBLE",
  "llm_rubric_results": [
    {
      "rubric_id": "rubric-1",
      "effective_verdict": "POSSIBLE",
      "base_verdict": "SHORTFALL",
      "browser_status": "COMPLETED",
      "browser_verdict": "POSSIBLE",
      "manager_accepted_verdict": "POSSIBLE",
      "manager_note": "The browser check resolved the worker's interaction shortfall.",
      "feedback": "The rubric is feasible as written."
    }
  ],
  "llm_feedback": {
    "task": "Optional feedback about the whole task.",
    "rubrics": [
      {
        "rubric_id": "rubric-1",
        "feedback": "Optional feedback about only this rubric."
      }
    ]
  },
  "llm_repair_plan": {
    "schema_version": "apollo-task-repair-plan-v3",
    "applied_automatically": false,
    "source_changed": false,
    "summary": "Advisory minimal repair summary.",
    "suggested_task_prompt": null,
    "task_prompt_edit_operations": [],
    "rubric_repairs": [
      {
        "rubric_id": "rubric-1",
        "repair_kind": "REPLACE_SOURCE",
        "edit_operations": [
          {
            "operation": "REPLACE",
            "old_text": "https://old.example",
            "new_text": "https://official.example"
          }
        ],
        "suggested_rubric_text": "Complete rubric with only the source corrected.",
        "verified_replacement_urls": [
          {
            "url": "https://official.example",
            "title": "Official replacement",
            "supports": "Provides the same public function."
          }
        ],
        "verified_possible": true,
        "verification": {
          "status": "COMPLETED",
          "review": {
            "verdict": "POSSIBLE",
            "summary": "The exact proposed rubric was independently verified on the live web.",
            "evidence": [{"url": "https://official.example"}]
          },
          "error": null
        }
      }
    ],
    "all_suggested_changes_verified": true,
    "all_rubrics_projected_possible": true,
    "projected_evergreen_review": {
      "status": "NOT_REQUIRED",
      "verdict": "NOT_ASSESSED",
      "summary": "Whether the task still works later is checked by the human reviewer."
    },
    "projected_feasibility_review": {
      "status": "COMPLETED",
      "disposition": "FEASIBLE",
      "summary": "The combined proposed task is coherent and feasible."
    },
    "projected_task_status": "POSSIBLE"
  },
  "llm_evergreen_review": {
    "verdict": "NOT_ASSESSED",
    "summary": "Whether the task still works later is checked by the human reviewer.",
    "concerns": []
  }
}
```

Steps are the canonical rubric items. Legacy success criteria are used only when a task has no authored steps. `llm_review.stale` is true when the artifact's content hash no longer matches the current final-gold task and rubrics.

`llm_review_status` is the lightweight storage classification: `passed`, `needs_attention`, `stale`, or `not_reviewed`. In an expanded response, `llm_review_result` is the artifact's exact deterministic outcome (`LLM_PASS`, `LLM_FAIL`, `NEEDS_HUMAN_REVIEW`, or `PIPELINE_ERROR`), and `llm_manager_disposition` is the manager's exact feasibility disposition. `llm_rubric_results` distinguishes the base live-web verdict from any browser verdict and the final effective verdict used by the manager.

`llm_quality_review` is the legacy normalized container name. For pipeline v18 it contains task coherence and rubric compatibility only; it remains separate from `llm_manager_disposition` so consumers do not conflate logical compatibility with a reachable live-web path.

`llm_review_stage` is `PRE_QC` for advisory reviews of pending/in-review drafts and `POST_QC` for reviews of approved final gold. PRE_QC lightweight statuses are `pre_qc_passed` and `pre_qc_attention`; they never imply human approval. The API will not return a PRE_QC artifact as the applicable review for an approved task, or a POST_QC artifact for a pending draft.

`llm_feedback` is read-only review feedback. It never changes `content.original`, `content.final`, human QC, or any rubric text. When an artifact has no explicit feedback for a rubric, the manager assessment note is returned as the feedback fallback.

`llm_repair_plan` is available on pipeline-v7+ artifacts. It is read-only and always reports `applied_automatically: false` and `source_changed: false`. Repairs use exact fragment operations and an independent live-web verifier; only an exact candidate marked both live-web `POSSIBLE` and compatibility `PASS` is exposed. A proposed task-prompt change causes every rubric to be rechecked in that exact context and is suppressed if any one fails. In pipeline v18, `projected_task_status` is `POSSIBLE` only when every proposed rubric is reachable and compatible and the combined-task feasibility and coherence managers pass it. Failed candidates remain unresolved and expose no edit.

`llm_evergreen_review` remains available for legacy artifacts. Pipeline v18 returns `NOT_ASSESSED`: the Codex gate no longer runs or uses a separate evergreen axis. Older artifacts may contain `EVERGREEN`, `NOT_EVERGREEN`, or `NEEDS_HUMAN_REVIEW`.

## LLM review storage

The Codex pipeline writes one immutable, manager-reviewed artifact per task state:

- `v2-review/llm_pass/{base64url(task_id)}.{task_content_hash}.{pipeline_version}.json` only when every rubric is independently verified and the manager disposition is `FEASIBLE`.
- `v2-review/llm_fail/{base64url(task_id)}.{task_content_hash}.{pipeline_version}.json` for explicit shortfalls, browser-verification needs, worker failures, or infeasible tasks.
- `v2-review/llm_pre_qc_pass/{base64url(task_id)}.{task_content_hash}.{pipeline_version}.json` for advisory clear results on pending/in-review drafts.
- `v2-review/llm_pre_qc_attention/{base64url(task_id)}.{task_content_hash}.{pipeline_version}.json` for every other advisory PRE_QC outcome.

Versioned, content-addressed names keep old reviews immutable while allowing a changed final-gold task or a newer pipeline version to be reviewed again. The API prefers a current-content-hash artifact even when a newer stale artifact exists, then chooses the highest numeric pipeline version and newest timestamp. If no current-hash artifact exists, it returns the best historical artifact and marks it stale.

The API never exposes source browsing journeys, private Apollo PC mail/calendar records, attachments, consent records, cookies, expected answers, or Codex event logs.

### LLM task-quality fields

Pipeline v18 narrows automated QC to the requested scope, writes human-facing notes in plain language, and permits reasonable agent choices when the prompt asks the agent to find, compare, recommend, choose, or plan. Planning dates/times and intermediate outputs from earlier rubric steps are valid inputs to later steps. `manager_review.quality_review` remains the container name for backward API compatibility, but it contains:

- `task_coherence.verdict` — whether the complete task has a consistent goal and non-contradictory flow;
- `rubric_assessments[]` — one prompt-compatibility verdict, summary, and issue list per canonical rubric;
- `overall_verdict` — passes only when task coherence and every rubric compatibility assessment pass.

Realism, writing polish, difficulty, rubric distinctness, and a separate evergreen score do not gate v18. `llm_repair_plan` may contain a prompt or rubric suggestion only after the exact proposal is independently checked as live-web `POSSIBLE` and compatibility `PASS`. `applied_automatically` and `source_changed` remain false. Older artifacts remain readable through the same endpoint.

The human reviewer surface uses only pipeline v17 or newer as active guidance. Older strict-policy artifacts remain available to authenticated reporting clients for audit history but appear as not yet reviewed in the human QC panel until rerun.

## Trajectory QC feed

`GET https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/reporting/trajectories`

Uses the same bearer credential as `/reporting/tasks`.

Trajectory manifests expose each rubric's advisory `llm_status` as `SUCCESS`, `FAILURE`, or `ERROR`. `ERROR` has null `llm_score`/`llm_success` and means the provider or parser failed; it must not be counted as agent failure. Human judgments remain separate and `llm_judge_correct` is null when the LLM judge errored. Apollo withholds the LLM status and reasoning from the Grade UI until the independent human judgment is saved.

Query parameters:

- `status=pending|in_review|reviewed`
- `task_id=<exact task id>`
- `limit=<n>` and `offset=<n>`
- `include=full` (or `include=content`) to include the complete normalized run package and human judgment; full pages are capped at 10

The default response contains run identity, queue status, runner/model/run label, reviewer/timestamp, LLM aggregate score, and `human_final_grade`. New final grades are `YES`, `NO`, `EDIT_NEEDED`, or `NEEDS_RERUN`. The immutable `apollo-human-trajectory-judgment-v3` document stores that value as `trajectory.overall_outcome`; it also retains the older three-way `trajectory.task_satisfied` alias. The existing API field `human_outcome` remains unchanged for compatibility, while `human_final_grade` gives both old and new records the normalized four-way value. `EDIT_NEEDED` and `NEEDS_RERUN` require at least 10 characters in `trajectory.notes` explaining the edit or rerun.

The full response adds the task prompt, rubrics/verifiers, LLM per-rubric reasoning, normalized actions/responses, screenshot object paths (not public URLs), and the immutable human judgment. Each human rubric continues to use `SUCCESS`, `FAILURE`, or `UNJUDGEABLE`. Screenshot binaries and presigned URLs are never returned by the reporting feed.
