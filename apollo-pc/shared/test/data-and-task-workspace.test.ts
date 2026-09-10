// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { CalendarRecord, DocumentRecord, EmailRecord, SourceRecord } from "../src/types";
import { initialState, type Ctx } from "../src/ui/context";
import { renderItems } from "../src/ui/screens/items";
import { renderTaskEdit } from "../src/ui/screens/task-edit";

function baseCtx(): Ctx {
  const state = initialState();
  return {
    state,
    rerender: vi.fn(),
    autosave: vi.fn(),
    store: { getBody: vi.fn() },
    actions: {
      importFiles: vi.fn(),
      isIncluded: () => true,
      defaultIncluded: () => true,
      decisionFor: () => ({ included: true, edits: {}, bodyEdit: null, maskOverrides: {} }),
      bulkInclude: vi.fn(),
      bulkIncludeSources: vi.fn(),
      toggleInclude: vi.fn(),
      toggleTaskRecord: vi.fn(),
      updateEntity: vi.fn(),
      openItem: vi.fn(),
      goto: vi.fn(),
      saveTaskDraft: vi.fn(),
    },
  } as unknown as Ctx;
}

describe("consolidated data workspace", () => {
  it("imports all supported sources and selects upload records in one screen", () => {
    const ctx = baseCtx();
    const root = renderItems(ctx);
    expect(root.textContent).toContain("Upload & import data");
    expect(root.textContent).toContain("Import locally, then choose what uploads");
    expect(root.querySelectorAll('[data-testid^="data-file-input-"]')).toHaveLength(3);

    const input = root.querySelector<HTMLInputElement>('[data-testid="data-file-input-email"]')!;
    const file = new File(["mail fixture"], "mail.eml", { type: "message/rfc822" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(ctx.actions.importFiles).toHaveBeenCalledWith("email", [file]);
  });
});

describe("task writing data and app guides", () => {
  it("uses an app as the task guideline and filters inspiration to matching records", () => {
    const ctx = baseCtx();
    const flight: EmailRecord = {
      id: "flight", source: "email", sourceDetail: "eml", timestamp: "2026-09-01T00:00:00Z", searchText: "delta flight", messageId: "flight",
      from: { name: "Delta", email: "trips@delta.com" }, to: [], cc: [], subject: "Flight itinerary", snippet: "JFK", bodyRef: false, bodyTruncated: false, labels: [], hasListUnsubscribe: false, attachments: [],
    };
    const resume: DocumentRecord = {
      id: "resume", source: "documents", sourceDetail: "document-pdf", timestamp: "2026-09-01T00:00:00Z", searchText: "resume experience skills", filename: "resume.pdf", title: "Resume", mimeType: "application/pdf", size: 100, text: "Experience and skills", pageCount: 1, bodyTruncated: false,
    };
    ctx.state.records = new Map<string, SourceRecord>([[flight.id, flight], [resume.id, resume]]);
    ctx.state.pickerApp = "lockedin";
    ctx.state.taskDraft = draft("mypcbench-lockedin");

    const root = renderTaskEdit(ctx);
    expect(root.querySelector('[data-save-status]')?.textContent).toBe("Saved locally");
    expect(root.textContent).toContain("MyPCBench app guide & data filter");
    expect(root.textContent).toContain("LOCKEDIN · LIKE LINKEDIN");
    expect(root.querySelector<HTMLAnchorElement>('.task-app-guide a')?.href).toBe("https://lockedin.mypcbench.app/profile?_autologin=1");
    expect([...root.querySelectorAll(".picker-row")].map((row) => row.textContent)).toEqual([expect.stringContaining("Resume")]);

    const guideFilter = root.querySelector<HTMLSelectElement>('[data-testid="task-app-guide"]')!;
    guideFilter.value = "";
    guideFilter.dispatchEvent(new Event("change", { bubbles: true }));
    const unfiltered = renderTaskEdit(ctx);
    expect(unfiltered.querySelectorAll(".picker-row")).toHaveLength(2);
  });

  it("uploads a document inside the task editor and attaches it to the draft", async () => {
    const ctx = baseCtx();
    ctx.state.taskDraft = draft("");
    ctx.actions.importFiles = vi.fn(async (_kind, files) => {
      const file = files[0];
      const record: DocumentRecord = {
        id: "new-resume", source: "documents", sourceDetail: "document-text", timestamp: null, searchText: "resume product manager", filename: file.name, title: "Resume", mimeType: file.type, size: file.size, text: "Product manager experience", pageCount: null, bodyTruncated: false,
      };
      ctx.state.records.set(record.id, record);
    });

    const root = renderTaskEdit(ctx);
    const input = root.querySelector<HTMLInputElement>('[data-testid="task-document-upload"]')!;
    const file = new File(["Product manager experience"], "resume.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.actions.importFiles).toHaveBeenCalledWith("documents", [file]);
    expect(ctx.state.taskDraft?.referencedRecordIds).toContain("new-resume");
    expect(ctx.state.pickerSource).toBe("documents");
  });

  it("keeps collapsed calendar rows small even when event descriptions are large", () => {
    const ctx = baseCtx();
    const description = "Calendar details ".repeat(100);
    const event: CalendarRecord = {
      id: "large-event",
      source: "calendar",
      sourceDetail: "ics",
      timestamp: "2026-09-01T00:00:00Z",
      searchText: "planning session calendar details",
      uid: "large-event",
      summary: "Planning session",
      description,
      location: "",
      dtstart: "2026-09-01T00:00:00Z",
      dtend: "2026-09-01T01:00:00Z",
      allDay: false,
      tzid: "UTC",
      organizer: null,
      attendees: [],
      rrule: null,
      recurrenceId: null,
      status: null,
    };
    ctx.state.records.set(event.id, event);
    ctx.state.taskDraft = draft("");

    const root = renderTaskEdit(ctx);
    const preview = root.querySelector<HTMLElement>(".picker-preview")!;
    expect(preview.textContent).toBe(description.slice(0, 180));
    expect(root.textContent).not.toContain(description);
  });
});

function draft(templateId: string): NonNullable<Ctx["state"]["taskDraft"]> {
  return {
    region: "GLOBAL",
    subjects: ["Jobs and Employment"],
    taskId: "task-fixture",
    templateId,
    category: "cross_source_reconciliation",
    title: "Update my profile",
    request: "Update my professional profile from the attached resume.",
    difficulty: "high",
    steps: [{ order: 0, title: "Compare", description: "Compare the resume and profile carefully." }],
    successCriteria: ["Every change is supported."],
    requiredOutputs: ["Change summary"],
    referencedRecordIds: [],
    expectedAnswer: "",
    notes: "",
  };
}
