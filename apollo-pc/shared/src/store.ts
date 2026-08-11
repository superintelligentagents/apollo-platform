// IndexedDB wrapper for parsed records + email bodies. localStorage's ~5 MB
// quota can't hold a mailbox; header-level records stay in memory (~300 B
// each) and everything durable lives here. Hand-rolled promise wrapper — no
// `idb` dependency, consistent with the zero-dep style.

import type { Entity, SourceRecord } from "./types";

const DB_NAME = "apollo-pc";
const DB_VERSION = 1;
const RECORDS = "records"; // SourceRecord, keyed by id
const BODIES = "bodies"; // { id, text } — email bodies, keyed by record id
const META = "meta"; // { key, value } — entity map, misc

export type RecordStore = {
  putRecords(records: SourceRecord[]): Promise<void>;
  allRecords(): Promise<SourceRecord[]>;
  putBodies(bodies: { id: string; text: string }[]): Promise<void>;
  getBody(id: string): Promise<string | null>;
  getBodies(ids: string[]): Promise<Map<string, string>>;
  getMeta<T>(key: string): Promise<T | null>;
  setMeta(key: string, value: unknown): Promise<void>;
  clearAll(): Promise<void>;
};

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export async function openStore(): Promise<RecordStore> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const d = open.result;
      if (!d.objectStoreNames.contains(RECORDS)) d.createObjectStore(RECORDS, { keyPath: "id" });
      if (!d.objectStoreNames.contains(BODIES)) d.createObjectStore(BODIES, { keyPath: "id" });
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: "key" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });

  return {
    async putRecords(records) {
      for (let i = 0; i < records.length; i += 500) {
        const tx = db.transaction(RECORDS, "readwrite");
        const store = tx.objectStore(RECORDS);
        for (const r of records.slice(i, i + 500)) store.put(r);
        await txDone(tx);
      }
    },
    async allRecords() {
      const tx = db.transaction(RECORDS, "readonly");
      return req(tx.objectStore(RECORDS).getAll()) as Promise<SourceRecord[]>;
    },
    async putBodies(bodies) {
      for (let i = 0; i < bodies.length; i += 500) {
        const tx = db.transaction(BODIES, "readwrite");
        const store = tx.objectStore(BODIES);
        for (const b of bodies.slice(i, i + 500)) store.put(b);
        await txDone(tx);
      }
    },
    async getBody(id) {
      const tx = db.transaction(BODIES, "readonly");
      const row = (await req(tx.objectStore(BODIES).get(id))) as { id: string; text: string } | undefined;
      return row?.text ?? null;
    },
    async getBodies(ids) {
      const out = new Map<string, string>();
      const tx = db.transaction(BODIES, "readonly");
      const store = tx.objectStore(BODIES);
      await Promise.all(
        ids.map(async (id) => {
          const row = (await req(store.get(id))) as { id: string; text: string } | undefined;
          if (row) out.set(id, row.text);
        })
      );
      return out;
    },
    async getMeta<T>(key: string): Promise<T | null> {
      const tx = db.transaction(META, "readonly");
      const row = (await req(tx.objectStore(META).get(key))) as { key: string; value: T } | undefined;
      return row ? row.value : null;
    },
    async setMeta(key, value) {
      const tx = db.transaction(META, "readwrite");
      tx.objectStore(META).put({ key, value });
      await txDone(tx);
    },
    async clearAll() {
      const tx = db.transaction([RECORDS, BODIES, META], "readwrite");
      tx.objectStore(RECORDS).clear();
      tx.objectStore(BODIES).clear();
      tx.objectStore(META).clear();
      await txDone(tx);
    },
  };
}

export const META_KEYS = {
  entities: "entities",
};

export type StoredEntities = { entities: Entity[]; recordCount?: number; classificationVersion?: string };
