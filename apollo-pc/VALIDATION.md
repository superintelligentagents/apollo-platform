# PC collector parity validation — 2026-09-10

Deployed to https://apollo-pc-site.vercel.app on 2026-09-10.
Frontend release: `2026-09-10.6`. Production returned the expected unified-data,
long-horizon task, resume example, 17-app-guide, app-path, app-filter, and in-editor
document-upload markers from the deployed route chunks. Computer-use passes covered the dashboard, unified data
workspace, recommendations, exact app links, guided task editor, review/submit flow,
metrics/admin workspace, and desktop and 390px navigation. A final production
computer-use pass wrote a request and step, observed the saved status, reloaded the
page, and verified the exact draft was restored. The post-deploy browser console was
clear. The `2026-09-10.5` pass additionally imported a synthetic resume locally,
verified it was the sole relevant recommendation, opened the seven-phase LockedIn
workflow with the resume attached, confirmed draft recovery after reload, and checked
the deployed resume example and a live mail/calendar recommendation path. The
`2026-09-10.6` pass aligned rubric authoring and review with v2: a 15-character
sentence floor, no silent loss of touched short steps, mandatory verification of
every rubric plus the evergreen check, refresh-safe removal/undo, stable Codex
verdict mapping after reorder/removal, and stable reviewer IDs on approvals. The
production smoke loaded the ranked recommendation rail and all 17 guides over the
existing large local QA mailbox, opened the seven-phase LockedIn editor, and
confirmed that Review remains gated by the device-local team key. It did not submit
a task or any private record.

Deployment target: the `apollo-pc-site` production project and
https://apollo-pc-site.vercel.app alias.
The isolated PC Lambda was deployed with code SHA-256
`S28jDksNv9XpHtCw6Cfisul+ihAsMD5J2YKSbfKsVu4=`. Its function, role, scope,
review prefix, API Gateway, S3 layout, and DynamoDB table are unchanged. The primary
v2 Lambda was not deployed or modified.

The separate `apollo-showcase` Vercel project tracks `apptainer-provider`, where
its static site exists. Its project root now remains the repository root, its output
continues to point at `scripts/showcase_site/site`, and non-showcase branches are
skipped so unrelated PC pull requests do not fail on the absent showcase directory.

## Capability coverage

| Area | Result and evidence |
| --- | --- |
| Mail/calendar/document import, receipt mining, source selection and filters | One data workspace now combines file import, parsed-record review, selection, app-guided filters, privacy controls, and the submit handoff. Browser-local PDF, DOCX, text, Markdown, CSV, JSON, and HTML extraction is supported. Original files never upload; document text passes through the existing editing, masking, aliasing, privacy audit, and bundle split. |
| Field edits, replacement rules, entity aliases, privacy audit, bundle splitting | Existing PC privacy and upload tests pass. New author revisions and appeal prose are audited before outbound mutations. |
| Task recommendations and authoring | **Write tasks** uses all 17 live MyPCBench apps as writing guidelines and record filters, with exact autologin links, real-world analogues, category partitions, deterministic local history ranking, and complete grounded drafts. Each guide now proposes a connected two-to-four-app path and a seven-phase task that establishes evidence, confirms current logged-in state, performs app-specific work, reconciles related apps, and verifies the final state. Matching records are selected across mail, calendar, and documents instead of letting one high-volume source crowd out the others. The editor also imports documents in place and automatically attaches the imported records. |
| Resume example | **Examples** leads with an actionable resume workflow: upload a resume, build a grounded LockedIn task, reconcile newer recruiting mail and the next 30 days of calendar events, prepare unsent follow-ups, and produce an evidence-backed change log. With a matching document already present, the action opens the prefilled task directly. |
| Draft durability | Authoring data is stored in IndexedDB with a synchronous local-storage mirror for lifecycle flushes and migration from older browser-only drafts. The editor reports saving, saved, and failed states, writes on edits, and flushes when the page hides. IndexedDB quota failure and migration are covered by tests; production computer use verified save and reload recovery. |
| My tasks | New list/detail screens, search/filter/sort, pagination, reviewer diffs, history, revisions, appeals, acceptance and amendments; ported author UI tests pass. Browser fixture verified desktop and 390px mobile layouts, navigation and editor controls. |
| Review | Return-to-author, rubric insertion/removal/reordering/undo, stable source and Codex-result mapping, sign-off callout and session skip hints added. Approval is blocked unless at least one rubric exists, every rubric is verified after its latest edit, and the evergreen check is confirmed. The API client repeats those gates, and approvals carry the stable reviewer ID used by team metrics. Existing approval/rejection contracts and the ordering, persistence, attribution, and enforcement tests pass. |
| Grade | Existing shortcuts and four outcome choices preserved. Added per-rubric lineage diffs and previous human grades; API carries both from AWS. |
| Identity | Author lookup and reviewer/creator assignment use the same protected participant ID as PC uploads. Explicit study IDs remain unchanged. |
| Runtime access | Team key is validated against PC before device-local storage. No build-time review key. Built JavaScript checked against the configured key without printing it. |
| Admin records | Email, calendar, and extracted-document counts/details are available to the same admin allowlist as v2. Document admins may edit only title and extracted text; filename, type, size, page count, ID, and uploaded original remain immutable. |
| Runtime performance | The initial production JavaScript fell from 348.57 KB (110.75 KB gzip) to 62.80 KB (22.19 KB gzip), an 82% raw and 80% gzip reduction. Larger workspaces and PDF extraction load on demand. App recommendations make one bounded pass over history, email-service classification is cached per record, imported records persist in 2,000-record transactions, and entity indexing finishes after the import becomes usable. Three cold 100,000-message runs completed in about 2.2 seconds each, safely below the 4-second recommendation and 1.5-second search limits. Hash-named JavaScript assets return `Cache-Control: public, max-age=31536000, immutable`; HTML continues to revalidate. |
| Concurrent author history | Each global task row has an author-scoped DynamoDB mirror. `My tasks` queries that prefix and reads S3 only for the requested page, so hundreds of annotators do not force a table scan or full task hydration. Optimistic revisions protect overlapping registration, review, appeal, sign-off, amendment, and re-queue updates. A readiness marker keeps the legacy path available until a verified backfill completes. |

