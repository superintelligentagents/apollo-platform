// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { initialState, type Ctx } from "../src/ui/context";
import { renderEntities } from "../src/ui/screens/entities";

describe("replace everywhere UI", () => {
  it("adds a removal rule even when no entities were detected", () => {
    const addRule = vi.fn();
    const ctx = {
      state: initialState(),
      actions: { addRule, removeRule: vi.fn() },
    } as unknown as Ctx;
    const root = renderEntities(ctx);
    const find = root.querySelector<HTMLInputElement>("#replacement-find")!;
    const replacement = root.querySelector<HTMLInputElement>("#replacement-with")!;
    find.value = "Private Street";
    replacement.value = "";
    root.querySelector<HTMLFormElement>(".replacement-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(addRule).toHaveBeenCalledWith({ find: "Private Street", replace: "", note: "" });
  });
});
