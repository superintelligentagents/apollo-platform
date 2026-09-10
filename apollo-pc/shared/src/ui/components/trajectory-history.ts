import { el } from "./helpers";
import { diffSummary, diffWords } from "../../textdiff";
import type { TaskLineage, TaskLineageRubric, TrajectoryRubric, PriorTrajectoryGrade } from "../../review-client";
// Inline word diff: struck = what the trainer wrote, highlighted = what ran.
export function inlineDiff(before: string, after: string, className = "inline-diff"): HTMLElement {
  const ops = diffWords(before, after);
  return el(
    "span",
    { class: className },
    ...ops.map((op) => op.type === "equal"
      ? document.createTextNode(op.text)
      : el(op.type === "insert" ? "ins" : "del", { class: op.type === "insert" ? "diff-ins" : "diff-del" }, op.text))
  );
}

// The run's rubric ids come from the OSWorld export (usually rubric-N, but
// older packages used R1/R2…). Match by id, then exact text, then position.
export function lineageRubricFor(lineage: TaskLineage | null | undefined, rubric: TrajectoryRubric, index: number, total: number): TaskLineageRubric | null {
  if (!lineage?.rubrics?.length) return null;
  const byId = lineage.rubrics.find((candidate) => candidate.rubric_id === rubric.rubric_id);
  if (byId) return byId;
  const byText = lineage.rubrics.find((candidate) => candidate.final.trim() === rubric.requirement.trim());
  if (byText) return byText;
  if (lineage.rubrics.length === total) return lineage.rubrics[index] ?? null;
  return null;
}

const VERDICT_LABEL: Record<string, string> = { SUCCESS: "Pass", FAILURE: "Fail", UNJUDGEABLE: "Unclear" };

export function priorRubricFor(prior: PriorTrajectoryGrade | null | undefined, rubric: TrajectoryRubric, index: number, total: number): PriorTrajectoryGrade["rubrics"][number] | null {
  if (!prior?.rubrics?.length) return null;
  const byId = prior.rubrics.find((candidate) => candidate.rubric_id === rubric.rubric_id);
  if (byId) return byId;
  const byText = prior.rubrics.find((candidate) => candidate.requirement.trim() === rubric.requirement.trim());
  if (byText) return byText;
  if (prior.rubrics.length === total) return prior.rubrics[index] ?? null;
  return null;
}

export function priorRubricBlock(prior: PriorTrajectoryGrade, priorRubric: PriorTrajectoryGrade["rubrics"][number], rubric: TrajectoryRubric): HTMLElement {
  const reworded = priorRubric.requirement.trim() !== rubric.requirement.trim();
  const verdict = priorRubric.human_verdict;
  return el(
    "div",
    { class: `rubric-prior verdict-${verdict.toLowerCase() || "none"}` },
    el("div", { class: "rubric-prior-head" },
      el("span", { class: "eyebrow mono" }, "PREVIOUS RUN"),
      el("span", { class: "rubric-prior-verdict" }, verdict ? VERDICT_LABEL[verdict] ?? verdict : "Not graded"),
      el("span", { class: "muted small" }, `${prior.graded_at ? formatReviewedAt(prior.graded_at) : ""}${prior.agent ? ` · ${prior.agent}` : ""}`)),
    ...(priorRubric.notes ? [el("p", { class: "rubric-prior-note" }, `“${priorRubric.notes}”`)] : []),
    ...(reworded
      ? [el("p", { class: "rubric-prior-reword muted small" }, "Rubric was reworded since: "), el("p", { class: "rubric-prior-diff" }, inlineDiff(priorRubric.requirement, rubric.requirement))]
      : [el("p", { class: "muted small" }, "Same rubric wording as this run.")])
  );
}

export function rubricLineageBlock(lineageRubric: TaskLineageRubric, rubric: TrajectoryRubric): HTMLElement {
  const before = lineageRubric.original ?? "";
  // Diff against the requirement the agent was judged on, so the highlighted
  // side always matches the text shown above it.
  const after = rubric.requirement;
  const summary = diffSummary(diffWords(before, after));
  return el(
    "div",
    { class: "rubric-lineage" },
    el("div", { class: "rubric-lineage-head" },
      el("span", { class: "eyebrow mono" }, before ? "EDITED IN REVIEW" : "ADDED IN REVIEW"),
      el("span", { class: "muted small" }, before ? `+${summary.inserted} / −${summary.deleted} words vs. what you wrote` : "This rubric was not in your submission")),
    el("p", { class: "rubric-lineage-diff" }, before ? inlineDiff(before, after) : el("ins", { class: "diff-ins" }, after))
  );
}

function formatReviewedAt(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

