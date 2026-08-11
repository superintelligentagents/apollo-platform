import { describe, expect, it } from "vitest";
import type { EmailRecord } from "../src/types";
import { applyDecisions, serializeDecisions } from "../src/ui/autosave";
import { initialState, type Ctx } from "../src/ui/context";
import { mailboxIndexFor } from "../src/ui/mailbox-index";
import { filterRecords } from "../src/ui/screens/items";

const MAILBOX_SIZE = 100_000;

function largeMailbox(): Map<string, EmailRecord> {
  const records = new Map<string, EmailRecord>();
  for (let index = 0; index < MAILBOX_SIZE; index++) {
    const id = `mail-${index}`;
    const domain = index % 5 === 0 ? "amazon.com" : `sender-${index % 20}.example.com`;
    const subject = index === MAILBOX_SIZE - 1 ? "Unique performance needle" : `Mailbox message ${index}`;
    records.set(id, {
      id,
      source: "email",
      sourceDetail: "gmail-mbox",
      timestamp: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00Z`,
      searchText: `${subject} sender-${index % 200}@${domain}`.toLowerCase(),
      messageId: id,
      from: { name: `Sender ${index % 200}`, email: `sender-${index % 200}@${domain}` },
      to: [{ name: "Mailbox Owner", email: "owner@example.com" }],
      cc: [],
      subject,
      snippet: "Local search preview",
      bodyRef: true,
      bodyTruncated: false,
      labels: ["Inbox"],
      hasListUnsubscribe: index % 10 === 0,
      attachments: [],
    });
  }
  return records;
}

describe("100k-message mailbox performance", () => {
  it("indexes once, reuses the result, and searches without reclassification or resorting", () => {
    const records = largeMailbox();
    const buildStarted = performance.now();
    const index = mailboxIndexFor(records, "owner@example.com");
    const buildMs = performance.now() - buildStarted;

    expect(index.emails).toHaveLength(MAILBOX_SIZE);
    expect(index.domainCounts.find((domain) => domain.label === "amazon.com")?.count).toBe(20_000);
    expect(buildMs).toBeLessThan(8_000);

    const cachedStarted = performance.now();
    expect(mailboxIndexFor(records, "owner@example.com")).toBe(index);
    expect(performance.now() - cachedStarted).toBeLessThan(20);

    const state = initialState();
    state.identity = {
      kind: "internal",
      participantId: "performance",
      name: "Performance Test",
      email: "owner@example.com",
      consent: { version: "test", accepted_at: "2026-08-12T00:00:00Z" },
    };
    state.records = records;
    Object.assign(state.filters, { source: "email", query: "unique performance needle" });
    const ctx = {
      state,
      actions: { isIncluded: () => true },
    } as unknown as Ctx;
    const searchStarted = performance.now();
    const matches = filterRecords(ctx, index, new Set());
    const searchMs = performance.now() - searchStarted;

    expect(matches.map((record) => record.id)).toEqual([`mail-${MAILBOX_SIZE - 1}`]);
    expect(searchMs).toBeLessThan(1_500);
  });

  it("persists a source-wide private choice without 100k decision objects", () => {
    const state = initialState();
    state.sourceInclusionDefaults.email = false;
    const saved = serializeDecisions(state);
    expect(saved.decisions).toEqual([]);
    expect(saved.sourceInclusionDefaults).toEqual({ email: false });

    const restored = initialState();
    applyDecisions(restored, saved);
    expect(restored.sourceInclusionDefaults.email).toBe(false);
    expect(restored.decisions.size).toBe(0);
    expect(restored.decisions).toBeInstanceOf(Map);
  });
});
