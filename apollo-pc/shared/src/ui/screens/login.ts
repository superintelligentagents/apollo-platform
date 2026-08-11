import { CONSENT_VERSION } from "../../config";
import { el } from "../components/helpers";
import type { Ctx } from "../context";

export function renderLogin(ctx: Ctx): HTMLElement {
  const last = ctx.state.identity ?? ctx.state.lastIdentity;
  const loading = Boolean(ctx.state.busy && ctx.state.identity);
  const root = el("section", { class: "screen login-screen" });

  const name = el("input", { class: "field-input", placeholder: "Your name", autocomplete: "off" });
  const email = el("input", { class: "field-input", placeholder: "you@example.com", type: "email", autocomplete: "off" });
  const consent = el("input", { type: "checkbox" }) as HTMLInputElement;
  if (last) {
    name.value = last.name;
    email.value = last.email;
  }
  consent.checked = loading;
  consent.disabled = loading;
  name.disabled = loading;
  email.disabled = loading;
  const err = el("p", { class: "field-error" });

  const form = el(
    "form",
    {
      class: "login-form",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const n = name.value.trim();
        const em = email.value.trim();
        if (!n || !em.includes("@")) {
          err.textContent = "Enter your name and a valid email.";
          return;
        }
        if (!consent.checked) {
          err.textContent = "Accept the data contribution consent to continue.";
          consent.focus();
          return;
        }
        void ctx.actions.login({
          kind: "internal",
          participantId: "",
          name: n,
          email: em,
          consent: { version: CONSENT_VERSION, accepted_at: new Date().toISOString() },
        });
      },
    },
    field("Name", name),
    field("Email", email),
    el(
      "section",
      { class: "login-consent" },
      el(
        "label",
        { class: "login-consent-check" },
        consent,
        el("span", null, "I agree to import personal data and upload only what I select.")
      ),
      el(
        "details",
        { class: "login-consent-details" },
        el("summary", null, "How your data is handled"),
        el("p", null, "Files are parsed in this browser. Nothing uploads until you review and submit. Direct identifiers are masked or pseudonymized by default, the private alias map is never uploaded, and a final privacy scan blocks unresolved protected values before any network upload. Submitted records and tasks may be licensed as part of the benchmark dataset.")
      )
    ),
    err,
    el("button", { class: "btn primary", type: "submit", disabled: loading }, loading ? "Loading workspace…" : "Start")
  );

  root.append(
    el(
      "div",
      { class: "login-card card" },
      el(
        "div",
        { class: "login-brand" },
        el("span", { class: "brand-mark" }, "◈"),
        el("h1", { class: "display" }, "Apollo PC"),
        el(
          "p",
          { class: "login-sub" },
          "Import, review, and selectively upload mail and calendar data."
        )
      ),
      el("p", { class: "login-eyebrow" }, "PARTICIPANT WORKSPACE"),
      form
    )
  );
  return root;
}

function field(label: string, input: HTMLElement) {
  return el("label", { class: "field" }, el("span", { class: "field-label" }, label), input);
}
