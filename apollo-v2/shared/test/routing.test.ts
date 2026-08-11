import { describe, expect, it } from "vitest";
import { screenFromHash } from "../src/ui/app";

describe("refresh routing", () => {
  it("restores stable workflow hashes", () => {
    expect(screenFromHash("#/home")).toBe("home");
    expect(screenFromHash("#/submit")).toBe("submit");
    expect(screenFromHash("#/review-queue")).toBe("review-queue");
    expect(screenFromHash("#/trajectory-review")).toBe("trajectory-queue");
    expect(screenFromHash("#/trajectory-judge")).toBe("trajectory-edit");
    expect(screenFromHash("#/examples")).toBe("examples");
  });

  it("falls back for unknown hashes", () => {
    expect(screenFromHash("#/not-a-screen")).toBeNull();
  });
});
