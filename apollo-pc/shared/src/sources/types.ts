import type { SourceKind, SourceRecord } from "../types";

export type ParseProgress = {
  phase: "reading" | "parsing";
  bytesRead: number;
  bytesTotal: number;
  recordsEmitted: number;
};

// Advisory, deduped by message — a malformed message never aborts an import.
export type ParseIssue = { message: string; count: number };

export type ParseStats = {
  recordsEmitted: number;
  itemsSkipped: number;
  bodiesTruncated: number;
  attachmentsStripped: number;
  dateRange: { min: string; max: string } | null;
};

export type ParseOptions = {
  maxBodyChars: number;
  // Records older than this ISO date are dropped AT PARSE TIME — the true
  // consent boundary for volume, and the memory-control lever for multi-GB
  // mailboxes. Null = no floor.
  dateFloor: string | null;
  signal?: AbortSignal;
  // Parser-specific answers gathered on the import screen,
  // e.g. whatsapp dateOrder: "dmy" | "mdy".
  locale?: Record<string, string>;
};

// Bodies stream to IndexedDB via the sink instead of accumulating in memory;
// only the ~300-byte header-level record stays in the returned array.
export type ParsedBody = { id: string; text: string };

export type ParseResult = {
  records: SourceRecord[];
  stats: ParseStats;
  issues: ParseIssue[];
};

export interface SourceParser {
  id: string; // "gmail-mbox"
  source: SourceKind;
  label: string;
  accept: string[]; // [".mbox", ".eml"]
  parse(
    files: File[],
    opts: ParseOptions,
    onProgress: (p: ParseProgress) => void,
    onBody: (bodies: ParsedBody[]) => Promise<void>
  ): Promise<ParseResult>;
}

export function collectIssue(issues: Map<string, number>, message: string): void {
  issues.set(message, (issues.get(message) || 0) + 1);
}

export function issueList(issues: Map<string, number>): ParseIssue[] {
  return [...issues.entries()].map(([message, count]) => ({ message, count }));
}

export function trackRange(
  range: { min: string; max: string } | null,
  iso: string | null
): { min: string; max: string } | null {
  if (!iso) return range;
  if (!range) return { min: iso, max: iso };
  if (iso < range.min) range.min = iso;
  if (iso > range.max) range.max = iso;
  return range;
}

// Cooperative yield so multi-minute parses keep the progress bar painting.
export function breather(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
