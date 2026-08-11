import { scrubText } from "./scrub";
import type {
  Entity,
  ParticipantIdentity,
  PrivacyAudit,
  PrivacyAuditFinding,
  PrivacyAuditSummary,
} from "./types";

export const PRIVACY_BASELINE = "NIST-oriented direct-identifier baseline 2026.08";

type AuditFile = { filename: string; body: string };
type Surface = { value: string; detector: "real-name" | "real-email" | "real-phone"; allowed: boolean };

export function privacyAuditSummary(audit: PrivacyAudit): PrivacyAuditSummary {
  return {
    standard: audit.standard,
    status: audit.status,
    scanned_files: audit.scanned_files,
    scanned_values: audit.scanned_values,
    blocking_findings: audit.blocking_findings,
    warnings: audit.warnings,
    kept_real_entities: audit.kept_real_entities,
  };
}

export function auditPrivacyBundle(opts: {
  files: AuditFile[];
  identity: ParticipantIdentity;
  entities: Entity[];
  generatedAt: string;
}): PrivacyAudit {
  const findings = new Map<string, PrivacyAuditFinding>();
  const surfaces = identitySurfaces(opts.identity, opts.entities);
  let scannedValues = 0;
  let exactTimestamps = 0;
  let retainedLocations = 0;
  let relationshipHints = 0;

  const add = (finding: Omit<PrivacyAuditFinding, "count">) => {
    const key = [finding.code, finding.detector, finding.severity, finding.filename, finding.path].join("::");
    const existing = findings.get(key);
    if (existing) existing.count += 1;
    else findings.set(key, { ...finding, count: 1 });
  };

  for (const file of opts.files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.body);
    } catch {
      add({
        code: "unscannable-json",
        detector: "serialization",
        severity: "block",
        filename: file.filename,
        path: "$",
        message: "The privacy gate could not parse this upload file.",
      });
      continue;
    }
    walkStrings(parsed, "$", (value, path) => {
      scannedValues++;
      const lower = value.toLowerCase();

      for (const surface of surfaces) {
        if (!surfaceAppears(value, surface)) continue;
        add({
          code: surface.allowed ? "explicit-keep-real" : "raw-identity-leak",
          detector: surface.detector,
          severity: surface.allowed ? "warn" : "block",
          filename: file.filename,
          path,
          message: surface.allowed
            ? "A user-approved keep-real identity is present in the upload copy."
            : "A protected original identity value remains in the upload copy.",
        });
      }

      // Opaque application IDs are UUIDs/hashes. Digit sequences inside them
      // can resemble phone numbers by chance, but they are not user data.
      // Exact raw-identity surface checks above still run on every field.
      if (!isOpaqueIdentifierPath(path)) {
        for (const match of scrubText(`audit:${file.filename}`, path, value)) {
          if (safeAliasMatch(match.excerpt)) continue;
          if (safeOrganizationMatch(match.excerpt, opts.entities)) continue;
          const approved = surfaces.some((surface) => surface.allowed && surfaceAppears(match.excerpt, surface));
          add({
            code: approved ? "explicit-keep-real" : "unmasked-pii",
            detector: match.detector,
            severity: approved ? "warn" : "block",
            filename: file.filename,
            path,
            message: approved
              ? "A user-approved keep-real value matches a PII detector."
              : "A direct identifier or secret remains unmasked in the upload copy.",
          });
        }
      }

      if (/\.(?:timestamp|dtstart|dtend)$/.test(path) && /T(?!00:00:00)/.test(value)) exactTimestamps++;
      if (/\.(?:location|shipping_address)$/.test(path) && value.trim() && !/^\[[a-z-]+\]$/i.test(value.trim())) retainedLocations++;
      if (path.includes(".correlation_hints[") && lower) relationshipHints++;
    });
  }

  for (const entity of opts.entities.filter((item) => item.keepReal && isPersonalEntity(item))) {
    add({
      code: "explicit-keep-real-entity",
      detector: "entity-policy",
      severity: "warn",
      filename: "manifest.json",
      path: `$.entities.${entity.entityId}`,
      message: "An entity is intentionally retained in real form and remains personal data.",
    });
  }
  if (exactTimestamps) add({
    code: "reidentification-exact-time",
    detector: "quasi-identifier",
    severity: "warn",
    filename: "bundle",
    path: "$.records.*.timestamp",
    message: "Exact timestamps are retained for utility and can increase re-identification risk.",
  });
  if (retainedLocations) add({
    code: "reidentification-location",
    detector: "quasi-identifier",
    severity: "warn",
    filename: "bundle",
    path: "$.records.*.location",
    message: "Non-address location details are retained and can increase re-identification risk.",
  });
  if (relationshipHints) add({
    code: "reidentification-relationships",
    detector: "quasi-identifier",
    severity: "warn",
    filename: "manifest.json",
    path: "$.correlation_hints",
    message: "Cross-record relationships are retained and can increase re-identification risk.",
  });

  const findingList = [...findings.values()].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "block" ? -1 : 1;
    return `${a.filename}:${a.path}:${a.detector}`.localeCompare(`${b.filename}:${b.path}:${b.detector}`);
  });
  const blocking = findingList.filter((finding) => finding.severity === "block").reduce((sum, finding) => sum + finding.count, 0);
  const warnings = findingList.filter((finding) => finding.severity === "warn").reduce((sum, finding) => sum + finding.count, 0);
  return {
    schema_version: "apollo_privacy_audit_v1",
    standard: PRIVACY_BASELINE,
    generated_at: opts.generatedAt,
    status: blocking ? "blocked" : warnings ? "review" : "pass",
    scanned_files: opts.files.length,
    scanned_values: scannedValues,
    blocking_findings: blocking,
    warnings,
    kept_real_entities: opts.entities.filter((entity) => entity.keepReal && isPersonalEntity(entity)).length,
    findings: findingList,
    controls: {
      aliases_applied: true,
      hard_masks_applied: true,
      tasks_scanned: true,
      final_dlp_scan: true,
      raw_alias_mapping_local_only: true,
    },
  };
}

