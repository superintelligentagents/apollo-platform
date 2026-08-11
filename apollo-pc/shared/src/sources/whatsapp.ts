// WhatsApp per-chat .txt export. Line-per-message but locale-variable:
//   iOS:     [dd/mm/yy, HH:MM:SS] Name: text
//   Android: dd/mm/yy, HH:MM - Name: text
// 12h with am/pm in some locales; U+200E/U+200F marks sprinkled in; D/M vs
// M/D is disambiguated by scanning for any first-component > 12, else the
// import screen asks (opts.locale.dateOrder: "dmy" | "mdy").

import { recordId } from "../ids";
import type { MessageRecord } from "../types";
import { breather, collectIssue, issueList, trackRange, type ParseResult, type SourceParser } from "./types";

const IOS_LINE = /^\[(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?)\]\s([^:]+):\s?([\s\S]*)$/;
const ANDROID_LINE = /^(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?)\s[-–]\s([^:]+):\s?([\s\S]*)$/;
const SYSTEM_ANDROID = /^(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+(\d{1,2}:\d{2}[^-–]*)[-–]\s([^:]+)$/;
const MEDIA = /<media omitted>|image omitted|video omitted|audio omitted|sticker omitted|document omitted|GIF omitted/i;
const SYSTEM_TEXT = /end-to-end encrypted|changed the group|created group|added you|security code changed|changed this group's icon|joined using this group/i;

export const whatsappParser: SourceParser = {
  id: "whatsapp-txt",
  source: "messages",
  label: "Messages (WhatsApp chat export .txt)",
  accept: [".txt"],

  async parse(files, opts, onProgress, _onBody): Promise<ParseResult> {
    const issues = new Map<string, number>();
    const records: MessageRecord[] = [];
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
      const raw = await file.text();
      bytesRead += file.size;
      const text = raw.replace(/[‎‏]/g, "");
      const chatName = chatNameFromFilename(file.name);
      const lines = text.split("\n");
      const dateOrder = resolveDateOrder(lines, opts.locale?.dateOrder);

      let current: { date: string; time: string; sender: string; text: string } | null = null;
      let count = 0;
      const flush = () => {
        if (!current) return;
        const ts = parseWaTimestamp(current.date, current.time, dateOrder);
        if (!ts) {
          collectIssue(issues, "Message with unparseable timestamp skipped");
          stats.itemsSkipped++;
          current = null;
          return;
        }
        if (opts.dateFloor && ts < opts.dateFloor) {
          stats.itemsSkipped++;
          current = null;
          return;
        }
        const body = current.text.trim();
        const isMedia = MEDIA.test(body);
        const isSystem = SYSTEM_TEXT.test(body);
        const nativeKey = `${chatName.toLowerCase()}|${ts}|${current.sender}|${body.slice(0, 64)}`;
        const record: MessageRecord = {
          id: recordId("whatsapp-txt", nativeKey),
          source: "messages",
          sourceDetail: "whatsapp-txt",
          timestamp: ts,
          searchText: `${chatName} ${current.sender}`.toLowerCase(),
          chatId: recordId("whatsapp-chat", chatName.toLowerCase()),
          chatName,
          sender: current.sender.trim(),
          text: isMedia ? "" : body,
          isSystem,
          isMedia,
        };
        current = null;
        if (seen.has(record.id)) return;
        seen.add(record.id);
        records.push(record);
        stats.recordsEmitted++;
        stats.dateRange = trackRange(stats.dateRange, ts);
      };

      for (const line of lines) {
        opts.signal?.throwIfAborted();
        const ios = line.match(IOS_LINE);
        const android = ios ? null : line.match(ANDROID_LINE);
        const m = ios || android;
        if (m) {
          flush();
          current = { date: m[1], time: m[2], sender: m[3], text: m[4] ?? "" };
        } else if (SYSTEM_ANDROID.test(line)) {
          flush(); // dated system line without a sender — drop
          stats.itemsSkipped++;
        } else if (current) {
          current.text += `\n${line}`; // continuation line
        }
        if (++count % 2000 === 0) {
          await breather();
          onProgress({ phase: "parsing", bytesRead, bytesTotal, recordsEmitted: stats.recordsEmitted });
        }
      }
      flush();
      onProgress({ phase: "parsing", bytesRead, bytesTotal, recordsEmitted: stats.recordsEmitted });
    }
    return { records, stats, issues: issueList(issues) };
  },
};

export function chatNameFromFilename(name: string): string {
  return name
    .replace(/\.txt$/i, "")
    .replace(/^WhatsApp Chat (with|-)\s*/i, "")
    .replace(/^_chat$/i, "Chat")
    .trim() || "Chat";
}

export function resolveDateOrder(lines: string[], override: string | undefined): "dmy" | "mdy" {
  if (override === "dmy" || override === "mdy") return override;
  for (const line of lines.slice(0, 500)) {
    const m = line.match(/(\d{1,2})[./-](\d{1,2})[./-]\d{2,4}/);
    if (!m) continue;
    if (parseInt(m[1], 10) > 12) return "dmy";
    if (parseInt(m[2], 10) > 12) return "mdy";
  }
  return "mdy"; // US default when genuinely ambiguous
}

export function parseWaTimestamp(date: string, time: string, order: "dmy" | "mdy"): string | null {
  const dm = date.match(/^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/);
  if (!dm) return null;
  let year: number, month: number, day: number;
  if (dm[1].length === 4) {
    // yyyy-mm-dd style
    year = parseInt(dm[1], 10);
    month = parseInt(dm[2], 10);
    day = parseInt(dm[3], 10);
  } else {
    const a = parseInt(dm[1], 10);
    const b = parseInt(dm[2], 10);
    year = parseInt(dm[3], 10);
    if (year < 100) year += 2000;
    if (order === "dmy") {
      day = a;
      month = b;
    } else {
      month = a;
      day = b;
    }
  }
  const tm = time.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s?([AaPp])?/);
  if (!tm) return null;
  let hour = parseInt(tm[1], 10);
  const minute = parseInt(tm[2], 10);
  const second = tm[3] ? parseInt(tm[3], 10) : 0;
  const ampm = tm[4]?.toLowerCase();
  if (ampm === "p" && hour < 12) hour += 12;
  if (ampm === "a" && hour === 12) hour = 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) return null;
  const d = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
