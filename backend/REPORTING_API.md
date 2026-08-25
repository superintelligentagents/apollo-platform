# Internal task reporting API

Read-only JSON feed for Apollo V2 and Apollo PC task creation, human QC, full authored task content, and automated live-web feasibility reviews.

Each deployment reports only its own review root:

| App | Tasks endpoint | Trajectories endpoint | Review root |
|---|---|---|---|
| V2 | `https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/reporting/tasks` | `https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/reporting/trajectories` | `v2-review/` |
| PC | `https://t1ynh195m1.execute-api.us-east-1.amazonaws.com/reporting/tasks` | `https://t1ynh195m1.execute-api.us-east-1.amazonaws.com/reporting/trajectories` | `pc-review/` |

Do not combine a token/URL from one deployment with a worker configured for the other queue. Workers additionally reject cross-queue task IDs before writing.

## Authentication

Send a bearer token in the `Authorization` header. Each Lambda's primary token is stored as `REPORTING_KEY`; individually revocable tokens are stored in the comma-separated `REPORTING_KEYS` variable.

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
- `include=llm_flags` adds a compact summary of which Codex checks fired (`llm_flag_count`, `llm_flags`, `llm_result`, `llm_rubrics_infeasible`, `llm_rubrics_misaligned`, `llm_has_repair_plan`) without shipping the whole artifact. `llm_flags` values: `website_feasibility` (a rubric's public-web check was not POSSIBLE), `step_alignment` (a rubric's scope/fairness check was not PASS), `task_quality` (task coherence was not PASS), `overall_feasibility` (the manager did not find a workable public-web path).
- `include=full` adds content, LLM reviews, and LLM flags.

### Freshness

Responses are served from a dashboard snapshot rebuilt every 5 minutes (`snapshot_built_at` on the response says when; `null` means it was built live for this request). Human-QC decisions therefore appear in the feed within ~5 minutes. Admin review actions and the queue itself are not affected — only this read feed.

### Paging

Every response carries the same `page` object: `{ offset, limit, returned, next_offset, filtered_total }`. Follow `page.next_offset` until it is `null`. `truncated` is `true` whenever the response does not contain every matching row — either because the source listing was capped or because this is one page of several — so anything that trusts `truncated` sees the whole corpus before calling itself complete.

Page caps by view (the `limit` you pass is clamped to these):

| View | Default `limit` | Max `limit` | Notes |
|---|---|---|---|
| lightweight (no `include`) | 5,000 | 5,000 | one page holds the whole corpus today |
| `include=content` | 100 | 150 | prompt + rubrics per row, ~20 KB each (150 rows ≈ 3 MB; the Lambda response limit is 6 MB) |
| `include=llm_flags` | 200 | 200 | reads each artifact server-side, emits only the summary |
| `include=llm_reviews` / `include=full` | 10 | 25 | full ~30 KB artifacts per row |

LLM artifact bodies are fetched only for the already-filtered rows on the requested page; the default lightweight feed never hydrates them.

### All task content, task-keyed (for duplicate detection, distribution, spot checks)

```bash
offset=0
while :; do
  page="$(curl -sS --get \
    -H "Authorization: Bearer $APOLLO_REPORTING_TOKEN" \
    --data-urlencode "include=content" \
    --data-urlencode "limit=150" \
    --data-urlencode "offset=$offset" \
    "$APOLLO_REPORTING_URL")"
  printf '%s\n' "$page" > ".reporting/content-$offset.json"   # local only, chmod 600, gitignored
  offset="$(printf '%s' "$page" | python3 -c 'import json,sys; print(json.load(sys.stdin)["page"]["next_offset"] or "")')"
  [ -n "$offset" ] || break
done
```

Each row's `content.original` / `content.final` hold the complete request text plus `steps[]` (title + description — the description is the rubric requirement) and `content.rubrics[]` the canonical rubric list with original-vs-final text. This is the same material the trajectories feed returns, keyed on tasks instead of runs, so it covers every task whether or not a trajectory exists.

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

## Lightweight row fields

Every row (any view) carries this metadata. None of it is authored task text.

