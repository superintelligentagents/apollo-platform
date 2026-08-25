// Renders the word-level diff from ../../diff as DOM.
//
// Kept separate from the algorithm so the algorithm tests need no jsdom, and so
// the reviewer and admin screens can adopt the same markup later.

import { diffWords } from "../../diff";
import { el } from "./helpers";

/**
 * Redline segments as nodes: plain text for unchanged runs, <del>/<ins> for
 * changes.
 *
 * <del> and <ins> are used rather than styled spans on purpose: they carry the
 * meaning semantically for assistive tech, so the red/green wash is decoration
 * rather than the only signal. Unchanged runs stay strings, which `el` appends
 * through createTextNode — never assign this to innerHTML.
 */
export function redlineNodes(before: string, after: string): (HTMLElement | string)[] {
  return diffWords(before, after).map((segment) => {
    if (segment.op === "equal") return segment.text;
    if (segment.op === "delete") return el("del", { class: "redline-del" }, segment.text);
    return el("ins", { class: "redline-ins" }, segment.text);
  });
}

/**
 * A labelled redlined paragraph, or null when the two versions are identical so
 * the caller can drop the section entirely instead of padding the view.
 */
export function redlineBlock(label: string, before: string, after: string): HTMLElement | null {
  if (before === after) return null;
  return el(
    "div",
    { class: "redline-block" },
    el("h6", null, label),
    el("p", { class: "redline-text" }, ...redlineNodes(before, after))
  );
}
