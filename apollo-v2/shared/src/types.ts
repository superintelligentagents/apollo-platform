export type Visit = {
  id: number;
  url: string;
  title: string;
  visited_at: string;
  from_visit?: number;
  domain?: string;
  search_term?: string;
};

export type Cluster = {
  cluster_id: number;
  visits: Visit[];
  fingerprint?: string;
  label?: string;
};

export type ProfileOption = {
  path: string;
  profile: string;
  browser: string;
  is_default: boolean;
  emails: string[];
};

export type ParticipantIdentity = {
  kind: "internal";
  participantId: string;
  name: string;
  email: string;
  consent: {
    version: string;
    accepted_at: string;
  };
};

export type TaskMode = "compose" | "theme" | "freeform" | "guided";

export type Difficulty = "low" | "medium" | "high";

export type SourceJourney = {
  order: number;
  cluster_id: number;
  fingerprint: string;
  start: string | null;
  end: string | null;
  label: string | null;
  visits: Visit[];
  key_urls: string[];
  visits_truncated?: boolean;
};

export type ThemeAlgo = "cohesion" | "topic" | "site" | "burst";

export type ThemeSuggestion = {
  theme_id: string;
  algo: ThemeAlgo;
  // Second-level chaining: suggestions sharing project vocabulary get the
  // same thread_group so the UI can present them as one meta-project.
  thread_group: number;
  score: number;
  shared_tokens: string[];
  site_families: string[];
  cluster_fingerprints: string[];
  start: string | null;
  end: string | null;
  distinct_days: number;
};

// One substep of a guided (blueprint) task. Mirrors the anatomy of the
// benchmark's rubric items: each step becomes a requirement a grader checks.
export type GuidedStep = {
  order: number;
  title: string;
  description: string;
};

// Distribution metadata. Declared by the author, used to monitor how collection
// is spread across places, sites, and topics — see taxonomy.ts for the reasoning
// and the vocabularies.
export type TaskMetadata = {
  // ISO 3166-1 alpha-2, or REGION_GLOBAL when the task has no geographic anchor.
  region: string;
  // 1–3 "Top > Sub" leaves from the Odysseys category vocabulary.
  subjects: string[];
};

export type LongTaskRubric = {
  task_title: string;
  agent_request: string;
  task_summary: string | null;
  difficulty: Difficulty;
  site_scope: string[];
  success_criteria: string[];
  must_visit_or_reach: string[];
  required_outputs: string[];
  notes: string | null;
  time_span: { start: string | null; end: string | null };
  // Present for guided-mode tasks: the structured substeps behind agent_request.
  steps?: GuidedStep[];
  // Optional on the type because tasks collected before this field existed are
  // still valid stored records, and readers must handle them. Authoring-time
  // validation requires it — see validateLongTask.
  metadata?: TaskMetadata;
};

export type LongTaskThemeProvenance = {
  theme_id: string;
  algo?: string;
  score: number;
  shared_tokens: string[];
  site_families: string[];
  accepted_journey_fingerprints: string[];
  removed_journey_fingerprints: string[];
};

export type LongTask = {
  schema_version: "odyssey_long_task_v2";
  task_id: string;
  mode: TaskMode;
  created_at: string;
  app: { name: string; version: string; platform: "tauri" | "web" };
  participant: {
    kind: "internal";
    participant_id: string;
    session_id: string | null;
    name: string | null;
    email: string | null;
    consent: {
      version: string;
      accepted_at: string;
    };
  };
  task: LongTaskRubric;
  provenance: {
    source_journeys: SourceJourney[];
    theme_suggestion: LongTaskThemeProvenance | null;
    template: { template_id: string; template_title: string } | null;
    attached_urls: string[];
  };
  // Non-blocking, client-computed effort/richness signals (see quality.ts).
  quality_signals?: import("./quality").QualitySignals;
};

export type ValidationResult = {
  valid: boolean;
  errors: Record<string, string>;
};
