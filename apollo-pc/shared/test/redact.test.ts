// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createAliasPool, detectEntities } from "../src/alias";
import { buildRedactContext, redactTaskForUpload, serializeRecord } from "../src/redact";
import { applyMasks, scrubText } from "../src/scrub";
import { splitRecordsIntoParts, validateBundle } from "../src/schema";
import type { CalendarRecord, ContactRecord, EmailRecord, MessageRecord, OrderRecord, PCTask, SerializedRecord, TransactionRecord } from "../src/types";

function email(over: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: "gmail-mbox-abc",
    source: "email",
    sourceDetail: "gmail-mbox",
    timestamp: "2026-07-20T10:00:00Z",
    searchText: "",
    messageId: "<m@x>",
    from: { name: "Jane Doe", email: "jane.doe@example.com" },
    to: [{ name: "Lawrence Jang", email: "lj@example.com" }],
    cc: [],
    subject: "Dinner with Jane Doe",
    snippet: "",
    bodyRef: true,
    bodyTruncated: false,
    labels: [],
    hasListUnsubscribe: false,
    attachments: [],
    ...over,
  };
}

function event(over: Partial<CalendarRecord> = {}): CalendarRecord {
  return {
    id: "ics-def",
    source: "calendar",
    sourceDetail: "ics",
    timestamp: "2026-07-21T18:00:00Z",
    searchText: "",
    uid: "e@cal",
    summary: "Dinner with Jane",
    description: "",
    location: "",
    dtstart: "2026-07-21T18:00:00Z",
    dtend: null,
    allDay: false,
    tzid: null,
    organizer: { name: "Jane Doe", email: "jane.doe@example.com" },
    attendees: [],
    rrule: null,
    recurrenceId: null,
    status: null,
    ...over,
  };
}

