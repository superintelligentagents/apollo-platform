import { describe, expect, it } from "vitest";
import { ADMIN_EMAILS, isAdminEmail } from "../src/admin-access";

describe("admin email access", () => {
  it("contains the approved seven-address allowlist", () => {
    expect([...ADMIN_EMAILS]).toEqual([
      "zhengyuan.ma@turing.com",
      "ljang@andrew.cmu.edu",
      "kyle.waters@turing.com",
      "liangjian.chen@turing.com",
      "jingyuk@andrew.cmu.edu",
      "rsalakhu@gmail.com",
      "vahid.h@turing.com",
    ]);
  });

  it("normalizes case and whitespace and rejects everyone else", () => {
    expect(isAdminEmail(" Kyle.Waters@TURING.com ")).toBe(true);
    expect(isAdminEmail("someone@example.com")).toBe(false);
    expect(isAdminEmail(null)).toBe(false);
  });
});
