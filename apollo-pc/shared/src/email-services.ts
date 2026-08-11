import type { EmailRecord } from "./types";
import { merchantForSender } from "./sources/receipts";

export type EmailService = {
  id: string;
  realName: string;
  cloneName: string;
  aliases: readonly string[];
  domains: readonly string[];
  cloneSlugs: readonly string[];
};

export type EmailServiceOption = { id: string; label: string; count: number; detected: boolean };

export type EmailSenderIdentity = {
  kind: "personal" | "organization" | "service";
  label: string | null;
  reason: "personal-correspondent" | "known-service" | "known-merchant" | "newsletter" | "organizational-sender";
};

// Canonical MyPCBench app set. Legacy aliases cover names present in earlier
// local benchmark assets, so mail seeded by either generation remains findable.
export const MYPCBENCH_EMAIL_SERVICES: readonly EmailService[] = [
  service("google-calendar", "Google Calendar", "HooliCalendar", ["google calendar", "hooli calendar", "hoolicalendar"], ["calendar.google.com"], ["hoolicalendar"]),
  service("gmail", "Gmail", "HooliMail", ["gmail", "google mail", "hooli mail", "hoolimail"], ["gmail.com", "googlemail.com"], ["hoolimail"]),
  service("whatsapp", "WhatsApp", "HooliChat", ["whatsapp", "hooli chat", "hoolichat", "buzzchat", "buzz chat"], ["whatsapp.com"], ["hoolichat", "buzzchat"]),
  service("slack", "Slack", "HooliWork", ["slack", "hooli work", "hooliwork", "workbuzz", "work buzz"], ["slack.com"], ["hooliwork", "workbuzz"]),
  service("sprintboard", "Jira / Asana", "SprintBoard", ["jira", "atlassian", "asana", "sprintboard", "sprint board"], ["atlassian.com", "jira.com", "asana.com"], ["sprintboard"]),
  service("linkedin", "LinkedIn", "LockedIn", ["linkedin", "linked in", "lockedin", "locked in"], ["linkedin.com"], ["lockedin"]),
  service("chase", "Chase Bank", "Gringotts", ["chase bank", "jpmorgan chase", "gringotts", "vaultbank", "vault bank"], ["chase.com", "jpmorgan.com", "jpmorganchase.com"], ["gringotts", "vaultbank"]),
  service("robinhood", "Robinhood", "BatBucks", ["robinhood", "batbucks", "bat bucks"], ["robinhood.com"], ["batbucks"]),
  service("turbotax", "TurboTax", "SpeedTax", ["turbotax", "turbo tax", "speedtax", "speed tax"], ["turbotax.com"], ["speedtax"]),
  service("delta", "Delta", "Dinoco", ["delta air lines", "delta airlines", "dinoco airlines", "dinoco"], ["delta.com", "deltaairlines.com"], ["dinoco"]),
  service("airbnb", "Airbnb", "Cheskepdia", ["airbnb", "cheskepdia"], ["airbnb.com"], ["cheskepdia"]),
  service("uber", "Uber", "eTaxi", ["uber", "e-taxi", "etaxi", "e taxi"], ["uber.com"], ["etaxi"]),
  service("doordash", "DoorDash", "HangryDash", ["doordash", "door dash", "hangrydash", "hangry dash"], ["doordash.com", "trycaviar.com"], ["hangrydash"]),
  service("opentable", "OpenTable", "TableFind", ["opentable", "open table", "tablefind", "table find"], ["opentable.com"], ["tablefind"]),
  service("amazon", "Amazon", "HooliShop", ["amazon", "hoolishop", "hooli shop"], ["amazon.com", "amazon.jobs"], ["hoolishop"]),
  service("instacart", "Instacart", "Kwik-E-Mart", ["instacart", "kwik-e-mart", "kwik e mart", "kwikemart"], ["instacart.com"], ["kwik-e-mart", "kwikemart"]),
  service("polymarket", "Polymarket", "OddsMarket", ["polymarket", "poly market", "oddsmarket", "odds market"], ["polymarket.com"], ["oddsmarket"]),
];

function service(id: string, realName: string, cloneName: string, aliases: string[], domains: string[], cloneSlugs: string[]): EmailService {
  return { id, realName, cloneName, aliases, domains, cloneSlugs };
}

function senderDomain(record: EmailRecord): string {
  const address = record.from.email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  return at > 0 && at < address.length - 1 ? address.slice(at + 1).replace(/\.$/, "") : "";
}

const COMPOUND_PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "co.kr", "com.br", "com.mx", "com.sg", "com.tr", "com.cn", "com.tw", "co.in", "co.za",
]);

const KNOWN_ORGANIZATION_DOMAINS = new Set([
  "nytimes.com", "washingtonpost.com", "wsj.com", "theatlantic.com", "economist.com",
  "bloomberg.com", "reuters.com", "cnn.com", "bbc.com", "npr.org", "medium.com",
  "substack.com", "spotify.com", "netflix.com", "apple.com", "microsoft.com",
]);

