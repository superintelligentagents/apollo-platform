import { describe, expect, it } from "vitest";
import { randomUuid } from "../src/ids";

describe("randomUuid", () => {
  it("creates a version 4 UUID when randomUUID is unavailable", () => {
    const random = {
      getRandomValues(array: Uint8Array): Uint8Array {
        array.fill(0xab);
        return array;
      },
    };

    expect(randomUuid(random)).toBe("abababab-abab-4bab-abab-abababababab");
  });
});
