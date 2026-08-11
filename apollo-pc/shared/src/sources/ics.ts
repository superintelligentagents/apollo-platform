// RFC 5545 .ics calendar parser (Google Takeout, Apple, Outlook exports).
// Calendar files are small (a decade ≈ 5–20 MB) — no streaming needed.
// RRULE is kept as the raw string; the downstream environment builder
// expands recurrences (EXDATE/COUNT/UNTIL correctness isn't worth doing here).

import { recordId } from "../ids";
import type { Address, CalendarRecord } from "../types";
import {
  breather,
  collectIssue,
  issueList,
  trackRange,
  type ParseResult,
  type SourceParser,
} from "./types";

const DESCRIPTION_CAP = 2000;

export const icsParser: SourceParser = {
  id: "ics",
  source: "calendar",
  label: "Calendar (.ics export)",
  accept: [".ics"],

  async parse(files, opts, onProgress, _onBody): Promise<ParseResult> {
    const issues = new Map<string, number>();
    const records: CalendarRecord[] = [];
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
      const events = extractBlocks(unfoldIcs(text), "VEVENT");
      let count = 0;
      for (const block of events) {
        opts.signal?.throwIfAborted();
        const record = parseVEvent(block, issues);
        if (!record) {
          stats.itemsSkipped++;
          continue;
        }
        if (opts.dateFloor && record.timestamp && record.timestamp < opts.dateFloor) {
          stats.itemsSkipped++;
          continue;
        }
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        records.push(record);
        stats.recordsEmitted++;
        stats.dateRange = trackRange(stats.dateRange, record.timestamp);
        if (++count % 500 === 0) {
          await breather();
          onProgress({ phase: "parsing", bytesRead, bytesTotal, recordsEmitted: stats.recordsEmitted });
        }
      }
      onProgress({ phase: "parsing", bytesRead, bytesTotal, recordsEmitted: stats.recordsEmitted });
    }
    return { records, stats, issues: issueList(issues) };
  },
};

export function unfoldIcs(text: string): string {
  return text.replace(/\r?\n[ \t]/g, "");
}

export function extractBlocks(text: string, kind: string): string[] {
  const out: string[] = [];
  const begin = `BEGIN:${kind}`;
  const end = `END:${kind}`;
  let idx = 0;
  for (;;) {
    const start = text.indexOf(begin, idx);
    if (start === -1) break;
    const stop = text.indexOf(end, start);
    if (stop === -1) break;
    out.push(text.slice(start + begin.length, stop));
    idx = stop + end.length;
  }
  return out;
}

export type IcsProp = { name: string; params: Record<string, string>; value: string };

// NAME;PARAM=x;PARAM="quoted":value — with escaped \, \; \n in values.
export function parseIcsLine(line: string): IcsProp | null {
  let i = 0;
  let inQuotes = false;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) break;
  }
  if (i >= line.length) return null;
  const left = line.slice(0, i);
  const value = line.slice(i + 1);
  const [name, ...paramParts] = splitOutsideQuotes(left, ";");
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of s) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === sep && !inQuotes) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

export function unescapeIcs(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function parseVEvent(block: string, issues: Map<string, number>): CalendarRecord | null {
  const props = new Map<string, IcsProp[]>();
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const prop = parseIcsLine(line.trim());
    if (!prop) continue;
    const list = props.get(prop.name) || [];
    list.push(prop);
    props.set(prop.name, list);
  }
  const first = (name: string) => props.get(name)?.[0];

  const uid = first("UID")?.value.trim() || "";
  const dtstartProp = first("DTSTART");
  if (!dtstartProp) {
    collectIssue(issues, "Event without DTSTART skipped");
    return null;
  }
  const start = parseIcsDate(dtstartProp);
  if (!start) {
    collectIssue(issues, "Event with unparseable DTSTART skipped");
    return null;
  }
  const dtendProp = first("DTEND");
  const end = dtendProp ? parseIcsDate(dtendProp) : null;
  const recurrenceId = first("RECURRENCE-ID")?.value.trim() || null;

  const summary = unescapeIcs(first("SUMMARY")?.value || "").trim();
  const description = unescapeIcs(first("DESCRIPTION")?.value || "").trim().slice(0, DESCRIPTION_CAP);
  const location = unescapeIcs(first("LOCATION")?.value || "").trim();
  const organizer = parseCalAddress(first("ORGANIZER"));
  const attendees = (props.get("ATTENDEE") || []).map(parseCalAddress).filter((a): a is Address => !!a);

  const nativeKey = `${uid || summary + start.iso}|${recurrenceId || ""}`;
  return {
    id: recordId("ics", nativeKey),
    source: "calendar",
    sourceDetail: "ics",
    timestamp: start.iso,
    searchText: [summary, location, organizer?.name, organizer?.email, ...attendees.map((a) => `${a.name} ${a.email}`)]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
    uid,
    summary,
    description,
    location,
    dtstart: start.iso,
    dtend: end?.iso ?? null,
    allDay: start.allDay,
    tzid: dtstartProp.params.TZID || null,
    organizer,
    attendees,
    rrule: first("RRULE")?.value.trim() || null,
    recurrenceId,
    status: first("STATUS")?.value.trim() || null,
  };
}

function parseCalAddress(prop: IcsProp | undefined): Address | null {
  if (!prop) return null;
  const email = prop.value.replace(/^mailto:/i, "").trim().toLowerCase();
  const name = (prop.params.CN || "").trim();
  if (!email && !name) return null;
  return { name, email: email.includes("@") ? email : "" };
}

// Three DTSTART shapes: UTC ("...Z"), local with TZID (kept as wall time —
// the tzid string rides along), and VALUE=DATE (all-day).
export function parseIcsDate(prop: IcsProp): { iso: string; allDay: boolean } | null {
  const v = prop.value.trim();
  if (prop.params.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    return { iso: `${m[1]}-${m[2]}-${m[3]}T00:00:00`, allDay: true };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || ""}`;
  return { iso, allDay: false };
}
