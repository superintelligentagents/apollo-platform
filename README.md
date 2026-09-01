# Apollo platform

Apollo contains two collection clients and their shared quality-control system:

- **Apollo V2** — long-horizon web-task authoring and human task review.
- **Apollo PC** — consented email/calendar context collection, task authoring, human task review, and trajectory grading.
- **Apollo review backend** — concurrent task/trajectory claims, immutable review records, reporting APIs, and the live-audit gate.
- **Codex feasibility check** — a read-only skill and runner that checks task coherence plus the alignment and public-web feasibility of every rubric before human review.

## Live applications

| Application | Production URL | Source |
|---|---|---|
| Apollo V2 | https://apollo-v2-site.vercel.app | `apollo-v2/` |
| Apollo PC | https://apollo-pc-site.vercel.app | `apollo-pc/` |

Both applications expose separate **Review** and **Grade** workspaces. Review is for prompt/rubric QC. Grade is for judging an agent trajectory against each rubric and the overall task, without showing the LLM trajectory verdict to the human grader.

## Repository map

- `apollo-v2/` — web and Tauri clients, shared UI, tests, participant and reviewer instructions.
- `apollo-pc/` — personal-context web client, privacy controls, shared review/grade UI, and tests.
- `backend/` — Lambda/Express review and reporting API.
- `.agents/skills/review-live-web-feasibility/` — Codex skill contract.
- `scripts/llm_feasibility/` — resumable Codex CLI pipeline for task/rubric checks.
- `scripts/trajectory_review/` — Odysseys-compatible trajectory judging, validation, packaging, and AWS publication.
- `scripts/osworld_runner/` — author-sign-off filtering, OSWorld/Meta execution, and one-command trajectory publication.
- `QUALITY_CONTROL.md` — ownership and invariants for all QC stages.
- `docs/APOLLO_FLOW.md` — end-to-end collection and review flow.
- `docs/TURING_HANDOFF.md` — access, setup, deployment, and security checklist.

## Local setup

Use Node 20+ and Python 3.11+.

```bash
npm install --prefix backend
npm install --prefix apollo-v2
npm install --prefix apollo-pc

python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r scripts/trajectory_review/requirements.txt
```

Run the main checks:

```bash
npm test --prefix backend
npm run typecheck --prefix apollo-v2
npm test --prefix apollo-v2 -- --run
npm run typecheck --prefix apollo-pc
npm test --prefix apollo-pc -- --run
python3 -m unittest scripts.llm_feasibility.test_run
python3 -m unittest discover -s scripts/trajectory_review -p 'test_*.py'
```

Run either web client locally:

```bash
npm run dev:web --prefix apollo-v2
npm run dev:web --prefix apollo-pc
```

## Use the Codex skill

Open this repository in Codex and ask it to use `review-live-web-feasibility`, or install the skill directory into a Codex skills location. The skill is deliberately read-only: it writes separate review artifacts and never edits, approves, rejects, or replaces an authored task.

Before a production batch, follow `.agents/skills/review-live-web-feasibility/SKILL.md`. Credentials are supplied from an approved secret store; none are committed here.

## Security boundary

This repository contains source and synthetic fixtures only. It must not contain participant exports, email/calendar records, browsing history, model-run screenshots, AWS objects, browser logs, production API keys, reviewer/reporting tokens, model-provider keys, or Chrome-extension signing keys.

This is a public, code-only repository. Production data, participant exports, browser records, model-run artifacts, and every credential remain outside Git. Application administration, AWS roles, Vercel access, and read-only reporting credentials are granted separately according to role.
