// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { initialState, type Ctx } from "../src/ui/context";
import { renderSubmitHub } from "../src/ui/screens/home";

describe("submit hub accessibility", () => {
  it("uses one button per task mode with no nested interactive controls", () => {
    const startMode = vi.fn();
    const ctx = {
      state: initialState(),
      actions: { startMode, goto: vi.fn() },
    } as unknown as Ctx;
    const root = renderSubmitHub(ctx);
    const modeRows = [...root.querySelectorAll<HTMLButtonElement>("button.mode-row")];
    expect(modeRows).toHaveLength(2);
    expect(root.querySelectorAll("button.mode-row button")).toHaveLength(0);
    modeRows[0].click();
    expect(startMode).toHaveBeenCalledWith("guided");
  });
});
