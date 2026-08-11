import { presignEndpoint, uploadJsonBrowser, type PlatformAdapter } from "@apollo-pc/shared";

export function createPcAdapter(): PlatformAdapter {
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
    storage: {
      async get(key) {
        return localStorage.getItem(key);
      },
      async set(key, value) {
        localStorage.setItem(key, value);
      },
    },
  };
}
