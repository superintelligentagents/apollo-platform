import { describe, expect, it } from "vitest";
import { screenFromHash } from "../src/ui/app";

describe("refresh routing", () => {
  it("restores public workflow hashes", () => {
    expect(screenFromHash("#/home")).toBe("home");
    expect(screenFromHash("#/tasks")).toBe("tasks");
    expect(screenFromHash("#/upload/calendar")).toBe("upload-calendar");
    expect(screenFromHash("#/review")).toBe("review");
    expect(screenFromHash("#/review-task")).toBe("task-review-queue");
    expect(screenFromHash("#/grade")).toBe("trajectory-queue");
  });

  it("falls back for unknown hashes", () => {
    expect(screenFromHash("#/not-a-screen")).toBeNull();
  });
});
