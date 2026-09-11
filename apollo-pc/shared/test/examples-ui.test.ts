// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { DocumentRecord, SourceRecord } from "../src/types";
import { initialState, type Ctx } from "../src/ui/context";
import { renderExamples } from "../src/ui/screens/examples";

const resume: DocumentRecord = {
  id: "resume",
  source: "documents",
  sourceDetail: "document-pdf",
  timestamp: "2026-09-01T00:00:00Z",
  searchText: "resume product manager experience education skills career",
  filename: "resume.pdf",
  title: "Resume",
  mimeType: "application/pdf",
  size: 100,
  text: "Product manager experience, education, projects, and skills",
  pageCount: 1,
  bodyTruncated: false,
};

function context(records: SourceRecord[] = []): { ctx: Ctx; goto: ReturnType<typeof vi.fn>; startRecommendedTask: ReturnType<typeof vi.fn> } {
  const state = initialState();
  state.records = new Map(records.map((record) => [record.id, record]));
  const goto = vi.fn();
  const startRecommendedTask = vi.fn();
  const ctx = {
    state,
    actions: { isIncluded: () => true, goto, startRecommendedTask },
    rerender: vi.fn(),
  } as unknown as Ctx;
  return { ctx, goto, startRecommendedTask };
}

describe("reference task resume workflow", () => {
  it("offers document upload before a resume is available", () => {
    const { ctx, goto } = context();
    const root = renderExamples(ctx);

    expect(root.textContent).toContain("Upload a resume and build a connected task");
    expect(root.textContent).toContain("RESUME → LOCKEDIN → HOOLIMAIL → HOOLICALENDAR");
    root.querySelector<HTMLButtonElement>('[data-testid="resume-example-start"]')!.click();

    expect(ctx.state.filters.source).toBe("documents");
    expect(ctx.state.filters.status).toBe("all");
    expect(goto).toHaveBeenCalledWith("items");
  });

  it("starts the grounded LockedIn workflow when a resume is available", () => {
    const { ctx, startRecommendedTask } = context([resume]);
    const root = renderExamples(ctx);
    const button = root.querySelector<HTMLButtonElement>('[data-testid="resume-example-start"]')!;

    expect(button.textContent).toBe("Build from my resume →");
    button.click();

    expect(startRecommendedTask).toHaveBeenCalledWith(expect.objectContaining({
      app: expect.objectContaining({ id: "lockedin" }),
      recordIds: ["resume"],
    }));
  });
});
