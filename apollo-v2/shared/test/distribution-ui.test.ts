// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../src/ui/context";
import { initialState } from "../src/ui/context";
import { renderProgress } from "../src/ui/screens/progress";
import { STORAGE_KEYS, type UploadLogEntry } from "../src/platform";
import { REGION_GLOBAL } from "../src/taxonomy";

const SUBJECT = "Travel and Tourism > Air Travel";

function entry(over: Partial<UploadLogEntry> = {}): UploadLogEntry {
  return {
    task_id: "v2/a/internal/task-1",
    title: "A task",
    mode: "guided",
    level: "high",
    at: "2026-08-12T00:00:00.000Z",
    region: "IN",
    subjects: [SUBJECT],
    ...over,
  };
}

// renderProgress loads the log asynchronously, so every assertion has to wait
// for that promise to settle before reading the DOM.
async function render(log: UploadLogEntry[]): Promise<HTMLElement> {
  const state = initialState();
  state.identity = {
    kind: "internal",
    participantId: "",
    name: "A",
    email: "a@e.com",
    consent: { version: "1", accepted_at: "2026-08-12T00:00:00.000Z" },
  };
  state.reviewKey = null; // keep the network-backed team panel out of this test
  const storage = {
    get: vi.fn(async (key: string) =>
      key === STORAGE_KEYS.uploadLog("a@e.com") ? JSON.stringify(log) : null
    ),
    set: vi.fn(async () => {}),
  };
  const ctx = {
    state,
    adapter: { platform: "web", storage },
    actions: { goto: vi.fn() },
  } as unknown as Ctx;

  const root = renderProgress(ctx);
  await vi.waitFor(() => {
    if (!root.querySelector(".distribution-panel") && !root.querySelector(".progress-body p")) {
      throw new Error("not settled");
    }
  });
  return root;
}

describe("your spread panel", () => {
  it("charts places and subjects from the author's own log", async () => {
    const root = await render([
      entry(),
      entry({ region: "IN" }),
      entry({ region: REGION_GLOBAL }),
      entry({ region: "BR" }),
    ]);
    const panel = root.querySelector(".distribution-panel")!;

    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain("India");
    expect(panel.textContent).toContain("Brazil");
    expect(panel.textContent).toContain("No specific country");
    expect(panel.textContent).toContain("Travel and Tourism");
    // Shares, not raw counts — the guidance is written in percentages.
    expect(panel.textContent).toContain("50% · 2");
  });

  it("shows the concentration nudge once there are enough tasks", async () => {
    const root = await render(Array.from({ length: 10 }, () => entry({ region: "IN" })));
    const advice = root.querySelector(".distribution-advice");

    expect(advice).not.toBeNull();
    expect(advice!.textContent).toContain("India");
    expect(advice!.textContent).toContain("about a third");
  });

  it("says nothing when the spread is healthy", async () => {
    const root = await render([
      ...Array.from({ length: 3 }, () => entry({ region: "IN" })),
      ...Array.from({ length: 3 }, () => entry({ region: "BR", subjects: ["Health > Medicine"] })),
      ...Array.from({ length: 4 }, () => entry({ region: REGION_GLOBAL, subjects: ["Finance > Insurance"] })),
    ]);
    expect(root.querySelector(".distribution-advice")).toBeNull();
  });

  it("explains an empty chart rather than showing zero bars", async () => {
    // Tasks submitted before the fields existed carry no region or subjects.
    const root = await render([entry({ region: undefined, subjects: undefined })]);
    const panel = root.querySelector(".distribution-panel")!;

    expect(panel.querySelectorAll(".share-row")).toHaveLength(0);
    expect(panel.textContent).toContain("before these fields existed");
  });

  it("does not count reviews of other people's tasks as your own spread", async () => {
    const root = await render([
      entry({ region: "IN" }),
      entry({ mode: "review", region: "US", subjects: ["Health > Medicine"] }),
    ]);
    const panel = root.querySelector(".distribution-panel")!;

    expect(panel.textContent).toContain("India");
    expect(panel.textContent).not.toContain("United States");
  });

  it("tags recent rows with their region", async () => {
    const root = await render([entry({ region: "BR", title: "Compare fibre plans" })]);
    const recent = root.querySelector(".recent")!;
    expect(recent.textContent).toContain("Brazil");
  });
});
