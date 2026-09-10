# Apollo PC — Personal-Context Collector

The web client includes separate top-level **Review** and **Grade** workspaces. Review uses the PC-only `pc-review/` task-QC queue, shows the full request and completed Codex live-web feedback, keeps the original and reviewed task versions separate, and allows edits only in the human working copy. Grade uses the separate PC trajectory queue: it shows recorded steps/screenshots, each rubric, and the overall task-satisfaction judgment while hiding the LLM judge from graders.

Tasks are not claimable in either Apollo client until a supported Codex PRE_QC run has completed every rubric for the exact current content hash. The Review queue shows these submissions as **waiting for Codex check**. Keyboard shortcuts in Grade are `←/→` for trajectory steps, `W/S` for rubrics, `P/O` for pass/fail, and `U` for unclear.

Collects **real, consented, redacted personal context** from email, calendar, and locally
extracted documents, including orders mined from receipt emails, plus participant-authored
agent tasks grounded in that data.
Contact and WhatsApp parsers exist behind hidden development flags but are not participant-facing
or part of the current production collection scope.

Sibling of `apollo-v2/` (browsing-history collector). It shares reviewed backend source, the S3
bucket, and the design language, but production uses a separate API, Lambda role, upload scope,
and `pc-review/` queue. The workspace is standalone and does not import `@odyssey/shared`.

## How it works

1. **Import** — participants export their own email (`.mbox`) and calendar (`.ics`) data, or
   add PDF, Word, text, Markdown, CSV, JSON, or HTML documents. Parsing is 100% in-browser;
   original document files never upload. A date-window select
   (default 12 months) drops older records *at parse time*. Email bodies are truncated
   (5 KB head+tail), extracted document text is capped at 200 KB, attachments are reduced to
   metadata, and selected records are stored in IndexedDB.
2. **Review & redact** — all imported email is selected by default; per-item and filtered
   bulk controls can keep anything private. Field editing, entity aliases, replacement rules,
   and the direct-identifier/credential mask layer apply only to the upload copy.
3. **People & entities** — recurring people are detected across imported sources and
   pseudonymized with **one consistent alias per person** so cross-source
   correlation survives. Merchants keep real names. The real→alias map **never uploads**.
4. **Discover tasks** — local email/calendar/document signals rank all 17 apps in the live
   MyPCBench catalog. App and category filters partition history by its closest real-world
   analogue. Each recommendation first opens the exact autologin app route, then creates a
   complete prefilled task with the matching `referenced_record_ids`. Five generic templates
   remain available.
5. **Submit** — records and tasks serialize through `redact.ts` (edits → rules → masks → aliases),
   then an independent bundle-wide privacy audit fails closed on unapproved PII. Passing files
   split into `records_{kind}[_partN].json` files under the 5 MB presign cap, uploaded
   sequentially, followed by `manifest.json`. Privacy-safe task sidecars upload only after the
   complete bundle; only those sidecars create PC task-review inbox markers. An interrupted or
   incomplete bundle therefore never creates a claimable task.

Schema: `odyssey_personal_context_v1`. S3 layout:
`prolific/journeys/{pid}/pc/{pid}/internal/bundle-{id}/{ts}_{filename}`.

## Current workflow parity (September 2026)

**My tasks** now provides paged submission status, search/filter/sort, a dedicated
feedback page, reviewer diffs, revision history, author edits, one eligible appeal,
and acceptance or amendment of approved tasks. Revisions and appeal reasons pass
the PC privacy audit before submission. Author lookup and creator-assigned grading
use the same protected participant ID as bundle uploads.

Review supports return-to-author, insertion/removal/reordering of rubrics, and
session skips. Grade displays available task-edit lineage and previous human
rubric judgments while keeping the model judge hidden. PC retains its mail,
calendar, document, aliasing, redaction, and record-admin workspaces.

Team review access is now entered through **Connect review tools** in My tasks,
Review, Grade, or the admin submissions page. It is stored on that device and
validated against the PC API. `VITE_REVIEW_KEY` is no longer consumed or compiled
into public assets. Existing devices need to enter the team key once after this
upgrade. The endpoint can still be configured with `VITE_PRESIGN_ENDPOINT`.

Validation details and the distinction between live tests and fixture tests are
in [`VALIDATION.md`](./VALIDATION.md).

## Dev

```bash
npm install
npm test              # vitest (parsers, aliasing, scrub, splitting)
npm run typecheck
npm run dev:web       # port 5181; set VITE_PRESIGN_ENDPOINT=http://localhost:4000/presign
                      # and run `node ../backend/server.js` for a local presign API
npm run build:web
```

## Deploy

Build locally (`npm run build:web`), then stage `web/dist` as a Vercel Build
Output API v3 static output for the existing `apollo-pc-site` project. Deploy
with `vercel deploy --prebuilt --prod --yes`. The remote project root is
`apollo-pc`, so the clean staging directory must also contain
`apollo-pc/.vercel/output` and the same `.vercel/project.json`. Keep source,
`.env` files, review keys, and synthetic QA HTML out of the staging directory.

Production PC traffic uses the isolated `journeys-pc-presign` Lambda at
`https://t1ynh195m1.execute-api.us-east-1.amazonaws.com/presign`, with
`APP_SCOPE=pc` and `REVIEW_PREFIX=pc-review/`. PC runs under the separate
`journeys-pc-presign-role`, limited to PC upload objects and `pc-review/*`.
The local shared backend currently contains other in-progress changes: compare
against the live package and deploy only the reviewed PC patch, with a saved
rollback archive and an optimistic revision check. Do not replace either live
Lambda with unrelated local work.
`backend/server.js` mirrors the upload validation for local development. See
[`../docs/APOLLO_PLATFORM_README.md`](../docs/APOLLO_PLATFORM_README.md) for the
deployment and queue checklist.

## Privacy invariants (do not break)

- Nothing leaves the browser before explicit submit; parse + redact are local.
- The real→alias mapping persists only in local IndexedDB; uploads carry alias-side only.
- Aliases are session-random, never derived by hashing real values.
- Contact birthdays never serialize. Credential-shaped strings hard-mask by default.
- Records, authored tasks, and manifest metadata must pass the bundle-wide DLP gate.
- Privacy-audit reports contain paths and detector classes but never matched values.
- Production presign and upload destinations must use HTTPS.
- "Erase local data" drops IndexedDB + localStorage.

See [`PRIVACY_BASELINE.md`](./PRIVACY_BASELINE.md) for the complete threat model, detector scope, fail-closed behavior, and residual-risk statement.

## Team metrics and administration

Open **Metrics & admin** and enter the team review key using **Connect review
tools**. It shows personal submitted/reviewed totals and team queue activity.
The same seven-email admin allowlist as Apollo v2 unlocks the team dashboard:
reviewer quality, author outcomes, author QC/sign-off progress, region/subject
distribution, searchable task details, and single/reviewer re-queue actions.
PC annotators have stable private identifiers; they are no longer combined into
one redacted user. Identity and raw personal records stay out of task analytics.
**Data submissions** retains the PC mail/calendar/document record administration tools.
The protected showcase contains current author-signed-off PC tasks, and removes
revoked approvals. Its category labels come from author metadata, not a claimed
model classification. **Examples** provides the shared curated task guidance.
