// Core record + bundle types for the odyssey_personal_context_v1 schema.
//
// In-memory records ALWAYS hold the participant's original values. Aliasing,
// edits, masks, and replacement rules are applied only at serialization time
// (redact.ts) — the participant reads and edits their real data; only the
// redacted shape ever leaves the browser.

export type SourceKind = "email" | "calendar" | "contacts" | "orders" | "messages" | "transactions";

export type Address = { name: string; email: string };

export type BaseRecord = {
  id: string; // deterministic: sourceDetail + "-" + h128(nativeKey) — see ids.ts
  source: SourceKind;
  sourceDetail: string; // "gmail-mbox" | "eml" | "ics" | "vcf" | "google-csv" | "whatsapp-txt" | "email-receipt" | ...
  timestamp: string | null; // ISO 8601; null only for undated contacts
  // Precomputed lowercase search index over headers/participants — never bodies,
  // so the items list can filter without touching IndexedDB.
  searchText: string;
};

export type EmailRecord = BaseRecord & {
  source: "email";
  messageId: string;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  snippet: string; // first ~140 chars of body, for list rows
  bodyRef: boolean; // body text lives in IndexedDB, keyed by record id
  bodyTruncated: boolean;
  labels: string[]; // Gmail X-Gmail-Labels
  hasListUnsubscribe: boolean; // promotional heuristic
  attachments: { filename: string; size: number | null; mime: string }[]; // metadata only — payloads never decoded
};

export type CalendarRecord = BaseRecord & {
  source: "calendar";
  uid: string;
  summary: string;
  description: string;
  location: string;
  dtstart: string;
  dtend: string | null;
  allDay: boolean;
  tzid: string | null;
  organizer: Address | null;
  attendees: Address[];
  rrule: string | null; // raw RRULE — downstream environment builder expands
  recurrenceId: string | null;
  status: string | null;
};

export type ContactRecord = BaseRecord & {
  source: "contacts";
  fullName: string;
  emails: string[];
  phones: string[]; // normalized (digits, keeps +CC)
  org: string | null;
  birthday: string | null;
  addresses: string[];
  notes: string | null;
};

export type MessageRecord = BaseRecord & {
  source: "messages";
  chatId: string;
  chatName: string;
  sender: string;
  text: string; // chat messages are short — kept in memory, not IndexedDB
  isSystem: boolean;
  isMedia: boolean; // "<Media omitted>"
};

export type OrderRecord = BaseRecord & {
  source: "orders";
  merchant: string;
  orderId: string | null;
  total: number | null;
  currency: string;
  items: { title: string; quantity: number | null; price: number | null }[];
  shippingAddress: string | null;
  relatedRecordIds: string[]; // e.g. the confirmation EmailRecord — cross-source link
};

export type TransactionRecord = BaseRecord & {
  source: "transactions";
  description: string;
  amount: number;
  currency: string;
  account: string | null;
  category: string | null;
  relatedRecordIds: string[];
};

export type SourceRecord =
  | EmailRecord
  | CalendarRecord
  | ContactRecord
  | MessageRecord
  | OrderRecord
  | TransactionRecord;

// ---------------------------------------------------------------------------
// Participant + consent (mirrors apollo-v2's LongTask.participant block)

export type ParticipantIdentity = {
  kind: "internal";
  participantId: string;
  name: string;
  email: string;
  consent: { version: string; accepted_at: string };
};

// ---------------------------------------------------------------------------
// Entities & redaction decisions (local-only state; alias side ships, real side never does)

export type EntityCategory = "self" | "person" | "org" | "merchant";

export type Entity = {
  entityId: string; // random uuid — NEVER derived from real values (hash of a name is dictionary-reversible)
  category: EntityCategory;
  // Real side — never serialized into any upload:
  realNames: string[];
  realEmails: string[];
  realPhones: string[]; // normalized
  // Alias side — the only side that ships:
  alias: string;
  aliasEmail: string;
  aliasPhone: string | null;
  keepReal: boolean; // merchants default true; persons false
  occurrences: Partial<Record<SourceKind, number>>;
  mergedFrom: string[];
};

export type ItemDecision = {
  included: boolean;
  edits: Record<string, string>; // fieldName -> new value (original untouched)
  bodyEdit: string | null;
  maskOverrides: Record<string, boolean>; // scrub match id -> user kept original (true = unmask)
};

export type ReplacementRule = { find: string; replace: string; note: string };

// ---------------------------------------------------------------------------
// Tasks

export type PCTaskCategory =
  | "cross_source_reconciliation"
  | "aggregation_reporting"
  | "personal_lookup"
  | "pattern_inference"
  | "multi_step_orchestration";

export type PCTaskStep = { order: number; title: string; description: string };

