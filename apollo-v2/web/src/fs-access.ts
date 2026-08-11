// File System Access API helpers: the browser can never read Chrome's
// History silently (by design), but Chromium lets us keep a handle to the
// file the user picked once — making every later re-read a single click.

type FileHandle = {
  getFile(): Promise<File>;
  queryPermission?(opts: { mode: string }): Promise<string>;
  requestPermission?(opts: { mode: string }): Promise<string>;
};

const DB_NAME = "apollo-v2";
const STORE = "handles";
const KEY = "history-file";

export function supportsFsAccess(): boolean {
  return typeof window !== "undefined" && "showOpenFilePicker" in window;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<unknown> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Open the native picker (user gesture required), remember the handle.
export async function pickHistoryFile(): Promise<File | null> {
  try {
    const picker = (window as unknown as {
      showOpenFilePicker(opts?: unknown): Promise<FileHandle[]>;
    }).showOpenFilePicker;
    const [handle] = await picker({
      // The History file has no extension; accept anything.
      types: [],
      excludeAcceptAllOption: false,
      multiple: false,
    });
    if (!handle) return null;
    await idbSet(KEY, handle).catch(() => {});
    return await handle.getFile();
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return null; // user cancelled
    throw err;
  }
}

// True when a previously-picked handle is stored (re-read is one click away).
export async function hasSavedHistoryHandle(): Promise<boolean> {
  try {
    return !!(await idbGet(KEY));
  } catch {
    return false;
  }
}

// Re-read the remembered file; the browser shows at most a permission prompt.
export async function readSavedHistoryFile(): Promise<File | null> {
  try {
    const handle = (await idbGet(KEY)) as FileHandle | undefined;
    if (!handle) return null;
    if (handle.queryPermission && (await handle.queryPermission({ mode: "read" })) !== "granted") {
      if (!handle.requestPermission || (await handle.requestPermission({ mode: "read" })) !== "granted") {
        return null;
      }
    }
    return await handle.getFile();
  } catch {
    return null;
  }
}
