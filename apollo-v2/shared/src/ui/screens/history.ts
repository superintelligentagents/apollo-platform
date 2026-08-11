import type { Ctx } from "../context";
import type { ProfileOption } from "../../types";
import { el } from "../components/helpers";

const HISTORY_PATHS: Array<{ os: string; path: string }> = [
  { os: "macOS", path: "~/Library/Application Support/Google/Chrome/Default/History" },
  { os: "Windows", path: "%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\History" },
  { os: "Linux", path: "~/.config/google-chrome/Default/History" },
];

export function renderHistory(ctx: Ctx): HTMLElement {
  const { state, adapter } = ctx;
  const root = el("section", { class: "screen history-screen" });

  // Desktop: detection needs no input from the user — start it on arrival.
  if (adapter.platform === "tauri" && state.profiles === null && !state.busy) {
    void ctx.actions.detectProfiles();
  }

  root.append(
    el(
      "header",
      { class: "screen-head" },
      el("h2", { class: "display" }, "Load your history"),
      el("p", { class: "screen-sub" }, "Apollo groups related Chrome visits into journeys on this device. Use them to remember substantial web projects; you choose exactly which journeys support the request.")
    )
  );

  // Loader on the left, orientation on the right — the bare column read as
  // "something's missing" at desktop widths.
  const howCard = el(
    "div",
    { class: "card how-card" },
    el("h3", null, "How this works"),
    el(
      "ol",
      null,
      el("li", null, "Load recent Chrome history locally—nothing is uploaded at this stage."),
      el("li", null, "Choose visits from one hour-long, afternoon-long, or multi-day web project."),
      el("li", null, "Write the request, inspect the selected journeys, and submit only when the task is complete.")
    ),
    el("p", { class: "privacy-line" }, "Chrome keeps ~90 days of history, so recent projects work best.")
  );
  root.append(
    el(
      "div",
      { class: "history-layout" },
      adapter.platform === "tauri" ? renderTauriLoader(ctx) : renderWebLoader(ctx),
      el("aside", null, howCard)
    )
  );

  if (state.historyLoaded) {
    const hasJourneys = state.journeys.length > 0;
    root.append(
      el(
        "div",
        { class: "history-ready card" },
        hasJourneys
          ? el("span", { class: "badge ok" }, `${state.journeys.length} journeys ready`)
          : el("span", { class: "badge" }, "No new journeys — ones you already used are hidden"),
        hasJourneys
          ? el("button", { class: "btn primary", type: "button", onclick: () => ctx.actions.goto(state.afterHistory ?? "submit") }, "Continue")
          : el("button", { class: "btn primary", type: "button", onclick: () => ctx.actions.startMode("guided") }, "Write a task instead")
      )
    );
  }

  // Never trap the user here — parse failures and empty profiles need an exit.
  root.append(
    el(
      "div",
      { class: "screen-foot" },
      el("button", { class: "btn ghost", type: "button", disabled: !!state.busy, onclick: () => ctx.actions.goto("submit") }, "Back")
    )
  );

  return root;
}

function renderTauriLoader(ctx: Ctx): HTMLElement {
  const { state } = ctx;
  const card = el("div", { class: "card loader-card" });

  if (!state.profiles) {
    card.append(el("p", null, "Looking for your Chrome profiles… (quit Chrome first)"));
    return card;
  }

  if (!state.profiles.length) {
    card.append(
      el("p", { class: "field-error" }, "No Chrome profiles with journeys found. Make sure Chrome has run on this machine, then try again."),
      el("button", { class: "btn ghost", type: "button", onclick: () => void ctx.actions.detectProfiles() }, "Try again")
    );
    return card;
  }

  const select = el("select", { class: "field-input" });
  state.profiles.forEach((p) => {
    select.append(
      el("option", { value: p.path, selected: state.selectedProfilePath === p.path }, profileLabel(p))
    );
  });
  if (!state.selectedProfilePath) {
    const preferred = state.profiles.find((p) => p.is_default) ?? state.profiles[0];
    select.value = preferred.path;
  }

  card.append(
    el("label", { class: "field" }, el("span", { class: "field-label" }, "Chrome profile"), select),
    el(
      "button",
      {
        class: "btn primary",
        type: "button",
        disabled: !!state.busy,
        onclick: () => {
          const profile = state.profiles?.find((p) => p.path === select.value);
          if (profile) void ctx.actions.loadHistory(profile);
        },
      },
      state.busy ? state.busy : state.historyLoaded ? "Reload history" : "Load history"
    )
  );
  return card;
}

function profileLabel(p: ProfileOption): string {
  const email = p.emails.length ? p.emails.join(", ") : "no email detected";
  return `${p.browser} · ${p.profile}${p.is_default ? " · Default" : ""} · ${email}`;
}

