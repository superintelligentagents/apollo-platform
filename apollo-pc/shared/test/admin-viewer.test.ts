import { describe, expect, it } from "vitest";
import {
  filterPCAdminBundles,
  adminPrivacyReviewLabel,
  formatAdminEmailAddress,
  isProtectedAdminEmailAddress,
  parseAdminEmailAddress,
  parseAdminEmailRecipients,
  parseAdminFieldValue,
} from "../src/ui/screens/progress";
import type { PCAdminBundle } from "../src/admin-client";

const bundles: PCAdminBundle[] = [
  { bundle_id: "pc/alice/internal/bundle-one", created_at: "2026-08-01T00:00:00Z", participant_id: "alice", participant_name: "Alice", participant_email: "alice@example.com", email_count: 10, calendar_count: 2, task_count: 1, edited_count: 0, masked_count: 0 },
  { bundle_id: "pc/bob/internal/bundle-two", created_at: "2026-08-01T00:00:00Z", participant_id: "bob", participant_name: "Bob", participant_email: "bob@example.com", email_count: 3, calendar_count: 4, task_count: 2, edited_count: 0, masked_count: 0 },
];

describe("Apollo PC admin bundle filters", () => {
  it("combines participant and free-text filtering", () => {
    expect(filterPCAdminBundles(bundles, "alice", "example.com")).toEqual([bundles[0]]);
    expect(filterPCAdminBundles(bundles, "alice", "bundle-two")).toEqual([]);
    expect(filterPCAdminBundles(bundles, "", "BOB")).toEqual([bundles[1]]);
  });

  it("parses scalar and structured inline editor fields", () => {
    expect(parseAdminFieldValue("42", 1)).toBe(42);
    expect(parseAdminFieldValue("false", true)).toBe(false);
    expect(parseAdminFieldValue('[{"name":"Alias"}]', [])).toEqual([{ name: "Alias" }]);
    expect(() => parseAdminFieldValue("not-json", [])).toThrow();
  });

  it("formats and parses the simplified email address controls", () => {
    expect(formatAdminEmailAddress({ name: "Ada Lovelace", email: "ada@example.com" })).toBe("Ada Lovelace <ada@example.com>");
    expect(parseAdminEmailAddress("Ada Lovelace <ada@example.com>")).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
    expect(parseAdminEmailAddress("ada@example.com")).toEqual({ name: "", email: "ada@example.com" });
    expect(parseAdminEmailRecipients("Ada <ada@example.com>\nbob@example.com")).toEqual([
      { name: "Ada", email: "ada@example.com" },
      { name: "", email: "bob@example.com" },
    ]);
  });

  it("recognizes protected participant addresses case-insensitively", () => {
    expect(isProtectedAdminEmailAddress({ email: "SELF-ALIAS@example.test" }, ["self-alias@example.test"])).toBe(true);
    expect(isProtectedAdminEmailAddress({ email: "coworker@example.test" }, ["self-alias@example.test"])).toBe(false);
  });

  it("labels personal correspondence for annotators without flagging organization mail as personal PII", () => {
    expect(adminPrivacyReviewLabel({
      privacy_review: {
        needs_annotator_review: true,
        sender_class: "personal",
        service_label: null,
        reasons: ["personal-correspondence"],
        sensitive_detectors: [],
      },
    })).toBe("PII REVIEW · personal sender");
    expect(adminPrivacyReviewLabel({
      privacy_review: {
        needs_annotator_review: false,
        sender_class: "organization",
        service_label: "The New York Times",
        reasons: [],
        sensitive_detectors: [],
      },
    })).toBe("The New York Times · no personal-sender flag");
  });
});
