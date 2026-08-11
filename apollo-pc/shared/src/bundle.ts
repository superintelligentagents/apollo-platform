// Bundle assembly: turns the in-memory state into the exact files that would
// upload — redacted record parts, tasks, and the manifest. Shared by the
// submit path (app.ts) and the review screen's "download exactly what
// uploads" preview, so what you export IS what ships, byte for byte.

import { buildCorrelationHints } from "./correlate";
import { TASKS_FILENAME } from "./config";
import { auditPrivacyBundle, privacyAuditSummary } from "./privacy-audit";
import { buildRedactContext, redactTaskForUpload, serializeRecord } from "./redact";
import { buildManifest, sha256Hex, splitRecordsIntoParts, utf8Bytes } from "./schema";
import { cardFor } from "./sources/registry";
import type { RecordStore } from "./store";
import type {
  ManifestPart,
  ParticipantIdentity,
  PCTask,
  PrivacyAudit,
  RedactionSummary,
  SerializedRecord,
  SourceKind,
  SourceMeta,
  SourceRecord,
} from "./types";
import type { AppState } from "./ui/context";

export type BundleUpload = {
  filename: string;
  body: string;
  kind: SourceKind | "tasks";
  recordCount: number;
};

export type AssembledBundle = {
  uploads: BundleUpload[]; // parts (+ tasks.json when large) — manifest NOT included
  manifestBody: string; // uploaded last / previewed alongside
  includedCount: number;
  privacyAudit: PrivacyAudit;
  sanitizedTasks: PCTask[];
};

export async function assembleBundle(
  state: AppState,
  store: RecordStore,
  identity: ParticipantIdentity,
  bundleId: string,
  createdAt: string,
  isIncluded: (r: SourceRecord) => boolean
): Promise<AssembledBundle> {
  const included = [...state.records.values()].filter(isIncluded);
  const redactCtx = buildRedactContext(state.entities, state.rules);
  const emailIds = included.filter((r) => r.source === "email").map((r) => r.id);
  const bodies = await store.getBodies(emailIds);

  const byKind = new Map<SourceKind, SerializedRecord[]>();
  const redaction: RedactionSummary = {
    items_edited: 0,
    items_excluded_by_source: {},
    auto_masks_applied: {},
    replacement_rules_applied: state.rules.length,
  };
  for (const record of state.records.values()) {
    if (!isIncluded(record)) {
      redaction.items_excluded_by_source[record.source] =
        (redaction.items_excluded_by_source[record.source] || 0) + 1;
    }
  }
  for (const record of included) {
    const serialized = serializeRecord(
      record,
      state.decisions.get(record.id),
      redactCtx,
      record.source === "email" ? bodies.get(record.id) ?? "" : null
    );
    if (serialized.edited.length) redaction.items_edited++;
    for (const det of serialized.masked) {
      redaction.auto_masks_applied[det] = (redaction.auto_masks_applied[det] || 0) + 1;
    }
    const list = byKind.get(record.source) || [];
    list.push(serialized);
    byKind.set(record.source, list);
  }

  const uploads: BundleUpload[] = [];
  for (const [kind, records] of byKind) {
    for (const part of splitRecordsIntoParts(bundleId, kind, records)) {
      uploads.push({ filename: part.filename, body: part.body, kind, recordCount: part.recordCount });
    }
  }
  const sanitizedTaskResults = state.tasks.map((task) => redactTaskForUpload(task, redactCtx));
  const sanitizedTasks = sanitizedTaskResults.map((result) => result.task);
  for (const result of sanitizedTaskResults) {
    for (const detector of result.masked) {
      redaction.auto_masks_applied[detector] = (redaction.auto_masks_applied[detector] || 0) + 1;
    }
  }
  const tasksBody = JSON.stringify({
    schema_version: "odyssey_personal_context_v1",
    bundle_id: bundleId,
    tasks: sanitizedTasks,
  });
  const inlineTasks = utf8Bytes(tasksBody) < 512 * 1024;
  if (!inlineTasks) uploads.push({ filename: TASKS_FILENAME, body: tasksBody, kind: "tasks", recordCount: sanitizedTasks.length });

  const parts: ManifestPart[] = [];
  for (const u of uploads) {
    parts.push({
      filename: u.filename,
      kind: u.kind,
      record_count: u.recordCount,
      bytes: utf8Bytes(u.body),
      sha256: await sha256Hex(u.body),
    });
  }

  const sources: SourceMeta[] = Object.entries(state.imports).map(([kind, info]) => ({
    source_id: kind,
    kind: kind as SourceKind,
    export_format: cardFor(kind as SourceKind).parser?.accept.join("/") ?? "derived",
    parser: { name: cardFor(kind as SourceKind).parser?.id ?? "derived", version: "1" },
    date_range: info.stats.dateRange
      ? { start: info.stats.dateRange.min, end: info.stats.dateRange.max }
      : { start: null, end: null },
    counts: {
      parsed: info.stats.recordsEmitted,
      included: included.filter((r) => r.source === kind).length,
      edited: included.filter(
        (r) => r.source === kind && Object.keys(state.decisions.get(r.id)?.edits ?? {}).length
      ).length,
      excluded: redaction.items_excluded_by_source[kind as SourceKind] || 0,
    },
  }));

  const manifestOptions = {
    bundleId,
    createdAt,
    identity,
    sources,
    parts,
    entities: state.entities,
    correlationHints: buildCorrelationHints(included, state.tasks),
    redaction,
    tasks: inlineTasks ? sanitizedTasks : [],
  };
  const provisionalManifest = buildManifest(manifestOptions);
  const uploadFiles = uploads.map((upload) => ({ filename: upload.filename, body: upload.body }));
  const initialAudit = auditPrivacyBundle({
    files: [...uploadFiles, { filename: "manifest.json", body: JSON.stringify(provisionalManifest) }],
    identity,
    entities: state.entities,
    generatedAt: createdAt,
  });
  let manifest = buildManifest({ ...manifestOptions, privacyAudit: privacyAuditSummary(initialAudit) });
  const privacyAudit = auditPrivacyBundle({
    files: [...uploadFiles, { filename: "manifest.json", body: JSON.stringify(manifest) }],
    identity,
    entities: state.entities,
    generatedAt: createdAt,
  });
  manifest = buildManifest({ ...manifestOptions, privacyAudit: privacyAuditSummary(privacyAudit) });

  return { uploads, manifestBody: JSON.stringify(manifest), includedCount: included.length, privacyAudit, sanitizedTasks };
}
