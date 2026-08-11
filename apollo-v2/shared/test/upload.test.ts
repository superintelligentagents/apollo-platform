import { describe, expect, it } from "vitest";
import { shouldRetryUploadStatus, uploadRetryDelayMs } from "../src/upload";

describe("upload retry policy", () => {
  it("retries throttles, timeouts, and server failures but not validation errors", () => {
    expect(shouldRetryUploadStatus(408)).toBe(true);
    expect(shouldRetryUploadStatus(429)).toBe(true);
    expect(shouldRetryUploadStatus(503)).toBe(true);
    expect(shouldRetryUploadStatus(400)).toBe(false);
    expect(shouldRetryUploadStatus(403)).toBe(false);
  });

  it("uses bounded exponential delay with jitter", () => {
    expect(uploadRetryDelayMs(0, 0)).toBe(188);
    expect(uploadRetryDelayMs(1, 0.5)).toBe(500);
    expect(uploadRetryDelayMs(9, 1)).toBe(2500);
  });
});
