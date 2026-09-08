# Apollo hard-100 showcase

A static site showing the hard-100 task set, each model's trajectory, and the
judge's per-rubric verdicts. Task list → task (both models side by side) →
trajectory, each on its own page.

## What it shows

100 tasks where `gpt-5.6-luna` scored below 0.35, screened for fairness and
stratified across the SimilarWeb taxonomy. Both models ran on their **own
upstream prompt** with the **same 120-step budget**, judged by
**gemini-3.1-flash-lite-preview** over **every** screenshot.

The `cap` badge marks a run stopped at the step limit. It matters: those runs
score far below the same model's finished ones, so a low number there is a
budget artifact rather than a capability result.

## Build the data

```bash
scripts/showcase_site/export_dataset.py --out scripts/showcase_site/site/data
```

Reads the queue state for each campaign, pulls each published manifest from S3,
and writes `index.json` plus one file per run. Screenshots are referenced by S3
key and never copied — the runs hold ~13,000 frames and about a gigabyte, which
no deployment should carry.

## Run it locally

```bash
scripts/showcase_site/serve_local.py          # http://127.0.0.1:8791
```

Stands in for the two things Vercel does that a plain static server does not:
resolves `/task` and `/run` to their HTML, and signs screenshots via `/api/shot`
using the AWS CLI. Without it a local preview shows every trajectory with blank
frames. Needs AWS credentials that can read `v2-review/trajectory-runs/*`.

## Deploy

The site is plain HTML/JS with one serverless function; there is no build step.

1. Create a Vercel project with **root directory `scripts/showcase_site/site`**.
2. Set these environment variables:

   | Variable | Purpose |
   |---|---|
   | `SHOWCASE_AWS_ACCESS_KEY_ID` | reads trajectory screenshots |
   | `SHOWCASE_AWS_SECRET_ACCESS_KEY` | " |
   | `AWS_REGION` | `us-east-1` |
   | `SHOWCASE_BUCKET` | `journeys-prolific` (default) |

   Use credentials scoped to `v2-review/trajectory-runs/*` — the function needs
   nothing else.

3. Deploy. `/api/shot` signs one screenshot at a time, for an hour, and only
   for keys matching the trajectory-run prefix, so the route cannot be used to
   read anything else in the bucket.

## Access

The site serves task text and trajectories with no authentication. Put it
behind Vercel password protection or SSO before sharing it outside the team.