| Admin / annotator metrics | Added contributions, queue activity, reviewer quality, author outcomes, QC/sign-off progress, distribution, search/filter/pagination, details, and re-queue controls. Same seven-email allowlist as v2. PC authors now have separate stable private IDs rather than one combined redacted row. |
| Protected showcase | Current author-signed-off PC finals only; no raw context or participant fields. Revoked approvals excluded. Empty state verified. Metadata labels do not imply model classification. |

## Automated checks

- PC: 229 tests passed across 37 files.
- Shared backend: 116 tests passed.
- Apollo v2 regression: 186 passed, 1 optional real-history test skipped.
- OSWorld runner: 23 Python tests; PC context provisioner: 2 Node tests; trajectory packaging/judging: 37 Python tests.
- PC TypeScript check and production Vite build passed.
- Scoped diff whitespace check passed.

These are 593 passing tests, plus the live integration scenarios below. Unit tests
and synthetic browser fixtures do not constitute a full production participant
session or a newly executed model audit.

## Live AWS checks

Used the configured account, `journeys-pc-presign`, its PC API Gateway endpoint,
`journeys-prolific`, and `apollo-dashboard-index`. Lambda scope was `pc`, review
prefix `pc-review/`, with the separate `journeys-pc-presign-role`.

1. `validate-cross-app-review.mjs`: real signed uploads, app-specific object paths,
   completed-audit queue eligibility, own-task exclusion and unchanged sibling
   queue counts. Disposable source/marker/lock/audit objects and both global and
   author-scoped DynamoDB rows removed; a post-run scan found zero fixture rows.
2. `E2E_APP=pc validate-author-signoff-amend.mjs`: author list, anonymous feedback,
   acceptance receipt, author-approved final, amendment, and immutable prior gold.
   Synthetic task objects and both index rows cleaned up.
3. `E2E_APP=pc validate-author-appeal.mjs`: first rejection notes, anonymous
   history, one appeal rationale and lineage, rejection-reviewer exclusion, a new
   reviewer, terminal second rejection, final author visibility, and enforcement
   of the one-appeal limit. Synthetic objects and both index rows cleaned up.
4. `validate-pc-integrations.mjs`: invalid-key and cross-app upload rejection;
   signed email, document, and manifest uploads; exact record round-trip; admin
   manifest index, document counts/detail/restricted edits, revision and conflict;
   completion tokens and indexed task registration; contribution metrics;
   task-matched email/document OSWorld context; assigned trajectory claim/release;
   invalid-lock and wrong-creator rejection; signed screenshot GET; model-judge
   withholding; durable human judgment and idempotent retry. All 14 synthetic
   objects deleted, with absence verified by S3 HEAD.