function identitySurfaces(identity: ParticipantIdentity, entities: Entity[]): Surface[] {
  const surfaces: Surface[] = [];
  for (const entity of entities.filter(isPersonalEntity)) {
    for (const value of entity.realNames) addSurface(surfaces, value, "real-name", entity.keepReal);
    for (const value of entity.realEmails) addSurface(surfaces, value, "real-email", entity.keepReal);
    for (const value of entity.realPhones) addSurface(surfaces, value, "real-phone", entity.keepReal);
  }
  const self = entities.find((entity) => entity.category === "self" && entity.realEmails.some((email) => email.toLowerCase() === identity.email.toLowerCase()));
  addSurface(surfaces, identity.name, "real-name", !!self?.keepReal);
  addSurface(surfaces, identity.email, "real-email", !!self?.keepReal);
  return surfaces;
}

function isPersonalEntity(entity: Entity): boolean {
  return entity.category === "self" || entity.category === "person";
}

function safeOrganizationMatch(value: string, entities: Entity[]): boolean {
  return entities
    .filter((entity) => entity.keepReal && (entity.category === "org" || entity.category === "merchant"))
    .some((entity) => [
      ...entity.realNames.map((surface) => ({ value: surface, detector: "real-name" as const, allowed: true })),
      ...entity.realEmails.map((surface) => ({ value: surface, detector: "real-email" as const, allowed: true })),
      ...entity.realPhones.map((surface) => ({ value: surface, detector: "real-phone" as const, allowed: true })),
    ].some((surface) => surfaceAppears(value, surface)));
}

function addSurface(surfaces: Surface[], value: string, detector: Surface["detector"], allowed: boolean): void {
  const trimmed = value.trim();
  if (!trimmed || (detector === "real-name" && trimmed.length < 3)) return;
  const duplicate = surfaces.find((surface) => surface.detector === detector && surface.value.toLowerCase() === trimmed.toLowerCase());
  if (duplicate) duplicate.allowed = duplicate.allowed && allowed;
  else surfaces.push({ value: trimmed, detector, allowed });
}

function surfaceAppears(text: string, surface: Surface): boolean {
  if (surface.detector === "real-phone") {
    const target = surface.value.replace(/\D/g, "");
    const candidate = text.replace(/\D/g, "");
    return target.length >= 7 && candidate.includes(target);
  }
  if (surface.detector === "real-name") {
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(surface.value)}(?=$|[^\\p{L}\\p{N}])`, "iu").test(text);
  }
  return text.toLowerCase().includes(surface.value.toLowerCase());
}

function safeAliasMatch(value: string): boolean {
  const lower = value.toLowerCase();
  const digits = value.replace(/\D/g, "");
  return lower.endsWith("@personamail.test") ||
    /@[^@]+\.(?:example|invalid|test)$/.test(lower) ||
    /^155501\d{2,4}$/.test(digits) ||
    /^\[[a-z-]+\]$/i.test(value);
}

function isOpaqueIdentifierPath(path: string): boolean {
  return /\.(?:entity_id|record_id|task_id|bundle_id|related_record_ids|referenced_record_ids|aliased_entity_ids)(?:\[\d+\])?$/.test(path);
}

function walkStrings(value: unknown, path: string, visit: (value: string, path: string) => void): void {
  if (typeof value === "string") {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${path}[${index}]`, visit));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) walkStrings(item, `${path}.${key}`, visit);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
