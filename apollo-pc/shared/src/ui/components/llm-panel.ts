import { el } from "./helpers";
import type { LlmReviewForHuman, LlmRubricReviewForHuman } from "../../review-client";

export type LlmPanelStatus = "loading" | "not_reviewed" | "pre_qc_passed" | "pre_qc_attention" | "stale" | "error";

/** Keep the reporting API exact while translating older pipeline prose for reviewers. */
export function plainReviewText(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/\bthe feasibility manager marked this rubric IMPOSSIBLE because\b/gi, "This step needs attention because")
    .replace(/\brequires NOT_FEASIBLE\b/g, "means the task cannot be completed as written")
    .replace(/\bis not presently feasible\b/gi, "cannot currently be completed")
    .replace(/\bnot presently feasible\b/gi, "cannot currently be completed")
    .replace(/\bunresolved verification shortfalls\b/gi, "items the automated check could not fully verify")
    .replace(/\bessential step[\s‐‑‒–—-]?(\d+) impossibility\b/gi, "problem in step $1")
    .replace(/\bstep[‐‑‒–—-](\d+)\b/gi, "step $1")
    .replace(/\bcompatibility failed\b/gi, "the step does not fit the task")
    .replace(/\brubric compatibility\b/gi, "how the step fits the task")
    .replace(/\bfeasibility manager\b/gi, "overall check")
    .replace(/\bcoherence manager\b/gi, "task check")
    .replace(/\bPlaywright navigation to (?:all three )?(?:the )?supplied targets\b/gi, "opening the referenced websites")
    .replace(/\bbrowser escalation\b/gi, "website check")
    .replace(/\bPlaywright navigation\b/gi, "automated website check")
    .replace(/\bverifier[- ]access limitation\b/gi, "limitation of the automated check")
    .replace(/\bsupplied targets\b/gi, "websites")
    .replace(/\btarget pages\b/gi, "websites")
    .replace(/\bpage rendered\b/gi, "website loaded")
    .replace(/\bpre[- ]purchase path\b/gi, "booking path")
    .replace(/\blive[- ]web\b/gi, "website")
    .replace(/\brubrics\b/gi, "steps")
    .replace(/\brubric\b/gi, "step")
    .replace(/\bcompatibility\b/gi, "fit with the task")
    .replace(/\bcompatible with\b/gi, "consistent with")
    .replace(/\bcompatible\b/gi, "consistent")
    .replace(/\bdeterministically bounded\b/gi, "clearly limited")
    .replace(/\benumerable\b/gi, "possible to list completely")
    .replace(/\bNEEDS_HUMAN_REVIEW\b/g, "needs a person to check")
    .replace(/\bNOT_FEASIBLE\b/g, "cannot be completed as written")
    .replace(/\bFEASIBLE\b/g, "can be completed")
    .replace(/\bWORKER_ERROR\b/g, "could not be checked")
    .replace(/\bSHORTFALL\b/g, "could not be fully checked")
    .replace(/\bIMPOSSIBLE\b/g, "cannot be completed as written")
    .replace(/\bPOSSIBLE\b/g, "can be completed")
    .replace(/\bworker\b/gi, "check")
    .replace(/\bmanager\b/gi, "overall check")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function conciseReviewText(value: string | null | undefined, maxChars = 240): string | null {
  const plain = plainReviewText(value);
  if (!plain) return null;
  const sentences = plain.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [plain];
  let concise = sentences.slice(0, 2).join(" ").replace(/\s+/g, " ").trim();
  if (concise.length <= maxChars) return concise;
  concise = concise.slice(0, maxChars - 1).replace(/\s+\S*$/, "").trimEnd();
  return `${concise}…`;
}

export function distinctReviewText(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const text = conciseReviewText(value);
    if (!text) return [];
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [text];
  });
}

function llmRubricNeedsAttention(rubric: LlmRubricReviewForHuman): boolean {
  return rubric.verdict !== "POSSIBLE" || (rubric.quality_verdict !== null && rubric.quality_verdict !== "PASS");
}

