// Contacts: vCard .vcf (Google, iCloud) + Google Contacts CSV. Contacts are
// the entity-join goldmine — one card often unifies a name, two emails, and a
// phone into a single entity that then links that person across every source.

import { recordId } from "../ids";
import type { ContactRecord } from "../types";
import { csvObjects } from "./csv";
import { decodeQuotedPrintable } from "./mime";
import { breather, issueList, type ParseResult, type SourceParser } from "./types";

export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) return "";
  return plus ? `+${digits}` : digits;
}

export const vcardParser: SourceParser = {
  id: "contacts",
  source: "contacts",
  label: "Contacts (.vcf or Google CSV)",
  accept: [".vcf", ".csv"],

  async parse(files, opts, onProgress, _onBody): Promise<ParseResult> {
    const issues = new Map<string, number>();
    const records: ContactRecord[] = [];
    const seen = new Set<string>();
    const stats = {
      recordsEmitted: 0,
      itemsSkipped: 0,
      bodiesTruncated: 0,
      attachmentsStripped: 0,
      dateRange: null as { min: string; max: string } | null,
    };
    const bytesTotal = files.reduce((a, f) => a + f.size, 0);
    let bytesRead = 0;

    for (const file of files) {
      const text = await file.text();
      bytesRead += file.size;
      const contacts = file.name.toLowerCase().endsWith(".csv") ? parseGoogleCsv(text) : parseVcf(text);
      let count = 0;
      for (const record of contacts) {
        opts.signal?.throwIfAborted();
        if (!record) {
          stats.itemsSkipped++;
          continue;
        }
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        records.push(record);
        stats.recordsEmitted++;
        if (++count % 500 === 0) await breather();
      }
      onProgress({ phase: "parsing", bytesRead, bytesTotal, recordsEmitted: stats.recordsEmitted });
    }
    return { records, stats, issues: issueList(issues) };
  },
};

function contactFrom(
  detail: string,
  fullName: string,
  emails: string[],
  phones: string[],
  org: string | null,
  birthday: string | null,
  addresses: string[],
  notes: string | null
): ContactRecord | null {
  const cleanEmails = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
  const cleanPhones = [...new Set(phones.map(normalizePhone).filter(Boolean))];
  const name = fullName.trim();
  if (!name && !cleanEmails.length && !cleanPhones.length) return null;
  const nativeKey = `${name.toLowerCase()}|${cleanEmails[0] || cleanPhones[0] || ""}`;
  return {
    id: recordId(detail, nativeKey),
    source: "contacts",
    sourceDetail: detail,
    timestamp: null,
    searchText: [name, ...cleanEmails, ...cleanPhones, org || ""].join(" ").toLowerCase(),
    fullName: name,
    emails: cleanEmails,
    phones: cleanPhones,
    org: org?.trim() || null,
    birthday: birthday?.trim() || null,
    addresses: addresses.map((a) => a.trim()).filter(Boolean),
    notes: notes?.trim() || null,
  };
}

export function parseVcf(text: string): (ContactRecord | null)[] {
  // Unfold (continuation lines start with space/tab).
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const cards = unfolded.split(/BEGIN:VCARD/i).slice(1);
  return cards.map((card) => {
    let fullName = "";
    let org: string | null = null;
    let birthday: string | null = null;
    let notes: string | null = null;
    const emails: string[] = [];
    const phones: string[] = [];
    const addresses: string[] = [];
    for (const line of card.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const left = line.slice(0, idx);
      let value = line.slice(idx + 1).trim();
      const nameParts = left.split(";");
      const prop = nameParts[0].toUpperCase();
      // v2.1 exports (old Outlook) quote-printable-encode values inline.
      if (/ENCODING=QUOTED-PRINTABLE/i.test(left)) value = decodeQuotedPrintable(value);
      const unescaped = value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
      switch (prop) {
        case "FN":
          fullName = unescaped;
          break;
        case "N":
          if (!fullName) {
            const [family, given] = unescaped.split(";");
            fullName = [given, family].filter(Boolean).join(" ").trim();
          }
          break;
        case "EMAIL":
          emails.push(unescaped);
          break;
        case "TEL":
          phones.push(unescaped);
          break;
        case "ORG":
          org = unescaped.split(";")[0];
          break;
        case "BDAY":
          birthday = unescaped;
          break;
        case "ADR":
          addresses.push(unescaped.split(";").filter(Boolean).join(", "));
          break;
        case "NOTE":
          notes = unescaped;
          break;
      }
    }
    return contactFrom("vcf", fullName, emails, phones, org, birthday, addresses, notes);
  });
}

export function parseGoogleCsv(text: string): (ContactRecord | null)[] {
  const rows = csvObjects(text);
  return rows.map((row) => {
    const fullName =
      row["Name"] ||
      [row["First Name"], row["Middle Name"], row["Last Name"]].filter(Boolean).join(" ").trim();
    const emails = Object.entries(row)
      .filter(([k]) => /^E-mail \d+ - Value$/i.test(k))
      .flatMap(([, v]) => v.split(" ::: "));
    const phones = Object.entries(row)
      .filter(([k]) => /^Phone \d+ - Value$/i.test(k))
      .flatMap(([, v]) => v.split(" ::: "));
    const addresses = Object.entries(row)
      .filter(([k]) => /^Address \d+ - Formatted$/i.test(k))
      .map(([, v]) => v.replace(/\n/g, ", "));
    return contactFrom(
      "google-contacts-csv",
      fullName,
      emails,
      phones,
      row["Organization 1 - Name"] || row["Organization Name"] || null,
      row["Birthday"] || null,
      addresses,
      row["Notes"] || null
    );
  });
}
