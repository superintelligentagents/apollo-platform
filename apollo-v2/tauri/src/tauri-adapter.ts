import { invoke } from "@tauri-apps/api/core";
import {
  clusterVisitsHeuristic,
  presignEndpoint,
  type Cluster,
  type PlatformAdapter,
  type ProfileOption,
  type UploadJsonOptions,
  type Visit,
} from "@odyssey/shared";

export function createTauriAdapter(): PlatformAdapter {
  return {
    platform: "tauri",

    async detectProfiles(): Promise<ProfileOption[]> {
      return (await invoke("detect_history_profiles")) as ProfileOption[];
    },

    async loadClusters(source: ProfileOption | File): Promise<Cluster[]> {
      if (source instanceof File) throw new Error("File sources are for the web client.");
      let clusters: Cluster[] = [];
      let clusterErr: string | null = null;
      try {
        // Bounded like the web client so multi-year histories don't
        // materialize wholesale in Rust and flood the webview; high enough to
        // cover Chrome's full ~90-day visit retention for heavy users.
        clusters = (await invoke("read_clusters", { path: source.path, clusterLimit: 4000 })) as Cluster[];
      } catch (e) {
        // "no cluster tables" is the normal missing-Journeys case → fall back
        // quietly. Anything else (a locked/corrupt DB) we remember so we can
        // surface a real message if the visits fallback also comes up empty.
        const msg = e instanceof Error ? e.message : String(e);
        clusterErr = /no cluster tables/i.test(msg) ? null : msg;
      }
      if (clusters.length) return clusters;
      // Missing OR empty Journeys tables: fall back to raw visits + heuristic
      // clustering (same normalization applies downstream).
      const visits = (await invoke("read_visits", { path: source.path, visitLimit: 40000 })) as Visit[];
      if (!visits.length && clusterErr) {
        throw new Error(`Couldn't read history — is Chrome mid-write? Quit Chrome and try again. (${clusterErr})`);
      }
      return clusterVisitsHeuristic(visits);
    },

    async uploadJson(opts: UploadJsonOptions): Promise<void> {
      await invoke("upload_json", {
        presignEndpoint: presignEndpoint(),
        participantId: opts.participantId,
        studyId: opts.studyId ?? null,
        taskId: opts.taskId,
        filename: opts.filename,
        body: opts.body,
      });
    },

    storage: {
      async get(key: string): Promise<string | null> {
        return ((await invoke("kv_get", { key })) as string | null) ?? null;
      },
      async set(key: string, value: string): Promise<void> {
        await invoke("kv_set", { key, value });
      },
    },
  };
}
