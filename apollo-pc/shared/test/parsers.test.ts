// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mboxParser, parseEmailMessage } from "../src/sources/mbox";
import { icsParser } from "../src/sources/ics";
import { vcardParser } from "../src/sources/vcard";
import { whatsappParser } from "../src/sources/whatsapp";
import { mineReceipt, isReceiptCandidate } from "../src/sources/receipts";
import { emailBreakdown } from "../src/ui/screens/sources";
import type { ParsedBody, ParseOptions } from "../src/sources/types";
import type { EmailRecord } from "../src/types";
import { fileOf, SAMPLE_EML, SAMPLE_ICS, SAMPLE_MBOX, SAMPLE_VCF, SAMPLE_WHATSAPP_IOS } from "./fixtures";

const OPTS: ParseOptions = { maxBodyChars: 5000, dateFloor: null };
const noProgress = () => {};

async function collectBodies(): Promise<{ sink: (b: ParsedBody[]) => Promise<void>; bodies: Map<string, string> }> {
  const bodies = new Map<string, string>();
  return {
    bodies,
    sink: async (batch) => {
      for (const b of batch) bodies.set(b.id, b.text);
    },
  };
}

describe("mbox parser", () => {
  it("parses messages, decodes RFC2047 + QP, strips attachments, handles mboxrd escapes", async () => {
    const { sink, bodies } = await collectBodies();
    const result = await mboxParser.parse([fileOf("all.mbox", SAMPLE_MBOX)], OPTS, noProgress, sink);
    expect(result.records).toHaveLength(4);
    const [trip, amazon] = result.records as EmailRecord[];
    expect(trip.subject).toBe("Trip plans ✈");
    expect(trip.from.email).toBe("jane.doe@example.com");
    expect(trip.to).toHaveLength(2);
    expect(trip.labels).toEqual(["Inbox", "Travel"]);
    const body = bodies.get(trip.id)!;
    expect(body).toContain("flights are booked! Confirmation ABC123");
    expect(body).toContain("From my phone"); // >From unescaped
    expect(body).not.toContain("<p>"); // plain part preferred
    expect(amazon.hasListUnsubscribe).toBe(true);
  });

  it("applies the date floor at parse time", async () => {
    const { sink } = await collectBodies();
    const result = await mboxParser.parse(
      [fileOf("all.mbox", SAMPLE_MBOX)],
      { ...OPTS, dateFloor: "2020-01-01T00:00:00Z" },
      noProgress,
      sink
    );
    expect(result.records).toHaveLength(3);
    expect(result.stats.itemsSkipped).toBe(1);
  });

  it("is deterministic: same input, same ids", async () => {
    const { sink } = await collectBodies();
    const a = await mboxParser.parse([fileOf("a.mbox", SAMPLE_MBOX)], OPTS, noProgress, sink);
    const b = await mboxParser.parse([fileOf("b.mbox", SAMPLE_MBOX)], OPTS, noProgress, sink);
    expect(a.records.map((r) => r.id)).toEqual(b.records.map((r) => r.id));
  });

  it("parses .eml and reduces attachments to metadata", async () => {
    const { sink, bodies } = await collectBodies();
    const result = await mboxParser.parse([fileOf("one.eml", SAMPLE_EML)], OPTS, noProgress, sink);
    expect(result.records).toHaveLength(1);
    const rec = result.records[0] as EmailRecord;
    expect(rec.attachments).toHaveLength(1);
    expect(rec.attachments[0].filename).toBe("invoice.pdf");
    expect(bodies.get(rec.id)).toContain("See attached invoice");
    expect(bodies.get(rec.id)).not.toContain("JVBERi0"); // payload never decoded into body
  });

  it("samples oversized encoded text parts before decoding them", () => {
    const oversizedQp = [
      "From: Large Sender <large@example.com>",
      "To: recipient@example.com",
      "Date: Mon, 20 Jul 2026 10:00:00 +0000",
      "Message-ID: <large-text@example.com>",
      "Subject: Large text body",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      `HEAD ${"A=20".repeat(100_000)} TAIL`,
    ].join("\r\n");

    const parsed = parseEmailMessage(oversizedQp, OPTS, "gmail-mbox");
    expect(parsed?.bodyText).toContain("HEAD");
    expect(parsed?.bodyText).toContain("TAIL");
    expect(parsed?.bodyText.length).toBeLessThanOrEqual(OPTS.maxBodyChars + 32);
  });

  it("organizes imported email by Gmail category and sender domain", async () => {
    const { sink } = await collectBodies();
    const result = await mboxParser.parse([fileOf("all.mbox", SAMPLE_MBOX)], OPTS, noProgress, sink);
    const records = result.records as EmailRecord[];
    const organized = emailBreakdown([
      { ...records[0], labels: ["Inbox", "Category Updates"] },
      { ...records[1], labels: ["Category Promotions"] },
      { ...records[2], labels: ["Category Updates"], from: { name: "Another", email: "another@example.com" } },
    ]);
    expect(organized.categories).toEqual([{ label: "Updates", count: 2 }, { label: "Promotions", count: 1 }]);
    expect(organized.domains[0]).toEqual({ label: "example.com", count: 2 });
  });
});

