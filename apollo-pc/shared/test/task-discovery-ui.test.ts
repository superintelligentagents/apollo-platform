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
    expect(root.textContent).toContain("Write long-horizon tasks from your history");
    expect(root.textContent).toContain("ANALYZED LOCALLY");
    expect(root.textContent).toContain("ALL 17 LIVE APP GUIDES");
    expect(root.textContent).toContain("SUGGESTED APP PATH");
    expect(root.textContent).toContain("LockedIn → HooliMail → HooliCalendar");
    const dinoco = root.querySelector<HTMLAnchorElement>('[data-testid="open-app-dinoco"]')!;
    expect(dinoco.href).toBe("https://dinoco.mypcbench.app/book?_autologin=1");
    root.querySelector<HTMLButtonElement>('[data-testid="write-task-lockedin"]')!.click();
    expect(startRecommendedTask).toHaveBeenCalledWith(expect.objectContaining({
      app: expect.objectContaining({ id: "lockedin", workflowAppIds: ["lockedin", "hoolimail", "hoolicalendar"], task: expect.objectContaining({ steps: expect.arrayContaining([expect.objectContaining({ title: "Verify and hand off" })]) }) }),
      recordIds: ["resume"],
    }));
  });

  it("paints before a large history recommendation pass finishes", async () => {
    const state = initialState();
    state.screen = "tasks";
    state.records = new Map(
      Array.from({ length: 2_001 }, (_, index) => {
        const record: EmailRecord = {
          ...mail,
          id: `mail-${index}`,
          messageId: `mail-${index}`,
          searchText: `delta flight ${index}`,
        };
        return [record.id, record] as const;
      })
    );
    const rerender = vi.fn();
    const ctx = { state, actions: { isIncluded: () => true, startRecommendedTask: vi.fn(), startTask: vi.fn(), goto: vi.fn(), editTask: vi.fn(), deleteTask: vi.fn() }, rerender } as unknown as Ctx;

    const started = performance.now();
    const loading = renderTasks(ctx);
    expect(performance.now() - started).toBeLessThan(100);
    expect(loading.textContent).toContain("Analyzing selected history");
    expect(loading.querySelector<HTMLButtonElement>('.app-library button[disabled]')).not.toBeNull();

    await vi.waitFor(() => expect(rerender).toHaveBeenCalled(), { timeout: 2_000 });
    const ready = renderTasks(ctx);
    expect(ready.textContent).not.toContain("Analyzing selected history");
    expect(ready.textContent).toContain("workflows with supporting context");
  });
});
