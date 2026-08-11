# Apollo PC — Personal-Context Collector

The web client includes separate top-level **Review** and **Grade** workspaces. Review uses the shared human task-QC queue, shows the full request and completed Codex live-web feedback, keeps the original and reviewed task versions separate, and allows edits only in the human working copy. Grade is trajectory-only: it shows recorded steps/screenshots, each rubric, and the overall task-satisfaction judgment while hiding the LLM judge from graders.

Tasks are not claimable in either Apollo client until a supported Codex PRE_QC run has completed every rubric for the exact current content hash. The Review queue shows these submissions as **waiting for Codex check**. Keyboard shortcuts in Grade are `←/→` for trajectory steps, `W/S` for rubrics, `P/O` for pass/fail, and `U` for unclear.

Collects **real, consented, redacted personal context** (email, calendar, contacts, WhatsApp
chats, and orders mined from receipt emails) plus participant-authored agent tasks grounded in
that data. Feeds persona/environment recreation for MyPCBench/iOSWorld-style benchmarks.

Sibling of `apollo-v2/` (browsing-history collector). Shares the presign lambda, S3 bucket,
and design system, but is a standalone workspace — nothing here imports `@odyssey/shared`.

## How it works

1. **Import** — participants export their own data (Google Takeout `.mbox`, `.ics`, `.vcf`,
   WhatsApp `.txt`) and load the files here. Parsing is 100% in-browser; a date-window select
   (default 12 months) drops older records *at parse time*. Email bodies are truncated
   (5 KB head+tail), attachments reduced to metadata, and stored in IndexedDB.
2. **Review & redact** — all imported email is selected by default; per-item and filtered
   bulk controls can keep anything private. Field editing, entity aliases, replacement rules,
   and the direct-identifier/credential mask layer apply only to the upload copy.
3. **People & entities** — recurring people are detected across all sources (contacts act as
   the join table) and pseudonymized with **one consistent alias per person** so cross-source
   correlation survives. Merchants keep real names. The real→alias map **never uploads**.
4. **Tasks** — five templates matching the MyPCBench taxonomy; each task attaches
   `referenced_record_ids` and (where required) a ground-truth `expected_answer`.
5. **Submit** — records and tasks serialize through `redact.ts` (edits → rules → masks → aliases),
   then an independent bundle-wide privacy audit fails closed on unapproved PII. Passing files
   split into `records_{kind}[_partN].json` files under the 5 MB presign cap, uploaded
   sequentially with `manifest.json` **last** (the lambda's review-inbox marker only fires
   on the manifest, so interrupted uploads never look complete).

Schema: `odyssey_personal_context_v1`. S3 layout:
`prolific/journeys/{pid}/pc/{pid}/internal/bundle-{id}/{ts}_{filename}`.

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

Same rule as apollo-v2: **never cloud-build** (workspace dep). Build locally, then deploy
the prebuilt `web/dist/` from a clean dir to the `apollo-pc-site` Vercel project:

```bash
npm run build:web
cp -r web/dist /tmp/apollo-pc-deploy && cd /tmp/apollo-pc-deploy
npx vercel deploy --prod
```

Backend: the `isPC` branch lives in `backend/lambda_presign.js` (repo file = deployed
source — re-zip and update the `journeys-presign` lambda when it changes; `backend/server.js`
mirrors it for local dev).

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
