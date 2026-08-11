import type { Ctx } from "./context";
import type { LongTask } from "../types";
import { buildLongTask, buildTaskId, deriveTimeSpan, sourceJourneyFromCluster } from "../schema";
import { substantiveSteps } from "../templates";
import { sanitizeHistoryUrl } from "../clustering";
import { computeQualitySignals } from "../quality";

// Typed URLs get the same privacy treatment as history URLs: http(s) only,
// credentials stripped, sensitive destinations dropped.
export function sanitizeAttachedUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject any explicit non-http(s) scheme (mailto:, javascript:, tel:, …)
  // before defaulting bare hosts to https.
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") return null;
  try {
    const u = new URL(scheme ? trimmed : `https://${trimmed}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.username = "";
    u.password = "";
    return sanitizeHistoryUrl(u.toString());
  } catch {
    return null;
  }
}

// Assemble the LongTask from current UI state. Called for both review display
// and the actual upload (the upload stamps a fresh task_id/created_at).
export function buildPendingTask(ctx: Ctx): LongTask | null {
  const { state, adapter } = ctx;
  if (!state.identity || !state.mode) return null;
  const d = state.draft;

  const sourceJourneys = state.basket.map((c, i) =>
    sourceJourneyFromCluster(c, i, state.keyUrls.filter((u) => c.visits.some((v) => v.url === u)))
  );

  const attachedUrls = state.attachedUrls
    .map(sanitizeAttachedUrl)
    .filter((u): u is string => u !== null);
  const historyBacked = state.mode === "compose" || state.mode === "theme";
  const mustVisit = historyBacked ? state.keyUrls.filter(Boolean) : attachedUrls;
  const allSteps = substantiveSteps(state.guidedSteps);
  const guidedSteps = allSteps.length ? allSteps : undefined;
  const userCriteria = d.success_criteria.map((s) => s.trim()).filter(Boolean);

  const request = d.agent_request.trim();
  // Title is optional in the UI — derive one from the request when blank,
  // trimming so it never ends mid-phrase ("…Yankee Stadium and").
  const DANGLING = new Set([
    "and", "or", "the", "a", "an", "to", "for", "with", "my", "our", "of",
    "in", "on", "at", "by", "from", "that", "then",
    "under", "over", "before", "after", "about", "between", "into", "near",
  ]);
  const autoTitle = () => {
    // Assembled guided requests open with a connective ("First, compare…");
    // a title shouldn't ("First compare flights…" reads broken).
    const LEADING = /^(first|then|next|after that|finally|from there)[,\s]+/i;
    const words = request
      .replace(LEADING, "")
      .replace(/[.,;:!?]+/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8);
    while (words.length > 3 && DANGLING.has(words[words.length - 1].toLowerCase())) {
      words.pop();
    }
    const joined = words.join(" ");
    // Stripping the connective can leave a lowercase start ("compare flights…").
    const title = joined.charAt(0).toUpperCase() + joined.slice(1);
    return title.length > 60 ? `${title.slice(0, 57)}…` : title;
  };

  // One stable task_id per draft attempt: retries of a false-failure upload
  // land on the same S3 task path, so the ingester's dedupe catches them.
  if (!state.pendingTaskId) {
    state.pendingCreatedAt = new Date().toISOString();
    state.pendingTaskId = buildTaskId(state.identity, state.pendingCreatedAt);
  }

  const task = buildLongTask({
    identity: state.identity,
    mode: state.mode,
    platform: adapter.platform,
    taskId: state.pendingTaskId,
    createdAt: state.pendingCreatedAt ?? undefined,
    task: {
      task_title: d.task_title.trim() || autoTitle(),
      agent_request: request,
      task_summary: d.task_summary.trim() || null,
      difficulty: d.difficulty || "high",
      site_scope: d.site_scope,
      // Steps are the review rubric for structured tasks. Keep this field only
      // for criteria the author explicitly entered; never duplicate steps.
      success_criteria: userCriteria,
      must_visit_or_reach: mustVisit,
      required_outputs: d.required_outputs.map((s) => s.trim()).filter(Boolean),
      notes: d.notes.trim() || null,
      time_span: deriveTimeSpan(sourceJourneys),
      ...(guidedSteps ? { steps: guidedSteps } : {}),
    },
    sourceJourneys,
    template:
      state.mode === "guided" && state.activeTemplate
        ? { template_id: state.activeTemplate.id, template_title: state.activeTemplate.title }
        : null,
    themeSuggestion:
      state.mode === "theme" && state.activeTheme
        ? {
            theme_id: state.activeTheme.theme_id,
            algo: state.activeTheme.algo,
            score: state.activeTheme.score,
            shared_tokens: state.activeTheme.shared_tokens,
            site_families: state.activeTheme.site_families,
            accepted_journey_fingerprints: sourceJourneys.map((j) => j.fingerprint),
            removed_journey_fingerprints: state.removedFromTheme,
          }
        : null,
    attachedUrls,
  });
  task.quality_signals = computeQualitySignals(task, state.generatedDraft);
  return task;
}
