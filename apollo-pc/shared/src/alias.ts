// Entity detection + aliasing — the core redaction mechanism. Recurring
// people/orgs get ONE consistent pseudonym (name, email, phone) applied
// across every source at serialization time, so cross-source correlation
// survives while identity does not. Detection:
//   1. email addresses, exact lowercase match, one node each
//   2. "Jane Doe <jane@x>" co-occurrence hard-links name↔address
//   3. contacts join names + emails + phones into single entities
//   4. same normalized name ALONE never auto-merges ("David" is not one person)
// Aliases come from a session-random pool — never derived by hashing the real
// name (a name-seeded hash is dictionary-reversible).

import { merchantForSender } from "./sources/receipts";
import { emailSenderIdentity } from "./email-services";
import type { Address, Entity, ParticipantIdentity, SourceKind, SourceRecord } from "./types";

const FIRST_NAMES = [
  "Maya", "Leo", "Kai", "Ava", "Noah", "Zoe", "Eli", "Ivy", "Owen", "Ruby",
  "Jonas", "Nina", "Theo", "Cleo", "Rex", "Wren", "Otis", "Vera", "Hugo", "Isla",
  "Felix", "Nora", "Silas", "June", "Ezra", "Faye", "Amos", "Lena", "Cyrus", "Dara",
];
const LAST_NAMES = [
  "Chen", "Patel", "Santos", "Rivera", "Kim", "Novak", "Haddad", "Okafor", "Larsen", "Mori",
  "Vargas", "Ito", "Beck", "Duarte", "Kaur", "Lindgren", "Osei", "Petrov", "Quinn", "Reyes",
];
const ALIAS_DOMAIN = "personamail.test";

export type AliasPool = { next(): { name: string; email: string; phone: string } };

export function createAliasPool(): AliasPool {
  const used = new Set<string>();
  let phoneCounter = 100;
  return {
    next() {
      for (let attempt = 0; attempt < 200; attempt++) {
        const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
        const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
        const name = `${first} ${last}`;
        if (used.has(name)) continue;
        used.add(name);
        phoneCounter += 1 + Math.floor(Math.random() * 7);
        return {
          name,
          email: `${first.toLowerCase()}.${last.toLowerCase()}@${ALIAS_DOMAIN}`,
          // Reserved fictional range (555-01XX pattern, extended).
          phone: `+1 555 ${String(phoneCounter % 10000).padStart(4, "0")}`,
        };
      }
      const n = used.size + 1;
      used.add(`Person ${n}`);
      return { name: `Person ${n}`, email: `person${n}@${ALIAS_DOMAIN}`, phone: `+1 555 ${String(1000 + n)}` };
    },
  };
}

export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePhoneKey(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.slice(-10); // match on last 10 digits across formats
}

// ---------------------------------------------------------------------------
// Detection: builds/updates the entity list from all in-memory records.
// Existing entities keep their entityId and alias — re-running detection
// after a new import merges new surface forms into the stable entities.

