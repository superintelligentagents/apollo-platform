import type { QualitySignals } from "../../quality";
import { qualityHints } from "../../quality";
import { el } from "./helpers";

const LABEL: Record<QualitySignals["strength"], string> = {
  low: "Looks quick",
  medium: "Good",
  high: "Strong task",
};

// Non-blocking task-strength meter: a colored bar, a label, and up to three
// concrete "make it richer" hints. Never gates upload.
export function strengthMeter(signals: QualitySignals): HTMLElement {
  const hints = qualityHints(signals);
  const bar = el("div", { class: "strength-bar" }, el("span", { class: "strength-fill", style: `width:${signals.score}%` }));
  return el(
    "div",
    { class: `strength-meter ${signals.strength}` },
    el(
      "div",
      { class: "strength-head" },
      el(
        "span",
        { class: "strength-label" },
        el("span", { class: "strength-cap" }, "Task strength — "),
        LABEL[signals.strength]
      ),
      el("span", { class: "strength-score mono" }, `${signals.score}/100`)
    ),
    bar,
    hints.length
      ? el(
          "div",
          { class: "strength-nudge" },
          el("p", { class: "strength-nudge-lead" }, "A little more would make it a stronger task:"),
          el("ul", { class: "strength-hints" }, ...hints.map((h) => el("li", null, h)))
        )
      : el("p", { class: "strength-nudge-lead" }, "Ready to go — this reads like a real task.")
  );
}
