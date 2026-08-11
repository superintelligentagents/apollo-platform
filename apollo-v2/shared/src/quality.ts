import type { LongTask } from "./types";

// Client-side, no-LLM quality signals recorded on every task and surfaced as a
// non-blocking "strength" meter. Collection stays frictionless (counts, not
// limits); these signals let the offline pipeline and dashboard triage
// low-effort submissions rather than prevent them.

export type QualityStrength = "low" | "medium" | "high";

export type QualitySignals = {
  strength: QualityStrength;
  score: number; // 0–100
  request_words: number;
  journey_count: number;
  visit_count: number;
  site_scope_count: number;
  step_count: number;
  has_constraints: boolean;
  has_comparison: boolean;
  has_deliverable: boolean;
  barely_edited_draft: boolean;
};

// Date-ish signals. Full month names are unambiguous (May excluded — it's a
// modal verb far more often); abbreviations only count with a day number
// ("Jul 17"), so "market"/"decide"/"separate" never match.
const MONTHS =
  /\b(january|february|march|april|june|july|august|september|october|november|december)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)\.? \d{1,2}\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
// A bare number isn't a constraint ("top 10", "iPhone 15"); money, a number
// with a unit, or an explicit bounding word is.
const CONSTRAINT =
  /[$£€]\s?\d|\b\d[\d,.]*\s?(nights?|days?|weeks?|hours?|people|guests?|stars?|%|km|miles?|k)\b|\bunder\b|\bbefore\b|\bwithin\b|\bbudget\b|\bmax(imum)?\b|\bat least\b|\bno more than\b|\bdeadline\b|\bper night\b|\bor less\b/i;
const COMPARISON =
  /\bcompare\b|\bvs\.?\b|\bversus\b|\bcheapest\b|\bbest\b|\bacross\b|\beither\b|\bbetween\b|\boptions?\b|\bshortlist\b/i;
const DELIVERABLE =
  /\bplan\b|\blist\b|\bitinerary\b|\bshortlist\b|\bspreadsheet\b|\btracker\b|\bbook\b|\bbooking\b|\bapply\b|\bapplication\b|\bsubmit\b|\breserve\b|\brecommend\b|\bsummary\b/i;

function countWords(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

// Net characters the author added on top of the generated draft, ignoring the
// bracket placeholders they were told to fill. A near-verbatim accept scores ~0.
export function netAuthoredChars(final: string, generated: string | null): number {
  const strip = (s: string) => s.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
  const f = strip(final);
  if (!generated) return f.length; // no draft was offered (fully hand-written)
  const g = strip(generated);
  // Longest common prefix + suffix against the draft skeleton; the middle the
  // author typed into the [slots] plus any net lengthening is "authored".
  let pre = 0;
  while (pre < f.length && pre < g.length && f[pre] === g[pre]) pre++;
  let suf = 0;
  while (
    suf < f.length - pre &&
    suf < g.length - pre &&
    f[f.length - 1 - suf] === g[g.length - 1 - suf]
  )
    suf++;
  const authoredMiddle = Math.max(0, f.length - pre - suf);
  const netLength = Math.max(0, f.length - g.length);
  return Math.max(authoredMiddle, netLength);
}

// Cheap per-keystroke signals for live UI feedback (the form's checklist).
export function liveRequestSignals(request: string): {
  words: number;
  constraints: boolean;
  comparison: boolean;
  deliverable: boolean;
} {
  return {
    words: request.trim() ? request.trim().split(/\s+/).length : 0,
    constraints: CONSTRAINT.test(request) || MONTHS.test(request),
    comparison: COMPARISON.test(request),
    deliverable: DELIVERABLE.test(request),
  };
}

export function computeQualitySignals(task: LongTask, generatedDraft: string | null): QualitySignals {
  const t = task.task;
  const request = t.agent_request || "";
  const journeys = task.provenance.source_journeys;
  const requestWords = countWords(request);
  const visitCount = journeys.reduce((s, j) => s + (j.visits?.length || 0), 0);
  const stepCount = t.steps?.length || 0;
  const siteScopeCount = t.site_scope.length;

  const live = liveRequestSignals(request);
  const hasConstraints = live.constraints;
  const hasComparison = live.comparison || siteScopeCount >= 2;
  const hasDeliverable = live.deliverable || t.required_outputs.length > 0;
  const barelyEdited = netAuthoredChars(request, generatedDraft) < 25;

  // Weighted score. Depth of the ASK dominates; provenance and structure add.
  let score = 0;
  score += Math.min(requestWords, 60) * 0.6; // up to 36
  if (hasConstraints) score += 16;
  if (hasComparison) score += 16;
  if (hasDeliverable) score += 12;
  score += Math.min(journeys.length, 4) * 3; // up to 12, history depth
  score += Math.min(stepCount, 4) * 2; // up to 8, structured plan
  if (barelyEdited) score -= 30; // the strongest low-effort signal
  score = Math.max(0, Math.min(100, Math.round(score)));

  const strength: QualityStrength = barelyEdited || score < 35 ? "low" : score < 65 ? "medium" : "high";

  return {
    strength,
    score,
    request_words: requestWords,
    journey_count: journeys.length,
    visit_count: visitCount,
    site_scope_count: siteScopeCount,
    step_count: stepCount,
    has_constraints: hasConstraints,
    has_comparison: hasComparison,
    has_deliverable: hasDeliverable,
    barely_edited_draft: barelyEdited,
  };
}

// The concrete, friendly hints behind a low/medium score — shown in the meter.
export function qualityHints(s: QualitySignals): string[] {
  const hints: string[] = [];
  if (s.barely_edited_draft) hints.push("Make it yours — the draft is barely changed.");
  if (s.request_words < 25) hints.push("Add detail — say exactly what to do.");
  if (!s.has_constraints) hints.push("Add a constraint (a budget, a reusable time window, a place).");
  if (!s.has_comparison) hints.push("Compare across options or two+ sites.");
  if (!s.has_deliverable) hints.push("Say what should exist at the end (a plan, a booking).");
  return hints.slice(0, 3);
}
