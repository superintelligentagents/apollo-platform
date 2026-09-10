# PC collector parity validation — 2026-09-10

Deployed to https://apollo-pc-site.vercel.app on 2026-09-10.
Release: `2026-09-10.1`. Production returned the expected release, 17-app,
document-import, exact Dinoco/LockedIn route, and admin-workspace markers from
the deployed JavaScript. The deploy updated only the isolated PC frontend and
`journeys-pc-presign`; the primary v2 Lambda, roles, environment variables, API
Gateway, S3 layout, and DynamoDB table remained unchanged.

Deployment: https://apollo-pc-site-10jblwfji-lawrences-projects-aa5ba59b.vercel.app
Vercel deployment ID: `dpl_F8yxEiwVWEqeqFd9JiLYzs3xGFvi`.
PC Lambda code SHA-256: `GuXzERUGKcryZk29ibKyTRGDzbRY98KrrI+NlHDPF64=`.

## Capability coverage

| Area | Result and evidence |
| --- | --- |
| Mail/calendar/document import, receipt mining, source selection and filters | Browser-local PDF, DOCX, text, Markdown, CSV, JSON, and HTML extraction added. Original files never upload; document text passes through the existing selection, editing, masking, aliasing, privacy audit, and bundle split. Parser/UI tests pass, including PDF/DOCX fixtures and a 100,000-message mailbox case. |
| Field edits, replacement rules, entity aliases, privacy audit, bundle splitting | Existing PC privacy and upload tests pass. New author revisions and appeal prose are audited before outbound mutations. |
| Task discovery and authoring | All 17 live MyPCBench apps have exact autologin links, real-world analogues, category partitions, deterministic local history ranking, and complete grounded task drafts. Added region/subject metadata, shared curated examples, and metadata propagation through privacy-safe review sidecars. |
| My tasks | New list/detail screens, search/filter/sort, pagination, reviewer diffs, history, revisions, appeals, acceptance and amendments; ported author UI tests pass. Browser fixture verified desktop and 390px mobile layouts, navigation and editor controls. |
| Review | Return-to-author, rubric insertion/removal/reordering, stable source mapping, sign-off callout and session skip hints added. Existing approval/rejection contracts and new ordering/API tests pass. |
| Grade | Existing shortcuts and four outcome choices preserved. Added per-rubric lineage diffs and previous human grades; API carries both from AWS. |
| Identity | Author lookup and reviewer/creator assignment use the same protected participant ID as PC uploads. Explicit study IDs remain unchanged. |
| Runtime access | Team key is validated against PC before device-local storage. No build-time review key. Built JavaScript checked against the configured key without printing it. |
| Admin records | Email, calendar, and extracted-document counts/details are available to the same admin allowlist as v2. Document admins may edit only title and extracted text; filename, type, size, page count, ID, and uploaded original remain immutable. |

| Admin / annotator metrics | Added contributions, queue activity, reviewer quality, author outcomes, QC/sign-off progress, distribution, search/filter/pagination, details, and re-queue controls. Same seven-email allowlist as v2. PC authors now have separate stable private IDs rather than one combined redacted row. |
| Protected showcase | Current author-signed-off PC finals only; no raw context or participant fields. Revoked approvals excluded. Empty state verified. Metadata labels do not imply model classification. |

## Automated checks

- PC: 216 tests passed across 33 files.
- Shared backend: 113 tests passed.
- Apollo v2 regression: 186 passed, 1 optional real-history test skipped.
- OSWorld runner: 23 Python tests; PC context provisioner: 2 Node tests; trajectory packaging/judging: 37 Python tests.
- PC TypeScript check and production Vite build passed.
- Scoped diff whitespace check passed.

These are 577 passing tests, plus the live integration scenarios below. Unit tests
and synthetic browser fixtures do not constitute a full production participant
session or a newly executed model audit.

## Live AWS checks

Used the configured account, `journeys-pc-presign`, its PC API Gateway endpoint,
`journeys-prolific`, and `apollo-dashboard-index`. Lambda scope was `pc`, review
prefix `pc-review/`, with the separate `journeys-pc-presign-role`.

1. `validate-cross-app-review.mjs`: real signed uploads, app-specific object paths,
   completed-audit queue eligibility, own-task exclusion and unchanged sibling
   queue counts. Disposable source/marker/lock/audit objects removed.
2. `E2E_APP=pc validate-author-signoff-amend.mjs`: author list, anonymous feedback,
   acceptance receipt, author-approved final, amendment, and immutable prior gold.
   Synthetic task objects and index row cleaned up.
3. `E2E_APP=pc validate-author-appeal.mjs`: rejection notes, anonymous history,
   appeal rationale and lineage, rejection-reviewer exclusion and eligibility for
   another reviewer. The existing fixture used retired v19/v10 audit metadata;
   updated to the supported v22/v11 contract, then passed. Synthetic objects and
   index row cleaned up.
4. `validate-pc-integrations.mjs`: invalid-key and cross-app upload rejection;
   signed email, document, and manifest uploads; exact record round-trip; admin
   manifest index, document counts/detail/restricted edits, revision and conflict;
   task-matched email/document OSWorld context; assigned trajectory claim/release;
   invalid-lock and wrong-creator rejection; signed screenshot GET; model-judge
   withholding; durable human judgment and idempotent retry. All 10 synthetic
   objects deleted, with absence verified by S3 HEAD.

5. `validate-pc-admin-metrics.mjs`: task sidecar contribution count; author sign-off
   and amendment; authenticated showcase inclusion; admin detail and filtered
   list; single-task re-queue with archived decisions; pending dashboard status;
   revoked showcase exclusion; empty bulk-requeue match for the exact synthetic
   reviewer. Exact fixture objects (including re-queue archives/markers) removed
   with S3 HEAD verification; fixture DynamoDB row deleted. Non-admin metrics
   request returned 403. Final production counts returned one task and zero
   author-approved showcase entries after cleanup.

All five production scenarios passed on release `2026-09-10.1`. The integration
scenario round-tripped both an email and an extracted document, verified their
manifest counts, built exact task-matched private context from both records,
and proved document admin edits could not change immutable filename metadata.
The lifecycle harnesses now select the v2 or PC endpoint and queue from
`E2E_APP`, so PC sign-off/amendment and one-appeal routing run against the PC
service rather than relying on the sibling implementation.

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
showcase; mobile headers were corrected to stack without page overflow.
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