function renderWebLoader(ctx: Ctx): HTMLElement {
  const { state, adapter } = ctx;
  const card = el("div", { class: "card loader-card" });

  const handleFile = (file: File | undefined | null) => {
    if (file) void ctx.actions.loadHistory(file);
  };

  // ---- Primary path: the helper extension reads Chrome's LIVE history in one
  // click — no file to find, no quitting Chrome (it uses the history API). ----
  const fileFallback = el("details", { class: "file-fallback" });
  if (adapter.detectExtension) {
    const extBlock = el("div", { class: "ext-block" }, el("p", { class: "muted" }, "Checking for the Chrome history helper…"));
    card.append(extBlock);
    let checking = false;
    let lastCheckedAt = 0;

    const drawExtension = (installed: boolean) => {
      extBlock.replaceChildren();
      if (installed) {
        extBlock.append(
          el(
            "div",
            { class: "ext-ready" },
            el("span", { class: "badge ok" }, "✓ Chrome history helper connected"),
            el(
              "button",
              {
                class: "btn primary xl",
                type: "button",
                disabled: !!state.busy,
                onclick: () => void ctx.actions.loadHistory("chrome-extension"),
              },
              state.busy ? state.busy : "Import my Chrome history"
            ),
            el("p", { class: "muted small" }, "Reads your live history locally. Selected journeys upload only after sign-in consent and task submission.")
          )
        );
      } else {
        const extensionAddress = "chrome://extensions";
        const copyAddress = el(
          "button",
          {
            class: "btn ghost tiny copy-address",
            type: "button",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(extensionAddress);
                copyAddress.textContent = "Copied";
                setTimeout(() => {
                  if (copyAddress.isConnected) copyAddress.textContent = "Copy address";
                }, 1600);
              } catch {
                copyAddress.textContent = "Copy manually";
              }
            },
          },
          "Copy address"
        );
        extBlock.append(
          el(
            "div",
            { class: "ext-install" },
            el("p", { class: "ext-install-title" }, "One-time setup: the history helper"),
            el("p", { class: "muted" }, "Set up once (~30 seconds). After that, importing your history is one click — no file to find, no quitting Chrome."),
            el("a", { class: "btn primary xl", href: "/apollo-history-helper.zip", download: "apollo-history-helper.zip" }, "1. Download the helper"),
            el(
              "ol",
              { class: "ext-ol" },
              el("li", null, "Unzip the download."),
              el(
                "li",
                null,
                "Open a new Chrome tab, enter ",
                el("span", { class: "extension-address" }, el("code", { class: "mono" }, extensionAddress), copyAddress),
                " in the address bar, and turn on Developer mode (top-right)."
              ),
              el("li", null, "Click “Load unpacked” and choose the unzipped folder."),
              el("li", null, "Return to this tab — Apollo checks again automatically.")
            ),
            el("button", { class: "btn ghost", type: "button", onclick: () => void checkExtension(true) }, "Check again")
          )
        );
      }
    };

    const checkExtension = async (showChecking = false) => {
      if (checking) return;
      checking = true;
      lastCheckedAt = Date.now();
      if (showChecking) {
        extBlock.replaceChildren(el("p", { class: "muted" }, "Checking for the Chrome history helper…"));
      }
      const installed = await adapter.detectExtension!().catch(() => false);
      checking = false;
      if (extBlock.isConnected) drawExtension(installed);
    };

    // Loading an unpacked extension happens in chrome://extensions, often in
    // another tab. Re-ping whenever this page becomes active again so the
    // helper page itself updates without navigating home or manually reloading.
    const removeReturnListeners = () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("pageshow", onReturn);
    };
    const onReturn = () => {
      if (!extBlock.isConnected) {
        removeReturnListeners();
        return;
      }
      if (document.visibilityState !== "visible" || Date.now() - lastCheckedAt < 300) return;
      void checkExtension();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("pageshow", onReturn);
    void checkExtension();
  }
  card.append(fileFallback);

  const input = el("input", {
    type: "file",
    id: "history-file",
    class: "visually-hidden",
    onchange: (e: Event) => handleFile((e.target as HTMLInputElement).files?.[0]),
  });

  // ---- Everything below is the file fallback, tucked behind a disclosure so
  // the extension button is the obvious path. Only this route needs the
  // "quit Chrome" dance; the extension does not. ----
  const fbSummary = adapter.detectExtension
    ? "No extension? Load a history file instead"
    : "Load your Chrome history file";
  fileFallback.append(el("summary", { class: "file-fallback-summary" }, fbSummary));

  // File System Access remembered handle (one click after the first pick).
  if (adapter.hasSavedHistoryHandle && adapter.readSavedHistoryFile) {
    const savedBlock = el("div", { class: "saved-block" });
    fileFallback.append(savedBlock);
    void adapter.hasSavedHistoryHandle().then((has) => {
      if (!has) return;
      savedBlock.append(
        el("button", {
          class: "btn ghost",
          type: "button",
          onclick: async () => {
            const file = await adapter.readSavedHistoryFile!();
            if (file) handleFile(file);
          },
        }, "Re-read my saved history file")
      );
    });
  }

  const drop = el(
    "div",
    {
      class: "dropzone",
      ondragover: (e: Event) => {
        e.preventDefault();
        drop.classList.add("over");
      },
      ondragleave: () => drop.classList.remove("over"),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        drop.classList.remove("over");
        handleFile(e.dataTransfer?.files?.[0]);
      },
    },
    el("span", { class: "dropzone-mark" }, "⇣"),
    el("p", null, state.busy ? state.busy : "Drop your Chrome “History” file here"),
    adapter.pickHistoryFile
      ? el("button", {
          class: "btn ghost",
          type: "button",
          onclick: async () => {
            const file = await adapter.pickHistoryFile!();
            if (file) handleFile(file);
          },
        }, "Choose the file")
      : el("label", { class: "btn ghost", for: "history-file" }, "…or choose the file"),
    input
  );
  fileFallback.append(drop);

  const paths = el("details", { class: "paths" });
  paths.append(el("summary", null, "Where is my History file? (quit Chrome first)"));
  for (const { os, path } of HISTORY_PATHS) {
    paths.append(
      el(
        "div",
        { class: "path-row" },
        el("span", { class: "path-os" }, os),
        el("code", { class: "mono" }, path),
        el(
          "button",
          {
            class: "icon-btn",
            type: "button",
            title: "Copy path",
            onclick: () => void navigator.clipboard?.writeText(path),
          },
          "⧉"
        )
      )
    );
  }
  fileFallback.append(paths);
  return card;
}
