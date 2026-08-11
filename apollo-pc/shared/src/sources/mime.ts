// Shared MIME primitives: header unfolding, RFC 2047 encoded-words,
// quoted-printable and base64 transfer decoding, address-list parsing,
// HTML-to-text. Browsers natively decode utf-8, iso-8859-*, windows-125x,
// shift_jis, etc. via TextDecoder, so no charset tables are needed.

import type { Address } from "../types";

export function unfoldHeaders(raw: string): string {
  return raw.replace(/\r?\n[ \t]+/g, " ");
}

export function parseHeaders(raw: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of unfoldHeaders(raw).split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    // First occurrence wins for singletons; Received etc. don't matter here.
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset || "utf-8", { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

export function base64Bytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  try {
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array();
  }
}

export function decodeQuotedPrintable(text: string, charset = "utf-8"): string {
  // Soft line breaks first, then =XX byte sequences (decoded as one byte
  // stream so multibyte chars split across =XX pairs survive).
  const joined = text.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = ch.charCodeAt(0);
      if (code < 128) bytes.push(code);
      else {
        // Non-ASCII char already in the string (mixed content) — encode as UTF-8.
        for (const b of new TextEncoder().encode(ch)) bytes.push(b);
      }
    }
  }
  return decodeCharset(new Uint8Array(bytes), charset);
}

// RFC 2047: =?charset?B|Q?...?=
const ENCODED_WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

export function decodeEncodedWords(value: string): string {
  // Adjacent encoded words are joined without the whitespace between them.
  const merged = value.replace(/\?=\s+=\?/g, "?==?");
  return merged.replace(ENCODED_WORD, (_m, charset: string, enc: string, data: string) => {
    if (enc.toLowerCase() === "b") return decodeCharset(base64Bytes(data), charset);
    // Q-encoding: underscore is space
    return decodeQuotedPrintable(data.replace(/_/g, " "), charset);
  });
}

export type ContentType = { type: string; params: Record<string, string> };

export function parseContentType(value: string | undefined): ContentType {
  if (!value) return { type: "text/plain", params: {} };
  const [type, ...rest] = value.split(";");
  const params: Record<string, string> = {};
  for (const p of rest) {
    const idx = p.indexOf("=");
    if (idx <= 0) continue;
    const key = p.slice(0, idx).trim().toLowerCase();
    let v = p.slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[key] = v;
  }
  return { type: (type || "text/plain").trim().toLowerCase(), params };
}

// "Jane Doe <jane@x.com>, bob@y.com" -> Address[]
export function parseAddressList(value: string | undefined): Address[] {
  if (!value) return [];
  const decoded = decodeEncodedWords(value);
  const out: Address[] = [];
  // Split on commas outside quotes/angle brackets.
  let depth = 0;
  let quoted = false;
  let current = "";
  const push = () => {
    const addr = parseSingleAddress(current.trim());
    if (addr) out.push(addr);
    current = "";
  };
  for (const ch of decoded) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "<" || ch === "(")) depth++;
    else if (!quoted && (ch === ">" || ch === ")")) depth = Math.max(0, depth - 1);
    if (ch === "," && !quoted && depth === 0) push();
    else current += ch;
  }
  push();
  return out;
}

function parseSingleAddress(raw: string): Address | null {
  if (!raw) return null;
  const angle = raw.match(/^(.*?)<([^>]+)>/);
  if (angle) {
    const name = angle[1].trim().replace(/^"|"$/g, "").trim();
    const email = angle[2].trim().toLowerCase();
    return email.includes("@") ? { name, email } : name ? { name, email: "" } : null;
  }
  const bare = raw.replace(/^"|"$/g, "").trim();
  if (bare.includes("@") && !bare.includes(" ")) return { name: "", email: bare.toLowerCase() };
  return bare ? { name: bare, email: "" } : null;
}

export function decodeTransfer(body: string, encoding: string | undefined, charset: string): string {
  const enc = (encoding || "").trim().toLowerCase();
  if (enc === "base64") return decodeCharset(base64Bytes(body), charset);
  if (enc === "quoted-printable") return decodeQuotedPrintable(body, charset);
  if (charset && !/^(utf-?8|us-ascii)$/i.test(charset)) {
    // 7bit/8bit with a non-UTF8 charset: bytes came through the JS string
    // as code units; best-effort re-decode.
    const bytes = new Uint8Array([...body].map((c) => c.charCodeAt(0) & 0xff));
    return decodeCharset(bytes, charset);
  }
  return body;
}

// HTML → text via an inert DOMParser document (no script execution).
export function htmlToText(html: string): string {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return html.replace(/<[^>]+>/g, " ");
  }
  doc.querySelectorAll("style, script, head").forEach((n) => n.remove());
  const BLOCK = new Set(["P", "DIV", "BR", "LI", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "UL", "OL", "BLOCKQUOTE"]);
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const eln = node as Element;
    const isBlock = BLOCK.has(eln.tagName);
    if (isBlock) parts.push("\n");
    for (const child of node.childNodes) walk(child);
    if (isBlock) parts.push("\n");
  };
  walk(doc.body);
  return parts
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncateBody(text: string, maxChars: number, keepHead: number, keepTail: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, keepHead)}\n…[truncated]…\n${text.slice(-keepTail)}`,
    truncated: true,
  };
}
