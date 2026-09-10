import { describe, expect, it } from "vitest";
import { appIdsForRecord, historyAppCounts, MYPCBENCH_APPS, recommendApps } from "../src/app-catalog";
import type { DocumentRecord, EmailRecord } from "../src/types";

const travelMail: EmailRecord = {
  id: "mail-flight",
  source: "email",
  sourceDetail: "eml",
  timestamp: "2026-09-01T10:00:00Z",
  searchText: "delta flight itinerary jfk",
  messageId: "m1",
  from: { name: "Delta", email: "trips@delta.com" },
  to: [],
  cc: [],
  subject: "Your flight itinerary",
  snippet: "Departure from JFK with one checked bag",
  bodyRef: false,
  bodyTruncated: false,
  labels: ["Travel"],
  hasListUnsubscribe: false,
  attachments: [],
};

const resume: DocumentRecord = {
  id: "doc-resume",
  source: "documents",
  sourceDetail: "document-docx",
  timestamp: "2026-09-01T10:00:00Z",
  searchText: "resume product manager experience skills",
  filename: "resume.docx",
  title: "Resume",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  size: 1200,
  text: "Product Manager. Experience, education, and skills.",
  pageCount: null,
  bodyTruncated: false,
};

describe("MyPCBench app recommendations", () => {
  it("covers all 17 live apps with autologin links and unique ids", () => {
    expect(MYPCBENCH_APPS).toHaveLength(17);
    expect(new Set(MYPCBENCH_APPS.map((app) => app.id)).size).toBe(17);
    expect(MYPCBENCH_APPS.every((app) => app.url.startsWith("https://") && app.url.includes("_autologin=1"))).toBe(true);
    expect(MYPCBENCH_APPS.find((app) => app.id === "dinoco")?.url).toBe("https://dinoco.mypcbench.app/book?_autologin=1");
  });

  it("maps real-world mail signals to the matching clone", () => {
    expect(appIdsForRecord(travelMail)).toContain("dinoco");
    const recommendations = recommendApps([travelMail]);
    expect(recommendations[0].app.id).toBe("dinoco");
    expect(recommendations[0].recordIds).toEqual(["mail-flight"]);
    expect(recommendations[0].reason).toContain("mail item");
  });

  it("uses an imported resume to recommend a prefilled LockedIn workflow", () => {
    const recommendation = recommendApps([resume]).find((entry) => entry.app.id === "lockedin");
    expect(recommendation?.recordIds).toEqual(["doc-resume"]);
    expect(recommendation?.app.task.request).toContain("attached resume");
    expect(recommendation?.app.task.steps).toHaveLength(3);
  });

  it("partitions history by clone and real-world analogue", () => {
    const counts = historyAppCounts([travelMail, resume]);
    expect(counts.get("dinoco")).toBe(1);
    expect(counts.get("lockedin")).toBe(1);
  });
});
