import { describe, expect, it } from "vitest";
import {
  alignCriteria,
  alignSteps,
  diffWords,
  isChanged,
  summarizeChanges,
  type DiffSegment,
} from "../src/diff";
import type { MyTaskHumanReview, MyTaskHumanReviewRubric } from "../src/review-client";

const joinOps = (segments: DiffSegment[], ops: DiffSegment["op"][]) =>
  segments.filter((s) => ops.includes(s.op)).map((s) => s.text).join("");

function step(order: number, title: string, description: string) {
  return { order, title, description };
}

function rubric(over: Partial<MyTaskHumanReviewRubric>): MyTaskHumanReviewRubric {
  return {
    rubric_id: `rubric-${over.source_index != null ? over.source_index + 1 : 9}`,
    kind: "step",
    title: null,
    original: null,
    final: "",
    changed: false,
    checked: false,
    ...over,
  };
}

function humanReview(over: Partial<MyTaskHumanReview> = {}): MyTaskHumanReview {
  return {
    original: { title: "T", request: "R", criteria: [], steps: [], ...(over.original ?? {}) },
    final: { title: "T", request: "R", criteria: [], steps: [], ...(over.final ?? {}) },
    rubrics: over.rubrics ?? [],
    title_edited: false,
    request_edited: false,
    evergreen_verified: false,
    ...over,
  };
}

describe("diffWords", () => {
  it("returns a single equal segment for identical text", () => {
    expect(diffWords("same text", "same text")).toEqual([{ op: "equal", text: "same text" }]);
    expect(isChanged(diffWords("same text", "same text"))).toBe(false);
  });

  it("returns nothing for two empty strings", () => {
    expect(diffWords("", "")).toEqual([]);
  });

  it("treats an empty side as a whole insert or delete", () => {
    expect(diffWords("", "hello")).toEqual([{ op: "insert", text: "hello" }]);
    expect(diffWords("hello", "")).toEqual([{ op: "delete", text: "hello" }]);
  });

  it("keeps the common prefix and suffix out of the change", () => {
    const segments = diffWords("book three East Coast games", "book four East Coast games");
    expect(segments.filter((s) => s.op === "delete").map((s) => s.text)).toEqual(["three"]);
    expect(segments.filter((s) => s.op === "insert").map((s) => s.text)).toEqual(["four"]);
    expect(segments[0]).toEqual({ op: "equal", text: "book " });
  });

  it("marks a pure insertion and a pure deletion", () => {
    expect(joinOps(diffWords("a b", "a new b"), ["insert"])).toContain("new");
    expect(joinOps(diffWords("a old b", "a b"), ["delete"])).toContain("old");
  });

  it("reassembles both sides from the segments", () => {
    const before = "Plan a seven-day East Coast trip for one traveler.";
    const after = "Plan a ten-day West Coast trip for two travelers, under budget.";
    const segments = diffWords(before, after);
    expect(joinOps(segments, ["equal", "delete"])).toBe(before);
    expect(joinOps(segments, ["equal", "insert"])).toBe(after);
  });

  it("ignores whitespace-only differences so a reflow is not a rewrite", () => {
    expect(isChanged(diffWords("a  b", "a b"))).toBe(false);
    expect(isChanged(diffWords("a b", "a\nb"))).toBe(false);
  });

  it("keeps punctuation attached to its word", () => {
    const segments = diffWords("go to the store.", "go to the shop.");
    expect(segments.filter((s) => s.op === "delete").map((s) => s.text)).toEqual(["store."]);
    expect(segments.filter((s) => s.op === "insert").map((s) => s.text)).toEqual(["shop."]);
  });

  it("degrades to a block replace rather than hanging on huge disjoint input", () => {
    const before = Array.from({ length: 900 }, (_, i) => `a${i}`).join(" ");
    const after = Array.from({ length: 900 }, (_, i) => `b${i}`).join(" ");
    const started = Date.now();
    const segments = diffWords(before, after);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(segments.map((s) => s.op)).toEqual(["delete", "insert"]);
    expect(joinOps(segments, ["equal", "delete"])).toBe(before);
    expect(joinOps(segments, ["equal", "insert"])).toBe(after);
  });
});