export function detectEntities(
  records: SourceRecord[],
  existing: Entity[],
  pool: AliasPool,
  identity?: ParticipantIdentity
): Entity[] {
  // Union-find over keys: "e:{email}" | "p:{phone10}" | entity anchors.
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(k, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const touch = (k: string) => {
    if (!parent.has(k)) parent.set(k, k);
  };

  type Surface = { names: Map<string, string>; emails: Set<string>; phones: Set<string>; occurrences: Map<SourceKind, number> };
  const surfaces = new Map<string, Surface>(); // by raw key, merged later by root
  const organizationKeys = new Set<string>();
  const surfaceFor = (key: string): Surface => {
    let s = surfaces.get(key);
    if (!s) {
      s = { names: new Map(), emails: new Set(), phones: new Set(), occurrences: new Map() };
      surfaces.set(key, s);
    }
    return s;
  };

  const noteAddress = (addr: Address, kind: SourceKind) => {
    const email = addr.email.trim().toLowerCase();
    const name = addr.name.trim();
    if (!email && !name) return;
    const key = email ? `e:${email}` : `n:${normalizeName(name)}`;
    touch(key);
    const s = surfaceFor(key);
    if (email) s.emails.add(email);
    if (name) s.names.set(normalizeName(name), name);
    s.occurrences.set(kind, (s.occurrences.get(kind) || 0) + 1);
  };

  for (const r of records) {
    if (r.source === "email") {
      noteAddress(r.from, "email");
      if (emailSenderIdentity(r).kind !== "personal") {
        const senderEmail = r.from.email.trim().toLowerCase();
        const senderName = r.from.name.trim();
        organizationKeys.add(senderEmail ? `e:${senderEmail}` : `n:${normalizeName(senderName)}`);
      }
      for (const a of r.to) noteAddress(a, "email");
      for (const a of r.cc) noteAddress(a, "email");
    } else if (r.source === "calendar") {
      if (r.organizer) noteAddress(r.organizer, "calendar");
      for (const a of r.attendees) noteAddress(a, "calendar");
    } else if (r.source === "contacts") {
      // Contacts are the join table: link every email + phone on one card.
      const keys: string[] = [];
      for (const e of r.emails) {
        const k = `e:${e}`;
        touch(k);
        keys.push(k);
        surfaceFor(k).emails.add(e);
      }
      for (const p of r.phones) {
        const pk = normalizePhoneKey(p);
        if (!pk) continue;
        const k = `p:${pk}`;
        touch(k);
        keys.push(k);
        surfaceFor(k).phones.add(p);
      }
      if (!keys.length && r.fullName) {
        const k = `n:${normalizeName(r.fullName)}`;
        touch(k);
        keys.push(k);
      }
      for (const k of keys.slice(1)) union(keys[0], k);
      if (keys.length && r.fullName) {
        const s = surfaceFor(keys[0]);
        s.names.set(normalizeName(r.fullName), r.fullName);
        s.occurrences.set("contacts", (s.occurrences.get("contacts") || 0) + 1);
      }
    } else if (r.source === "messages") {
      if (r.isSystem || !r.sender) continue;
      const asPhone = normalizePhoneKey(r.sender);
      const key = asPhone.length === 10 ? `p:${asPhone}` : `n:${normalizeName(r.sender)}`;
      touch(key);
      const s = surfaceFor(key);
      if (asPhone.length === 10) s.phones.add(r.sender);
      else s.names.set(normalizeName(r.sender), r.sender);
      s.occurrences.set("messages", (s.occurrences.get("messages") || 0) + 1);
    }
  }

  // Anchor existing entities so their ids/aliases survive re-detection.
  for (const e of existing) {
    const anchor = `entity:${e.entityId}`;
    touch(anchor);
    for (const em of e.realEmails) {
      const k = `e:${em}`;
      touch(k);
      union(anchor, k);
    }
    for (const p of e.realPhones) {
      const pk = normalizePhoneKey(p);
      if (pk) {
        const k = `p:${pk}`;
        touch(k);
        union(anchor, k);
      }
    }
  }

  // Group surfaces by root.
  const groups = new Map<string, { keys: string[]; anchor: Entity | null }>();
  for (const key of parent.keys()) {
    const root = find(key);
    let g = groups.get(root);
    if (!g) {
      g = { keys: [], anchor: null };
      groups.set(root, g);
    }
    if (key.startsWith("entity:")) {
      const id = key.slice("entity:".length);
      g.anchor = existing.find((e) => e.entityId === id) ?? null;
    } else {
      g.keys.push(key);
    }
  }

  const out: Entity[] = [];
  for (const g of groups.values()) {
    const names = new Map<string, string>();
    const emails = new Set<string>();
    const phones = new Set<string>();
    const occurrences = new Map<SourceKind, number>();
    for (const key of g.keys) {
      const s = surfaces.get(key);
      if (!s) continue;
      for (const [nk, nv] of s.names) names.set(nk, nv);
      for (const e of s.emails) emails.add(e);
      for (const p of s.phones) phones.add(p);
      for (const [k, v] of s.occurrences) occurrences.set(k, (occurrences.get(k) || 0) + v);
    }
    const hasCurrentSurface = names.size > 0 || emails.size > 0 || phones.size > 0;
    const identityEmail = identity?.email.trim().toLowerCase() ?? "";
    const identityName = normalizeName(identity?.name ?? "");
    const isAuthoritativeIdentity = !!g.anchor && (
      (!!identityEmail && g.anchor.realEmails.some((email) => email.toLowerCase() === identityEmail)) ||
      (!!identityName && g.anchor.realNames.some((name) => normalizeName(name) === identityName))
    );
    // Existing entities are anchors for stable aliases, not permanent rows.
    // Drop an anchor when none of its addresses or phones occur in the current
    // import. The consented identity is the sole exception because it is also
    // used to scrub the participant's name from unstructured text.
    if (!hasCurrentSurface && !isAuthoritativeIdentity) continue;

    const isMerchant = [...emails].some((e) => merchantForSender(e)) || [...emails].every((e) => /noreply|no-reply|donotreply|notifications?@|updates?@|info@|support@|hello@|news@|mailer/i.test(e)) && emails.size > 0 && !names.size;
    const isOrganization = g.keys.some((key) => organizationKeys.has(key));
    if (g.anchor) {
      const e = g.anchor;
      e.realNames = mergeUnique(e.realNames, [...names.values()]);
      e.realEmails = mergeUnique(e.realEmails, [...emails]);
      e.realPhones = mergeUnique(e.realPhones, [...phones]);
      e.occurrences = Object.fromEntries(occurrences) as Entity["occurrences"];
      // Migrate locally persisted newsletter/service entities that older
      // builds treated as people. A real person or the participant is never
      // downgraded based on domain alone; this requires sender-level evidence.
      if ((e.category === "person" || e.category === "self") && (isMerchant || isOrganization)) {
        e.category = isMerchant ? "merchant" : "org";
        e.keepReal = true;
      }
      out.push(e);
      continue;
    }
    const fresh = pool.next();
    const category = isMerchant ? "merchant" : isOrganization ? "org" : "person";
    out.push({
      entityId: crypto.randomUUID(),
      category,
      realNames: [...names.values()],
      realEmails: [...emails],
      realPhones: [...phones],
      alias: fresh.name,
      aliasEmail: fresh.email,
      aliasPhone: fresh.phone,
      keepReal: category === "merchant" || category === "org",
      occurrences: Object.fromEntries(occurrences) as Entity["occurrences"],
      mergedFrom: [],
    });
  }

  // The consented identity is authoritative. Calendar-only exports often put
  // the participant's display name only in free-text descriptions, so it must
  // be attached to the email-backed self entity before serialization. Without
  // this, structured addresses are aliased while the same real name can leak
  // from SUMMARY/DESCRIPTION fields.
  if (identity) attachParticipantIdentity(out, identity, pool);
  else markSelf(out, records);
  // Busiest entities first — that's the review order that matters.
  out.sort((a, b) => totalOccurrences(b) - totalOccurrences(a));
  return out;
}

function attachParticipantIdentity(entities: Entity[], identity: ParticipantIdentity, pool: AliasPool): void {
  const email = identity.email.trim().toLowerCase();
  const name = identity.name.trim();
  const nameKey = normalizeName(name);
  let entity =
    (email ? entities.find((e) => e.realEmails.includes(email)) : undefined) ||
    (nameKey ? entities.find((e) => e.realNames.some((n) => normalizeName(n) === nameKey)) : undefined);

  if (!entity) {
    const fresh = pool.next();
    entity = {
      entityId: crypto.randomUUID(),
      category: "self",
      realNames: [],
      realEmails: [],
      realPhones: [],
      alias: fresh.name,
      aliasEmail: fresh.email,
      aliasPhone: fresh.phone,
      keepReal: false,
      occurrences: {},
      mergedFrom: [],
    };
    entities.push(entity);
  }

  if (name && !entity.realNames.some((n) => normalizeName(n) === nameKey)) entity.realNames.push(name);
  if (email && !entity.realEmails.includes(email)) entity.realEmails.push(email);
  // Old heuristic builds could mark a high-volume automated sender as self.
  // The consented login identity is authoritative and must be the only self.
  for (const other of entities) {
    if (other !== entity && other.category === "self") {
      other.category = "person";
      other.keepReal = false;
    }
  }
  entity.category = "self";
  entity.keepReal = false;
}

function mergeUnique(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

export function totalOccurrences(e: Entity): number {
  return Object.values(e.occurrences).reduce((x, y) => x + (y || 0), 0);
}

function markSelf(entities: Entity[], records: SourceRecord[]): void {
  if (entities.some((e) => e.category === "self")) return;
  const fromCounts = new Map<string, number>();
  for (const r of records) {
    if (r.source === "email" && r.from.email) {
      fromCounts.set(r.from.email, (fromCounts.get(r.from.email) || 0) + 1);
    }
  }
  // The dominant sender in a personal Takeout is almost always the person
  // themselves (Sent mail); require a clear majority signal to avoid
  // mislabeling a newsletter-heavy inbox.
  let best: { email: string; count: number } | null = null;
  for (const [email, count] of fromCounts) {
    if (!best || count > best.count) best = { email, count };
  }
  if (!best || best.count < 5) return;
  const entity = entities.find((e) => e.realEmails.includes(best!.email));
  if (entity && entity.category === "person") entity.category = "self";
}

// ---------------------------------------------------------------------------
// Lookup used at serialization time.

export type AliasLookup = {
  byEmail: Map<string, Entity>;
  byPhoneKey: Map<string, Entity>;
  byName: Map<string, Entity>;
};

export function buildLookup(entities: Entity[]): AliasLookup {
  const byEmail = new Map<string, Entity>();
  const byPhoneKey = new Map<string, Entity>();
  const byName = new Map<string, Entity>();
  for (const e of entities) {
    for (const em of e.realEmails) byEmail.set(em.toLowerCase(), e);
    for (const p of e.realPhones) {
      const k = normalizePhoneKey(p);
      if (k) byPhoneKey.set(k, e);
    }
    for (const n of e.realNames) {
      const k = normalizeName(n);
      if (k) byName.set(k, e);
    }
  }
  return { byEmail, byPhoneKey, byName };
}
