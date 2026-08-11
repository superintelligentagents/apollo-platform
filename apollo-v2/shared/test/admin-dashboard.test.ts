import { describe, expect, it } from "vitest";
import { filterAdminSubmissions } from "../src/ui/screens/progress";
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
