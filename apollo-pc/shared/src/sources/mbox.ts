// Gmail Takeout .mbox (streaming) + individual .eml files.
//
// Mbox files are routinely 1–10 GB, so the file is read in 8 MB slices with a
// streaming TextDecoder (multibyte chars split across slice boundaries
// survive) and split on message boundaries incrementally. Attachment payloads
// are never decoded — any non-text part is reduced to {filename, mime, size}
// metadata at the transfer-encoded stage, which is the single biggest perf win.

import { BODY_KEEP_HEAD, BODY_KEEP_TAIL } from "../config";
import { recordId } from "../ids";
import type { EmailRecord } from "../types";
import {
  decodeEncodedWords,
  decodeTransfer,
  htmlToText,
  parseAddressList,
  parseContentType,
  parseHeaders,
  truncateBody,
} from "./mime";
import {
  breather,
  collectIssue,
  issueList,
  trackRange,
  type ParsedBody,
  type ParseOptions,
  type ParseProgress,
  type ParseResult,
  type SourceParser,
} from "./types";

const SLICE_BYTES = 1 * 1024 * 1024;
// A single "message" that grows past this without a boundary is a runaway
// (usually a giant attachment blob) — skip it and note the issue. Capping it
// keeps Chrome's renderer below its per-tab memory ceiling.
const MAX_MESSAGE_CHARS = 16 * 1024 * 1024;
const MAX_MESSAGE_MB = MAX_MESSAGE_CHARS / (1024 * 1024);
// Only a 5 KB body preview is retained. Decoding an entire multi-megabyte
// quoted-printable or base64 text part first can temporarily require hundreds
// of megabytes (QP uses a JS number array), enough for Chrome to kill the
// renderer. Sample a generous encoded head+tail before transfer decoding.
const MAX_TEXT_PART_RAW_CHARS = 128 * 1024;
const SNIPPET_CHARS = 140;
const BODY_FLUSH = 200;

export const mboxParser: SourceParser = {
  id: "gmail-mbox",
  source: "email",
  label: "Email (Gmail Takeout .mbox / .eml)",
  accept: [".mbox", ".eml"],

  async parse(files, opts, onProgress, onBody): Promise<ParseResult> {
    const issues = new Map<string, number>();
    const records: EmailRecord[] = [];
    const seen = new Set<string>();
    let bodies: ParsedBody[] = [];
    const stats = {
      recordsEmitted: 0,
      itemsSkipped: 0,
      bodiesTruncated: 0,
      attachmentsStripped: 0,
      dateRange: null as { min: string; max: string } | null,
    };
    const bytesTotal = files.reduce((a, f) => a + f.size, 0);
    let bytesDone = 0;

    const flushBodies = async (force = false) => {
      if (bodies.length >= BODY_FLUSH || (force && bodies.length)) {
        await onBody(bodies);
        bodies = [];
      }
    };

    const emit = async (rawMessage: string) => {
      // Most Takeout exports are ordered newest-first. Avoid walking MIME
      // trees and decoding bodies for messages that the selected date window
      // will discard anyway; on this 10 GB fixture that skips ~83k expensive
      // body parses while retaining the same records.
      if (opts.dateFloor) {
        const timestamp = peekMessageTimestamp(rawMessage);
        if (timestamp && timestamp < opts.dateFloor) {
          stats.itemsSkipped++;
          return;
        }
      }

      const parsedView = parseEmailMessage(rawMessage, opts, this.id);
      if (!parsedView) {
        stats.itemsSkipped++;
        return;
      }
      if (opts.dateFloor && parsedView.record.timestamp && parsedView.record.timestamp < opts.dateFloor) {
        stats.itemsSkipped++;
        return;
      }

      // V8 can represent slices as views over the original string. Without
      // detaching here, retaining a tiny subject/message-id/body snippet can
      // keep the complete raw message alive. On a multi-GB Takeout export that
      // makes heap usage grow with bytes scanned even though parsing streams.
      // JSON round-tripping the already-small parsed shape gives every kept
      // string an independent backing store and is supported in every target
      // browser (unlike engine-specific string-flattening tricks).
      const parsed = detachParsedMessage(parsedView);
      if (seen.has(parsed.record.id)) return; // duplicate across label mboxes
      seen.add(parsed.record.id);
      records.push(parsed.record);
      stats.recordsEmitted++;
      stats.attachmentsStripped += parsed.record.attachments.length;
      if (parsed.record.bodyTruncated) stats.bodiesTruncated++;
      stats.dateRange = trackRange(stats.dateRange, parsed.record.timestamp);
      bodies.push({ id: parsed.record.id, text: parsed.bodyText });
      await flushBodies();
    };

    for (const file of files) {
      if (file.name.toLowerCase().endsWith(".eml")) {
        const text = await file.text();
        await emit(text);
        bytesDone += file.size;
        continue;
      }

      const decoder = new TextDecoder("utf-8", { fatal: false });
      let carry = "";
      let offset = 0;
      let messageCount = 0;
      while (offset < file.size) {
        opts.signal?.throwIfAborted();
        const slice = file.slice(offset, offset + SLICE_BYTES);
        const buf = await slice.arrayBuffer();
        offset += SLICE_BYTES;
        carry += decoder.decode(buf, { stream: true });

        // Split out complete messages; keep the trailing partial in carry.
        let searchFrom = 0;
        for (;;) {
          const boundary = findMboxBoundary(carry, searchFrom);
          if (boundary === -1) break;
          const message = carry.slice(0, boundary);
          carry = carry.slice(boundary + 1); // skip the \n before "From "
          searchFrom = 0;
          if (message.trim()) {
            await emit(message);
            if (++messageCount % 200 === 0) await breather();
          }
        }

        if (carry.length > MAX_MESSAGE_CHARS) {
          collectIssue(issues, `Skipped an oversized message block (no boundary found within ${MAX_MESSAGE_MB} MB)`);
          stats.itemsSkipped++;
          // Keep the tail so the next real boundary can still be found.
          carry = carry.slice(-1024 * 1024);
        }

        const progress: ParseProgress = {
          phase: "parsing",
          bytesRead: Math.min(bytesDone + offset, bytesDone + file.size),
          bytesTotal,
          recordsEmitted: stats.recordsEmitted,
        };
        onProgress(progress);
      }
      carry += decoder.decode(); // flush the streaming decoder
      if (carry.trim()) await emit(carry);
      bytesDone += file.size;
    }

    await flushBodies(true);
    onProgress({ phase: "parsing", bytesRead: bytesTotal, bytesTotal, recordsEmitted: stats.recordsEmitted });
    return { records, stats, issues: issueList(issues) };
  },
};