describe("entity detection + aliasing", () => {
  it("gives the same person one alias across email and calendar", () => {
    const entities = detectEntities([email(), event()], [], createAliasPool());
    const jane = entities.find((e) => e.realEmails.includes("jane.doe@example.com"));
    expect(jane).toBeDefined();
    expect((jane!.occurrences.email ?? 0) + (jane!.occurrences.calendar ?? 0)).toBeGreaterThanOrEqual(2);

    const ctx = buildRedactContext(entities, []);
    const e1 = serializeRecord(email(), undefined, ctx, "Jane Doe said hi. Reach her at jane.doe@example.com.");
    const e2 = serializeRecord(event(), undefined, ctx, null);
    const from = e1.record.from as { name: string; email: string };
    const organizer = e2.record.organizer as { name: string; email: string };
    expect(from.name).toBe(jane!.alias);
    expect(organizer.name).toBe(jane!.alias);
    expect(from.email).toBe(jane!.aliasEmail);
    // Free text: name and email both replaced consistently.
    expect(e1.record.body_text as string).toContain(jane!.alias);
    expect(e1.record.body_text as string).not.toContain("Jane Doe");
    expect(e1.record.body_text as string).not.toContain("jane.doe@example.com");
    expect(e1.record.subject as string).not.toContain("Jane Doe");
    expect(e1.aliased_entity_ids).toContain(jane!.entityId);
    expect(e1.privacy_review).toMatchObject({ needs_annotator_review: true, sender_class: "personal" });
    expect(e1.privacy_review?.reasons).toContain("personal-correspondence");
  });

  it("keeps NYT and other newsletter organizations recognizable without a personal-PII flag", () => {
    const nyt = email({
      id: "nyt-newsletter",
      from: { name: "The New York Times", email: "news@nytimes.com" },
      subject: "Today's headlines",
      hasListUnsubscribe: true,
    });
    const entities = detectEntities([nyt], [], createAliasPool());
    const sender = entities.find((entity) => entity.realEmails.includes("news@nytimes.com"));
    expect(sender).toMatchObject({ category: "org", keepReal: true });

    const output = serializeRecord(nyt, undefined, buildRedactContext(entities, []), "Read today's briefing.");
    expect(output.record.from).toEqual({ name: "The New York Times", email: "news@nytimes.com" });
    expect(output.privacy_review).toEqual({
      needs_annotator_review: false,
      sender_class: "organization",
      service_label: "The New York Times",
      reasons: [],
      sensitive_detectors: [],
    });
  });

  it("classifies common notification senders as services instead of people", () => {
    const records = [
      email({ id: "strava", from: { name: "Strava", email: "no-reply@strava.com" } }),
      email({ id: "piazza", from: { name: "Piazza Team", email: "no-reply@piazza.com" } }),
      email({ id: "canvas", from: { name: "CMU Canvas", email: "notifications@instructure.com" } }),
    ];
    const entities = detectEntities(records, [], createAliasPool());
    for (const address of ["no-reply@strava.com", "no-reply@piazza.com", "notifications@instructure.com"]) {
      expect(entities.find((entity) => entity.realEmails.includes(address))).toMatchObject({ category: "org", keepReal: true });
    }
  });

  it("does not mistake an ordinary Gmail correspondent for the Gmail service", () => {
    const personalGmail = email({ from: { name: "Jane Doe", email: "jane.person@gmail.com" } });
    const entities = detectEntities([personalGmail], [], createAliasPool());
    const sender = entities.find((entity) => entity.realEmails.includes("jane.person@gmail.com"));
    expect(sender).toMatchObject({ category: "person", keepReal: false });
    const output = serializeRecord(personalGmail, undefined, buildRedactContext(entities, []), "See you soon.");
    expect(output.privacy_review).toMatchObject({ needs_annotator_review: true, sender_class: "personal" });
    expect(JSON.stringify(output.record.from)).not.toContain("jane.person@gmail.com");
  });

  it("migrates a previously misclassified newsletter entity from person to organization", () => {
    const nyt = email({
      id: "nyt-migration",
      from: { name: "The New York Times", email: "news@nytimes.com" },
      hasListUnsubscribe: true,
    });
    const oldEntity = detectEntities([email()], [], createAliasPool())[0]!;
    oldEntity.realNames = ["The New York Times"];
    oldEntity.realEmails = ["news@nytimes.com"];
    oldEntity.category = "person";
    oldEntity.keepReal = false;
    const migrated = detectEntities([nyt], [oldEntity], createAliasPool()).find((entity) => entity.entityId === oldEntity.entityId);
    expect(migrated).toMatchObject({ category: "org", keepReal: true });
  });

  it("replaces a legacy automated self heuristic with the consented identity", () => {
    const strava = email({
      id: "strava-legacy-self",
      from: { name: "Strava", email: "no-reply@strava.com" },
    });
    const oldSelf = detectEntities([strava], [], createAliasPool())[0]!;
    oldSelf.category = "self";
    oldSelf.keepReal = false;
    const identity = {
      kind: "internal" as const,
      participantId: "participant",
      name: "Mailbox Owner",
      email: "owner@example.com",
      consent: { version: "1", accepted_at: "2026-08-12T00:00:00Z" },
    };

    const migrated = detectEntities([strava], [oldSelf], createAliasPool(), identity);
    expect(migrated.find((entity) => entity.entityId === oldSelf.entityId)).toMatchObject({ category: "org", keepReal: true });
    expect(migrated.filter((entity) => entity.category === "self")).toHaveLength(1);
    expect(migrated.find((entity) => entity.category === "self")?.realEmails).toContain(identity.email);
  });

  it("drops persisted entities that no longer occur in the current imports", () => {
    const previous = detectEntities([email()], [], createAliasPool());
    expect(previous.length).toBeGreaterThan(0);
    expect(detectEntities([], previous, createAliasPool())).toEqual([]);
  });

  it("preserves the authoritative identity alias even when it has no structured occurrence", () => {
    const identity = {
      kind: "internal" as const,
      participantId: "participant",
      name: "Mailbox Owner",
      email: "owner@example.com",
      consent: { version: "1", accepted_at: "2026-08-12T00:00:00Z" },
    };
    const pool = createAliasPool();
    const previous = detectEntities([], [], pool, identity);
    const refreshed = detectEntities([], previous, pool, identity);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatchObject({ entityId: previous[0].entityId, alias: previous[0].alias, category: "self", occurrences: {} });
  });

  it("re-detection preserves entity ids and aliases", () => {
    const pool = createAliasPool();
    const first = detectEntities([email()], [], pool);
    const jane1 = first.find((e) => e.realEmails.includes("jane.doe@example.com"))!;
    const second = detectEntities([email(), event()], first, pool);
    const jane2 = second.find((e) => e.realEmails.includes("jane.doe@example.com"))!;
    expect(jane2.entityId).toBe(jane1.entityId);
    expect(jane2.alias).toBe(jane1.alias);
  });

  it("aliases the participant name in calendar-only free text", () => {
    const identity = {
      kind: "internal" as const,
      participantId: "",
      name: "Lawrence Jang",
      email: "lj@example.com",
      consent: { version: "1", accepted_at: "2026-07-29T00:00:00Z" },
    };
    const calendarOnly = event({
      organizer: { name: "", email: identity.email },
      attendees: [{ name: "", email: identity.email }],
      summary: "Calendar for Lawrence Jang",
      description: "Owner: Lawrence Jang (lj@example.com)",
    });
    const entities = detectEntities([calendarOnly], [], createAliasPool(), identity);
    const self = entities.find((e) => e.category === "self");
    expect(self).toBeDefined();
    expect(self!.realNames).toContain(identity.name);

    const out = serializeRecord(calendarOnly, undefined, buildRedactContext(entities, []), null);
    expect(out.record.summary).toContain(self!.alias);
    expect(out.record.description).toContain(self!.aliasEmail);
    expect(JSON.stringify(out.record)).not.toContain(identity.name);
    expect(JSON.stringify(out.record)).not.toContain(identity.email);
  });

  it("keepReal entities pass through untouched", () => {
    const entities = detectEntities([email()], [], createAliasPool());
    const jane = entities.find((e) => e.realEmails.includes("jane.doe@example.com"))!;
    jane.keepReal = true;
    const ctx = buildRedactContext(entities, []);
    const out = serializeRecord(email(), undefined, ctx, "Jane Doe wrote this.");
    expect((out.record.from as { name: string }).name).toBe("Jane Doe");
    expect(out.record.body_text as string).toContain("Jane Doe");
  });
});

