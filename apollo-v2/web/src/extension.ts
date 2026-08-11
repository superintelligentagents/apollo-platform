// Bridge to the Apollo History Helper extension: the ONLY way a web page can
// read Chrome history automatically. The extension answers only allow-listed
// origins; data stays local until the user uploads a task.
import type { Visit } from "@odyssey/shared";

export const EXTENSION_ID =
  (import.meta as { env?: Record<string, string> }).env?.VITE_EXTENSION_ID ||
  "jodeickgpmlohcpebffkbbkpnadppgfb";

type ChromeRuntime = {
  runtime?: {
    sendMessage(extId: string, msg: unknown, cb: (resp: unknown) => void): void;
    lastError?: { message?: string };
  };
};

function runtime() {
  return (globalThis as { chrome?: ChromeRuntime }).chrome?.runtime;
}

function send<T>(msg: unknown, timeoutMs: number): Promise<T | null> {
  const rt = runtime();
  if (!rt) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      rt.sendMessage(EXTENSION_ID, msg, (resp) => {
        clearTimeout(timer);
        // Reading lastError clears Chrome's "Unchecked runtime.lastError" warning.
        void (rt as { lastError?: unknown }).lastError;
        resolve((resp as T) ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export async function extensionAvailable(): Promise<boolean> {
  const resp = await send<{ ok?: boolean }>({ type: "ping" }, 800);
  return !!resp?.ok;
}

export async function readHistoryFromExtension(): Promise<Visit[] | null> {
  const resp = await send<{ ok?: boolean; visits?: Visit[] }>({ type: "history" }, 60000);
  if (!resp?.ok || !Array.isArray(resp.visits)) return null;
  return resp.visits.map((v) => {
    let domain = "";
    try {
      domain = new URL(v.url).host;
    } catch {
      domain = "";
    }
    let searchTerm: string | undefined;
    try {
      searchTerm = new URL(v.url).searchParams.get("q")?.trim() || undefined;
    } catch {
      searchTerm = undefined;
    }
    return { ...v, domain, search_term: searchTerm };
  });
}
