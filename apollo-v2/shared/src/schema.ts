import type {
  Cluster,
  LongTask,
  ParticipantIdentity,
  SourceJourney,
  ValidationResult,
} from "./types";
import { clusterEnd, clusterStart, sanitizeHistoryUrl } from "./clustering";
import { GENERIC_SITE_FAMILIES, siteFamily } from "./themes";
import { APP_NAME, APP_VERSION, MAX_UPLOAD_BYTES } from "./config";
import {
  dedupeDomains,
  isRegionCode,
  MAX_SUBJECTS,
  MIN_SUBJECTS,
  normalizeSubject,
} from "./taxonomy";

// Deliberately minimal gates (v1 parity): counts, not limits. Everything else
// is advisory — the offline LLM pass refines what annotators leave loose.
export const MIN_REQUEST_LENGTH = 15;
export const MIN_JOURNEYS_FOR_HISTORY_MODES = 1;
const TRUNCATE_KEEP_HEAD = 150;
const TRUNCATE_KEEP_TAIL = 150;


export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function shortId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

export function participantId(identity: ParticipantIdentity): string {
  return identity.participantId || slugify(identity.email) || "internal";
}

export function sessionSegment(_identity: ParticipantIdentity): string {
  return "internal";
}

export function buildTaskId(identity: ParticipantIdentity, createdAt: string): string {
  const slug = createdAt.replace(/[^0-9T]/g, "").slice(0, 15);
  return `v2/${participantId(identity)}/${sessionSegment(identity)}/task-${shortId()}-${slug}`;
}