export type PCTask = {
  task_id: string;
  category: PCTaskCategory;
  task_title: string;
  agent_request: string;
  steps: PCTaskStep[];
  success_criteria: string[];
  required_sources: SourceKind[];
  referenced_record_ids: string[]; // grounding — the record-picker output
  expected_answer: string | null; // participant-supplied ground truth
  notes: string | null;
};

// Authored-text-only shape returned by the shared Apollo review service.
// Apollo PC publishes this sidecar when a bundle is submitted; private mail,
// calendar data, record ids, and expected answers never enter the review flow.
export type ReviewLongTask = {
  schema_version: "odyssey_long_task_v2";
  task_id: string;
  mode: string;
  created_at: string;
  app: { name: string; version: string; platform: string };
  participant: {
    kind: "internal";
    participant_id: string;
    session_id: string | null;
    name: string | null;
    email: string | null;
    consent: { version: string; accepted_at: string };
  };
  task: {
    task_title: string;
    agent_request: string;
    task_summary: string | null;
    difficulty: string;
    site_scope: string[];
    success_criteria: string[];
    must_visit_or_reach: string[];
    required_outputs: string[];
    notes: string | null;
    time_span: { start: string | null; end: string | null };
    steps?: PCTaskStep[];
  };
  provenance: {
    source_journeys: unknown[];
    theme_suggestion: unknown | null;
    template: { template_id: string; template_title: string } | null;
    attached_urls: string[];
  };
  quality_signals?: unknown;
};

// ---------------------------------------------------------------------------
// Upload shapes (odyssey_personal_context_v1)

export type SourceMeta = {
  source_id: string; // sourceDetail, unique per import batch
  kind: SourceKind;
  export_format: string;
  parser: { name: string; version: string };
  date_range: { start: string | null; end: string | null };
  counts: { parsed: number; included: number; edited: number; excluded: number };
};

export type CorrelationHint = {
  a: string; // record_id
  b: string;
  relation: "confirms" | "pays_for" | "mentions" | "same_event";
  confidence: number;
};

export type ManifestEntityEntry = {
  entity_id: string;
  category: EntityCategory;
  alias: string;
  alias_email: string;
  alias_phone: string | null;
  kept_real: boolean;
  sources_present: SourceKind[];
  occurrence_count: number;
};

export type ManifestPart = {
  filename: string;
  kind: SourceKind | "tasks";
  record_count: number;
  bytes: number;
  sha256: string;
};

export type RedactionSummary = {
  items_edited: number;
  items_excluded_by_source: Partial<Record<SourceKind, number>>;
  auto_masks_applied: Record<string, number>; // detector -> count
  replacement_rules_applied: number;
};

export type PrivacyAuditFinding = {
  code: string;
  detector: string;
  severity: "block" | "warn";
  filename: string;
  path: string;
  count: number;
  message: string; // never contains the matched value
};

export type PrivacyAuditSummary = {
  standard: string;
  status: "pass" | "review" | "blocked";
  scanned_files: number;
  scanned_values: number;
  blocking_findings: number;
  warnings: number;
  kept_real_entities: number;
};

export type PrivacyAudit = PrivacyAuditSummary & {
  schema_version: "apollo_privacy_audit_v1";
  generated_at: string;
  findings: PrivacyAuditFinding[];
  controls: {
    aliases_applied: boolean;
    hard_masks_applied: boolean;
    tasks_scanned: boolean;
    final_dlp_scan: boolean;
    raw_alias_mapping_local_only: boolean;
  };
};

export type PCManifest = {
  schema_version: "odyssey_personal_context_v1";
  bundle_id: string;
  created_at: string;
  app: { name: string; version: string; platform: "web" };
  participant: {
    kind: "internal";
    participant_id: string;
    session_id: string;
    name: string;
    email: string;
    consent: { version: string; accepted_at: string };
  };
  sources: SourceMeta[];
  parts: ManifestPart[];
  entities: ManifestEntityEntry[];
  correlation_hints: CorrelationHint[];
  redaction: RedactionSummary;
  privacy_audit: PrivacyAuditSummary;
  tasks: PCTask[];
};

export type EmailPrivacyReview = {
  needs_annotator_review: boolean;
  sender_class: "personal" | "organization" | "service";
  service_label: string | null;
  reasons: Array<"personal-correspondence" | "personal-sender-kept-real" | "sensitive-content-masked">;
  sensitive_detectors: string[];
};

// The per-record envelope inside records_{kind}.json part files.
export type SerializedRecord = {
  record: Record<string, unknown>; // the redacted record (alias-side values)
  edited: string[]; // field names the participant hand-edited
  masked: string[]; // scrub detector names that fired and were applied
  aliased_entity_ids: string[];
  privacy_review?: EmailPrivacyReview; // email-only, value-free annotator signal
};

export type RecordsPart = {
  schema_version: "odyssey_personal_context_v1";
  bundle_id: string;
  kind: SourceKind;
  part: number; // 1-based
  records: SerializedRecord[];
};