describe("scrub", () => {
  it("hard-masks cards, SSNs, passwords, OTPs, and street addresses", () => {
    const text =
      "Card: 4111 1111 1111 1111. SSN 123-45-6789. password: hunter2. Your code 482913 expires. I live at 12 Main Street.";
    const matches = scrubText("r1", "body", text);
    const detectors = matches.map((m) => m.detector);
    expect(detectors).toContain("card-number");
    expect(detectors).toContain("ssn");
    expect(detectors).toContain("password");
    expect(detectors).toContain("otp-code");
    const { text: masked } = applyMasks(text, matches, {});
    expect(masked).not.toContain("4111 1111 1111 1111");
    expect(masked).not.toContain("123-45-6789");
    expect(masked).not.toContain("hunter2");
    expect(masked).not.toContain("12 Main Street");
    expect(masked).toContain("[address]");
    expect(masked).toContain("[card-number]");
  });

  it("rejects Luhn-invalid number strings", () => {
    const matches = scrubText("r1", "body", "Tracking: 1234 5678 9012 3456");
    expect(matches.filter((m) => m.detector === "card-number")).toHaveLength(0);
  });

  it("mask overrides restore the original", () => {
    const text = "SSN 123-45-6789";
    const matches = scrubText("r1", "body", text);
    const { text: kept } = applyMasks(text, matches, { [matches[0].matchId]: true });
    expect(kept).toContain("123-45-6789");
  });
});

