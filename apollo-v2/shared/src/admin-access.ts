// This is a visibility/access allowlist for Apollo's internal admin tools.
// The current identity is self-entered, not OAuth-verified; the backend repeats
// this check to prevent accidental access but it is not a substitute for SSO.
export const ADMIN_EMAILS = new Set([
  "zhengyuan.ma@turing.com",
  "ljang@andrew.cmu.edu",
  "kyle.waters@turing.com",
  "liangjian.chen@turing.com",
  "jingyuk@andrew.cmu.edu",
  "rsalakhu@gmail.com",
  "vahid.h@turing.com",
]);

export function isAdminEmail(email: string | null | undefined): boolean {
  return ADMIN_EMAILS.has(String(email || "").trim().toLowerCase());
}