// The top-level Codex panel (summary + two check items + optional suggested
// task edit). Shared by the reviewer screen and the author's my-tasks view so
// the rendering never drifts. `onApplyTaskSuggestion` is omitted for a read-only
// evidence view; when provided it wires the "Use this suggestion" button to the
// caller's editable request field (an explicit edit, never auto-applied).
export function renderLlmPanel(opts: {
  review: LlmReviewForHuman | null;
  status: LlmPanelStatus;
  onApplyTaskSuggestion?: (text: string) => void;
}): HTMLElement {
  const { review, status, onApplyTaskSuggestion } = opts;
  if (status === "loading") {
    return el("div", { class: "llm-preqc-loading" }, el("span", { class: "spinner-dot" }), "Loading the Codex live check…");
  }
  if (!review) {
    const copy =
      status === "stale"
        ? "This task changed after its last Codex check. Review this version yourself."
        : status === "error"
          ? "The Codex check could not be loaded. You can still review the task."
          : "Codex has not checked this version yet. No automated result is being hidden.";
    return el("div", { class: "llm-preqc-empty" }, el("strong", null, "Codex live check"), el("span", null, copy));
  }
  const flagged = review.rubrics.filter((rubric) => llmRubricNeedsAttention(rubric)).length;
  const overallPass = review.status === "LLM_PASS";
  const coherence = review.quality?.task_coherence ?? review.quality?.prompt_quality ?? null;
  const taskClear = coherence?.verdict === "PASS";
  const websitesWork = review.manager_disposition === "FEASIBLE";
  const taskNote = conciseReviewText(coherence?.summary ?? review.quality?.summary);
  const websiteNote = conciseReviewText(review.manager_summary);
  const extraNotes = websiteNote
    ? []
    : distinctReviewText([review.task_feedback]).filter((note) => taskNote?.toLocaleLowerCase() !== note.toLocaleLowerCase());
  return el(
    "details",
    { class: `llm-preqc-panel ${overallPass ? "pass" : "attention"}`, open: true },
    el(
      "summary",
      null,
      el(
        "span",
        { class: "llm-preqc-title" },
        el("strong", null, "Codex live check"),
        el("small", null, "Task quality, alignment, and feasibility")
      ),
      el(
        "span",
        { class: `badge ${overallPass ? "ok" : "warn"}` },
        overallPass ? "Looks good" : flagged > 0 ? `${flagged} step${flagged === 1 ? "" : "s"} need a look` : "Task needs a look"
      )
    ),
    el(
      "div",
      { class: "llm-preqc-body" },
      el(
        "div",
        { class: "codex-check-list" },
        el(
          "div",
          { class: `codex-check-item ${taskClear ? "pass" : "attention"}` },
          el("span", { class: "codex-check-mark", "aria-hidden": "true" }, taskClear ? "✓" : "!"),
          el("span", { class: "codex-check-copy" }, el("strong", null, "Coherent and high quality"), taskNote ? el("small", null, taskNote) : null),
          el("span", { class: "codex-check-result" }, taskClear ? "Yes" : "Needs a look")
        ),
        el(
          "div",
          { class: `codex-check-item ${websitesWork ? "pass" : "attention"}` },
          el("span", { class: "codex-check-mark", "aria-hidden": "true" }, websitesWork ? "✓" : "!"),
          el("span", { class: "codex-check-copy" }, el("strong", null, "Feasible overall"), websiteNote ? el("small", null, websiteNote) : null),
          el("span", { class: "codex-check-result" }, websitesWork ? "Yes" : "Needs a look")
        )
      ),
      ...extraNotes.slice(0, 1).map((note) => el("p", { class: "llm-task-feedback" }, note)),
      review.task_repair
        ? el(
            "details",
            { class: "llm-repair task-repair" },
            el("summary", null, "Suggested task edit"),
            el("p", { class: "suggested-copy" }, review.task_repair.suggested_task_prompt),
            onApplyTaskSuggestion
              ? el(
                  "button",
                  {
                    class: "btn ghost small",
                    type: "button",
                    onclick: () => onApplyTaskSuggestion(review.task_repair!.suggested_task_prompt),
                  },
                  "Use this suggestion"
                )
              : null
          )
        : null,
      el("p", { class: "muted small codex-check-foot" }, "Use this as evidence, not the final decision. Nothing changes unless you apply a suggestion.")
    )
  );
}