describe("edits + rules", () => {
  it("field edits win, replace-everywhere rules apply to text", () => {
    const entities = detectEntities([email()], [], createAliasPool());
    const ctx = buildRedactContext(entities, [{ find: "Example Corp", replace: "Acme", note: "" }]);
    const out = serializeRecord(
      email(),
      { included: true, edits: { subject: "Dinner plans" }, bodyEdit: null, maskOverrides: {} },
      ctx,
      "I work at Example Corp now."
    );
    expect(out.record.subject).toBe("Dinner plans");
    expect(out.edited).toContain("subject");
    expect(out.record.body_text as string).toContain("Acme");
    expect(out.record.body_text as string).not.toContain("Example Corp");
  });

  it("replace-everywhere ignores capitalization and covers structured addresses", () => {
    const record = email({
      from: { name: "Travel Desk", email: "bookings@private-domain.example" },
      to: [{ name: "Guest", email: "guest@private-domain.example" }],
    });
    const ctx = buildRedactContext([], [
      { find: "private-domain.example", replace: "redacted.example", note: "hide domain" },
      { find: "travel desk", replace: "Assistant", note: "" },
    ]);
    const out = serializeRecord(record, undefined, ctx, "PRIVATE-DOMAIN.EXAMPLE itinerary");
    expect(out.record.from).toEqual({ name: "Assistant", email: "bookings@redacted.example" });
    expect(out.record.to).toEqual([{ name: "Guest", email: "guest@redacted.example" }]);
    expect(out.record.body_text).toBe("redacted.example itinerary");
  });

  it("applies replace-everywhere before entity aliases can change the match", () => {
    const record = email({
      from: { name: "Private Sender", email: "private.sender@example.com" },
      to: [{ name: "Release Tester", email: "release@example.com" }],
    });
    const entities = detectEntities([record], [], createAliasPool());
    const ctx = buildRedactContext(entities, [
      { find: "Private Street", replace: "", note: "remove address" },
      { find: "private.sender@example.com", replace: "sender@redacted.example", note: "replace address" },
    ]);
    const out = serializeRecord(record, undefined, ctx, "Meet at 12 Private Street.");

    expect(out.record.body_text).toBe("Meet at 12 .");
    expect(out.record.body_text).not.toContain("Street");
    expect(out.record.from).toEqual({ name: expect.not.stringContaining("Private"), email: "sender@redacted.example" });
  });

  it("applies only subject and content edits to email uploads", () => {
    const record = email({
      cc: [{ name: "Old CC", email: "old@example.com" }],
      labels: ["Inbox"],
      attachments: [{ filename: "old.pdf", mime: "application/pdf", size: 12 }],
    });
    const edits = {
      source_detail: "edited-mbox",
      timestamp: "2026-07-22T12:00:00Z",
      subject: "Edited subject",
      from: "New Sender <new-sender@example.net>",
      to: "One <one@example.net>\nTwo <two@example.net>",
      cc: "",
      labels: "Important\nPersonal",
      body_truncated: "true",
      attachments: JSON.stringify([{ filename: "renamed.txt", mime: "text/plain", size: 44 }]),
    };
    const out = serializeRecord(record, { included: true, edits, bodyEdit: "Edited body", maskOverrides: {} }, buildRedactContext([], []), "Original body");
    expect(out.record).toMatchObject({
      source_detail: "gmail-mbox",
      timestamp: "2026-07-20T10:00:00Z",
      subject: "Edited subject",
      from: { name: "Jane Doe", email: "[email]" },
      to: [{ name: "Lawrence Jang", email: "[email]" }],
      cc: [{ name: "Old CC", email: "[email]" }],
      labels: ["Inbox"],
      body_truncated: false,
      attachments: [{ filename: "old.pdf", mime: "application/pdf", size: 12 }],
      body_text: "Edited body",
    });
    expect(out.edited).toEqual(["subject", "body"]);
  });

  it("applies only calendar summary and description edits", () => {
    const entities = detectEntities([event()], [], createAliasPool());
    const jane = entities.find((e) => e.realEmails.includes("jane.doe@example.com"))!;
    const out = serializeRecord(event(), {
      included: true,
      edits: {
        summary: "Edited event",
        description: "Edited description",
        organizer: "Jane Doe <jane.doe@example.com>",
        attendees: "Jane Doe <jane.doe@example.com>\nGuest <guest@example.net>",
        dtstart: "2026-07-23T09:00:00Z",
        dtend: "",
        all_day: "true",
        tzid: "Asia/Seoul",
        rrule: "FREQ=WEEKLY",
        status: "confirmed",
      },
      bodyEdit: null,
      maskOverrides: {},
    }, buildRedactContext(entities, []), null);
    expect(out.record.organizer).toEqual({ name: jane.alias, email: jane.aliasEmail });
    expect(out.record.attendees).toEqual([]);
    expect(out.record).toMatchObject({ summary: "Edited event", description: "Edited description", dtstart: "2026-07-21T18:00:00Z", dtend: null, all_day: false, tzid: null, rrule: null, status: null });
    expect(out.edited).toEqual(["summary", "description"]);
  });

  it("applies contact and order collection edits", () => {
    const contact: ContactRecord = {
      id: "contact-1", source: "contacts", sourceDetail: "vcf", timestamp: null, searchText: "",
      fullName: "Original", emails: ["old@example.com"], phones: ["+14125550100"], org: null,
      birthday: null, addresses: ["Old address"], notes: null,
    };
    const contactOut = serializeRecord(contact, {
      included: true,
      edits: { full_name: "Edited Person", emails: "new@example.net", phones: "+821012345678", org: "Edited Org", addresses: "Address one\nAddress two", notes: "Edited notes" },
      bodyEdit: null, maskOverrides: {},
    }, buildRedactContext([], []), null);
    expect(contactOut.record).toMatchObject({ full_name: "Edited Person", emails: ["[email]"], phones: ["[phone]"], org: "Edited Org", addresses: ["Address one", "Address two"], notes: "Edited notes" });

    const order: OrderRecord = {
      id: "order-1", source: "orders", sourceDetail: "email-receipt", timestamp: "2026-07-20T00:00:00Z", searchText: "",
      merchant: "Old shop", orderId: "A1", total: 10, currency: "USD",
      items: [{ title: "Old item", quantity: 1, price: 10 }], shippingAddress: "Old address", relatedRecordIds: ["email-1"],
    };
    const orderOut = serializeRecord(order, {
      included: true,
      edits: { merchant: "New shop", order_id: "B2", total: "18.5", currency: "KRW", items: JSON.stringify([{ title: "New item", quantity: 2, price: 9.25 }]), shipping_address: "New address", related_record_ids: "email-2\nemail-3" },
      bodyEdit: null, maskOverrides: {},
    }, buildRedactContext([], []), null);
    expect(orderOut.record).toMatchObject({ merchant: "New shop", order_id: "B2", total: 18.5, currency: "KRW", items: [{ title: "New item", quantity: 2, price: 9.25 }], shipping_address: "New address", related_record_ids: ["email-2", "email-3"] });
  });

  it("masks opaque source identifiers unless the participant supplies a safe edit", () => {
    const message: MessageRecord = {
      id: "message-1", source: "messages", sourceDetail: "whatsapp-txt", timestamp: "2026-07-20T00:00:00Z", searchText: "",
      chatId: "private-chat-991", chatName: "Planning", sender: "Someone", text: "Hello", isSystem: false, isMedia: false,
    };
    const transaction: TransactionRecord = {
      id: "transaction-1", source: "transactions", sourceDetail: "google-csv", timestamp: "2026-07-20T00:00:00Z", searchText: "",
      description: "Transfer", amount: 5, currency: "USD", account: "Checking 123456789", category: null, relatedRecordIds: [],
    };
    const order: OrderRecord = {
      id: "order-private", source: "orders", sourceDetail: "email-receipt", timestamp: "2026-07-20T00:00:00Z", searchText: "",
      merchant: "Shop", orderId: "ORDER-PRIVATE-991", total: 5, currency: "USD", items: [], shippingAddress: null, relatedRecordIds: [],
    };
    const ctx = buildRedactContext([], []);
    expect(serializeRecord(message, undefined, ctx, null).record.chat_id).toBe("[chat-id]");
    expect(serializeRecord(transaction, undefined, ctx, null).record.account).toBe("[account]");
    expect(serializeRecord(order, undefined, ctx, null).record.order_id).toBe("[order-id]");
  });

  it("redacts authored task text before either private upload or peer review", () => {
    const entities = detectEntities([email()], [], createAliasPool());
    const jane = entities.find((entity) => entity.realEmails.includes("jane.doe@example.com"))!;
    const task: PCTask = {
      task_id: "task-private",
      category: "personal_lookup",
      task_title: "Find Jane Doe's document",
      agent_request: "Email jane.doe@example.com and use passport number X12345678.",
      steps: [{ order: 1, title: "Contact Jane Doe", description: "Use jane.doe@example.com" }],
      success_criteria: ["Return Jane Doe's answer"],
      required_sources: ["email"],
      referenced_record_ids: ["gmail-mbox-abc"],
      expected_answer: "Passport number X12345678",
      notes: null,
    };
    const output = redactTaskForUpload(task, buildRedactContext(entities, []));
    const serialized = JSON.stringify(output.task);
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("jane.doe@example.com");
    expect(serialized).not.toContain("X12345678");
    expect(serialized).toContain(jane.alias);
    expect(serialized).toContain("[passport-number]");
  });
});

