import { test } from "node:test";
import assert from "node:assert";
import type { SavedPlaylistSource } from "../../domain/sourceProfiles.ts";
import { scrubSourceProfileSecrets } from "./profiles.ts";

test("scrubSourceProfileSecrets removes Xtream passwords before persistence", () => {
  const sources: Record<string, SavedPlaylistSource> = {
    source_m3u_url_1: {
      id: "source_m3u_url_1",
      kind: "m3u_url",
      name: "M3U",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastLoadedAt: null,
      url: "https://example.com/list.m3u",
    },
    source_xtream_1: {
      id: "source_xtream_1",
      kind: "xtream",
      name: "Xtream",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastLoadedAt: null,
      domain: "example.com",
      username: "user",
      password: "secret-password",
    },
  };

  assert.deepStrictEqual(scrubSourceProfileSecrets(sources), {
    ...sources,
    source_xtream_1: {
      ...sources.source_xtream_1,
      password: "",
    },
  });
});