// A boundary is "\nFrom " where the line looks like a real mbox From-line
// (`From <addr-ish> <asctime-ish>`) AND the following line looks like a
// header. Gmail escapes in-body "From " as ">From " (mboxrd), but the
// double-check keeps the splitter robust to other producers.
export function findMboxBoundary(text: string, from: number): number {
  // A "From " at position 0 is the first message's own From-line, not a
  // boundary — boundaries are only ever preceded by a newline.
  let idx = text.indexOf("\nFrom ", from);
  while (idx !== -1) {
    const lineEnd = text.indexOf("\n", idx + 1);
    if (lineEnd === -1) return -1; // partial line — wait for more data
    const line = text.slice(idx + 1, lineEnd);
    const nextLineEnd = text.indexOf("\n", lineEnd + 1);
    const nextLine = text.slice(lineEnd + 1, nextLineEnd === -1 ? lineEnd + 200 : nextLineEnd);
    if (looksLikeFromLine(line) && /^[A-Za-z-]+:/.test(nextLine)) return idx;
    idx = text.indexOf("\nFrom ", idx + 1);
  }
  return -1;
}

function looksLikeFromLine(line: string): boolean {
  // "From 1234567890@xxx Mon Jul 20 10:11:12 +0000 2026" (Gmail) or
  // "From someone@host Thu Jan  1 00:00:00 1970"
  return /^From \S+ .*\d{4}/.test(line) || /^From \S+@\S+/.test(line);
}

function peekMessageTimestamp(raw: string): string | null {
  const withoutFromLine = raw.startsWith("From ") ? raw.slice(raw.indexOf("\n") + 1) : raw;
  const headerEnd = withoutFromLine.search(/\r?\n\r?\n/);
  if (headerEnd === -1) return null;
  return parseDate(parseHeaders(withoutFromLine.slice(0, headerEnd)).get("date") || "");
}

// ---------------------------------------------------------------------------

type ParsedMessage = { record: EmailRecord; bodyText: string };

function detachParsedMessage(parsed: ParsedMessage): ParsedMessage {
  return JSON.parse(JSON.stringify(parsed)) as ParsedMessage;
}

export function parseEmailMessage(raw: string, opts: ParseOptions, sourceDetail: string): ParsedMessage | null {
  // Drop a leading mbox From-line if present.
  const withoutFromLine = raw.startsWith("From ") ? raw.slice(raw.indexOf("\n") + 1) : raw;
  const headerEnd = withoutFromLine.search(/\r?\n\r?\n/);
  if (headerEnd === -1) return null;
  const headers = parseHeaders(withoutFromLine.slice(0, headerEnd));
  const body = withoutFromLine.slice(headerEnd).replace(/^\r?\n\r?\n/, "");

  const messageId = headers.get("message-id")?.trim() || "";
  const dateRaw = headers.get("date") || "";
  const timestamp = parseDate(dateRaw);
  const from = parseAddressList(headers.get("from"))[0] ?? { name: "", email: "" };
  const subject = decodeEncodedWords(headers.get("subject") || "").trim();

  const nativeKey = messageId || `${dateRaw}|${from.email}|${subject}`;
  const id = recordId(sourceDetail, nativeKey);

  const attachments: EmailRecord["attachments"] = [];
  const bodyRaw = extractBody(headers, body, attachments, 0);
  // mboxrd unescaping: ">From " at line start was escaped by the producer.
  const unescaped = bodyRaw.replace(/^>From /gm, "From ");
  const { text: bodyText, truncated } = truncateBody(
    unescaped.trim(),
    opts.maxBodyChars,
    Math.min(BODY_KEEP_HEAD, opts.maxBodyChars),
    BODY_KEEP_TAIL
  );

  const to = parseAddressList(headers.get("to"));
  const cc = parseAddressList(headers.get("cc"));
  const labels = (headers.get("x-gmail-labels") || "")
    .split(",")
    .map((s) => decodeEncodedWords(s).trim())
    .filter(Boolean);

  const record: EmailRecord = {
    id,
    source: "email",
    sourceDetail,
    timestamp,
    searchText: [subject, from.name, from.email, ...to.map((a) => `${a.name} ${a.email}`), ...labels]
      .join(" ")
      .toLowerCase(),
    messageId,
    from,
    to,
    cc,
    subject,
    snippet: bodyText.slice(0, SNIPPET_CHARS).replace(/\s+/g, " ").trim(),
    bodyRef: true,
    bodyTruncated: truncated,
    labels,
    hasListUnsubscribe: headers.has("list-unsubscribe"),
    attachments,
  };
  return { record, bodyText };
}

