// Serialization-time redaction. In-memory records always hold originals; this
// module produces the upload shape by applying, in order:
//   1. field edits / body edit (participant's hand edits win over everything)
//   2. Replace-everywhere rules (against the participant-visible original)
//   3. hard masks (scrub runs after rules so offsets remain valid)
//   4. entity aliasing (structured fields via lookup; free text via
//      longest-first word-boundary replacement of every remaining known surface form)
// The real→alias map never leaves this function's inputs.

import { buildLookup, normalizeName, normalizePhoneKey, type AliasLookup } from "./alias";
import { emailSenderIdentity } from "./email-services";
import { applyMasks, scrubText } from "./scrub";
import type {
  Address,
  EmailPrivacyReview,
  EmailRecord,
  Entity,
  ItemDecision,
  PCTask,
  ReplacementRule,
  SerializedRecord,
  SourceRecord,
} from "./types";

const ANNOTATOR_SENSITIVE_DETECTORS = new Set([
  "private-key", "card-number", "ssn", "iban", "passport-number", "drivers-license",
  "national-id", "medical-record-number", "employee-student-id", "routing-number",
  "bank-account", "password", "otp-code", "api-secret", "credential-token", "dob",
  "precise-coordinates", "coordinate-pair", "license-plate",
]);

export type RedactContext = {
  lookup: AliasLookup;
  entities: Entity[];
  rules: ReplacementRule[];
  textPairs: { regex: RegExp; replace: string; entityId: string | null }[];
};

const emptyDecision: ItemDecision = { included: true, edits: {}, bodyEdit: null, maskOverrides: {} };