| Field | Meaning |
|---|---|
| `task_id`, `mode`, `status`, `qc_completed` | workflow identity/state; `status` ∈ pending / in_review / approved / rejected |
| `participant_id` | the account that submitted |
| `canonical_participant_id` | `participant_id` after the admin alias map (`{review-root}config/participant_aliases.json`, `{alias: canonical}`), so duplicate accounts roll up to one trainer |
| `participant_name` | one stable display name per account — the most frequent spelling across that account's rows (capitalized spelling wins ties); `participant_name_raw` is the spelling on this submission |
| `participant_email` | as entered on the submission |
| `authoring_started_at`, `created_at`, `authoring_minutes` | `authoring_started_at` = when the participant chose a mode and started the draft (client clock, recorded from 2026-08-20; older rows `""`); `created_at` = when the draft was assembled for submission (payload `created_at`, identical to `submitted_at`); `authoring_minutes` = the difference, i.e. real authoring time for the AHT question (`null` when the start is unknown) |
| `uploaded_at` | server-minted upload time from the S3 object key |
| `anchored_country`, `subjects` | the "About this task" picks (effective = final gold when reviewed, else the submission) |
| `reviewer`, `claimed_at`, `reviewed_at`, `review_minutes` | who decided, when the lock was taken, when the decision landed, and the difference in minutes. `claimed_at` is recorded at decision time from 2026-08-20 onward; older reviews have `claimed_at: ""` and `review_minutes: null` |
| `changed_in_qc`, `title_edited`, `request_edited`, `rubric_count`, `rubrics_edited`, `rubrics_edited_ids` | how much the reviewer actually changed |
| `skip_count`, `skipped_by` | how many times reviewers claimed and released this task before a decision, and who (recorded from 2026-08-20 onward) |
| `rejection_reason` | free text when rejected |
| `trajectory_count`, `visit_count` | provenance volume (counts only) |
| `llm_review_status`, `llm_review_stage` | the artifact applicable to the task's *current* workflow state: PRE_QC while pending/in_review, POST_QC once approved/rejected. Values `not_reviewed` / `pre_qc_passed` / `pre_qc_attention` / `passed` / `needs_attention` / `stale`. Because decided tasks switch to POST_QC, an approved task with no POST_QC run reads `not_reviewed` here even though Codex pre-checked it — use `llm_pre_qc_status` for that |
| `llm_pre_qc_status` | the Codex pre-QC outcome regardless of workflow state (`pre_qc_passed` / `pre_qc_attention` / `stale` / `not_reviewed`), judged against the content as submitted. `not_reviewed` means Codex never ran on the draft — it is not a clean result. Since the pre-QC gate, pending tasks without a current pre-QC result are not claimable, so such a task is either waiting for Codex or was reviewed before the gate existed |

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

`llm_quality_review` is the legacy normalized container name. For pipeline v22 it contains task coherence and rubric compatibility only; it remains separate from `llm_manager_disposition` so consumers do not conflate logical compatibility with a reachable live-web path. Each rubric assessment includes exact `request_support` excerpts and any `introduced_requirements` found during alignment review.

`llm_review_stage` is `PRE_QC` for advisory reviews of pending/in-review drafts and `POST_QC` for reviews of approved final gold. PRE_QC lightweight statuses are `pre_qc_passed` and `pre_qc_attention`; they never imply human approval. The API will not return a PRE_QC artifact as the applicable review for an approved task, or a POST_QC artifact for a pending draft.

`llm_feedback` is read-only review feedback. It never changes `content.original`, `content.final`, human QC, or any rubric text. When an artifact has no explicit feedback for a rubric, the manager assessment note is returned as the feedback fallback.

`llm_repair_plan` is available on pipeline-v7+ artifacts. It is read-only and always reports `applied_automatically: false` and `source_changed: false`. Repairs use exact fragment operations and an independent live-web verifier; only an exact candidate marked both live-web `POSSIBLE` and compatibility `PASS` is exposed. A proposed task-prompt change causes every rubric to be rechecked in that exact context and is suppressed if any one fails. In pipeline v22, `projected_task_status` is `POSSIBLE` only when every proposed rubric is reachable and compatible and the combined-task feasibility and coherence managers pass it. Failed candidates remain unresolved and expose no edit.

`llm_evergreen_review` remains available for legacy artifacts. Pipeline v18 returns `NOT_ASSESSED`: the Codex gate no longer runs or uses a separate evergreen axis. Older artifacts may contain `EVERGREEN`, `NOT_EVERGREEN`, or `NEEDS_HUMAN_REVIEW`.

## Review and author-stage timing

Every row carries the stored timestamps used for timing and the minutes derived
from them. Durations are always computed server-side from two timestamps; a
duration sent by a client is never stored.

| Field | Derived from | Meaning |
|---|---|---|
| `review_minutes` | `reviewed_at` − `claimed_at` | Human-review duration. Rows finished before claim timestamps were retained report `null`. |
| `signoff_minutes` | `signoff_at` − the author's open stamp | Time spent reading the review before accepting or amending. |
| `author_edit_minutes` | `submitted_at` − `edit_started_at` | Time spent self-editing an open task. |
| `appeal_minutes` | `submitted_at` − `appeal_started_at` | Time spent revising after a rejection. |

`signoff_action` is `accepted` or `amended`, and is empty while a task still
awaits its author. `appeal_number` is 0 for an ordinary submission and 1 for the
single permitted appeal. `final_gold_revision` starts at 1 for reviewer gold and
increases with each author amendment.