export function sourceJourneyFromCluster(c: Cluster, order: number, keyUrls: string[]): SourceJourney {
  const visits = c.visits.flatMap((visit) => {
    const url = sanitizeHistoryUrl(visit.url);
    if (!url) return [];
    let domain = visit.domain;
    try {
      domain = new URL(url).host;
    } catch {
      domain = "";
    }
    return [{ ...visit, url, domain }];
  });
  const safeKeys = keyUrls.map(sanitizeHistoryUrl).filter((url): url is string => !!url);
  // The local fingerprint contains URL anchors for deduplication. Never put
  // that reversible value in an upload; hash the sanitized journey instead.
  const fingerprintInput = visits.map((v) => `${v.visited_at}|${v.url}`).join("||");
  let hash = 2166136261;
  for (let i = 0; i < fingerprintInput.length; i++) {
    hash ^= fingerprintInput.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return {
    order,
    cluster_id: c.cluster_id,
    fingerprint: `journey-${(hash >>> 0).toString(16).padStart(8, "0")}`,
    start: visits[0]?.visited_at ?? clusterStart(c),
    end: visits[visits.length - 1]?.visited_at ?? clusterEnd(c),
    label: c.label || null,
    visits,
    key_urls: safeKeys,
  };
}

export function deriveSiteScope(journeys: SourceJourney[]): string[] {
  const counts = new Map<string, number>();
  for (const j of journeys) {
    for (const v of j.visits) {
      const family = siteFamily(v.domain || hostOf(v.url));
      if (family && !GENERIC_SITE_FAMILIES.has(family)) {
        counts.set(family, (counts.get(family) || 0) + 1);
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// The sites a task actually runs through, in the author's own order of
// emphasis: the scope chips they curated first, then the URLs they singled out,
// then anything else they attached.
//
// Not stored on the task and not asked of the author — every input is already
// part of the record, so domain distribution can be recomputed from stored
// tasks at any time by calling this. Kept here so that reporting and the
// authoring app agree on what "the sites this task uses" means.
export function derivePrimaryDomains(input: {
  siteScope?: readonly string[];
  keyUrls?: readonly string[];
  attachedUrls?: readonly string[];
}): string[] {
  return dedupeDomains([
    ...(input.siteScope ?? []),
    ...(input.keyUrls ?? []).map((url) => siteFamily(hostOf(url))),
    ...(input.attachedUrls ?? []).map((url) => siteFamily(hostOf(url))),
  ]);
}

export function deriveTimeSpan(journeys: SourceJourney[]): { start: string | null; end: string | null } {
  const starts = journeys.map((j) => j.start).filter(Boolean) as string[];
  const ends = journeys.map((j) => j.end).filter(Boolean) as string[];
  return {
    start: starts.length ? [...starts].sort()[0] : null,
    end: ends.length ? [...ends].sort()[ends.length - 1] : null,
  };
}

export function validateLongTask(task: LongTask): ValidationResult {
  const errors: Record<string, string> = {};
  const t = task.task;

  if ((t.agent_request || "").trim().length < MIN_REQUEST_LENGTH) {
    errors.agent_request = `Say a little more — at least ${MIN_REQUEST_LENGTH} characters.`;
  } else if (/\[[^\]]*\]/.test(t.agent_request)) {
    errors.agent_request = "Replace the [bracketed] parts of the draft with your specifics.";
  }
  // Title, difficulty, key URLs, and success criteria are all optional or
  // defaulted — the offline pipeline refines what annotators leave loose.

  // Distribution metadata is required at authoring time even though the field is
  // optional on the type: stored tasks predating it stay readable, but nothing
  // new should land without it, or the distribution counts are built on a
  // self-selected sample. Two picks, and only two — see derivePrimaryDomains for
  // the third signal, which is computed rather than asked for.
  const meta = t.metadata;
  if (!meta) {
    errors.metadata = "Add the region, sites, and subjects for this task.";
  } else {
    if (!isRegionCode(meta.region)) {
      errors.region = "Pick the country this task is anchored in, or 'no specific country'.";
    }
    // Normalize before counting: two spellings of the same leaf are one
    // subject, and the duplicate check below has to see them that way.
    const subjects = (meta.subjects ?? []).flatMap((s) => {
      const canonical = normalizeSubject(s);
      return canonical ? [canonical] : [];
    });
    if (subjects.length < MIN_SUBJECTS) {
      errors.subjects = "Pick at least one subject.";
    } else if (subjects.length > MAX_SUBJECTS) {
      errors.subjects = `Pick at most ${MAX_SUBJECTS} subjects — choose the ones the task is really about.`;
    } else if (new Set(subjects).size !== subjects.length) {
      errors.subjects = "Remove the duplicate subject.";
    }
  }

  const journeys = task.provenance.source_journeys;
  if (task.mode === "compose" || task.mode === "theme") {
    if (journeys.length < MIN_JOURNEYS_FOR_HISTORY_MODES) {
      errors.source_journeys = "Select at least one journey.";
    }
  }
  if (task.mode === "theme" && !task.provenance.theme_suggestion) {
    errors.theme_suggestion = "Theme tasks must record the suggestion they came from.";
  }
  if (task.mode === "guided") {
    const steps = (t.steps ?? []).filter((s) => s.description.trim().length >= 15);
    if (steps.length < 1) {
      errors.steps = "Fill in at least one substep (a sentence is enough).";
    }
  }

  if (!task.participant.participant_id) {
    errors.participant = "Missing participant identity.";
  }
  const consent = task.participant.consent;
  if (!consent?.version || !Number.isFinite(Date.parse(consent.accepted_at))) {
    errors.consent = "Data contribution consent is missing.";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function serializeLongTask(task: LongTask): string {
  return JSON.stringify(task, null, 2);
}

export function estimatePayloadBytes(task: LongTask): number {
  return new TextEncoder().encode(serializeLongTask(task)).length;
}

// Trim embedded journeys so the payload fits under the presign cap. Keeps the
// head and tail of each journey's visit list, which preserves the entry point
// and the goal state. Halves the kept window until the payload fits (or the
// window bottoms out — the review screen blocks upload in that case).
export function truncateForUpload(task: LongTask): { task: LongTask; truncated: boolean } {
  if (estimatePayloadBytes(task) <= MAX_UPLOAD_BYTES) return { task, truncated: false };

  const trimTo = (keepHead: number, keepTail: number): LongTask => ({
    ...task,
    provenance: {
      ...task.provenance,
      source_journeys: task.provenance.source_journeys.map((j) => {
        if (j.visits.length <= keepHead + keepTail) return j;
        return {
          ...j,
          visits: [...j.visits.slice(0, keepHead), ...j.visits.slice(-keepTail)],
          visits_truncated: true,
        };
      }),
    },
  });

  let head = TRUNCATE_KEEP_HEAD;
  let tail = TRUNCATE_KEEP_TAIL;
  let trimmed = trimTo(head, tail);
  while (estimatePayloadBytes(trimmed) > MAX_UPLOAD_BYTES && head > 5) {
    head = Math.floor(head / 2);
    tail = Math.floor(tail / 2);
    trimmed = trimTo(head, tail);
  }
  return { task: trimmed, truncated: true };
}

export function buildLongTask(input: {
  identity: ParticipantIdentity;
  mode: LongTask["mode"];
  platform: "tauri" | "web";
  task: LongTask["task"];
  sourceJourneys: SourceJourney[];
  themeSuggestion: LongTask["provenance"]["theme_suggestion"];
  template?: LongTask["provenance"]["template"];
  attachedUrls: string[];
  // Stable identifiers across retries of the same draft (else every retry of
  // a false-failure would mint a new S3 object the ingester can't dedupe).
  taskId?: string;
  createdAt?: string;
}): LongTask {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const identity = input.identity;
  return {
    schema_version: "odyssey_long_task_v2",
    task_id: input.taskId ?? buildTaskId(identity, createdAt),
    mode: input.mode,
    created_at: createdAt,
    app: { name: APP_NAME, version: APP_VERSION, platform: input.platform },
    participant: {
      kind: identity.kind,
      participant_id: participantId(identity),
      session_id: null,
      name: identity.name,
      email: identity.email,
      consent: { ...identity.consent },
    },
    task: input.task,
    provenance: {
      source_journeys: input.sourceJourneys,
      theme_suggestion: input.themeSuggestion,
      template: input.template ?? null,
      attached_urls: input.attachedUrls,
    },
  };
}
