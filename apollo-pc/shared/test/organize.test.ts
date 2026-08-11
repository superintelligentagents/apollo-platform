import { describe, expect, it } from "vitest";
import { calendarCategory, emailCategory, linkEmailAndCalendar } from "../src/organize";
import type { CalendarRecord, EmailRecord } from "../src/types";

const email = (patch: Partial<EmailRecord> = {}): EmailRecord => ({
  id: "mail-1", source: "email", sourceDetail: "eml", timestamp: "2026-07-01T10:00:00Z", searchText: "", messageId: "1",
  from: { name: "Amazon", email: "ship@amazon.com" }, to: [], cc: [], subject: "Your order shipped", snippet: "", bodyRef: true,
  bodyTruncated: false, labels: [], hasListUnsubscribe: false, attachments: [], ...patch,
});

const calendar = (patch: Partial<CalendarRecord> = {}): CalendarRecord => ({
  id: "cal-1", source: "calendar", sourceDetail: "ics", timestamp: "2026-07-02T10:00:00Z", searchText: "", uid: "1",
  summary: "Order shipped delivery", description: "", location: "Home", dtstart: "2026-07-02T10:00:00Z", dtend: null, allDay: false,
  tzid: null, organizer: null, attendees: [], rrule: null, recurrenceId: null, status: "confirmed", ...patch,
});

describe("local data organization", () => {
  it("classifies common email sources", () => {
    expect(emailCategory(email())).toBe("shopping");
    expect(emailCategory(email({ from: { name: "DoorDash", email: "orders@doordash.com" }, subject: "Your order receipt" }))).toBe("food-delivery");
    expect(emailCategory(email({ from: { name: "Uber", email: "receipts@uber.com" }, subject: "Trip receipt" }))).toBe("rides");
  });

  it.each([
    ["Uber Eats", "receipts@ubereats.com", "Your dinner receipt", "food-delivery"],
    ["Instacart", "orders@instacart.com", "Your grocery delivery", "groceries"],
    ["OpenTable", "confirmations@opentable.com", "Dinner reservation confirmed", "dining"],
    ["Delta", "confirmation@delta.com", "Flight confirmation ATL to LGA", "flights"],
    ["Airbnb", "automated@airbnb.com", "Your stay is confirmed", "lodging"],
    ["Chase", "alerts@chase.com", "Your monthly account statement", "banking"],
    ["Robinhood", "no-reply@robinhood.com", "Trade confirmation", "investing"],
    ["TurboTax", "notify@turbotax.com", "Your tax return was accepted", "taxes"],
    ["Polymarket", "activity@polymarket.com", "Prediction market activity", "betting"],
    ["GitHub", "notifications@github.com", "Project review requested", "work"],
  ])("classifies MyPCBench-aligned %s mail", (name, address, subject, category) => {
    expect(emailCategory(email({ from: { name, email: address }, subject }))).toBe(category);
  });

  it("uses specific service precedence for ambiguous categories", () => {
    expect(emailCategory(email({ from: { name: "Uber Eats", email: "orders@uber.com" }, subject: "Food delivery receipt" }))).toBe("food-delivery");
    expect(emailCategory(email({ from: { name: "OpenTable", email: "confirmations@opentable.com" }, subject: "Your reservation" }))).toBe("dining");
    expect(emailCategory(email({ from: { name: "TurboTax", email: "notify@intuit.com" }, subject: "Tax refund update" }))).toBe("taxes");
  });

  it("does not confuse unrelated domains and substrings for persona commerce", () => {
    expect(emailCategory(email({
      from: { name: "Multimodal Machine Learning", email: "notifications@instructure.com" },
      subject: "Assignment due date changed: Lecture Participation",
      labels: ["Category Purchases"],
    }))).toBe("work");
    expect(emailCategory(email({
      from: { name: "NCAA", email: "news@mail2.ncaa.com" },
      subject: "Final Four tickets are available",
      hasListUnsubscribe: true,
    }))).toBe("newsletters");
    expect(emailCategory(email({
      from: { name: "Amazon Web Services", email: "billing@aws.com" },
      subject: "AWS billing statement available",
    }))).toBe("work");
    expect(emailCategory(email({
      from: { name: "LinkedIn", email: "jobs@linkedin.com" },
      subject: "Amazon AI Engineer role",
    }))).toBe("work");
    expect(emailCategory(email({
      from: { name: "LinkedIn", email: "jobs@linkedin.com" },
      subject: "Machine Learning Engineer at Uber",
    }))).toBe("work");
    expect(emailCategory(email({
      from: { name: "Research newsletter", email: "post@substack.com" },
      subject: "Are prediction markets doomed?",
      hasListUnsubscribe: true,
    }))).toBe("newsletters");
    expect(emailCategory(email({
      from: { name: "Venmo", email: "receipts@venmo.com" },
      subject: "Receipt from Uber - $19.95",
    }))).toBe("rides");
  });

  it("classifies calendar intent", () => {
    expect(calendarCategory(calendar({ summary: "Lunch with Maya" }))).toBe("meals");
    expect(calendarCategory(calendar({ summary: "Weekly yoga", rrule: "FREQ=WEEKLY" }))).toBe("workout");
    expect(calendarCategory(calendar({ summary: "Flight KE 121" }))).toBe("flights");
    expect(calendarCategory(calendar({ summary: "Airbnb check-in" }))).toBe("lodging");
    expect(calendarCategory(calendar({ summary: "Uber airport pickup" }))).toBe("rides");
  });

  it("links nearby mail and events by meaningful text", () => {
    expect(linkEmailAndCalendar([email(), calendar()])).toEqual([{ emailId: "mail-1", calendarId: "cal-1" }]);
    expect(linkEmailAndCalendar([email(), calendar({ timestamp: "2027-01-01T00:00:00Z" })])).toEqual([]);
  });
});