describe("ics parser", () => {
  it("parses VEVENTs with TZID, all-day, escapes, attendees, rrule", async () => {
    const { sink } = await collectBodies();
    const result = await icsParser.parse([fileOf("cal.ics", SAMPLE_ICS)], OPTS, noProgress, sink);
    expect(result.records).toHaveLength(2);
    const [coffee, vacation] = result.records as import("../src/types").CalendarRecord[];
    expect(coffee.summary).toBe("Coffee with Jane, downtown");
    expect(coffee.location).toBe("Blue Bottle; 5th Ave");
    expect(coffee.description).toContain("Catch up about the trip\nBring");
    expect(coffee.tzid).toBe("America/New_York");
    expect(coffee.organizer?.email).toBe("lj@example.com");
    expect(coffee.attendees[0]).toEqual({ name: "Jane Doe", email: "jane.doe@example.com" });
    expect(vacation.allDay).toBe(true);
    expect(vacation.rrule).toBe("FREQ=YEARLY");
  });
});

describe("vcard parser", () => {
  it("parses v3 + v2.1 QP cards, normalizes phones, dedupes emails", async () => {
    const { sink } = await collectBodies();
    const result = await vcardParser.parse([fileOf("contacts.vcf", SAMPLE_VCF)], OPTS, noProgress, sink);
    expect(result.records).toHaveLength(2);
    const [jane, bob] = result.records as import("../src/types").ContactRecord[];
    expect(jane.fullName).toBe("Jane Doe");
    expect(jane.emails).toEqual(["jane.doe@example.com", "jdoe@work.example.com"]);
    expect(jane.phones).toEqual(["+14125550187"]);
    expect(jane.org).toBe("Example Corp");
    expect(bob.fullName).toBe("Bob Smith");
    expect(bob.phones).toEqual(["4125550199"]);
  });
});

describe("whatsapp parser", () => {
  it("parses iOS format with continuations, media, and system lines", async () => {
    const { sink } = await collectBodies();
    const result = await whatsappParser.parse(
      [fileOf("WhatsApp Chat with Jane Doe.txt", SAMPLE_WHATSAPP_IOS)],
      { ...OPTS, locale: { dateOrder: "dmy" } },
      noProgress,
      sink
    );
    // 4 timestamped messages; the bare line is a continuation of message 2.
    expect(result.records).toHaveLength(4);
    const msgs = result.records as import("../src/types").MessageRecord[];
    expect(msgs[0].chatName).toBe("Jane Doe");
    expect(msgs[1].text).toContain("still packing though"); // continuation joined
    expect(msgs[2].isMedia).toBe(true);
    expect(msgs[3].isSystem).toBe(true);
    // dmy: 19/07/26 = July 19 2026
    expect(msgs[0].timestamp!.slice(0, 7)).toBe("2026-07");
  });
});

describe("receipt miner", () => {
  it("mines an order from an Amazon shipping email and links it back", async () => {
    const { sink, bodies } = await collectBodies();
    const parsed = await mboxParser.parse([fileOf("all.mbox", SAMPLE_MBOX)], OPTS, noProgress, sink);
    const amazon = parsed.records.find((r) => (r as EmailRecord).from?.email === "ship-confirm@amazon.com") as EmailRecord;
    expect(isReceiptCandidate(amazon)).toBe(true);
    const order = mineReceipt(amazon, bodies.get(amazon.id)!);
    expect(order).not.toBeNull();
    expect(order!.merchant).toBe("Amazon");
    expect(order!.orderId).toBe("123-4567890-1234567");
    expect(order!.total).toBe(56.78);
    expect(order!.relatedRecordIds).toEqual([amazon.id]);
  });
});
