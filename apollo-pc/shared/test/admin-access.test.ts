import { describe, expect, it } from "vitest";
import { ADMIN_EMAILS, isAdminEmail } from "../src/admin-access";

describe("Apollo PC admin access", () => {
  it("uses the approved seven-address allowlist", () => {
    expect(ADMIN_EMAILS.size).toBe(7);
    expect(isAdminEmail(" Liangjian.Chen@TURING.com ")).toBe(true);
    expect(isAdminEmail("cu-e2e-reviewer@apollo.local")).toBe(false);
  });
});