describe("expanded direct-identifier baseline", () => {
  it("masks international contact, government, financial, device, account, and location identifiers", () => {
    const samples: Array<[string, string]> = [
      ["passport-number", "Passport number X12345678"],
      ["drivers-license", "Driver's license D123-456-789"],
      ["national-id", "National ID KR-99112233"],
      ["medical-record-number", "MRN A1234567"],
      ["employee-student-id", "Employee ID EMP-44019"],
      ["routing-number", "Routing number 021000021"],
      ["bank-account", "Bank account number 1234567890"],
      ["api-secret", "API key sk_live_abcdefghijklmnopqrstuvwxyz"],
      ["credential-token", "Leaked credential AKIA1234567890ABCDEF"],
      ["ipv4-address", "Last login 192.168.1.42"],
      ["mac-address", "Device AA:BB:CC:DD:EE:FF"],
      ["precise-coordinates", "Coordinates 37.774900, -122.419400"],
      ["coordinate-pair", "Pinned location 35.681236, 139.767125"],
      ["po-box", "Mail to PO Box 404"],
      ["postal-code", "Postal code SW1A 1AA"],
      ["street-address", "Meet at 221B Baker Street"],
      ["international-street-address", "Meet at 10 Rue de Rivoli"],
      ["dob", "Date of birth March 8, 1991"],
      ["license-plate", "License plate ABC-1234"],
      ["online-identifier", "Username @private_handle"],
      ["labeled-person-name", "Legal name: Eleanor Rigby"],
      ["phone-number", "Call +44 20 7946 0958"],
    ];
    for (const [detector, text] of samples) {
      const matches = scrubText("baseline", "body", text);
      expect(matches.map((match) => match.detector), text).toContain(detector);
      expect(applyMasks(text, matches, {}).text, text).not.toBe(text);
    }
  });

  it("masks private key blocks without placing their contents in an audit report", () => {
    const text = "-----BEGIN PRIVATE KEY-----\nabcdef123456\n-----END PRIVATE KEY-----";
    const matches = scrubText("key", "body", text);
    expect(matches.map((match) => match.detector)).toContain("private-key");
    expect(applyMasks(text, matches, {}).text).toBe("[private-key]");
  });
});

