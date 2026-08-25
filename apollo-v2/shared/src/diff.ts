// Word-level redline between two versions of a task, for the author sign-off
// screen. Deliberately dependency-free: `shared` has no runtime dependencies,
// and a diff small enough to read is worth more here than a general library.
//
// Nothing in this module touches the DOM. The rendering lives in
// ui/components/redline.ts so this half stays unit-testable without jsdom.

import type { MyTaskHumanReview, MyTaskHumanReviewRubric } from "./review-client";

export type DiffOp = "equal" | "insert" | "delete";

export interface DiffSegment {
  op: DiffOp;
  text: string;
}

// Full DP cells we are willing to allocate. A task request is a few hundred
// words and a step is shorter, so this should never bind in practice; it is
// here so a pathological input degrades to a block replace instead of locking
// the tab. At 4 bytes a cell this caps the table at ~1MB.
const MAX_DP_CELLS = 250_000;

// Split into words AND the whitespace between them, so the segments reassemble
// into the original text with nothing silently dropped.
function tokenize(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

// What two tokens are compared on. Every run of whitespace is the same key, so
// a reflowed paragraph — a wrapped line, a double space collapsed — reads as
// unchanged instead of lighting up the whole field.
function keyOf(token: string): string {
  return /^\s+$/.test(token) ? " " : token;
}

/**
 * Word-level diff of two prose strings.
 *
 * Returns segments in reading order. Concatenating `equal` + `delete`
 * reproduces `before`, and `equal` + `insert` reproduces `after`, up to
 * whitespace: equal runs carry the AFTER side's spacing, because that is the
 * text the author is being asked to sign off on.
 */
export function diffWords(before: string, after: string): DiffSegment[] {
  if (before === after) return before ? [{ op: "equal", text: before }] : [];

  const a = tokenize(before);
  const b = tokenize(after);
  const ka = a.map(keyOf);
  const kb = b.map(keyOf);

  // Trim the common head and tail first. Reviewer edits are usually local to
  // one clause, so this removes most of the work before the quadratic step.
  let start = 0;
  while (start < a.length && start < b.length && ka[start] === kb[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) {
    endA--;
    endB--;
  }

  const segments: DiffSegment[] = [];
  const push = (op: DiffOp, text: string) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.op === op) last.text += text;
    else segments.push({ op, text });
  };

  push("equal", b.slice(0, start).join(""));

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_DP_CELLS) {
    push("delete", midA.join(""));
    push("insert", midB.join(""));
  } else {
    for (const [op, token] of lcsDiff(midA, midB, ka.slice(start, endA), kb.slice(start, endB))) {
      push(op, token);
    }
  }

  push("equal", b.slice(endB).join(""));
  return segments;
}

/** True when anything was actually inserted or deleted. */
export function isChanged(segments: readonly DiffSegment[]): boolean {
  return segments.some((segment) => segment.op !== "equal");
}

// Longest-common-subsequence diff over tokens, backtracked into ops. Deletions
// are emitted before insertions on a tie so a replaced phrase reads as
// "old new" rather than interleaved.
function lcsDiff(a: string[], b: string[], ka: string[], kb: string[]): [DiffOp, string][] {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return b.map((token) => ["insert", token] as [DiffOp, string]);
  if (!m) return a.map((token) => ["delete", token] as [DiffOp, string]);

  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = ka[i] === kb[j]
        ? table[(i + 1) * width + (j + 1)] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }

  const out: [DiffOp, string][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      // The after side's text: equal-by-key still means the spacing may differ.
      out.push(["equal", b[j]]);
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      out.push(["delete", a[i]]);
      i++;
    } else {
      out.push(["insert", b[j]]);
      j++;
    }
  }
  while (i < n) out.push(["delete", a[i++]]);
  while (j < m) out.push(["insert", b[j++]]);
  return out;
}

export type StepStatus = "unchanged" | "changed" | "added" | "removed";

export interface StepDiffRow {
  status: StepStatus;
  title: string;
  /** The author's text. null when the reviewer added this row. */
  before: string | null;
  /** The final-gold text. null when the reviewer removed this row. */
  after: string | null;
}

interface SnapshotStep {
  order: number;
  title: string;
  description: string;
}

/**
 * Pair the author's steps against final gold.
 *
 * A step the reviewer REMOVED leaves no rubric behind at all — the reviewer UI
 * splices it out of the list — so the only way to show the author that their
 * step was dropped is to find the original indices that no rubric claims. That
 * is what `source_index` is for.
 */
export function alignSteps(hr: MyTaskHumanReview): StepDiffRow[] {
  const originalSteps = hr.original?.steps ?? [];
  const finalSteps = hr.final?.steps ?? [];
  const rubrics = (hr.rubrics ?? []).filter((rubric) => rubric.kind !== "criterion");
  if (rubrics.length && trustworthyIndices(rubrics, originalSteps)) {
    return rowsFromRubrics(rubrics, originalSteps);
  }
  return zipRows(
    originalSteps.map(stepToPair),
    finalSteps.map(stepToPair)
  );
}

