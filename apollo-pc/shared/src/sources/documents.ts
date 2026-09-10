import { strFromU8, unzipSync } from "fflate";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { recordId } from "../ids";
import type { DocumentRecord } from "../types";
import { breather, collectIssue, issueList, trackRange, type ParseResult, type SourceParser } from "./types";

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

export const documentParser: SourceParser = {
  id: "local-documents",
  source: "documents",
  label: "Documents (PDF, Word, or text)",
  accept: [".pdf", ".docx", ".txt", ".md", ".csv", ".json", ".html", ".htm"],

  async parse(files, opts, onProgress, _onBody): Promise<ParseResult> {
    const records: DocumentRecord[] = [];
    const issues = new Map<string, number>();
    const stats = {
      recordsEmitted: 0,
      itemsSkipped: 0,
      bodiesTruncated: 0,
      attachmentsStripped: 0,
      dateRange: null as { min: string; max: string } | null,
    };
    const bytesTotal = files.reduce((sum, file) => sum + file.size, 0);
    let bytesRead = 0;

    for (const file of files) {
      opts.signal?.throwIfAborted();
      if (file.size > MAX_DOCUMENT_BYTES) {
        stats.itemsSkipped++;
        bytesRead += file.size;
        collectIssue(issues, "Document larger than 25 MB skipped");
        onProgress({ phase: "parsing", bytesRead, bytesTotal, recordsEmitted: stats.recordsEmitted });
        continue;
      }
      try {
        const extracted = await extractDocumentText(file);
        const cleaned = normalizeDocumentText(extracted.text);
        if (!cleaned) {
          stats.itemsSkipped++;
          collectIssue(issues, "Document with no extractable text skipped");
        } else {
          const maxDocumentChars = opts.maxDocumentChars ?? opts.maxBodyChars;
          const bodyTruncated = cleaned.length > maxDocumentChars;
          const text = bodyTruncated ? cleaned.slice(0, maxDocumentChars) : cleaned;
          const timestamp = file.lastModified > 0 ? new Date(file.lastModified).toISOString() : null;
          const filename = file.name.trim() || "document";
          const title = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || filename;
          const sourceDetail = `document-${extension(filename) || "text"}`;
          records.push({
            id: recordId(sourceDetail, `${filename.toLowerCase()}|${file.size}|${file.lastModified}`),
            source: "documents",
            sourceDetail,
            timestamp,
            searchText: `${filename} ${title} ${text.slice(0, 10_000)}`.toLowerCase(),
            filename,
            title,
            mimeType: file.type || mimeForExtension(extension(filename)),
            size: file.size,
            text,
            pageCount: extracted.pageCount,
            bodyTruncated,
          });
          stats.recordsEmitted++;
          if (bodyTruncated) stats.bodiesTruncated++;
          stats.dateRange = trackRange(stats.dateRange, timestamp);
        }
      } catch (error) {
        stats.itemsSkipped++;
        collectIssue(issues, documentError(error));
      }
      bytesRead += file.size;
      onProgress({ phase: "parsing", bytesRead, bytesTotal, recordsEmitted: stats.recordsEmitted });
      await breather();
    }
    return { records, stats, issues: issueList(issues) };
  },
};

export async function extractDocumentText(file: File): Promise<{ text: string; pageCount: number | null }> {
  const ext = extension(file.name);
  if (ext === "pdf" || file.type === "application/pdf") return extractPdf(file);
  if (ext === "docx" || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return { text: extractDocx(await file.arrayBuffer()), pageCount: null };
  }
  const raw = await file.text();
  if (ext === "html" || ext === "htm" || file.type === "text/html") {
    const doc = new DOMParser().parseFromString(raw, "text/html");
    doc.querySelectorAll("script,style,noscript").forEach((node) => node.remove());
    return { text: doc.body?.textContent ?? "", pageCount: null };
  }
  return { text: raw, pageCount: null };
}

export function extractDocx(buffer: ArrayBuffer): string {
  const archive = unzipSync(new Uint8Array(buffer));
  const main = archive["word/document.xml"];
  if (!main) throw new Error("Word document content is missing");
  const xml = new DOMParser().parseFromString(strFromU8(main), "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("Word document XML could not be read");
  const paragraphs = [...xml.getElementsByTagName("w:p")];
  return paragraphs.map((paragraph) => paragraph.textContent?.trim() ?? "").filter(Boolean).join("\n");
}

async function extractPdf(file: File): Promise<{ text: string; pageCount: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof Worker === "undefined") {
    const workerModule = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as typeof globalThis & { pdfjsWorker?: typeof workerModule }).pdfjsWorker = workerModule;
  } else {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
  const loading = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdf = await loading.promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
      await breather();
    }
  } finally {
    await pdf.destroy();
  }
  return { text: pages.join("\n\n"), pageCount: pages.length };
}

function normalizeDocumentText(value: string): string {
  return value.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

function extension(name: string): string {
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
}

function mimeForExtension(ext: string): string {
  if (ext === "pdf") return "application/pdf";
  if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === "json") return "application/json";
  if (ext === "html" || ext === "htm") return "text/html";
  if (ext === "csv") return "text/csv";
  return "text/plain";
}

function documentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/password/i.test(message)) return "Password-protected document skipped";
  if (/pdf/i.test(message)) return "PDF text could not be extracted";
  if (/word|zip|xml/i.test(message)) return "Word document text could not be extracted";
  return "Document text could not be extracted";
}