function parseDate(raw: string): string | null {
  if (!raw) return null;
  const d = new Date(raw.replace(/\(.*\)$/, "").trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Recursive multipart walk, depth-capped. Prefers text/plain, falls back to
// text/html (converted). Non-text and attachment-disposed parts are recorded
// as metadata and their payloads skipped entirely.
function extractBody(
  headers: Map<string, string>,
  body: string,
  attachments: EmailRecord["attachments"],
  depth: number
): string {
  if (depth > 5) return "";
  const ct = parseContentType(headers.get("content-type"));
  const disposition = (headers.get("content-disposition") || "").toLowerCase();
  const encoding = headers.get("content-transfer-encoding");
  const charset = ct.params.charset || "utf-8";

  if (disposition.startsWith("attachment") || (!ct.type.startsWith("text/") && !ct.type.startsWith("multipart/"))) {
    attachments.push({
      filename: decodeEncodedWords(ct.params.name || filenameFromDisposition(headers.get("content-disposition")) || "attachment"),
      mime: ct.type,
      size: Math.round(body.length * ((encoding || "").toLowerCase() === "base64" ? 0.75 : 1)),
    });
    return "";
  }

  if (ct.type.startsWith("multipart/")) {
    const boundary = ct.params.boundary;
    if (!boundary) return "";
    const parts = splitMultipart(body, boundary);
    let plain = "";
    let html = "";
    for (const part of parts) {
      const partHeaderEnd = part.search(/\r?\n\r?\n/);
      if (partHeaderEnd === -1) continue;
      const partHeaders = parseHeaders(part.slice(0, partHeaderEnd));
      const partBody = part.slice(partHeaderEnd).replace(/^\r?\n\r?\n/, "");
      const partCt = parseContentType(partHeaders.get("content-type"));
      if (partCt.type.startsWith("multipart/")) {
        const nested = extractBody(partHeaders, partBody, attachments, depth + 1);
        if (nested && !plain) plain = nested;
        continue;
      }
      const text = extractBody(partHeaders, partBody, attachments, depth + 1);
      if (!text) continue;
      if (partCt.type === "text/plain" && !plain) plain = text;
      else if (partCt.type === "text/html" && !html) html = text;
      else if (!plain && partCt.type.startsWith("text/")) plain = text;
    }
    return plain || html;
  }

  const decoded = decodeTransferBounded(body, encoding, charset);
  if (ct.type === "text/html") return htmlToText(decoded);
  return decoded;
}

function decodeTransferBounded(body: string, encoding: string | undefined, charset: string): string {
  if (body.length <= MAX_TEXT_PART_RAW_CHARS) return decodeTransfer(body, encoding, charset);

  const half = Math.floor(MAX_TEXT_PART_RAW_CHARS / 2);
  const enc = (encoding || "").trim().toLowerCase();
  let head = body.slice(0, half);
  let tail = body.slice(-half);

  if (enc === "base64") {
    head = head.replace(/[^A-Za-z0-9+/=]/g, "");
    head = head.slice(0, head.length - (head.length % 4));
    tail = tail.replace(/[^A-Za-z0-9+/=]/g, "");
    // The sample ends at the original stream's end, so discarding the leading
    // remainder restores four-character base64 alignment for the tail.
    tail = tail.slice(tail.length % 4);
  }

  const headText = decodeTransfer(head, enc, charset);
  const tailText = decodeTransfer(tail, enc, charset);
  return `${headText}\n…[large text part sampled]…\n${tailText}`;
}

function splitMultipart(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const sections = body.split(marker);
  // First section is the preamble, last (after the closing "--") is epilogue.
  return sections.slice(1).filter((s) => !s.startsWith("--")).map((s) => s.replace(/^\r?\n/, ""));
}

function filenameFromDisposition(value: string | undefined): string {
  if (!value) return "";
  const m = value.match(/filename\*?=(?:"([^"]+)"|([^;\s]+))/i);
  return m ? (m[1] || m[2] || "").replace(/^UTF-8''/i, "") : "";
}
