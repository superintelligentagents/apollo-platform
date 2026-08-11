// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { initialState, type Ctx } from "../src/ui/context";
import { renderLogin } from "../src/ui/screens/login";

describe("login loading state", () => {
  it("keeps consent and identity visible while the workspace loads", () => {
    const state = initialState();
    state.identity = {
      kind: "internal",
      participantId: "",
      name: "Apollo PC Admin",
      email: "admin@example.com",
      consent: { version: "1", accepted_at: "2026-08-01T00:00:00Z" },
    };
    state.busy = "Loading your workspace…";
    const root = renderLogin({ state, actions: { login: vi.fn() } } as unknown as Ctx);

    const inputs = root.querySelectorAll<HTMLInputElement>("input");
    const consent = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const button = root.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(inputs[0]?.value).toBe("Apollo PC Admin");
    expect(inputs[1]?.value).toBe("admin@example.com");
    expect(consent.checked).toBe(true);
    expect(consent.disabled).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Loading workspace…");
  });
});