describe("part splitting", () => {
  it("packs records under the byte cap and names parts correctly", () => {
    const rec = (i: number): SerializedRecord => ({
      record: { id: `r${i}`, payload: "x".repeat(400) },
      edited: [],
      masked: [],
      aliased_entity_ids: [],
    });
    const records = Array.from({ length: 50 }, (_, i) => rec(i));
    const parts = splitRecordsIntoParts("pc/p/internal/bundle-x", "email", records, 5000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].filename).toBe("records_email.json");
    expect(parts[1].filename).toBe("records_email_part2.json");
    expect(parts.reduce((a, p) => a + p.recordCount, 0)).toBe(50);
    for (const p of parts) {
      expect(new TextEncoder().encode(p.body).length).toBeLessThanOrEqual(5000);
      expect(JSON.parse(p.body).records.length).toBe(p.recordCount);
    }
  });
});

describe("validateBundle", () => {
  const identity = {
    kind: "internal" as const,
    participantId: "",
    name: "LJ",
    email: "lj@x.com",
    consent: { version: "1", accepted_at: "2026-07-29T00:00:00Z" },
  };
  const task = {
    task_id: "t1",
    category: "personal_lookup" as const,
    task_title: "Find it",
    agent_request: "Find the confirmation number for my July flight.",
    steps: [],
    success_criteria: [],
    required_sources: [],
    referenced_record_ids: ["r1"],
    expected_answer: "ABC123",
    notes: null,
  };

  it("requires consent, one included record, one substantive task", () => {
    expect(validateBundle({ identity, includedCounts: { email: 3 }, tasks: [task] }).valid).toBe(true);
    expect(validateBundle({ identity: null, includedCounts: { email: 3 }, tasks: [task] }).valid).toBe(false);
    expect(validateBundle({ identity, includedCounts: {}, tasks: [task] }).valid).toBe(false);
    expect(validateBundle({ identity, includedCounts: { email: 3 }, tasks: [] }).valid).toBe(false);
    expect(
      validateBundle({ identity, includedCounts: { email: 3 }, tasks: [{ ...task, agent_request: "Find [the thing] please" }] }).valid
    ).toBe(false);
  });
});