/**
 * Step number a rubric belongs to, from its `rubric-N` id. The server builds
 * rubric ids as `rubric-${stepIndex + 1}`, but the review's rubric ARRAY is a
 * de-duped union of the pipeline's outcome, assessment, and feedback lists in
 * insertion order — neither dense nor sorted. Position is therefore not the
 * step number; review-edit pairs on the id for the same reason.
 */
export function stepNumberFromRubricId(rubricId: string, fallbackIndex: number): number {
  const m = /^rubric-(\d+)$/.exec(rubricId);
  return m ? Number(m[1]) : fallbackIndex + 1;
}

// Read-only per-step Codex feedback. Mirrors the per-rubric detail block from
// review-edit so the author sees the same verdicts, notes, concerns, and
// suggested fixes. `onApplyRubricSuggestion` (rubricId, text) wires a "Use
// this suggestion" button to the matching step in an open edit form; omitted for
// a purely read-only view.
export function renderLlmRubricList(
  review: LlmReviewForHuman,
  onApplyRubricSuggestion?: (rubricId: string, text: string) => void
): HTMLElement {
  const wrap = el("div", { class: "my-task-rubric-feedback" });
  review.rubrics.forEach((rubric, i) => {
    const stepNumber = stepNumberFromRubricId(rubric.rubric_id, i);
    const needsAttention = llmRubricNeedsAttention(rubric);
    const notes = distinctReviewText([rubric.summary, rubric.feedback]);
    const taskFitNote =
      rubric.quality_verdict && rubric.quality_verdict !== "PASS" ? conciseReviewText(rubric.quality_summary) : null;
    const concerns = distinctReviewText([...(rubric.quality_issues ?? []), ...(rubric.blockers ?? [])]).slice(0, 2);
    const repairDetails = rubric.repair
      ? rubric.repair.suggested_rubric_text && rubric.repair.verified_possible
        ? el(
            "details",
            { class: "llm-repair" },
            el("summary", null, "Suggested fix"),
            el("p", { class: "suggested-copy" }, rubric.repair.suggested_rubric_text),
            onApplyRubricSuggestion
              ? el(
                  "button",
                  {
                    class: "btn ghost small",
                    type: "button",
                    onclick: () => onApplyRubricSuggestion(rubric.rubric_id, rubric.repair!.suggested_rubric_text!),
                  },
                  "Use this suggestion"
                )
              : null
          )
        : needsAttention
          ? el(
              "details",
              { class: "llm-repair unresolved" },
              el("summary", null, "Why there isn't a suggested fix"),
              el("p", null, plainReviewText(rubric.repair.reason) || "Codex could not find a small, safe change. Review this step yourself.")
            )
          : null
      : null;
    wrap.append(
      el(
        "div",
        { class: "my-task-rubric-item" },
        el("p", { class: "eyebrow mono" }, `STEP ${stepNumber}`),
        el(
          "details",
          { class: `llm-rubric-detail verdict-${rubric.verdict.toLowerCase()}`, open: needsAttention },
          el(
            "summary",
            { class: "llm-rubric-detail-head" },
            el("strong", null, needsAttention ? "Codex found something to review" : "What Codex verified"),
            el("span", { class: `llm-rubric-badge status-${needsAttention ? "check" : "ready"}` }, needsAttention ? "Needs a look" : "Looks good")
          ),
          el(
            "div",
            { class: "llm-rubric-detail-body" },
            ...notes.map((note) => el("p", null, note)),
            taskFitNote ? el("div", { class: "llm-simple-note" }, el("strong", null, "Alignment"), el("p", null, taskFitNote)) : null,
            concerns.length
              ? el(
                  "div",
                  { class: "llm-simple-note attention" },
                  el("strong", null, "What may block the agent"),
                  el("ul", null, ...concerns.map((concern) => el("li", null, concern)))
                )
              : null,
            repairDetails,
            rubric.evidence.length
              ? el(
                  "details",
                  { class: "llm-pages-checked" },
                  el("summary", null, `Pages checked (${rubric.evidence.length})`),
                  el("div", { class: "llm-evidence-links" }, ...rubric.evidence.map((source) => el("a", { href: source.url, target: "_blank", rel: "noreferrer" }, source.title || source.url)))
                )
              : null
          )
        )
      )
    );
  });
  return wrap;
}
