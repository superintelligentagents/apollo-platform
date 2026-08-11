import type { Ctx } from "../context";
import { CONSENT_VERSION } from "../../config";
import { el } from "../components/helpers";

export function renderLogin(ctx: Ctx): HTMLElement {
  const last = ctx.state.lastIdentity;

  const root = el("section", { class: "screen login-screen" });

  const draw = () => {
    root.replaceChildren();
    root.append(
      el(
        "div",
        { class: "login-card card" },
        el("div", { class: "login-brand" },
          el("span", { class: "brand-mark" }, "◈"),
          el("h1", { class: "display" }, "Apollo v2"),
          el("p", { class: "login-sub" }, "Create long-horizon web requests: realistic browser work that can take an agent an hour, an afternoon, or several days.")
        ),
        el("p", { class: "login-eyebrow" }, "ANNOTATOR WORKSPACE"),
        internalForm(),
        el("p", { class: "privacy-note" }, "Nothing leaves this device until you submit a task.")
      )
    );
  };

  const internalForm = () => {
    const name = el("input", { class: "field-input", placeholder: "Your name", autocomplete: "off" });
    const email = el("input", { class: "field-input", placeholder: "you@example.com", type: "email", autocomplete: "off" });
    const consent = el("input", { type: "checkbox" }) as HTMLInputElement;
    if (last) {
      name.value = last.name;
      email.value = last.email;
    }
    const err = el("p", { class: "field-error" });
    return el(
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
        el("p", { class: "login-consent-kicker mono" }, "DATA CONTRIBUTION CONSENT"),
        el(
          "label",
          { class: "login-consent-check" },
          consent,
          el(
            "span",
            null,
            "I agree to let Apollo process my selected Chrome history and upload only the journeys I attach to a submitted task."
          )
        ),
        el(
          "p",
          { class: "login-consent-detail" },
          "Selected journeys include visit-level history such as URLs, titles, visit times, search terms, and navigation links. Those selected details upload with your submitted task for internal validation; unselected history stays on your device. Authored task content may be published or licensed, but browsing history will not be published, licensed, or sold. ",
          el("a", { href: "/privacy.html", target: "_blank", rel: "noreferrer" }, "Privacy policy")
        )
      ),
      err,
      el("button", { class: "btn primary", type: "submit" }, "Start")
    );
  };

  const field = (label: string, input: HTMLElement) =>
    el("label", { class: "field" }, el("span", { class: "field-label" }, label), input);

  draw();
  return root;
}