export function buildRedactContext(entities: Entity[], rules: ReplacementRule[]): RedactContext {
  const lookup = buildLookup(entities);
  const textPairs: RedactContext["textPairs"] = [];
  for (const e of entities) {
    if (e.keepReal) continue;
    for (const name of e.realNames) {
      const trimmed = name.trim();
      if (trimmed.length < 3) continue; // "Al" would shred unrelated words
      textPairs.push({
        regex: new RegExp(`\\b${escapeRegex(trimmed)}\\b`, "gi"),
        replace: e.alias,
        entityId: e.entityId,
      });
      // First name alone, when distinctive enough, catches "Thanks, Jane".
      const first = trimmed.split(/\s+/)[0];
      if (first.length >= 4 && first.toLowerCase() !== trimmed.toLowerCase()) {
        textPairs.push({
          regex: new RegExp(`\\b${escapeRegex(first)}\\b`, "gi"),
          replace: e.alias.split(" ")[0],
          entityId: e.entityId,
        });
      }
    }
    for (const email of e.realEmails) {
      textPairs.push({ regex: new RegExp(escapeRegex(email), "gi"), replace: e.aliasEmail, entityId: e.entityId });
    }
    for (const phone of e.realPhones) {
      const digits = phone.replace(/\D/g, "");
      if (digits.length < 7) continue;
      const last10 = digits.slice(-10);
      // Match common formattings: (412) 555-0123, 412-555-0123, +14125550123…
      const pattern = `(?:\\+?1[ -.]?)?\\(?${last10.slice(0, 3)}\\)?[ -.]?${last10.slice(3, 6)}[ -.]?${last10.slice(6)}`;
      textPairs.push({
        regex: new RegExp(pattern, "g"),
        replace: e.aliasPhone || "[phone]",
        entityId: e.entityId,
      });
    }
  }
  // Longest-first so "Jane Doe-Smith" wins over "Jane".
  textPairs.sort((a, b) => b.regex.source.length - a.regex.source.length);
  return { lookup, entities, rules, textPairs };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyReplacementRules(value: string, rules: ReplacementRule[]): string {
  let text = value;
  for (const rule of rules) {
    const find = rule.find.trim();
    if (!find) continue;
    text = text.replace(new RegExp(escapeRegex(find), "gi"), () => rule.replace);
  }
  return text;
}

type TextResult = { text: string; masked: string[]; aliased: Set<string> };

function redactText(recordIdStr: string, field: string, raw: string, decision: ItemDecision, ctx: RedactContext): TextResult {
  const effective = decision.edits[field] ?? raw;
  // Participant-authored replacements must see the same text shown in the
  // editor. If aliasing ran first, a rule such as "Private Street" could miss
  // because the entity pass had already changed it to "Ivy Street".
  const replacedText = applyReplacementRules(effective, ctx.rules);
  // Known people use stable aliases instead of generic masks. Unknown email
  // addresses and phone numbers still receive hard-mask protection.
  const matches = scrubText(recordIdStr, field, replacedText).filter((match) => {
    if (match.detector === "email-address") {
      const email = match.excerpt.toLowerCase();
      return !ctx.lookup.byEmail.has(email) && !/@[^@]+\.(?:example|invalid|test)$/.test(email);
    }
    if (match.detector === "phone-number") return !ctx.lookup.byPhoneKey.has(normalizePhoneKey(match.excerpt));
    return true;
  });
  const { text: maskedText, applied } = applyMasks(replacedText, matches, decision.maskOverrides);
  let text = maskedText;
  const aliased = new Set<string>();
  for (const pair of ctx.textPairs) {
    pair.regex.lastIndex = 0;
    if (pair.regex.test(text)) {
      pair.regex.lastIndex = 0;
      text = text.replace(pair.regex, pair.replace);
      if (pair.entityId) aliased.add(pair.entityId);
    }
  }
  return { text, masked: applied, aliased };
}

function redactAddress(
  addr: Address,
  ctx: RedactContext,
  aliased: Set<string>,
  redact: (field: string, raw: string) => string,
  fieldPrefix: string
): Address {
  const replaced = {
    name: applyReplacementRules(addr.name, ctx.rules),
    email: applyReplacementRules(addr.email, ctx.rules),
  };
  const entity = (addr.email && ctx.lookup.byEmail.get(addr.email.toLowerCase())) ||
    (addr.name && ctx.lookup.byName.get(normalizeName(addr.name))) || null;
  const output = entity && !entity.keepReal
    ? (aliased.add(entity.entityId), {
        name: replaced.name === addr.name ? entity.alias : replaced.name,
        email: replaced.email === addr.email ? entity.aliasEmail : replaced.email,
      })
    : entity?.keepReal
      ? replaced
      : {
          name: redact(`${fieldPrefix}_name`, replaced.name),
          email: redact(`${fieldPrefix}_email`, replaced.email),
        };
  return output;
}

export function redactTaskForUpload(task: PCTask, ctx: RedactContext): { task: PCTask; masked: string[]; aliasedEntityIds: string[] } {
  const masked = new Set<string>();
  const aliased = new Set<string>();
  const text = (field: string, raw: string): string => {
    const result = redactText(`task:${task.task_id}`, field, raw, emptyDecision, ctx);
    result.masked.forEach((detector) => masked.add(detector));
    result.aliased.forEach((entityId) => aliased.add(entityId));
    return result.text;
  };
  return {
    task: {
      ...task,
      task_title: text("task_title", task.task_title),
      agent_request: text("agent_request", task.agent_request),
      steps: task.steps.map((step, index) => ({
        ...step,
        title: text(`step_${index}_title`, step.title),
        description: text(`step_${index}_description`, step.description),
      })),
      success_criteria: task.success_criteria.map((criterion, index) => text(`criterion_${index}`, criterion)),
      expected_answer: task.expected_answer === null ? null : text("expected_answer", task.expected_answer),
      notes: task.notes === null ? null : text("notes", task.notes),
    },
    masked: [...masked],
    aliasedEntityIds: [...aliased],
  };
}

export function serializeRecord(
  record: SourceRecord,
  decision: ItemDecision | undefined,
  ctx: RedactContext,
  bodyText: string | null
): SerializedRecord {
  const d = decision ?? emptyDecision;
  const allowedEdits = record.source === "email"
    ? { subject: d.edits.subject }
    : record.source === "calendar"
      ? { summary: d.edits.summary, description: d.edits.description }
      : d.edits;
  const effectiveDecision: ItemDecision = { ...d, edits: allowedEdits };
  const edited = Object.keys(allowedEdits).filter((k) => allowedEdits[k] !== undefined);
  if (d.bodyEdit !== null) edited.push("body");
  const masked = new Set<string>();
  const aliased = new Set<string>();

  const text = (field: string, raw: string): string => {
    const r = redactText(record.id, field, raw, effectiveDecision, ctx);
    r.masked.forEach((m) => masked.add(m));
    r.aliased.forEach((a) => aliased.add(a));
    return r.text;
  };

  const base = {
    id: record.id,
    source: record.source,
    source_detail: text("source_detail", record.sourceDetail),
    timestamp: record.source === "email" || record.source === "calendar" ? record.timestamp : nullableEdit(d.edits.timestamp, record.timestamp),
  };

  let out: Record<string, unknown>;
  switch (record.source) {
    case "email": {
      const body = d.bodyEdit ?? bodyText ?? "";
      out = {
        ...base,
        message_id: record.messageId ? "redacted" : "",
        from: redactAddress(record.from, ctx, aliased, text, "from"),
        to: record.to.map((a, index) => redactAddress(a, ctx, aliased, text, `to_${index}`)),
        cc: record.cc.map((a, index) => redactAddress(a, ctx, aliased, text, `cc_${index}`)),
        subject: text("subject", record.subject),
        body_text: text("body", body),
        body_truncated: record.bodyTruncated,
        labels: record.labels.map((label) => text("label", label)),
        attachments: record.attachments.map((a) => ({
          filename: text("attachment", a.filename),
          mime: text("attachment_mime", a.mime),
          size: a.size,
        })),
      };
      break;
    }
    case "calendar":
      out = {
        ...base,
        summary: text("summary", record.summary),
        description: text("description", record.description),
        location: text("location", record.location),
        dtstart: text("dtstart", record.dtstart),
        dtend: record.dtend === null ? null : text("dtend", record.dtend),
        all_day: record.allDay,
        tzid: record.tzid === null ? null : text("tzid", record.tzid),
        organizer: record.organizer ? redactAddress(record.organizer, ctx, aliased, text, "organizer") : null,
        attendees: record.attendees.map((a, index) => redactAddress(a, ctx, aliased, text, `attendee_${index}`)),
        rrule: record.rrule === null ? null : text("rrule", record.rrule),
        status: record.status === null ? null : text("status", record.status),
      };
      break;
    case "contacts": {
      const entity =
        record.emails.map((e) => ctx.lookup.byEmail.get(e)).find(Boolean) ||
        record.phones.map((p) => ctx.lookup.byPhoneKey.get(normalizePhoneKey(p))).find(Boolean) ||
        (record.fullName ? ctx.lookup.byName.get(normalizeName(record.fullName)) : undefined);
      const hasIdentityEdits = ["full_name", "emails", "phones"].some((field) => d.edits[field] !== undefined);
      if (entity && !entity.keepReal && !hasIdentityEdits) {
        aliased.add(entity.entityId);
        out = {
          ...base,
          full_name: entity.alias,
          emails: [entity.aliasEmail],
          phones: entity.aliasPhone ? [entity.aliasPhone] : [],
          org: nullableText("org", d.edits.org, record.org, text),
          birthday: null, // DOB never ships from a contact card
          addresses: stringListEdit(d.edits.addresses, record.addresses).map((a) => text("address", a)),
          notes: nullableText("notes", d.edits.notes, record.notes, text),
        };
      } else {
        out = {
          ...base,
          full_name: text("full_name", editString(d.edits.full_name, record.fullName)),
          emails: stringListEdit(d.edits.emails, record.emails).map((email, index) => redactAddress({ name: "", email }, ctx, aliased, text, `contact_email_${index}`).email),
          phones: stringListEdit(d.edits.phones, record.phones).map((phone, index) => redactPhone(phone, ctx, aliased, text, `contact_phone_${index}`)),
          org: nullableText("org", d.edits.org, record.org, text),
          birthday: null,
          addresses: stringListEdit(d.edits.addresses, record.addresses).map((a) => text("address", a)),
          notes: nullableText("notes", d.edits.notes, record.notes, text),
        };
      }
      break;
    }
    case "messages": {
      const sender = editString(d.edits.sender, record.sender);
      const senderEntity =
        ctx.lookup.byPhoneKey.get(normalizePhoneKey(sender)) ||
        ctx.lookup.byName.get(normalizeName(sender));
      if (senderEntity && !senderEntity.keepReal) aliased.add(senderEntity.entityId);
      out = {
        ...base,
        chat_id: protectedIdentifier("chat_id", d.edits.chat_id, record.chatId, "[chat-id]", text),
        chat_name: text("chat_name", record.chatName),
        sender: senderEntity && !senderEntity.keepReal ? senderEntity.alias : text("sender", sender),
        text: text("text", record.text),
        is_system: booleanEdit(d.edits.is_system, record.isSystem),
        is_media: booleanEdit(d.edits.is_media, record.isMedia),
      };
      break;
    }
    case "orders":
      out = {
        ...base,
        merchant: text("merchant", record.merchant),
        order_id: protectedNullableIdentifier("order_id", d.edits.order_id, record.orderId, "[order-id]", text),
        total: numberEdit(d.edits.total, record.total),
        currency: text("currency", editString(d.edits.currency, record.currency)),
        items: jsonEdit(d.edits.items, record.items).map((it) => ({ title: text("item", it.title), quantity: it.quantity, price: it.price })),
        shipping_address: nullableText("shipping_address", d.edits.shipping_address, record.shippingAddress, text),
        related_record_ids: stringListEdit(d.edits.related_record_ids, record.relatedRecordIds),
      };
      break;
    case "transactions":
      out = {
        ...base,
        description: text("description", record.description),
        amount: numberEdit(d.edits.amount, record.amount) ?? record.amount,
        currency: text("currency", editString(d.edits.currency, record.currency)),
        account: protectedNullableIdentifier("account", d.edits.account, record.account, "[account]", text),
        category: nullableText("category", d.edits.category, record.category, text),
        related_record_ids: stringListEdit(d.edits.related_record_ids, record.relatedRecordIds),
      };
      break;
  }

  return {
    record: out,
    edited: [...new Set(edited)],
    masked: [...masked],
    aliased_entity_ids: [...aliased],
    ...(record.source === "email" ? { privacy_review: emailPrivacyReview(record, ctx, masked) } : {}),
  };
}

function emailPrivacyReview(record: EmailRecord, ctx: RedactContext, masked: Set<string>): EmailPrivacyReview {
  const inferred = emailSenderIdentity(record);
  const senderEntity = ctx.lookup.byEmail.get(record.from.email.trim().toLowerCase()) ||
    ctx.lookup.byName.get(normalizeName(record.from.name));
  const senderClass = inferred.kind !== "personal"
    ? inferred.kind
    : senderEntity?.category === "org" || senderEntity?.category === "merchant"
      ? "organization"
      : "personal";
  const sensitiveDetectors = [...masked].filter((detector) => ANNOTATOR_SENSITIVE_DETECTORS.has(detector)).sort();
  const reasons: EmailPrivacyReview["reasons"] = [];
  if (senderClass === "personal") reasons.push("personal-correspondence");
  if (senderClass === "personal" && senderEntity?.keepReal) reasons.push("personal-sender-kept-real");
  if (sensitiveDetectors.length) reasons.push("sensitive-content-masked");
  return {
    needs_annotator_review: reasons.length > 0,
    sender_class: senderClass,
    service_label: senderClass === "personal" ? null : inferred.label,
    reasons,
    sensitive_detectors: sensitiveDetectors,
  };
}

function numberEdit(edit: string | undefined, original: number | null): number | null {
  if (edit === undefined) return original;
  const n = parseFloat(edit);
  return Number.isFinite(n) ? n : original;
}

function editString(edit: string | undefined, original: string): string {
  return edit === undefined ? original : edit;
}

function nullableEdit(edit: string | undefined, original: string | null): string | null {
  if (edit === undefined) return original;
  return edit.trim() ? edit : null;
}

function nullableText(
  field: string,
  edit: string | undefined,
  original: string | null,
  redact: (field: string, raw: string) => string
): string | null {
  const value = nullableEdit(edit, original);
  return value === null ? null : redact(field, value);
}

function booleanEdit(edit: string | undefined, original: boolean): boolean {
  if (edit === undefined) return original;
  return edit === "true";
}

function stringListEdit(edit: string | undefined, original: string[]): string[] {
  if (edit === undefined) return original;
  return edit.split("\n").map((value) => value.trim()).filter(Boolean);
}

function redactPhone(
  phone: string,
  ctx: RedactContext,
  aliased: Set<string>,
  redact: (field: string, raw: string) => string,
  field: string
): string {
  const replaced = applyReplacementRules(phone, ctx.rules);
  const entity = ctx.lookup.byPhoneKey.get(normalizePhoneKey(replaced));
  const output = entity && !entity.keepReal
    ? (aliased.add(entity.entityId), entity.aliasPhone || "[phone]")
    : entity?.keepReal
      ? replaced
      : redact(field, replaced);
  return output;
}

function protectedIdentifier(
  field: string,
  edit: string | undefined,
  original: string,
  replacement: string,
  redact: (field: string, raw: string) => string
): string {
  if (edit !== undefined) return redact(field, edit);
  return original ? replacement : "";
}

function protectedNullableIdentifier(
  field: string,
  edit: string | undefined,
  original: string | null,
  replacement: string,
  redact: (field: string, raw: string) => string
): string | null {
  if (edit !== undefined) return edit.trim() ? redact(field, edit) : null;
  return original ? replacement : null;
}

function jsonEdit<T>(edit: string | undefined, original: T[]): T[] {
  if (edit === undefined) return original;
  try {
    const parsed = JSON.parse(edit);
    return Array.isArray(parsed) ? (parsed as T[]) : original;
  } catch {
    return original;
  }
}
