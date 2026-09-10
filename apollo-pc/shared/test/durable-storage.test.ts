import { describe, expect, it } from "vitest";
import { createDurableKeyValueStore } from "../src/durable-storage";
import type { RecordStore } from "../src/store";

function fixtures() {
  const meta = new Map<string, unknown>();
  const local = new Map<string, string>();
  const store = {
    async getMeta<T>(key: string) { return (meta.get(key) as T | undefined) ?? null; },
    async setMeta(key: string, value: unknown) { meta.set(key, value); },
  } as RecordStore;
  const fallback = {
    getItem(key: string) { return local.get(key) ?? null; },
    setItem(key: string, value: string) { local.set(key, value); },
  };
  return { meta, local, store, fallback };
}

describe("durable key-value storage", () => {
  it("writes IndexedDB and the synchronous local mirror", async () => {
    const { meta, local, store, fallback } = fixtures();
    const storage = createDurableKeyValueStore(store, fallback);
    await storage.set("draft", "large authored task state");
    expect(local.get("draft")).toBe("large authored task state");
    expect(meta.get("kv:draft")).toBe("large authored task state");
  });

  it("migrates an existing localStorage value on read", async () => {
    const { meta, local, store, fallback } = fixtures();
    local.set("draft", "legacy");
    const storage = createDurableKeyValueStore(store, fallback);
    expect(await storage.get("draft")).toBe("legacy");
    await Promise.resolve();
    expect(meta.get("kv:draft")).toBe("legacy");
  });

  it("keeps saving when the localStorage quota is exhausted", async () => {
    const { meta, store, fallback } = fixtures();
    fallback.setItem = () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); };
    const storage = createDurableKeyValueStore(store, fallback);
    await storage.set("draft", "large");
    expect(meta.get("kv:draft")).toBe("large");
  });
});
