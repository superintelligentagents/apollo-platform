import { APP_NAME, APP_VERSION } from "./config";
import type { PCTask } from "./types";

// PC bundles contain private contextual records. Peer review receives only
// this authored-task sidecar: no participant identity, record ids, expected
// answers, entities, aliases, or source data.
export function reviewTaskFilename(task: PCTask): string {
  const safeId = task.task_id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) || "task";
  return `review_task_${safeId}.json`;
}

export function buildReviewTaskSidecar(task: PCTask, createdAt: string): string {
  return JSON.stringify({
    schema_version: "odyssey_long_task_v2",
    task_id: `pc_${task.task_id}`,
    mode: "guided",
    created_at: createdAt,
    app: { name: APP_NAME, version: APP_VERSION, platform: "web" },
    participant: {
      kind: "internal",
      participant_id: "redacted",
      session_id: null,
      name: null,
      email: null,
      consent: { version: "redacted", accepted_at: createdAt },
    },
    task: {
      task_title: task.task_title,
      agent_request: task.agent_request,
      task_summary: null,
      difficulty: "high",
      site_scope: [],
      success_criteria: task.success_criteria,
      must_visit_or_reach: [],
      required_outputs: [],
      notes: task.notes,
      time_span: { start: null, end: null },
      steps: task.steps,
    },
    provenance: {
      source_journeys: [],
      theme_suggestion: null,
      template: { template_id: `pc-${task.category}`, template_title: "Apollo PC task" },
      attached_urls: [],
    },
  });
}
