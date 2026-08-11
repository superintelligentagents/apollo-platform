// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createAliasPool, detectEntities } from "../src/alias";
import { assembleBundle } from "../src/bundle";
import { participantUploadIdentity } from "../src/schema";
import { scrubText } from "../src/scrub";
import type { RecordStore } from "../src/store";
import type { EmailRecord } from "../src/types";
import { includedByDefault } from "../src/ui/app";
import { initialState } from "../src/ui/context";

function mail(id: string, from: { name: string; email: string }, subject: string): EmailRecord {
  return {
    id,
    source: "email",
    sourceDetail: "gmail-mbox",
    timestamp: "2026-08-10T12:00:00Z",
    searchText: "",
    messageId: `<${id}@example.test>`,
    from,
    to: [{ name: "Lawrence Jang", email: "lawrence@example.com" }],
    cc: [],
    subject,
    snippet: "",
    bodyRef: true,
    bodyTruncated: false,
    labels: ["Inbox"],
    hasListUnsubscribe: false,
    attachments: [],
  };
}

describe("email privacy end to end", () => {
  it("selects every email by default, including promotional and spam-labelled mail", () => {
    const promotional = mail("promo", { name: "Newsletter", email: "noreply@newsletter.example" }, "Weekly digest");
    promotional.hasListUnsubscribe = true;
    promotional.labels = ["Spam", "Category Promotions"];
    expect(includedByDefault(promotional)).toBe(true);
  });

  it("excludes deselected mail and removes personal names, addresses, and hard PII from the serialized upload", async () => {
    const identity = {
      kind: "internal" as const,
      participantId: "privacy-test",
      name: "Lawrence Jang",
      email: "lawrence@example.com",
      consent: { version: "test", accepted_at: "2026-08-10T00:00:00Z" },
    };
    const privateMail = mail("private", { name: "Jane Doe", email: "jane.doe@example.com" }, "Jane Doe private details");
    const excludedMail = mail("excluded", { name: "Bob Smith", email: "bob@example.net" }, "DO_NOT_UPLOAD");
    const body = [
      "Jane Doe can be reached at jane.doe@example.com or backup.secret@example.net.",
      "Phone +1 (412) 555-0187. Address 12 Main Street. DOB 01/02/1990.",
      "Card 4111 1111 1111 1111. password: hunter2. Your verification code 482913.",
    ].join(" ");
    const state = initialState();
    state.identity = identity;
    state.records = new Map([[privateMail.id, privateMail], [excludedMail.id, excludedMail]]);
    state.entities = detectEntities([...state.records.values()], [], createAliasPool(), identity);
    state.decisions.set(excludedMail.id, { included: false, edits: {}, bodyEdit: null, maskOverrides: {} });
    const store = {
      getBodies: async () => new Map([[privateMail.id, body], [excludedMail.id, "DO_NOT_UPLOAD body"]]),
    } as unknown as RecordStore;

    const assembled = await assembleBundle(
      state,
      store,
      identity,
      "pc/privacy-test/internal/bundle-test",
      "2026-08-10T00:00:00Z",
      (record) => state.decisions.get(record.id)?.included ?? includedByDefault(record)
    );
    expect(assembled.includedCount).toBe(1);
    expect(assembled.privacyAudit.findings.filter((finding) => finding.severity === "block")).toEqual([]);
    expect(assembled.privacyAudit.status).not.toBe("blocked");
    const self = state.entities.find((entity) => entity.category === "self" && entity.realEmails.includes(identity.email));
    expect(self).toBeTruthy();
    expect(participantUploadIdentity(identity, state.entities)).toMatchObject({
      participantId: identity.participantId,
      name: self!.alias,
      email: self!.aliasEmail,
    });
    const manifest = JSON.parse(assembled.manifestBody);
    expect(manifest.participant).toMatchObject({
      participant_id: identity.participantId,
      name: self!.alias,
      email: self!.aliasEmail,
    });
    expect(assembled.manifestBody).not.toContain(identity.name);
    expect(assembled.manifestBody).not.toContain(identity.email);
    const recordsJson = assembled.uploads.filter((upload) => upload.kind === "email").map((upload) => upload.body).join(" ");
    for (const secret of [
      "DO_NOT_UPLOAD",
      "Jane Doe",
      "jane.doe@example.com",
      "backup.secret@example.net",
      "+1 (412) 555-0187",
      "12 Main Street",
      "01/02/1990",
      "4111 1111 1111 1111",
      "hunter2",
      "482913",
    ]) expect(recordsJson).not.toContain(secret);
    for (const replacement of ["[email]", "[phone]", "[address]", "[dob]", "[card-number]", "[password]", "[otp]"]) {
      expect(recordsJson).toContain(replacement);
    }
  });

  it("fails closed when a user restores a protected value before assembly", async () => {
    const identity = {
      kind: "internal" as const,
      participantId: "override-test",
      name: "Privacy Tester",
      email: "privacy.tester@example.com",
      consent: { version: "test", accepted_at: "2026-08-10T00:00:00Z" },
    };
    const record = mail("override", { name: "Service", email: "service@example.test" }, "Account update");
    const body = "My SSN is 123-45-6789.";
    const match = scrubText(record.id, "body", body).find((item) => item.detector === "ssn");
    expect(match).toBeTruthy();

    const state = initialState();
    state.identity = identity;
    state.records = new Map([[record.id, record]]);
    state.entities = detectEntities([record], [], createAliasPool(), identity);
    state.decisions.set(record.id, {
      included: true,
      edits: {},
      bodyEdit: null,
      maskOverrides: { [match!.matchId]: true },
    });
    const store = { getBodies: async () => new Map([[record.id, body]]) } as unknown as RecordStore;

    const assembled = await assembleBundle(
      state,
      store,
      identity,
      "pc/override-test/internal/bundle-override",
      "2026-08-10T00:00:00Z",
      () => true
    );

    expect(assembled.privacyAudit.status).toBe("blocked");
    expect(assembled.privacyAudit.blocking_findings).toBeGreaterThan(0);
    expect(JSON.stringify(assembled.privacyAudit)).not.toContain("123-45-6789");
    expect(JSON.stringify(assembled.uploads)).toContain("123-45-6789");
  });
});