const ORGANIZATION_LOCAL_PART = /^(?:no-?reply|donotreply|newsletter|news|digest|alerts?|notifications?|updates?|support|help|billing|receipts?|orders?|shipping|info|hello|team|service|marketing|events?)\b/i;
const ORGANIZATION_NAME = /\b(?:news|times|daily|weekly|newsletter|digest|team|support|billing|receipts?|orders?|notifications?|alerts?|store|bank|airlines?|university|college|calendar|canvas|piazza|spotify|netflix)\b/i;

export function registrableSenderDomain(record: EmailRecord): string {
  const domain = senderDomain(record);
  const parts = domain.split(".").filter(Boolean);
  if (parts.length < 2) return domain;
  const suffix = parts.slice(-2).join(".");
  return COMPOUND_PUBLIC_SUFFIXES.has(suffix) && parts.length >= 3 ? parts.slice(-3).join(".") : suffix;
}

function labelFromDomain(domain: string): string {
  const token = domain.split(".")[0] ?? domain;
  return token
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.length <= 3 && /^[a-z]+$/.test(part) ? part.toUpperCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function domainMatches(domain: string, expected: string): boolean {
  return domain === expected || domain.endsWith(`.${expected}`);
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function containsAlias(senderName: string, alias: string): boolean {
  const haystack = ` ${normalized(senderName)} `;
  const needle = normalized(alias);
  return !!needle && haystack.includes(` ${needle} `);
}

export function emailMatchesService(record: EmailRecord, serviceId: string): boolean {
  const definition = MYPCBENCH_EMAIL_SERVICES.find((entry) => entry.id === serviceId);
  if (!definition) return serviceId.startsWith("detected:") && registrableSenderDomain(record) === serviceId.slice("detected:".length);
  const domain = senderDomain(record);
  if (definition.domains.some((candidate) => domainMatches(domain, candidate))) return true;
  if (definition.cloneSlugs.some((slug) => domainMatches(domain, `${slug}.mypcbench.app`) || domainMatches(domain, `${slug}.mypcbench.com`))) return true;
  return definition.aliases.some((alias) => containsAlias(record.from.name, alias));
}

export function emailService(record: EmailRecord): EmailService | null {
  return MYPCBENCH_EMAIL_SERVICES.find((serviceDefinition) => emailMatchesService(record, serviceDefinition.id)) ?? null;
}

export function emailServiceCounts(records: EmailRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const match = emailService(record);
    if (match) counts.set(match.id, (counts.get(match.id) ?? 0) + 1);
  }
  return counts;
}

export function detectedEmailService(record: EmailRecord): { id: string; label: string; detected: boolean } | null {
  const known = emailService(record);
  if (known) return { id: known.id, label: known.realName, detected: false };
  const domain = registrableSenderDomain(record);
  if (!domain) return null;
  return { id: `detected:${domain}`, label: labelFromDomain(domain), detected: true };
}

export function emailServiceOptions(records: EmailRecord[]): EmailServiceOption[] {
  const knownCounts = emailServiceCounts(records);
  const detected = new Map<string, EmailServiceOption>();
  for (const record of records) {
    const match = detectedEmailService(record);
    if (!match?.detected) continue;
    const current = detected.get(match.id);
    detected.set(match.id, { ...match, count: (current?.count ?? 0) + 1 });
  }
  return [
    ...MYPCBENCH_EMAIL_SERVICES.map((serviceDefinition) => ({ id: serviceDefinition.id, label: serviceDefinition.realName, count: knownCounts.get(serviceDefinition.id) ?? 0, detected: false })),
    ...[...detected.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  ];
}

export function emailServiceLabel(record: EmailRecord): string {
  return detectedEmailService(record)?.label ?? "";
}

// Privacy classification deliberately asks a narrower question than service
// discovery: is the sender a human correspondent whose identity should be
// pseudonymized? Public newsletters, publishers, merchants, and automated
// service accounts remain recognizable and do not become false-positive PII.
export function emailSenderIdentity(record: EmailRecord): EmailSenderIdentity {
  const known = emailService(record);
  // gmail.com is a consumer mailbox domain, not proof that the sender is the
  // Gmail product. Require an explicit product-name/automation signal so an
  // ordinary human at Gmail remains protected as a person.
  const namedKnownService = known && (
    known.id !== "gmail" ||
    known.aliases.some((alias) => containsAlias(record.from.name, alias)) ||
    ORGANIZATION_LOCAL_PART.test(record.from.email.split("@")[0] || "")
  );
  if (namedKnownService) return { kind: "service", label: known.realName, reason: "known-service" };
  const merchant = merchantForSender(record.from.email);
  if (merchant) return { kind: "service", label: merchant.merchant, reason: "known-merchant" };

  const address = record.from.email.trim().toLowerCase();
  const localPart = address.slice(0, Math.max(0, address.lastIndexOf("@")));
  const domain = registrableSenderDomain(record);
  const senderName = record.from.name.trim();
  if (record.hasListUnsubscribe) {
    return { kind: "organization", label: senderName || labelFromDomain(domain), reason: "newsletter" };
  }
  if (KNOWN_ORGANIZATION_DOMAINS.has(domain) || ORGANIZATION_LOCAL_PART.test(localPart) || ORGANIZATION_NAME.test(senderName)) {
    return { kind: "organization", label: senderName || labelFromDomain(domain), reason: "organizational-sender" };
  }
  return { kind: "personal", label: null, reason: "personal-correspondent" };
}
