import type { Address, EmailRecord } from "./types";

export type EmailDirection = "received" | "sent";
export type EmailActivityStat = { key: string; label: string; count: number };
export type EmailActivitySummary = {
  received: { messages: number; people: EmailActivityStat[]; domains: EmailActivityStat[] };
  sent: { messages: number; people: EmailActivityStat[]; domains: EmailActivityStat[] };
};

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

function addressDomain(address: string): string {
  const normalized = normalizedEmail(address);
  const at = normalized.lastIndexOf("@");
  return at > 0 && at < normalized.length - 1 ? normalized.slice(at + 1).replace(/\.$/, "") : "";
}

export function emailDirection(record: EmailRecord, selfEmail: string): EmailDirection {
  const fromSelf = !!normalizedEmail(selfEmail) && normalizedEmail(record.from.email) === normalizedEmail(selfEmail);
  const sentLabel = record.labels.some((label) => /(^|[\\/])sent$/i.test(label.trim()));
  return fromSelf || sentLabel ? "sent" : "received";
}

export function activityParties(record: EmailRecord, direction: EmailDirection): Address[] {
  if (direction === "received") return record.from.email ? [record.from] : [];
  const seen = new Set<string>();
  return [...record.to, ...record.cc].filter((address) => {
    const email = normalizedEmail(address.email);
    if (!email || seen.has(email)) return false;
    seen.add(email);
    return true;
  });
}

function ranked(counts: Map<string, { label: string; count: number }>, limit = 5): EmailActivityStat[] {
  return [...counts]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export function emailActivitySummary(records: EmailRecord[], selfEmail: string): EmailActivitySummary {
  const buckets = {
    received: { messages: 0, people: new Map<string, { label: string; count: number }>(), domains: new Map<string, { label: string; count: number }>() },
    sent: { messages: 0, people: new Map<string, { label: string; count: number }>(), domains: new Map<string, { label: string; count: number }>() },
  };
  for (const record of records) {
    const direction = emailDirection(record, selfEmail);
    const bucket = buckets[direction];
    bucket.messages += 1;
    const messageDomains = new Set<string>();
    for (const party of activityParties(record, direction)) {
      const email = normalizedEmail(party.email);
      if (!email) continue;
      const current = bucket.people.get(email);
      bucket.people.set(email, { label: party.name.trim() || email, count: (current?.count ?? 0) + 1 });
      const domain = addressDomain(email);
      if (domain) messageDomains.add(domain);
    }
    for (const domain of messageDomains) {
      const current = bucket.domains.get(domain);
      bucket.domains.set(domain, { label: domain, count: (current?.count ?? 0) + 1 });
    }
  }
  return {
    received: { messages: buckets.received.messages, people: ranked(buckets.received.people), domains: ranked(buckets.received.domains) },
    sent: { messages: buckets.sent.messages, people: ranked(buckets.sent.people), domains: ranked(buckets.sent.domains) },
  };
}

export function emailMatchesActivity(record: EmailRecord, selfEmail: string, direction: EmailDirection | "all", correspondent: string): boolean {
  const actualDirection = emailDirection(record, selfEmail);
  if (direction !== "all" && direction !== actualDirection) return false;
  if (!correspondent) return true;
  const matchesParty = (predicate: (address: Address) => boolean) => {
    if (actualDirection === "received") return !!record.from.email && predicate(record.from);
    for (const address of record.to) if (predicate(address)) return true;
    for (const address of record.cc) if (predicate(address)) return true;
    return false;
  };
  if (correspondent.startsWith("domain:")) {
    const domain = correspondent.slice("domain:".length);
    return matchesParty((party) => addressDomain(party.email) === domain);
  }
  if (correspondent.startsWith("email:")) {
    const email = correspondent.slice("email:".length);
    return matchesParty((party) => normalizedEmail(party.email) === email);
  }
  return false;
}
