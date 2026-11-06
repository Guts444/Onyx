import { test } from "node:test";
import assert from "node:assert";
import {
  parseM3u,
  parseM3uInChunks,
  PLAYLIST_CANCELLED_MESSAGE,
} from "./m3u.ts";

const ORIGIN = { sourceId: "source_test", trust: "remote" as const };

function buildFixture(channels: number, lineEnding = "\n") {
  const lines = ["#EXTM3U"];
  for (let index = 0; index < channels; index += 1) {
    const group = `Group ${index % 40}`;
    if (index % 7 === 0) {
      lines.push(`#EXTINF:-1 tvg-id="id${index}.example",Channel ${index}`);
    } else if (index % 11 === 0) {
      lines.push(`#EXTINF:-1 group-title="${group}",Channel ${index} HD`);
    } else {
      lines.push(
        `#EXTINF:-1 tvg-id="id${index}.example" tvg-name="Channel ${index}" tvg-logo="https://logos.example.com/${index}.png" group-title="${group}",Channel ${index} HD`,
      );
    }
    lines.push(index % 13 === 0 ? `ftp://unsupported.example/${index}.ts` : `https://provider.example/live/${index}.ts`);
  }
  lines.push("#EXTINF:-1,Dangling entry without a stream");
  return lines.join(lineEnding);
}

function channelFingerprint(channels: Array<{ id: string; name: string; group: string; stream: string | null; isPlayable: boolean }>) {
  return channels
    .map((channel) => [channel.id, channel.name, channel.group, channel.stream, channel.isPlayable].join("\u0001"))
    .join("\n");
}

test("chunked parsing produces exactly the sync parse result", async () => {
  const text = `\uFEFF${buildFixture(5_000, "\r\n")}`;

  const sync = parseM3u(text, "fixture.m3u", ORIGIN);
  const chunked = await parseM3uInChunks(text, "fixture.m3u", ORIGIN);

  assert.equal(chunked.channels.length, sync.channels.length);
  assert.equal(chunked.disabledChannelCount, sync.disabledChannelCount);
  assert.equal(chunked.skippedEntryCount, sync.skippedEntryCount);
  assert.deepStrictEqual(chunked.groups, sync.groups);
  assert.equal(channelFingerprint(chunked.channels), channelFingerprint(sync.channels));
});

test("chunked parsing reports monotonic progress that ends at one", async () => {
  const text = buildFixture(20_000);
  const reported: number[] = [];

  const playlist = await parseM3uInChunks(text, "progress.m3u", ORIGIN, {
    onProgress: (fraction) => reported.push(fraction),
  });

  assert.equal(playlist.channels.length, 20_000);
  assert.ok(reported.length >= 5, `expected several progress reports, saw ${reported.length}`);
  for (let index = 1; index < reported.length; index += 1) {
    assert.ok(reported[index] >= reported[index - 1], `progress went backwards at ${index}`);
  }
  assert.equal(reported[reported.length - 1], 1);
});

test("an aborted import stops mid-parse and reports the cancellation", async () => {
  const text = buildFixture(20_000);
  const controller = new AbortController();
  let sawProgress = false;

  await assert.rejects(
    parseM3uInChunks(text, "cancelled.m3u", ORIGIN, {
      signal: controller.signal,
      onProgress: (fraction) => {
        sawProgress = true;
        if (fraction >= 0.1) controller.abort();
      },
    }),
    new RegExp(PLAYLIST_CANCELLED_MESSAGE),
  );
  assert.equal(sawProgress, true);
});

test("an already-aborted import never returns a playlist", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    parseM3uInChunks(buildFixture(100), "aborted.m3u", ORIGIN, { signal: controller.signal }),
    new RegExp(PLAYLIST_CANCELLED_MESSAGE),
  );
});

test("an empty playlist is rejected by both drivers", async () => {
  await assert.rejects(parseM3uInChunks("#EXTM3U\n#EXTINF:-1,Only metadata\n", "empty.m3u", ORIGIN), /did not contain any channels/);
  assert.throws(() => parseM3u("#EXTM3U\n", "empty.m3u", ORIGIN), /did not contain any channels/);
});
