import { APP_NAME, APP_VERSION, MAX_UPLOAD_BYTES } from "./config";
import { shortId } from "./ids";
import type {
  CorrelationHint,
  Entity,
  ManifestEntityEntry,
  ManifestPart,
  ParticipantIdentity,
  PCManifest,
  PCTask,
  PrivacyAuditSummary,
  RecordsPart,
  RedactionSummary,
  SerializedRecord,
  SourceKind,
  SourceMeta,
} from "./types";

export function participantId(identity: ParticipantIdentity): string {
  if (identity.participantId) return identity.participantId;
  return slugify(identity.email);
}

export function participantUploadIdentity(identity: ParticipantIdentity, entities: Entity[]): ParticipantIdentity {
  const normalizedEmail = identity.email.trim().toLowerCase();
  const normalizedName = identity.name.trim().toLowerCase();
  const self = entities.find((entity) =>
    entity.category === "self" && entity.realEmails.some((email) => email.trim().toLowerCase() === normalizedEmail)
  ) ?? entities.find((entity) =>
    entity.category === "self" && entity.realNames.some((name) => name.trim().toLowerCase() === normalizedName)
  );
  if (self?.keepReal) return identity;

  const aliasName = self?.alias || "Protected participant";
  const aliasEmail = self?.aliasEmail || `${opaqueIdentityKey(identity.email)}@personamail.test`;
  return {
    ...identity,
    // Explicit study IDs are already opaque and must remain stable. Login-only
    // identities use the alias address so the raw email is absent from paths,
    // upload routing metadata, and the manifest.
    participantId: identity.participantId || slugify(aliasEmail),
    name: aliasName,
    email: aliasEmail,
  };
}

function opaqueIdentityKey(value: string): string {
  let hash = 2166136261;
  for (const char of value.trim().toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `participant-${(hash >>> 0).toString(36)}`;
}

export function slugify(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/^-+|-+$/g, "") || "anon"
  );
}

// pc/{pid}/internal/bundle-{shortid}-{tsSlug} — same anatomy as apollo-v2's
// v2 task ids, so the presign lambda validates it with a parallel regex and
// retries of one draft land in one S3 directory.
export function buildBundleId(identity: ParticipantIdentity, createdAt: string): string {
  const ts = createdAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace(/Z$/, "");
  return `pc/${participantId(identity)}/internal/bundle-${shortId(8)}-${ts}`;
}

// ---------------------------------------------------------------------------
// Part splitting: greedy pack of serialized records into files under the
// presign cap. Each part is independently valid JSON (RecordsPart envelope).

const PART_OVERHEAD = 512; // envelope + commas headroom

export function splitRecordsIntoParts(
  bundleId: string,
  kind: SourceKind,
  records: SerializedRecord[],
  maxBytes = MAX_UPLOAD_BYTES
): { filename: string; body: string; recordCount: number }[] {
  const chunks: SerializedRecord[][] = [];
  let current: SerializedRecord[] = [];
  let currentBytes = PART_OVERHEAD;
  for (const record of records) {
    const size = utf8Bytes(JSON.stringify(record)) + 1;
    if (current.length && currentBytes + size > maxBytes) {
      chunks.push(current);
      current = [];
      currentBytes = PART_OVERHEAD;
    }
    current.push(record);
    currentBytes += size;
  }
  if (current.length) chunks.push(current);

  return chunks.map((chunk, i) => {
    const part: RecordsPart = {
      schema_version: "odyssey_personal_context_v1",
      bundle_id: bundleId,
      kind,
      part: i + 1,
      records: chunk,
    };
    const filename = i === 0 ? `records_${kind}.json` : `records_${kind}_part${i + 1}.json`;
    return { filename, body: JSON.stringify(part), recordCount: chunk.length };
  });
}

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export async function sha256Hex(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Manifest

export function manifestEntities(entities: Entity[]): ManifestEntityEntry[] {
  return entities.map((e) => ({
    entity_id: e.entityId,
    category: e.category,
    alias: e.keepReal ? e.realNames[0] || e.alias : e.alias,
    alias_email: e.keepReal ? e.realEmails[0] || e.aliasEmail : e.aliasEmail,
    alias_phone: e.keepReal ? e.realPhones[0] || e.aliasPhone : e.aliasPhone,
    kept_real: e.keepReal,
    sources_present: Object.keys(e.occurrences) as SourceKind[],
    occurrence_count: Object.values(e.occurrences).reduce((a, b) => a + (b || 0), 0),
  }));
}

export function buildManifest(opts: {
  bundleId: string;
  createdAt: string;
  identity: ParticipantIdentity;
  sources: SourceMeta[];
  parts: ManifestPart[];
  entities: Entity[];
  correlationHints: CorrelationHint[];
  redaction: RedactionSummary;
  privacyAudit?: PrivacyAuditSummary;
  tasks: PCTask[];
}): PCManifest {
  const uploadIdentity = participantUploadIdentity(opts.identity, opts.entities);
  const privacyAudit = opts.privacyAudit ?? {
    standard: "NIST-oriented direct-identifier baseline 2026.08",
    status: "blocked" as const,
    scanned_files: 0,
    scanned_values: 0,
    blocking_findings: 1,
    warnings: 0,
    kept_real_entities: opts.entities.filter((entity) => entity.keepReal && (entity.category === "self" || entity.category === "person")).length,
  };
  return {
    schema_version: "odyssey_personal_context_v1",
    bundle_id: opts.bundleId,
    created_at: opts.createdAt,
    app: { name: APP_NAME, version: APP_VERSION, platform: "web" },
    participant: {
      kind: "internal",
      participant_id: participantId(uploadIdentity),
      session_id: "internal",
      name: uploadIdentity.name,
      email: uploadIdentity.email,
      consent: opts.identity.consent,
    },
    sources: opts.sources,
    parts: opts.parts,
    entities: manifestEntities(opts.entities),
    correlation_hints: opts.correlationHints,
    redaction: opts.redaction,
    privacy_audit: privacyAudit,
    tasks: opts.tasks,
  };
}

// ---------------------------------------------------------------------------
// Validation — soft-gates philosophy: hard checks only for consent, at least
// one included source, and at least one task with a substantive request.
// Everything else (category constraints, expected answers) is advisory.

export type ValidationResult = { valid: boolean; errors: Record<string, string> };

export const MIN_REQUEST_LENGTH = 15;

export function validateBundle(opts: {
  identity: ParticipantIdentity | null;
  includedCounts: Partial<Record<SourceKind, number>>;
  tasks: PCTask[];
}): ValidationResult {
  const errors: Record<string, string> = {};
  if (!opts.identity?.consent?.accepted_at) {
    errors.consent = "Sign in and accept the data contribution consent first.";
  }
  const totalIncluded = Object.values(opts.includedCounts).reduce((a, b) => a + (b || 0), 0);
  if (totalIncluded < 1) {
    errors.sources = "Include at least one record from one of your imports.";
  }
  if (!opts.tasks.length) {
    errors.tasks = "Write at least one personal assistant task.";
  } else {
    const weak = opts.tasks.find((t) => t.agent_request.trim().length < MIN_REQUEST_LENGTH);
    if (weak) errors.tasks = `"${weak.task_title || "Untitled"}" needs a fuller request (a sentence or two).`;
    const bracketed = opts.tasks.find((t) => /\[[^\]]+\]/.test(t.agent_request));
    if (bracketed) errors.tasks = `"${bracketed.task_title || "Untitled"}" still has unreplaced [brackets].`;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}