describe("alignSteps", () => {
  const originalSteps = [
    step(1, "One", "First step."),
    step(2, "Two", "Second step."),
    step(3, "Three", "Third step."),
  ];

  it("pairs edited, unchanged and added steps by source_index", () => {
    const hr = humanReview({
      original: { title: "T", request: "R", criteria: [], steps: originalSteps },
      final: {
        title: "T",
        request: "R",
        criteria: [],
        steps: [step(1, "One", "First step, revised."), step(2, "Two", "Second step."), step(3, "New", "Added step.")],
      },
      rubrics: [
        rubric({ source_index: 0, original: "First step.", final: "First step, revised.", changed: true }),
        rubric({ source_index: 1, original: "Second step.", final: "Second step." }),
        rubric({ source_index: 2, original: "Third step.", final: "Third step." }),
        rubric({ source_index: null, original: null, final: "Added step.", title: "New" }),
      ],
    });
    expect(alignSteps(hr).map((r) => r.status)).toEqual(["changed", "unchanged", "unchanged", "added"]);
  });

  it("surfaces a step the reviewer removed, at the position it used to hold", () => {
    const hr = humanReview({
      original: { title: "T", request: "R", criteria: [], steps: originalSteps },
      final: { title: "T", request: "R", criteria: [], steps: [originalSteps[0], originalSteps[2]] },
      // The reviewer spliced step 2 out, so no rubric claims index 1.
      rubrics: [
        rubric({ source_index: 0, original: "First step.", final: "First step." }),
        rubric({ source_index: 2, original: "Third step.", final: "Third step." }),
      ],
    });
    const rows = alignSteps(hr);
    expect(rows.map((r) => r.status)).toEqual(["unchanged", "removed", "unchanged"]);
    expect(rows[1].before).toBe("Second step.");
    expect(rows[1].after).toBeNull();
  });

  it("falls back to positional pairing when there are no rubrics", () => {
    const hr = humanReview({
      original: { title: "T", request: "R", criteria: [], steps: [originalSteps[0], originalSteps[1]] },
      final: { title: "T", request: "R", criteria: [], steps: [step(1, "One", "First step, revised.")] },
      rubrics: [],
    });
    expect(alignSteps(hr).map((r) => r.status)).toEqual(["changed", "removed"]);
  });

  it("distrusts a source_index whose recorded original does not match the task", () => {
    const hr = humanReview({
      original: { title: "T", request: "R", criteria: [], steps: originalSteps },
      final: { title: "T", request: "R", criteria: [], steps: [step(1, "One", "First step.")] },
      // Index points at step 1 but records step 3's text — the legacy backend
      // branch indexes the FINAL list. Pairing on it would be wrong.
      rubrics: [rubric({ source_index: 0, original: "Third step.", final: "First step." })],
    });
    expect(alignSteps(hr).map((r) => r.status)).toEqual(["unchanged", "removed", "removed"]);
  });

  it("treats a rubric with no recorded original as an added step", () => {
    const hr = humanReview({
      original: { title: "T", request: "R", criteria: [], steps: [originalSteps[0]] },
      final: { title: "T", request: "R", criteria: [], steps: [originalSteps[0], step(2, "New", "Brand new.")] },
      rubrics: [
        rubric({ source_index: 0, original: "First step.", final: "First step." }),
        rubric({ source_index: 1, original: null, final: "Brand new." }),
      ],
    });
    expect(alignSteps(hr).map((r) => r.status)).toEqual(["unchanged", "added"]);
  });
});

describe("alignCriteria", () => {
  it("pairs criteria by position", () => {
    const hr = humanReview({
      original: { title: "T", request: "R", criteria: ["Keep it cheap", "Book nothing"], steps: [] },
      final: { title: "T", request: "R", criteria: ["Keep it under $2,500"], steps: [] },
    });
    expect(alignCriteria(hr).map((r) => r.status)).toEqual(["changed", "removed"]);
  });
});

describe("summarizeChanges", () => {
  it("reports nothing when the reviewer left the task alone", () => {
    const hr = humanReview({
      original: { title: "T", request: "R", criteria: [], steps: [step(1, "One", "Same.")] },
      final: { title: "T", request: "R", criteria: [], steps: [step(1, "One", "Same.")] },
    });
    expect(summarizeChanges(hr).anyChange).toBe(false);
  });

  it("counts what moved", () => {
    const hr = humanReview({
      original: { title: "Old", request: "R", criteria: [], steps: [step(1, "One", "Before.")] },
      final: { title: "New", request: "R", criteria: [], steps: [step(1, "One", "After.")] },
    });
    const summary = summarizeChanges(hr);
    expect(summary).toMatchObject({ titleChanged: true, requestChanged: false, stepsChanged: 1, stepsTotal: 1, anyChange: true });
  });
});
