import { describe, expect, it } from "vitest";
import { appIdsForRecord, historyAppCounts, MYPCBENCH_APPS, recommendApps } from "../src/app-catalog";
import type { CalendarRecord, DocumentRecord, EmailRecord } from "../src/types";

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

const interview: CalendarRecord = {
  id: "calendar-interview",
  source: "calendar",
  sourceDetail: "ics",
  timestamp: "2026-09-04T14:00:00Z",
  searchText: "recruiter interview product manager job",
  uid: "interview-1",
  summary: "Product manager interview",
  description: "Recruiter interview",
  location: "Video call",
  dtstart: "2026-09-04T14:00:00Z",
  dtend: "2026-09-04T14:30:00Z",
  allDay: false,
  tzid: "America/New_York",
  organizer: { name: "Recruiter", email: "recruiter@example.com" },
  attendees: [],
  rrule: null,
  recurrenceId: null,
  status: "CONFIRMED",
};

const recruitingMail: EmailRecord = {
  ...travelMail,
  id: "mail-recruiter",
  searchText: "recruiter interview product manager career job",
  from: { name: "Recruiter", email: "recruiter@example.com" },
  subject: "Product manager interview",
  snippet: "Your interview is confirmed",
};

describe("MyPCBench app recommendations", () => {
  it("covers all 17 live apps with autologin links and unique ids", () => {
    expect(MYPCBENCH_APPS).toHaveLength(17);
    expect(new Set(MYPCBENCH_APPS.map((app) => app.id)).size).toBe(17);
    expect(MYPCBENCH_APPS.every((app) => app.url.startsWith("https://") && app.url.includes("_autologin=1"))).toBe(true);
    expect(MYPCBENCH_APPS.find((app) => app.id === "dinoco")?.url).toBe("https://dinoco.mypcbench.app/book?_autologin=1");
    expect(MYPCBENCH_APPS.every((app) => app.workflowAppIds.length >= 2)).toBe(true);
    expect(MYPCBENCH_APPS.every((app) => app.task.request.length >= 120 && app.task.steps.length >= 7)).toBe(true);
    expect(MYPCBENCH_APPS.every((app) => app.task.successCriteria.length >= 6 && app.task.requiredOutputs.length >= 4)).toBe(true);
  });

  it("maps real-world mail signals to the matching clone", () => {
    expect(appIdsForRecord(travelMail)).toContain("dinoco");
    const recommendations = recommendApps([travelMail]);
    expect(recommendations[0].app.id).toBe("dinoco");
    expect(recommendations[0].recordIds).toEqual(["mail-flight"]);
    expect(recommendations[0].reason).toContain("mail item");
  });

  it("uses an imported resume to recommend a prefilled LockedIn workflow", () => {
    const recommendations = recommendApps([resume]);
    const recommendation = recommendations.find((entry) => entry.app.id === "lockedin");
    expect(recommendations.map((entry) => entry.app.id)).toEqual(["lockedin"]);
    expect(recommendation?.recordIds).toEqual(["doc-resume"]);
    expect(recommendation?.app.task.request).toContain("attached resume");
    expect(recommendation?.app.task.request).toContain("current logged-in state");
    expect(recommendation?.app.task.request).toContain("LockedIn, HooliMail, HooliCalendar");
    expect(recommendation?.app.task.steps).toHaveLength(7);
  });

  it("keeps diverse mail, calendar, and document evidence in a recommendation", () => {
    const recommendation = recommendApps([recruitingMail, interview, resume], MYPCBENCH_APPS.length).find((entry) => entry.app.id === "lockedin");
    expect(recommendation?.recordIds).toEqual(["mail-recruiter", "calendar-interview", "doc-resume"]);
    expect(recommendation?.reason).toContain("mail item");
    expect(recommendation?.reason).toContain("calendar event");
    expect(recommendation?.reason).toContain("document");
  });

  it("partitions history by clone and real-world analogue", () => {
    const counts = historyAppCounts([travelMail, resume]);
    expect(counts.get("dinoco")).toBe(1);
    expect(counts.get("lockedin")).toBe(1);
  });
});
