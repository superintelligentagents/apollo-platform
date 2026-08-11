// Access follows Apollo's current self-entered identity model. The API repeats
// this allowlist check, but verified SSO is still required for strong identity.
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
