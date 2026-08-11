import { describe, expect, it } from "vitest";
import { auditPrivacyBundle } from "../src/privacy-audit";
import type { Entity, ParticipantIdentity } from "../src/types";

const identity: ParticipantIdentity = {
  kind: "internal",
  participantId: "participant-opaque",
  name: "Jane Private",
  email: "jane.private@real.example.com",
  consent: { version: "test", accepted_at: "2026-08-12T00:00:00Z" },
};

const self: Entity = {
  entityId: "self-private",
  category: "self",
  realNames: [identity.name],
  realEmails: [identity.email],
  realPhones: ["+44 20 7946 0958"],
  alias: "Maya Chen",
  aliasEmail: "maya.chen@personamail.test",
  aliasPhone: "+1 555 0101",
  keepReal: false,
  occurrences: { email: 1 },
  mergedFrom: [],
};

describe("bundle-wide privacy audit", () => {
  it("does not mistake digits inside opaque UUID/hash fields for a phone number", () => {
    const audit = auditPrivacyBundle({
      files: [{ filename: "records_email.json", body: JSON.stringify({
        records: [{
          record_id: "record-14125550187",
          aliased_entity_ids: ["123e4567-e89b-12d3-a456-14125550187"],
        }],
      }) }],
      identity,
      entities: [],
      generatedAt: "2026-08-12T00:00:00Z",
    });
    expect(audit.findings.filter((finding) => finding.severity === "block")).toEqual([]);
  });

  it("fails closed on protected identity values and direct identifiers without copying values into findings", () => {
    const raw = JSON.stringify({ records: [{ body: `Contact ${identity.name} at ${identity.email}. IP 192.168.1.42` }] });
    const audit = auditPrivacyBundle({ files: [{ filename: "records_email.json", body: raw }], identity, entities: [self], generatedAt: "2026-08-12T00:00:00Z" });
    expect(audit.status).toBe("blocked");
    expect(audit.blocking_findings).toBeGreaterThan(0);
    const report = JSON.stringify(audit);
    expect(report).not.toContain(identity.name);
    expect(report).not.toContain(identity.email);
    expect(report).not.toContain("192.168.1.42");
  });

  it("does not treat a public organization identity as personal PII", () => {
    const merchant: Entity = {
      ...self,
      entityId: "merchant-real",
      category: "merchant",
      realNames: ["Example Merchant"],
      realEmails: ["support@example-merchant.com"],
      realPhones: [],
      alias: "Example Merchant",
      aliasEmail: "merchant@personamail.test",
      aliasPhone: null,
      keepReal: true,
    };
    const body = JSON.stringify({ participant: { name: self.alias, email: self.aliasEmail }, merchant: { name: "Example Merchant", email: "support@example-merchant.com" } });
    const audit = auditPrivacyBundle({ files: [{ filename: "manifest.json", body }], identity, entities: [self, merchant], generatedAt: "2026-08-12T00:00:00Z" });
    expect(audit.status).toBe("pass");
    expect(audit.blocking_findings).toBe(0);
    expect(audit.warnings).toBe(0);
    expect(audit.kept_real_entities).toBe(0);
  });

  it("records an explicit keep-real personal identity as residual risk", () => {
    const friend: Entity = {
      ...self,
      entityId: "friend-real",
      category: "person",
      realNames: ["Alex Personal"],
      realEmails: ["alex@personalmail.com"],
      realPhones: [],
      keepReal: true,
    };
    const body = JSON.stringify({ participant: { name: self.alias, email: self.aliasEmail }, friend: { name: "Alex Personal", email: "alex@personalmail.com" } });
    const audit = auditPrivacyBundle({ files: [{ filename: "manifest.json", body }], identity, entities: [self, friend], generatedAt: "2026-08-12T00:00:00Z" });
    expect(audit.status).toBe("review");
    expect(audit.blocking_findings).toBe(0);
    expect(audit.kept_real_entities).toBe(1);
    expect(audit.findings.some((finding) => finding.code === "explicit-keep-real-entity")).toBe(true);
  });
});
