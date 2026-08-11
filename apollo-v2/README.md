# Apollo v2 — Manual Long-Horizon Task Collection

Collects **long-horizon tasks** — natural requests spanning days of real browsing (plan a trip,
run a job hunt) — authored by the person whose history it is, then reviewed into a licensable
finished set. Exists because hand-authored tasks beat automatic history-chaining on quality.
v1 (`journeys-helper-tauri/`, `web_app/`) is untouched.

| | |
|---|---|
| **Live web client** | https://apollo-v2-site.vercel.app (Vercel project `apollo-v2-site`) |
| **Participant guide** | [INSTRUCTIONS.md](INSTRUCTIONS.md) |
| **Reviewer guide** | [REVIEWING.md](REVIEWING.md) |
| **History helper extension** | [`extension/`](extension/README.md) — one-click Chrome history import (store package ready, see `extension/PUBLISH.md`) |
| **Upload API** | `https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/presign` → bucket `journeys-prolific` |
| **Collection monitor** | `JourneysData/v2_dashboard.html` + `ingest_v2_long_tasks.py --watch N` |

```
apollo-v2/
  shared/     everything: clustering, themes, schema, quality, autosave, ALL screens (vanilla TS)
  tauri/      desktop shell (Tauri 2, installs beside v1, dev port 1430)
  web/        web shell (sql.js History parsing + extension bridge, dev port 5180)
  extension/  MV3 helper: reads chrome.history for the web client, nothing leaves the device
```

## What participants do

Three home cards, all soft-gated ("counts, not limits" — only hard checks: request ≥15 chars,
no unreplaced `[brackets]`, ≥1 journey or substantive step):

- **Write your own** — blank page or a blueprint (trip / job hunt / purchase / event / catalog /
  move); each filled substep becomes `task.steps[]` and seeds a success criterion. Deliverable
  picker includes free text. `shared/src/templates.ts`
- **Pick your journeys** — history grouped into journeys on-device; search/filter/date-group,
  whole-row select, sticky selection bar (count · Clear all · continue). `ui/screens/compose.ts`
- **Start from a theme** — 4-matcher ensemble (cohesion / topic / site / burst) with habitual-domain
  demotion and thread-grouping. `shared/src/themes.ts`

Everything pre-drafts; user text is never overwritten. Autosave offers **Resume** after a refresh.
A non-blocking **strength meter** scores each task (recorded as `quality_signals` for triage —
never blocks). Keyboard: `Esc` back, `⌘⏎` primary action, `/` search. The topbar counter opens
the annotator's **stats page** (per-mode/strength and review credit).

## Reviewing → the finished set

Home → "Review tasks & runs" (internal identities only; key ships in the build, verified server-side) →
**Claim the next task** → read/edit the full request, confirm it still works later, then check off or rewrite every rubric line →
**Approve → finished**.

Pending task reviews show the applicable Codex live-web pre-QC beneath the full request and beside each matching rubric. The focused panel shows task coherence, whole-task feasibility, per-rubric website reachability, and fit with the request. A missing or stale check is labelled explicitly. Failed checks expand to evidence and either an independently checked minimal revision or a reason that human repair is required. It is advisory: it never edits, approves, rejects, or promotes task content. Reviewers may explicitly copy a verified suggestion into their working copy.

A submission is not claimable until every rubric in its exact current content hash has a completed supported PRE_QC artifact. Passes and attention findings both proceed to human QC; missing, stale, partial, and pipeline-error runs remain visible only in the queue's **waiting for Codex check** count.

- **Locks**: S3 conditional writes — `If-None-Match` create, `If-Match` takeover after the 30-min
  TTL. Concurrency-tested: N racing claims → one winner each, zero double-grants.
- **Dedupe**: upload retries share a task directory; only the newest file is claimable.
- **Crash-safe**: claims + edits snapshot locally (resume after refresh); live lock countdown.
- **Credit-safe**: each approval/rejection writes an immutable, idempotent S3 receipt. Personal
  and overall totals count receipts by prefix, so retries cannot double-credit and concurrent devices
  cannot lose credit.
- **Output**: `v2-review/finished/{task_id}.json`, schema `odyssey_long_task_v2_reviewed` —
  **authored content only, provenance stripped server-side**.
