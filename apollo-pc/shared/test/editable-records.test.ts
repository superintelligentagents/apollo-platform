// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { editableFields } from "../src/ui/screens/items";
import type { CalendarRecord, EmailRecord } from "../src/types";

const email: EmailRecord = {
  id: "mail-1",
  source: "email",
  sourceDetail: "gmail-mbox",
  timestamp: "2026-07-01T00:00:00Z",
  searchText: "",
  messageId: "private-message-id",
  from: { name: "Sender", email: "sender@example.com" },
  to: [{ name: "Recipient", email: "recipient@example.com" }],
  cc: [],
  subject: "Subject",
  snippet: "Snippet",
  bodyRef: true,
  bodyTruncated: false,
  labels: ["Inbox"],
  hasListUnsubscribe: false,
  attachments: [{ filename: "private.pdf", size: 20, mime: "application/pdf" }],
};

const calendar: CalendarRecord = {
  id: "event-1",
  source: "calendar",
  sourceDetail: "ics",
  timestamp: "2026-07-02T00:00:00Z",
  searchText: "",
  uid: "private-calendar-uid",
  summary: "Event",
  description: "Description",
  location: "Location",
  dtstart: "2026-07-02T10:00:00Z",
  dtend: "2026-07-02T11:00:00Z",
  allDay: false,
  tzid: "Asia/Seoul",
  organizer: { name: "Organizer", email: "organizer@example.com" },
  attendees: [{ name: "Guest", email: "guest@example.com" }],
  rrule: "FREQ=WEEKLY",
  recurrenceId: "private-recurrence-id",
  status: "confirmed",
};

describe("annotator record editing coverage", () => {
  it("only exposes email subject editing", () => {
    expect(editableFields(email).map((field) => field.field)).toEqual(["subject"]);
    // Email content has its own larger editor. All metadata stays hidden and locked.
  });

  it("only exposes calendar summary and description editing", () => {
    expect(editableFields(calendar).map((field) => field.field)).toEqual(["summary", "description"]);
  });
});
