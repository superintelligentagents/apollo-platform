import {
  createDurableKeyValueStore,
  openStore,
  presignEndpoint,
  uploadJsonBrowser,
  type PlatformAdapter,
} from "@apollo-pc/shared";

export function createPcAdapter(): PlatformAdapter {
  const storage = createDurableKeyValueStore(openStore(), localStorage);
  return {
    platform: "web",
    async uploadJson(opts) {
      await uploadJsonBrowser(
        presignEndpoint(),
        {
          participantId: opts.participantId,
          studyId: opts.studyId ?? "internal",
          taskId: opts.taskId,
          filename: opts.filename,
          contentType: "application/json",
        },
        opts.body
      );
    },
    storage,
  };
}