5. `validate-pc-admin-metrics.mjs`: task sidecar contribution count; indexed
   sign-off queue; author sign-off
   and amendment; authenticated showcase inclusion; admin detail and filtered
   list; single-task re-queue with archived decisions; pending dashboard status;
   revoked showcase exclusion; fresh bulk re-queue after a lifecycle mutation.
   Exact fixture objects (including re-queue archives/markers) removed
   with S3 HEAD verification; both fixture DynamoDB rows deleted. Non-admin metrics
   request returned 403. Final production counts returned one task and zero
   author-approved showcase entries after cleanup.

6. `validate-pc-load.mjs`: 200 simultaneous, read-only author-history requests
   against the author-scoped production endpoint returned 200 HTTP 200 responses,
   with zero retries, 1.47-second p95 latency, 1.92-second maximum latency, and
   1.95 seconds of total wall time. The probe creates no records and fails if any
   request remains unsuccessful after one safe read retry or p95 exceeds 5 seconds.

All five production lifecycle/integration scenarios and the load probe passed
against frontend release `2026-09-10.4` and the PC Lambda SHA recorded above. The integration
scenario round-tripped both an email and an extracted document, verified their
manifest counts, built exact task-matched private context from both records,
and proved document admin edits could not change immutable filename metadata.
The lifecycle harnesses now select the v2 or PC endpoint and queue from
`E2E_APP`, so PC sign-off/amendment and one-appeal routing run against the PC
service rather than relying on the sibling implementation.

The PC dashboard index backfill was run in write mode after the live scenarios. It
converted the one current source task, wrote one matching author row, removed zero
stale rows, and verified zero mismatches before writing the readiness marker. The PC
admin endpoint serves verified DynamoDB records directly because the deliberately
restricted PC role cannot list the shared S3 bucket. Bulk re-queue bypasses the
short-lived dashboard cache so a just-completed lifecycle mutation is immediately
visible to the operation.

The live smoke tests use synthetic records, synthetic trajectory evidence, and
synthetic completed-audit artifacts. They do not invoke a model or claim real
participants' review work. Review approval/rejection/return and the other grading
outcomes are covered by local contracts rather than live production mutations.

## Reproduction

```sh
npm test --prefix apollo-pc
npm run typecheck --prefix apollo-pc
npm run build:web --prefix apollo-pc
npm test --prefix backend
npm test --prefix apollo-v2
python3 -m unittest discover -s scripts/trajectory_review -p 'test_*.py'

# Supply credentials through the environment; never commit or print them.
node scripts/e2e/validate-cross-app-review.mjs
E2E_APP=pc node scripts/e2e/validate-author-signoff-amend.mjs
E2E_APP=pc node scripts/e2e/validate-author-appeal.mjs
node scripts/e2e/validate-pc-integrations.mjs
E2E_ADMIN_EMAIL=<allowed-admin-email> node scripts/e2e/validate-pc-admin-metrics.mjs
node scripts/e2e/validate-pc-load.mjs
```

Live scripts need `E2E_PC_REVIEW_KEY`, configured AWS credentials, and optionally
`E2E_ADMIN_EMAIL` for the PC record admin checks. Cross-app validation also needs
`E2E_V2_REVIEW_KEY`. Scripts target production by default and remove their own
fixtures in `finally` blocks.

For browser fixtures, run `node scripts/e2e/fixture-pc-parity-ui.mjs`, start the PC
Vite server, and open `/pc-parity-qa.html`. Remove that generated HTML after QA;
it must not be published. It uses mocked API responses and synthetic identities.
For metrics QA, use `fixture-pc-admin-ui.mjs` and `/pc-admin-qa.html` instead.
Both generated fixture pages were removed before building. Desktop/mobile
inspection covered the quality tabs, search results, task details and empty
showcase; mobile headers were corrected to stack without page overflow. A second
synthetic computer-use fixture exercised data filters, a grounded task, document
attachment, privacy review, mocked submit, uploaded counts, annotator metrics, and
the same-admin dashboard. Programmatic native file selection was unavailable in the
Chrome extension and in-app browser; parser/import behavior remains covered by the
automated file tests, and production exposed the expected chooser controls.
Screenshots are in `../artifacts/pc-parity-2026-09-08/`.

## Scope

PC collection and record administration remain distinct from v2's browsing-history
import, extension, and Tauri shell. Email/calendar/document recommendations,
author/reviewer/grader workflows, and the admin dashboard are available in PC.
PC showcase categories use author
metadata; the v2 model-classified public corpus is not copied into PC. PC task
examples stay admin-gated. Contacts and WhatsApp remain hidden development
features, outside production collection scope. Runtime keys retain the existing
internal-team access model. No SSO or AWS permission changes were introduced.