Negative spans or spans longer than 24 hours report `null`, so an old tab or bad
client clock does not become a timing data point.

## LLM review storage

The Codex pipeline writes one immutable, manager-reviewed artifact per task state:

- `{review-root}/llm_pass/{base64url(task_id)}.{task_content_hash}.{pipeline_version}.json` only when every rubric is independently verified and the manager disposition is `FEASIBLE`.
- `{review-root}/llm_fail/{base64url(task_id)}.{task_content_hash}.{pipeline_version}.json` for explicit shortfalls, browser-verification needs, worker failures, or infeasible tasks.
- `{review-root}/llm_pre_qc_pass/{base64url(task_id)}.{task_content_hash}.{pipeline_version}.json` for advisory clear results on pending/in-review drafts.
- `{review-root}/llm_pre_qc_attention/{base64url(task_id)}.{task_content_hash}.{pipeline_version}.json` for every other advisory PRE_QC outcome.

Versioned, content-addressed names keep old reviews immutable while allowing a changed final-gold task or a newer pipeline version to be reviewed again. The API prefers a current-content-hash artifact even when a newer stale artifact exists, then chooses the highest numeric pipeline version and newest timestamp. If no current-hash artifact exists, it returns the best historical artifact and marks it stale.

The API never exposes source browsing journeys, private Apollo PC mail/calendar records, attachments, consent records, cookies, expected answers, or Codex event logs.

### LLM task-quality fields

Pipeline v22 narrows automated QC to the requested scope, writes human-facing notes in plain language, and permits reasonable agent choices when the prompt asks the agent to find, compare, recommend, choose, or plan. Planning dates/times and intermediate outputs from earlier rubric steps are valid inputs to later steps. `manager_review.quality_review` remains the container name for backward API compatibility, but it contains:

- `task_coherence.verdict` — whether the complete task has a consistent goal and non-contradictory flow;
- `rubric_assessments[]` — one prompt-compatibility verdict, summary, issue list, exact `request_support`, and `introduced_requirements` list per canonical rubric;
- `overall_verdict` — passes only when task coherence and every rubric compatibility assessment pass.

Realism, writing polish, difficulty, rubric distinctness, and a separate evergreen score do not gate v22. A pass is rejected if its request support is not a literal excerpt, if it reports an introduced requirement, or if the scored step names an app or service absent from the request. `llm_repair_plan` may contain a prompt or rubric suggestion only after the exact proposal is independently checked as live-web `POSSIBLE` and compatibility `PASS`. `applied_automatically` and `source_changed` remain false. Older artifacts remain readable through the same endpoint.

The human reviewer surface uses only pipeline v22 or newer as active guidance. Older artifacts remain available to authenticated reporting clients for audit history but appear as not yet reviewed in the human QC panel until rerun.

## Trajectory QC feed

Use the matching `/reporting/trajectories` endpoint from the deployment table at
the top of this document.

Uses the same bearer credential as `/reporting/tasks`.

Trajectory manifests expose each rubric's advisory `llm_status` as `SUCCESS`, `FAILURE`, or `ERROR`. `ERROR` has null `llm_score`/`llm_success` and means the provider or parser failed; it must not be counted as agent failure. Human judgments remain separate and `llm_judge_correct` is null when the LLM judge errored. Apollo withholds the LLM status and reasoning from the Grade UI until the independent human judgment is saved.

Query parameters:

- `status=pending|in_review|reviewed`
- `task_id=<exact task id>`
- `limit=<n>` and `offset=<n>`
- `include=full` (or `include=content`) to include the complete normalized run package and human judgment; full pages are capped at 10
- `include=osworld` to add `osworld_task` to every row: the original task rendered as a stock OSWorld task config (see below). Composable with `include=full` (`include=full,osworld`).
- `format=osworld` to receive the whole set as the OSWorld export bundle instead of rows (see below). Accepts the same `status`/`task_id`/`limit`/`offset` filters plus `grade=any` and `snapshot=<name>` (default `chrome`).

The default response contains run identity, queue status, runner/model/run label, reviewer/timestamp, LLM aggregate score, and `human_final_grade`. New final grades are `YES`, `NO`, `EDIT_NEEDED`, or `NEEDS_RERUN`. The immutable `apollo-human-trajectory-judgment-v3` document stores that value as `trajectory.overall_outcome`; it also retains the older three-way `trajectory.task_satisfied` alias. The existing API field `human_outcome` remains unchanged for compatibility, while `human_final_grade` gives both old and new records the normalized four-way value. `EDIT_NEEDED` and `NEEDS_RERUN` require at least 10 characters in `trajectory.notes` explaining the edit or rerun.

