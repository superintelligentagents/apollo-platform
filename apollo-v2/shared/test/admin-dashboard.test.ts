// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { filterAdminSubmissions, teamDistribution } from "../src/ui/screens/progress";
import type { AdminSubmission } from "../src/review-client";

function submission(overrides: Partial<AdminSubmission>): AdminSubmission {
  return {
    task_id: "task-1",
    participant_id: "alice",
    participant_name: "Alice",
    participant_email: "alice@example.com",
    mode: "compose",
    submitted_at: "2026-08-01T00:00:00.000Z",
    status: "pending",
    reviewer: "",
    reviewed_at: "",
    rejection_reason: "",
    trajectory_count: 2,
    visit_count: 8,
    changed: false,
    original: { title: "Book dinner", request: "Find a table", difficulty: "high", criteria: [], steps: [] },
    final: null,
    ...overrides,
  };
}

describe("admin submission filters", () => {
  const items = [
    submission({}),
    submission({
      task_id: "task-2",
      participant_id: "bob",
      participant_name: "Bob",
      participant_email: "bob@example.com",
      status: "approved",
      reviewer: "Reviewer One",
      original: { title: "Compare flights", request: "Find Seoul fares", difficulty: "high", criteria: [], steps: [] },
    }),
  ];

  it("filters by participant and status", () => {
    expect(filterAdminSubmissions(items, { query: "", participantId: "bob", status: "approved" })).toEqual([items[1]]);
    expect(filterAdminSubmissions(items, { query: "", participantId: "alice", status: "approved" })).toEqual([]);
  });

  it("searches user, authored content, task id, and reviewer case-insensitively", () => {
    expect(filterAdminSubmissions(items, { query: "SEOUL", participantId: "", status: "" })).toEqual([items[1]]);
    expect(filterAdminSubmissions(items, { query: "reviewer one", participantId: "", status: "" })).toEqual([items[1]]);
    expect(filterAdminSubmissions(items, { query: "alice@example", participantId: "", status: "" })).toEqual([items[0]]);
  });
});

describe("team spread panel", () => {
  it("charts places and subjects once the server returns metadata", () => {
    const items = [
      submission({
        original: {
          title: "A", request: "", difficulty: "high", criteria: [], steps: [],
          metadata: { region: "IN", subjects: ["Travel and Tourism > Air Travel"] },
        },
      }),
      submission({
        original: {
          title: "B", request: "", difficulty: "high", criteria: [], steps: [],
          metadata: { region: "GLOBAL", subjects: ["Health > Medicine"] },
        },
      }),
    ];

    const text = teamDistribution(items).textContent ?? "";
    expect(text).toContain("India");
    expect(text).toContain("No specific country");
    expect(text).toContain("Travel and Tourism");
    expect(text).toContain("50%");
  });

  it("prefers final gold over the original submission", () => {
    // A reviewer may correct the author's pick; final gold is what gets counted.
    const items = [
      submission({
        original: {
          title: "A", request: "", difficulty: "high", criteria: [], steps: [],
          metadata: { region: "IN", subjects: [] },
        },
        final: {
          title: "A", request: "", difficulty: "high", criteria: [], steps: [],
          metadata: { region: "BR", subjects: [] },
        },
      }),
    ];

    const text = teamDistribution(items).textContent ?? "";
    expect(text).toContain("Brazil");
    expect(text).not.toContain("India");
  });

  it("shows a true empty state when no metadata has been recorded", () => {
    const text = teamDistribution([submission({})]).textContent ?? "";
    expect(text).toContain("No region or subject data has been recorded yet.");
  });

  it("keeps a large team spread compact", () => {
    const items = ["US", "IN", "GB", "BR", "CA", "AU"].map((region, index) =>
      submission({
        task_id: `task-${index}`,
        original: {
          title: `Task ${index}`, request: "", difficulty: "high", criteria: [], steps: [],
          metadata: { region, subjects: [] },
        },
      })
    );
    const root = teamDistribution(items);
    expect(root.querySelectorAll(".share-row")).toHaveLength(5);
    expect(root.textContent).toContain("top 5 of 6");
    expect(root.textContent).not.toContain("United States");
  });
});
