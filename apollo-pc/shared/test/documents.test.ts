// @vitest-environment jsdom
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { documentParser, extractDocumentText, extractDocx } from "../src/sources/documents";
import type { DocumentRecord } from "../src/types";

describe("local document import", () => {
  it("extracts paragraphs from a Word document without uploading the original", () => {
    const zipped = zipSync({ "word/document.xml": strToU8('<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>Lawrence Resume</w:t></w:r></w:p><w:p><w:r><w:t>Product Manager</w:t></w:r></w:p></w:body></w:document>') });
    expect(extractDocx(zipped.buffer as ArrayBuffer)).toBe("Lawrence Resume\nProduct Manager");
  });

  it("imports and caps locally extracted text", async () => {
    const file = new File(["Resume\nExperience: Product Manager\nSkills: Research"], "resume.txt", { type: "text/plain", lastModified: Date.parse("2026-09-01T00:00:00Z") });
    const result = await documentParser.parse([file], { maxBodyChars: 5_000, maxDocumentChars: 24, dateFloor: null }, () => {}, async () => {});
    expect(result.records).toHaveLength(1);
    const record = result.records[0] as DocumentRecord;
    expect(record.source).toBe("documents");
    expect(record.filename).toBe("resume.txt");
    expect(record.text.length).toBe(24);
    expect(record.bodyTruncated).toBe(true);
    expect(result.stats.bodiesTruncated).toBe(1);
  });

  it("extracts text and a page count from a PDF", async () => {
    const file = new File([minimalPdf("Resume PDF")], "resume.pdf", { type: "application/pdf" });
    const extracted = await extractDocumentText(file);
    expect(extracted.text).toContain("Resume PDF");
    expect(extracted.pageCount).toBe(1);
  });
});

function minimalPdf(text: string): Uint8Array {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  objects.push(`5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
