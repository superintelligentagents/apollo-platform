import type { KeyValueStore } from "./platform";
import type { RecordStore } from "./store";

const KEY_PREFIX = "kv:";

export type LocalStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

// Keep a synchronous localStorage mirror for fast startup and page-close
// flushes, while IndexedDB provides the capacity needed for large task lists
// and drafts with document references. Existing localStorage-only installs are
// migrated on first read.
export function createDurableKeyValueStore(
  store: Promise<RecordStore> | RecordStore,
  fallback: LocalStorageLike,
): KeyValueStore {
  const ready = Promise.resolve(store);
  return {
    async get(key) {
      try {
        const value = await (await ready).getMeta<string>(`${KEY_PREFIX}${key}`);
        if (value != null) return value;
      } catch {
        // The local mirror remains readable if IndexedDB is unavailable.
      }
      const value = fallback.getItem(key);
      if (value != null) {
        void ready.then((db) => db.setMeta(`${KEY_PREFIX}${key}`, value)).catch(() => {});
      }
      return value;
    },
    async set(key, value) {
      let mirrored = false;
      try {
        // This happens before the first await so a pagehide flush has a
        // synchronous durable-enough fallback even if IndexedDB is still busy.
        fallback.setItem(key, value);
        mirrored = true;
      } catch {
        // Quota errors are expected for large workspaces; IndexedDB is primary.
      }
      try {
        await (await ready).setMeta(`${KEY_PREFIX}${key}`, value);
      } catch (error) {
        if (!mirrored) throw error;
      }
    },
  };
}