- API: explicit POST routes `/review/{status,contributions,claim,release,submit,finished,reject}`
  on the presign lambda, gated by its `REVIEW_KEY` env var (rotate via
  `aws lambda update-function-configuration`). Unknown routes and non-POST methods are rejected.
  API Gateway is throttled globally, with a tighter throttle on `/presign`. Source:
  `backend/lambda_presign.js`.

## Human trajectory QC

Odysseys model-run judgments are packaged with their action stream and screenshots by
`scripts/trajectory_review/prepare.py`, then appear under **Review → Open trajectory QC**.
The grader shows the complete prompt and rubric/verifier as reference alongside the
step-by-step browser evidence. The LLM trajectory verdict is withheld to prevent bias.
Human graders label each rubric `Pass`, `Fail`, or `Unclear`. The separate final grade is
exactly `Yes`, `No`, `Edit needed`, or `Needs rerun`. `Edit needed` and `Needs rerun`
require a short explanation of what must change. This stage grades only the recorded agent
run; it does not re-score prompt quality and does not reveal the LLM judge.

Keyboard shortcuts: `←/→` move through steps, `W/S` move through rubrics, `P/O` set the
current rubric to pass/fail, `U` marks it unclear, and `Shift+Enter` submits a complete grade.
Task and trajectory queues use separate conditional locks and immutable outcome records.
See [`../QUALITY_CONTROL.md`](../QUALITY_CONTROL.md) and
[`../scripts/trajectory_review/README.md`](../scripts/trajectory_review/README.md).

## Data model & policy

- One file per task: `long_task.json`, schema `odyssey_long_task_v2` (`shared/src/schema.ts`) —
  benchmark-shaped rubric block + provenance. Lands under
  `prolific/journeys/{pid}/v2/{pid}/{session}/task-…/{ts}_long_task.json`. 4.5 MB client guard.
- **Licensing rule**: published/licensed datasets contain authored content only (request, rubrics,
  site scope) — **never raw visit provenance**. Enforced in the review lambda, stated in
  `web/public/privacy.html`, the required sign-in consent, and INSTRUCTIONS.md.
- Ingest: `JourneysData/scripts/ingest_v2_long_tasks.py` → benchmark JSONL + `v2_summary.json`
  for the dashboard.
- AWS prefixes are separated by purpose: raw v2 tasks under
  `prolific/journeys/{participant}/v2/`; queue markers under `v2-review/inbox/`, `locks/`, and
  `done/`; accepted tasks under `v2-review/finished/`; rejections under `v2-review/rejected/`;
  and immutable reviewer receipts under `v2-review/credits/`.

## Develop

```bash
cd apollo-v2 && npm install
npm test            # vitest (shared/)
npm run dev:web     # http://localhost:5180
npm run dev:tauri   # desktop
# local presign: VITE_PRESIGN_ENDPOINT=http://localhost:4000/presign npm run dev:web
```

## Deploy & ship

| What | How |
|---|---|
| Web | `npm run build -w web`, copy `web/dist/` to a clean dir linked to Vercel project `apollo-v2-site`, `npx vercel deploy --prod`. **Never** cloud-build (workspace dep breaks it). Any static host works; subpaths need `--base`. |
| Desktop DMG | `IDENTITY=… NOTARY_PROFILE=… ./scripts/build_mac_v2.sh` (repo root) — signs, notarizes, uploads; never touches v1. |
| Extension | Unpacked zip served at `/apollo-history-helper.zip`; Chrome Web Store package `extension/apollo-history-helper-store.zip` contains only store assets and code. The private signing key never ships. Steps: `extension/PUBLISH.md`. |
| Review key | `REVIEW_KEY` env on lambda `journeys-presign` validates every call; bake it into clients with `VITE_REVIEW_KEY=… npm run build -w web` (reviewers never enter it). |

## Limits worth knowing

- Chrome expires history at ~90 days — long arcs need periodic re-collection.
- Web file-drop needs Chrome quit (SQLite lock); the extension and desktop paths don't.
- Cleared localStorage resets web-side dedupe/counters (server data unaffected).
- The review queue reads an inbox index written at presign time. Submissions uploaded before
  the index existed need `scripts/backfill_inbox_markers.sh` (idempotent) or they won't appear.
- Sensitive-URL filtering (prolific/gusto) runs before anything is shown or uploaded.
