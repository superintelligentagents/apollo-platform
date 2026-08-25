# Apollo V2 task-review guide

Review another trainer's task, never your own. The goal is to make each task
clear, realistic, achievable, and fair for evaluating a long-horizon web agent.

## Start a review

Open [Apollo V2](https://apollo-v2-site.vercel.app/#/review-queue), go to
**Review**, and select **Claim the next task**. A claim is locked to you for 30
minutes so two people cannot review it at once. Aim to finish in about 20
minutes. Select **Skip** if you cannot finish so another reviewer can claim it.

Apollo never offers you your own submissions.

## What Codex checked

Every claimable task has completed an automated first pass for its exact current
version. Codex checks:

- whether the complete task is coherent and high quality;
- whether the complete task can be performed on the current public web;
- whether each rubric matches the request, stays in scope, and is fair to
  evaluate; and
- whether each rubric can be completed on the current public web.

Codex findings appear beside the task and individual rubrics. They are advisory,
not the final decision. A failed page is not automatically a task failure. If the
prompt does not require one exact website, Google or another suitable public
source may provide the same information.

## Review the task prompt

Read the complete request as if you were the agent. Confirm that:

- it describes realistic web work that generally requires an hour or more of
  research, comparison, verification, or production work;
- the goal, constraints, sources, decisions, and final result are clear enough
  to start without asking the author a question;
- it can be completed from a fresh, logged-out browser without private data,
  personal credentials, a purchase, or inaccessible content;
- it works for an English-speaking agent and is not unintentionally blocked by
  location; and
- it is evergreen: the instructions still make sense and the task can still be
  completed if it is assigned next month or later.

Live prices, schedules, rankings, and availability may change. That is fine. The
task should tell the agent how to find the answer instead of embedding an answer
that will expire.

## Review every rubric

Open every rubric, visit a sample of the relevant pages in a signed-out browser,
and investigate anything Codex flagged. Confirm that each rubric:

- checks something the original request asks for;
- does not add a new or unfair requirement;
- describes a concrete result or action that can be verified from the agent's
  run or final output;
- can be satisfied using the public web; and
- remains understandable and useful when live information changes.

Edit only what must change. Editing a rubric unchecks it, so verify the revised
text and check it again. Approval stays disabled until every rubric is checked
and **Still works later** is confirmed.

## Edit, return, reject, or skip

Use this rule:

> Edit when you can preserve the author's original goal. Reject when fixing the
> task would require replacing that goal with a substantially different task.

**Edit** unclear wording, missing qualifiers, outdated URLs, a small number of
infeasible or out-of-scope rubrics, or a time-sensitive phrase that has a simple
evergreen replacement. Keep the original workflow and intent.

**Return to author** when the task can be saved but the author should make the
substantive revision. Your name and note are shown so they can ask for clarification.

**Reject** only when the task is fundamentally unusable: spam or gibberish, no
salvageable goal, a central requirement that depends on unavailable private
access, essential information that a reviewer would have to invent, or defects
so broad that the task would need to be replaced. Enter a specific rejection
reason of at least 40 characters explaining the fundamental problem and why a
small edit cannot fix it. The author sees the reason and your step notes without
your identity, and may appeal once with a written rationale to a different reviewer. The fresh reviewer sees that rationale but not the first reviewer's identity.

Do not reject solely because Codex flagged the task, one page temporarily failed
to load, or you would have written it differently.

Use **Skip** when you are unsure or running out of time. It releases the task
without changing it. Skipping is always allowed — no task is mandatory. Your
next claim hands you a *different* task; skipped ones only come back when they
are the only tasks left in the queue (skips reset if you reload the page).

## Finish

Before approving, make sure you read the full request, opened and checked every
rubric, investigated Codex warnings, made only necessary edits, and confirmed
that the task still works later. Then select **Approve task**.

Apollo keeps the submitted version, the reviewed final version, the reviewer,
and any rejection reason as separate auditable records. Aim for 15–20 thoughtful
reviews per day; quality matters more than clearing the queue quickly.

After approval, the author sees both versions in **My tasks**, but not your name. They
can accept your reviewed version or amend it into final gold. Their amendment is
archived and auditable, but it does not receive a second reviewer pass.

## Edge cases

- If the lock countdown turns red, approve or skip. After 30 minutes another
  reviewer may claim the task.
- If you close the tab, return to **Review** and resume the claim while its lock
  remains active; the working edits are saved locally.
- If Apollo says another reviewer already finished the task, your lock expired.
  Claim the next task instead.
