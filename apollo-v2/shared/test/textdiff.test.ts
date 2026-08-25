import { describe, expect, it } from "vitest";
import { diffSummary, diffWords } from "../src/textdiff";

const join = (ops: ReturnType<typeof diffWords>, type: string) => ops.filter((op) => op.type === type).map((op) => op.text).join("");

describe("diffWords", () => {
  it("marks inserted and deleted words and keeps shared text equal", () => {
    const ops = diffWords("Find a hotel near Hongdae for 3 nights.", "Find a hotel near Hongdae for 3 nights under $150/night.");
    // "nights." -> "nights under $150/night." is one swap plus an insertion.
    expect(join(ops, "delete")).toBe("nights.");
    expect(join(ops, "insert").trim()).toBe("nights under $150/night.");
    expect(ops.filter((op) => op.type === "equal").map((op) => op.text).join("")).toContain("Find a hotel near Hongdae for 3 ");
    expect(diffSummary(ops)).toEqual({ inserted: 3, deleted: 1 });
  });

  it("reconstructs both sides exactly", () => {
    const before = "Compare three\nflights from SFO to ICN and pick the cheapest.";
    const after = "Compare four\nflights from SFO to ICN, list them, and pick the cheapest nonstop.";
    const ops = diffWords(before, after);
    // `after` (what ran) is reproduced byte-for-byte; `before` up to whitespace.
    expect(ops.filter((op) => op.type !== "delete").map((op) => op.text).join("")).toBe(after);
    const squash = (text: string) => text.replace(/\s+/g, "");
    expect(squash(ops.filter((op) => op.type !== "insert").map((op) => op.text).join(""))).toBe(squash(before));
  });

  it("keeps multi-word insertions as one span even when the LCS matched their spaces", () => {
    const ops = diffWords("Hotel is near Hongdae", "Hotel is within 1 km of Hongdae station");
    expect(ops.filter((op) => op.type === "insert").map((op) => op.text)).toEqual(["within 1 km of", "station"]);
    expect(ops.filter((op) => op.type === "delete").map((op) => op.text)).toEqual(["near"]);
    expect(ops.filter((op) => op.type !== "delete").map((op) => op.text).join("")).toBe("Hotel is within 1 km of Hongdae station");
    const deletes = diffWords("Remove these two words now", "Remove now");
    expect(deletes.filter((op) => op.type === "delete").map((op) => op.text)).toEqual(["these two words"]);
    expect(deletes.filter((op) => op.type !== "delete").map((op) => op.text).join("")).toBe("Remove now");
  });

  it("handles empty sides", () => {
    expect(diffWords("", "")).toEqual([]);
    expect(diffWords("", "added")).toEqual([{ type: "insert", text: "added" }]);
    expect(diffWords("gone", "")).toEqual([{ type: "delete", text: "gone" }]);
  });

  it("treats identical text as a single equal run", () => {
    const ops = diffWords("same words here", "same words here");
    expect(ops).toEqual([{ type: "equal", text: "same words here" }]);
    expect(diffSummary(ops)).toEqual({ inserted: 0, deleted: 0 });
  });
});