Trajectory Grade is assigned to the task's original creator. A new package
must therefore include `manifest.creator_pid` (current Apollo task IDs can be
used to infer it; legacy external IDs require `prepare.py --creator-map`). An
`EDIT_NEEDED` judgment creates a linked additive revision in the normal task
Review pipeline after Codex live audit; it does not overwrite the source task,
accepted gold, run, or judgment. `NEEDS_RERUN` waits for a new immutable run
package.

### OSWorld-style task view

The API can render each Apollo task in stock OSWorld shape so teammates get the
original task set without a checkout or the offline exporter. Two entry points,
both built server-side from the immutable manifest + human judgment:

**Per row — `include=osworld`.** Every trajectory row gains `osworld_task`, for
any grade status:

```json
{
  "id": "28272d35-4acf-5465-94b6-d9b4acf3a715",
  "snapshot": "chrome",
  "instruction": "Complete original task prompt",
  "source": "Apollo",
  "config": [ {"type": "launch", "parameters": {"command": ["google-chrome", "--remote-debugging-port=1337"]}}, "…" ],
  "trajectory": "trajectories/",
  "related_apps": ["chrome"],
  "evaluator": { "func": "is_expected_url_pattern_match", "…": "inert; Apollo grades via rubrics, not result.txt" },
  "proxy": false, "fixed_ip": false, "possibility_of_env_change": "low",
  "apollo": {
    "schema_version": "apollo-osworld-export-v1",
    "task_id": "0106b570…", "creator_pid": "alice",
    "run_id": "3b302820…", "manifest_key": "v2-review/trajectory-runs/…/manifest.json",
    "status": "reviewed", "human_final_grade": "YES", "human_pass": true,
    "accepted_run_id": "3b302820…", "accepted_manifest_key": "…",
    "human_reviewed_at": "2026-08-15T00:00:00Z",
    "rubrics": [ {"rubric_id": "rubric-1", "requirement": "…", "verification": "…"} ],
    "evaluation": "Run scripts/trajectory_review/run.py and complete Apollo human Grade; ignore OSWorld result.txt."
  }
}
```

`id` is `uuid5(APOLLO_OSWORLD_NAMESPACE, task_id)` — identical to the id
`export_osworld.py` writes, so API and offline outputs line up. `human_pass` is
true only for a complete affirmative grade (reviewed, `YES`, every rubric
human-marked `SUCCESS`); `accepted_*` are populated only then. LLM verdicts are
never copied into the runner config; use `include=full` for those.

**Whole set — `format=osworld`.** Returns the same bundle the exporter writes
to disk, in one response:

```bash
# drop-in equivalent of export_osworld.py: newest accepted human pass per task
curl -sS -H "Authorization: Bearer $APOLLO_REPORTING_TOKEN" \
  "https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/reporting/trajectories?format=osworld"

# every task currently in the trajectory queue, regardless of grade
curl -sS -H "Authorization: Bearer $APOLLO_REPORTING_TOKEN" \
  "https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/reporting/trajectories?format=osworld&grade=any"
```

```json
{
  "schema_version": "apollo-osworld-export-v1",
  "generated_at": "…",
  "snapshot": "chrome",
  "selection": "latest_accepted_human_pass_per_task",
  "exported": 12,
  "task_ids": ["…"], "osworld_ids": ["…"],
  "tasks": [ "…one OSWorld task per Apollo task — this is tasks.json / examples/chrome/<id>.json…" ],
  "test_apollo": { "chrome": ["…every osworld id…"] },
  "native_result_txt_is_authoritative": false,
  "page": { "offset": 0, "limit": 200, "returned": 12, "filtered_total": 12, "next_offset": null }
}
```

`tasks` is `tasks.json`; write each element to `examples/<snapshot>/<id>.json`
and `test_apollo` to `test_apollo.json` to reproduce the stock OSWorld layout.
One task per Apollo task id (newest run wins, by `reviewed_at` then `run_id`).
`test_apollo` always lists every selected id even when `tasks` is paged.

Human-passed rows can also be converted offline using
`scripts/trajectory_review/export_osworld.py`. The exporter pages this endpoint
with `status=reviewed&include=full`, keeps only `YES` rows whose every rubric is
human-marked `SUCCESS`, and writes `tasks.json` plus the stock OSWorld
`examples/chrome/` and `test_apollo.json` layout. LLM verdicts are not copied
into those runner configs.

The full response adds the task prompt, rubrics/verifiers, LLM per-rubric reasoning, normalized actions/responses, screenshot object paths (not public URLs), and the immutable human judgment. Each human rubric continues to use `SUCCESS`, `FAILURE`, or `UNJUDGEABLE`. Screenshot binaries and presigned URLs are never returned by the reporting feed.
