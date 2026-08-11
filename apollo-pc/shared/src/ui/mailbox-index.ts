import { emailActivitySummary, type EmailActivitySummary } from "../email-activity";
import { detectedEmailService, MYPCBENCH_EMAIL_SERVICES, type EmailServiceOption } from "../email-services";
import { calendarCategory, emailCategory } from "../organize";
import type { CalendarRecord, EmailRecord, SourceKind, SourceRecord } from "../types";

export type DomainCount = { label: string; count: number };

/**
 * Expensive, immutable summaries for the current in-memory record set.
 *
 * Upload-screen renders are intentionally frequent while somebody searches or
 * changes filters. Building this once means those renders only do one ordered
 * match pass instead of repeatedly reclassifying and resorting 100k records.
 */
export type MailboxIndex = {
  size: number;
  selfEmail: string;
  orderedRecords: SourceRecord[];
  emailData: SourceRecord[];
  emails: EmailRecord[];
  calendars: CalendarRecord[];
  recurringCalendars: CalendarRecord[];
  bySource: Map<SourceKind, SourceRecord[]>;
  counts: Map<SourceKind, number>;
  categoryById: Map<string, string>;
  emailCategoryCounts: Map<string, number>;
  calendarCategoryCounts: Map<string, number>;
  serviceById: Map<string, string>;
  serviceLabelById: Map<string, string>;
  serviceOptions: EmailServiceOption[];
  domainById: Map<string, string>;
  domainCounts: DomainCount[];
  activity: EmailActivitySummary;
};

type CachedIndex = { size: number; selfEmail: string; index: MailboxIndex };
const cache = new WeakMap<Map<string, SourceRecord>, CachedIndex>();

export function mailboxIndexFor(records: Map<string, SourceRecord>, selfEmail = ""): MailboxIndex {
  const normalizedSelf = selfEmail.trim().toLowerCase();
  const cached = cache.get(records);
  if (cached && cached.size === records.size && cached.selfEmail === normalizedSelf) return cached.index;

  const all = [...records.values()];
  const emails: EmailRecord[] = [];
  const calendars: CalendarRecord[] = [];
  const counts = new Map<SourceKind, number>();
  const categoryById = new Map<string, string>();
  const emailCategoryCounts = new Map<string, number>();
  const calendarCategoryCounts = new Map<string, number>();
  const serviceById = new Map<string, string>();
  const serviceLabelById = new Map<string, string>();
  const knownServiceCounts = new Map<string, number>();
  const detectedServices = new Map<string, EmailServiceOption>();
  const domainById = new Map<string, string>();
  const rawDomainCounts = new Map<string, number>();

  for (const record of all) {
    counts.set(record.source, (counts.get(record.source) ?? 0) + 1);
    if (record.source === "email") {
      emails.push(record);
      const category = emailCategory(record);
      categoryById.set(record.id, category);
      emailCategoryCounts.set(category, (emailCategoryCounts.get(category) ?? 0) + 1);

      const service = detectedEmailService(record);
      if (service) {
        serviceById.set(record.id, service.id);
        serviceLabelById.set(record.id, service.label.toLowerCase());
        if (service.detected) {
          const current = detectedServices.get(service.id);
          detectedServices.set(service.id, { ...service, count: (current?.count ?? 0) + 1 });
        } else {
          knownServiceCounts.set(service.id, (knownServiceCounts.get(service.id) ?? 0) + 1);
        }
      }

      const domain = senderDomain(record.from.email);
      if (domain) {
        domainById.set(record.id, domain);
        rawDomainCounts.set(domain, (rawDomainCounts.get(domain) ?? 0) + 1);
      }
    } else if (record.source === "calendar") {
      calendars.push(record);
      const category = calendarCategory(record);
      categoryById.set(record.id, category);
      calendarCategoryCounts.set(category, (calendarCategoryCounts.get(category) ?? 0) + 1);
    } else if (record.source === "orders") {
      categoryById.set(record.id, "purchases");
      emailCategoryCounts.set("purchases", (emailCategoryCounts.get("purchases") ?? 0) + 1);
    }
  }

  const orderedRecords = all.sort(compareNewestFirst);
  const bySource = new Map<SourceKind, SourceRecord[]>();
  const emailData: SourceRecord[] = [];
  for (const record of orderedRecords) {
    const sourceRecords = bySource.get(record.source) ?? [];
    sourceRecords.push(record);
    bySource.set(record.source, sourceRecords);
    if (record.source === "email" || record.source === "orders") emailData.push(record);
  }

  const serviceOptions: EmailServiceOption[] = [
    ...MYPCBENCH_EMAIL_SERVICES.map((service) => ({
      id: service.id,
      label: service.realName,
      count: knownServiceCounts.get(service.id) ?? 0,
      detected: false,
    })),
    ...[...detectedServices.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  ];
  const domainCounts = [...rawDomainCounts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const index: MailboxIndex = {
    size: records.size,
    selfEmail: normalizedSelf,
    orderedRecords,
    emailData,
    emails,
    calendars,
    recurringCalendars: calendars.filter((record) => !!(record.rrule || record.recurrenceId)),
    bySource,
    counts,
    categoryById,
    emailCategoryCounts,
    calendarCategoryCounts,
    serviceById,
    serviceLabelById,
    serviceOptions,
    domainById,
    domainCounts,
    activity: emailActivitySummary(emails, normalizedSelf),
  };
  cache.set(records, { size: records.size, selfEmail: normalizedSelf, index });
  return index;
}

function compareNewestFirst(a: SourceRecord, b: SourceRecord): number {
  return (b.timestamp || "").localeCompare(a.timestamp || "");
}

function senderDomain(address: string): string {
  const normalized = address.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  return at > 0 && at < normalized.length - 1 ? normalized.slice(at + 1).replace(/\.$/, "") : "";
}
