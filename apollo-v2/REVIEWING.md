# Apollo v2 — Reviewer Guide (internal)

You turn raw submissions into the **finished set** — the tasks that actually ship. Rubric
quality is the product: each line must be independently checkable by looking at an agent's run.

## Setup (once)

Open https://apollo-v2-site.vercel.app → **Internal annotator** → your name + email.
That's it — reviewing is enabled automatically for reviewer builds.

## The loop

1. **Claim the next task.** It's locked to you for 30 minutes — no one else can get it.
2. **Fix the title and request** if needed. Read it like a stranger: could an agent run this
   without asking anything?
3. **Read the LLM pre-QC.** It independently checked each rubric on the live web. Treat it as
   evidence, not an answer: it cannot edit or approve the task. Open flagged steps to read the
   reason and any independently verified minimal suggestion.
4. **The rubric.** Check off each line that's accurate. Editing a line un-checks it (re-verify
   what you rewrote). If a task arrives with no checklist, write at least one line: what,
   concretely, would prove the task was done?
5. **Make sure it works later.** Someone should still be able to do the task weeks or months from
   now. Use timing such as “next week” or “30 days from when the task starts.” Replace fixed dates
   and copied prices, schedules, availability, rankings, or answers that will go out of date.
6. Three ways out:
   - **Approve → finished** — the task ships.
   - **Skip — release it** — put it back for someone else (you're unsure, or out of time).
   - **Reject — not usable** — no salvageable intent. Write a real reason: at least a
     sentence saying what is wrong and what would have to change. Your step notes go with
     it. The author sees both, without your name, and can appeal once — a vague reason
     just turns into a wasted appeal for two people.

Your approved/rejected counts show on the queue screen (yours and the total), and every
review is credited on your stats page (the counter in the top bar).

What you edit goes back to the author. After you approve a task it appears in their
**My tasks** with your name on it, your version beside their original, and the option to
accept it or amend it. Rejections reach them anonymously. Rejection rate is not what is
being watched — how long you spend and how much you explain is.

Before you decide, the advisory LLM panel shows five separate task checks: realistic request,
live-web feasibility, appropriate difficulty, prompt quality, and whether it works later. Each
rubric has its own web-feasibility and rubric-quality traffic lights. Expand a failed check for
evidence, issues, and either an independently checked minimal revision or an explanation of why
the LLM could not safely suggest one. **Use suggestion in working copy** is an explicit human
edit; the LLM never changes the submission or approves the task.

## Reviewing model trajectories

Open **Review → Open trajectory QC** after model runs have been packaged. Check three things:

1. Is the prompt realistic, feasible on the live web, and appropriately difficult?
2. Does each rubric/verifier correctly measure the prompt?
3. Does the recorded action path and screenshot evidence actually satisfy each rubric?

Finish by separating a **real model failure** from a **broken task/rubric**. The LLM judge is
shown for comparison, but the human decision is the final QC label. Use `?` on the grader for
keyboard shortcuts.

## Good rubric lines

- ✅ "A round-trip PIT→LAX flight landing before the 1st is open in a tab."
- ✅ "The final document lists 3 hotels under $200/night with links."
- ❌ "The agent searched for flights" (not checkable from the outcome)
- ❌ "Task completed successfully" (not independent, not concrete)

## Edge cases

- **Lock about to expire** (countdown turns red): approve or skip — past 30 minutes another
  reviewer may take the task, and your submit will be rejected.
- **Closed the tab mid-review?** Reopen → Review submitted tasks → **Resume that review** —
  your edits are intact while the lock lasts.
- **"Already finished by another reviewer" (rare)**: your lock expired and someone else
  completed it. Claim the next one.
- **Bad task** (spam, gibberish, no salvageable intent): use **Reject** with a real
  reason — never approve a weak rubric just to clear the queue.
- **An appeal**: a task an author revised after a rejection comes back through the normal
  queue. You will never be offered an appeal of a task you rejected yourself, so when one
  reaches you it is genuinely a second opinion. Review it on its merits.
