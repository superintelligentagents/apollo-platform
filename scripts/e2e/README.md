# Browser e2e / validation suite (Playwright)

Live-site validation scripts written during the 2026-07-29 build-out. They run
against PRODUCTION (apollo-pc-site.vercel.app / apollo-v2-site.vercel.app) and
some SUBMIT REAL DATA to the prod S3 bucket — always clean up afterwards
(delete `prolific/journeys/{test-participant}/` plus the matching
`v2-review/inbox|done/` markers; every script uses throwaway participant
emails like `lj-e2e-test@example.com` so the prefixes are easy to find).

Setup (one-time per machine):
```bash
npm i --no-save playwright && npx playwright install chromium   # headed + headless
python3 gen_gmail.py    # writes e2e-fixtures/ next to the scripts (mbox+ics)
```

| Script | Covers | Notes |
|---|---|---|
| `validate.mjs` | Apollo PC full flow: import → choose/bulk/filters → edit → entities → task → export preview → submit → resume → erase | `E2E_BASE=` to point at dev |
| `validate-scale.mjs` | 132 MB Gmail mbox, receipt mining, pagination, cross-source entity join, real AWS upload | regenerate fixtures first |
| `validate-gaps-pc.mjs` | scrub-panel UI, all 5 templates, task edit/delete, multi-part upload | uses `gmail-longbodies.mbox` (see git history of gen script or make bodies ~6 KB) |
| `validate-v2.mjs` | Apollo v2: guided submit, Chrome-History file → journeys → compose submit, examples, progress, own-task exclusion | needs a `History` sqlite fixture (urls+visits tables, Chrome epoch µs) |
| `validate-gaps-v2.mjs` | v2 approve + reject endgames via the LOCK-SHIELD pattern (shield reviewer holds the real queue task so the approver only draws disposables) | scrub S3 traces after: task dirs, inbox/done markers, finished/, rejected/, credits/ for test reviewer names |
| `e2e-review2.mjs` | v2 claim → navigate away → resume card → release; self-review exclusion | non-destructive |
| `validate-cross-app-review.mjs` | Production API check for both v2 and PC: app-specific upload keys, completed-audit admission, own-task exclusion, and concurrent distinct claims | Set `E2E_REVIEW_KEY`; releases locks and deletes its disposable source, marker, lock, and audit objects automatically |
| `ext-test.mjs` | Chrome extension live-import in a HEADED persistent context (`--load-extension` on apollo-v2/extension; pinned key keeps the prod extension ID) | headed only |

Golden assertion in every PC run: grep the uploaded/preview bytes for real
names/emails — must always be empty.