/** Success criteria have no rubric identity, so they pair by position. */
export function alignCriteria(hr: MyTaskHumanReview): StepDiffRow[] {
  const before = (hr.original?.criteria ?? []).map((text, i) => ({ title: `Criterion ${i + 1}`, text }));
  const after = (hr.final?.criteria ?? []).map((text, i) => ({ title: `Criterion ${i + 1}`, text }));
  return zipRows(before, after);
}

function stepToPair(step: SnapshotStep, i: number): { title: string; text: string } {
  return { title: step.title || `Step ${i + 1}`, text: step.description };
}

/**
 * Can `source_index` be believed?
 *
 * Records reviewed before the field was forwarded carry no index at all. Worse,
 * the legacy fallback inside the backend's `cleanRubrics` sets `source_index`
 * to a position in the FINAL step list rather than the original one. Both cases
 * are caught the same way: a trustworthy index points at an original step whose
 * text is the one the rubric recorded. Anything else falls back to positional
 * pairing, which is all the information those records actually contain.
 */
function trustworthyIndices(rubrics: MyTaskHumanReviewRubric[], originalSteps: SnapshotStep[]): boolean {
  let indexed = 0;
  for (const rubric of rubrics) {
    if (typeof rubric.source_index !== "number") continue;
    indexed++;
    const source = originalSteps[rubric.source_index];
    if (!source) return false;
    if (rubric.original != null && rubric.original.trim() !== source.description.trim()) return false;
  }
  return indexed > 0;
}

function rowsFromRubrics(rubrics: MyTaskHumanReviewRubric[], originalSteps: SnapshotStep[]): StepDiffRow[] {
  const claimed = new Set<number>();
  for (const rubric of rubrics) {
    if (typeof rubric.source_index === "number") claimed.add(rubric.source_index);
  }

  const rows: StepDiffRow[] = [];
  let nextOriginal = 0;
  // Emit any original step the reviewer dropped at the position it used to
  // occupy, so the gap reads where the author remembers writing it.
  const flushRemovedBefore = (limit: number) => {
    while (nextOriginal < limit) {
      const step = originalSteps[nextOriginal];
      if (!claimed.has(nextOriginal) && step) {
        rows.push({
          status: "removed",
          title: step.title || `Step ${nextOriginal + 1}`,
          before: step.description,
          after: null,
        });
      }
      nextOriginal++;
    }
  };

  for (const rubric of rubrics) {
    const source = typeof rubric.source_index === "number" ? originalSteps[rubric.source_index] : undefined;
    const before = rubric.original ?? source?.description ?? null;
    if (typeof rubric.source_index === "number" && before !== null) {
      flushRemovedBefore(rubric.source_index);
      nextOriginal = Math.max(nextOriginal, rubric.source_index + 1);
      const after = rubric.final;
      rows.push({
        status: before.trim() === after.trim() ? "unchanged" : "changed",
        title: rubric.title || source?.title || `Step ${rubric.source_index + 1}`,
        before,
        after,
      });
    } else {
      rows.push({
        status: "added",
        title: rubric.title || "Added by the reviewer",
        before: null,
        after: rubric.final,
      });
    }
  }
  flushRemovedBefore(originalSteps.length);
  return rows;
}

function zipRows(
  before: { title: string; text: string }[],
  after: { title: string; text: string }[]
): StepDiffRow[] {
  const rows: StepDiffRow[] = [];
  const length = Math.max(before.length, after.length);
  for (let i = 0; i < length; i++) {
    const b = before[i];
    const a = after[i];
    if (b && a) {
      rows.push({
        status: b.text.trim() === a.text.trim() && b.title === a.title ? "unchanged" : "changed",
        title: a.title || b.title,
        before: b.text,
        after: a.text,
      });
    } else if (a) {
      rows.push({ status: "added", title: a.title, before: null, after: a.text });
    } else if (b) {
      rows.push({ status: "removed", title: b.title, before: b.text, after: null });
    }
  }
  return rows;
}

export interface ReviewChangeSummary {
  titleChanged: boolean;
  requestChanged: boolean;
  stepsChanged: number;
  stepsTotal: number;
  criteriaChanged: number;
  anyChange: boolean;
}

/** What actually differs, for the one-line header above the redline. */
export function summarizeChanges(hr: MyTaskHumanReview): ReviewChangeSummary {
  const steps = alignSteps(hr);
  const criteria = alignCriteria(hr);
  const titleChanged = (hr.original?.title ?? "") !== (hr.final?.title ?? "");
  const requestChanged = (hr.original?.request ?? "") !== (hr.final?.request ?? "");
  const stepsChanged = steps.filter((row) => row.status !== "unchanged").length;
  const criteriaChanged = criteria.filter((row) => row.status !== "unchanged").length;
  return {
    titleChanged,
    requestChanged,
    stepsChanged,
    stepsTotal: steps.length,
    criteriaChanged,
    anyChange: titleChanged || requestChanged || stepsChanged > 0 || criteriaChanged > 0,
  };
}
