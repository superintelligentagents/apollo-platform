// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { DocumentRecord, EmailRecord, SourceRecord } from "../src/types";
import { initialState, type Ctx } from "../src/ui/context";
import { renderTasks } from "../src/ui/screens/tasks";

const mail: EmailRecord = {
  id: "travel-mail", source: "email", sourceDetail: "eml", timestamp: "2026-09-01T00:00:00Z", searchText: "delta flight", messageId: "1",
  from: { name: "Delta", email: "trips@delta.com" }, to: [], cc: [], subject: "Flight itinerary", snippet: "JFK flight and baggage", bodyRef: false, bodyTruncated: false, labels: [], hasListUnsubscribe: false, attachments: [],
};
const resume: DocumentRecord = {
  id: "resume", source: "documents", sourceDetail: "document-pdf", timestamp: "2026-09-01T00:00:00Z", searchText: "resume skills experience", filename: "resume.pdf", title: "Resume", mimeType: "application/pdf", size: 100, text: "Experience and skills", pageCount: 1, bodyTruncated: false,
};

describe("task discovery UI", () => {
  it("links live apps, explains local matching, and starts grounded drafts", () => {
    const state = initialState();
    state.records = new Map<string, SourceRecord>([[mail.id, mail], [resume.id, resume]]);
    const startRecommendedTask = vi.fn();
    const ctx = { state, actions: { isIncluded: () => true, startRecommendedTask, startTask: vi.fn(), goto: vi.fn(), editTask: vi.fn(), deleteTask: vi.fn() }, rerender: vi.fn() } as unknown as Ctx;
    const root = renderTasks(ctx);
    expect(root.textContent).toContain("Write tasks with recommendations");
    expect(root.textContent).toContain("ANALYZED LOCALLY");
    expect(root.textContent).toContain("ALL 17 LIVE APP GUIDES");
    const dinoco = root.querySelector<HTMLAnchorElement>('[data-testid="open-app-dinoco"]')!;
    expect(dinoco.href).toBe("https://dinoco.mypcbench.app/book?_autologin=1");
    root.querySelector<HTMLButtonElement>('[data-testid="write-task-lockedin"]')!.click();
    expect(startRecommendedTask).toHaveBeenCalledWith(expect.objectContaining({ app: expect.objectContaining({ id: "lockedin" }), recordIds: ["resume"] }));
  });
});
