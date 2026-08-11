import { createAliasPool, detectEntities } from "./alias";
import type { Entity, ParticipantIdentity, SourceRecord } from "./types";

type EntityWorkerRequest = {
  records: SourceRecord[];
  existing: Entity[];
  identity?: ParticipantIdentity;
};

type WorkerScope = {
  onmessage: ((event: MessageEvent<EntityWorkerRequest>) => void) | null;
  postMessage(value: { entities: Entity[] }): void;
};

const workerScope = self as unknown as WorkerScope;
workerScope.onmessage = (event) => {
  const { records, existing, identity } = event.data;
  workerScope.postMessage({ entities: detectEntities(records, existing, createAliasPool(), identity) });
};
