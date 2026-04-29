import { test } from "node:test";
import assert from "node:assert";
import { normalizeStreamReference } from "./channelFactory.ts";

const LOCAL_FILE_STREAM_ERROR = "Local file paths are not supported in playlist entries.";

test("normalizeStreamReference rejects Windows file paths", () => {
  const result1 = normalizeStreamReference("C:\\media\\video.mp4");
  assert.deepStrictEqual(result1, {
    stream: "C:\\media\\video.mp4",
    isPlayable: false,
    playabilityError: LOCAL_FILE_STREAM_ERROR,
  });

  const result2 = normalizeStreamReference("d:\\Movies\\movie.mkv");
  assert.deepStrictEqual(result2, {
    stream: "d:\\Movies\\movie.mkv",
    isPlayable: false,
    playabilityError: LOCAL_FILE_STREAM_ERROR,
  });
});

test("normalizeStreamReference rejects UNC network paths", () => {
  const result = normalizeStreamReference("\\\\SERVER\\Share\\video.mp4");
  assert.deepStrictEqual(result, {
    stream: "\\\\SERVER\\Share\\video.mp4",
    isPlayable: false,
    playabilityError: LOCAL_FILE_STREAM_ERROR,
  });
});

test("normalizeStreamReference correctly handles valid protocols", () => {
  const validStreams = [
    { input: "http://example.com/stream.m3u8", expected: "http://example.com/stream.m3u8" },
    { input: "https://example.com/stream.m3u8", expected: "https://example.com/stream.m3u8" },
    { input: "rtsp://192.168.1.100:554/stream", expected: "rtsp://192.168.1.100:554/stream" },
    { input: "rtmp://example.com/live", expected: "rtmp://example.com/live" },
    { input: "rtmps://example.com/live", expected: "rtmps://example.com/live" },
    { input: "udp://@239.0.0.1:1234", expected: "udp://239.0.0.1:1234" },
    { input: "tcp://192.168.1.1:1234", expected: "tcp://192.168.1.1:1234" },
    { input: "mms://example.com/stream", expected: "mms://example.com/stream" },
    { input: "mmsh://example.com/stream", expected: "mmsh://example.com/stream" },
    { input: "rtp://127.0.0.1:1234", expected: "rtp://127.0.0.1:1234" },
    { input: "srt://example.com:1234", expected: "srt://example.com:1234" },
  ];

  for (const { input, expected } of validStreams) {
    const result = normalizeStreamReference(input);
    assert.deepStrictEqual(result, {
      stream: expected,
      isPlayable: true,
      playabilityError: null,
    });
  }
});

test("normalizeStreamReference rejects unsupported protocols", () => {
  const unsupportedStreams = [
    "ftp://example.com/video.mp4",
    "smb://192.168.1.100/share/video.mp4",
    "sftp://example.com/video",
  ];

  for (const stream of unsupportedStreams) {
    const parsedUrl = new URL(stream);
    const result = normalizeStreamReference(stream);
    assert.deepStrictEqual(result, {
      stream,
      isPlayable: false,
      playabilityError: `Unsupported stream protocol: ${parsedUrl.protocol}`,
    });
  }
});

test("normalizeStreamReference rejects file URLs", () => {
  const result = normalizeStreamReference("file:///home/user/video.mp4");
  assert.deepStrictEqual(result, {
    stream: "file:///home/user/video.mp4",
    isPlayable: false,
    playabilityError: LOCAL_FILE_STREAM_ERROR,
  });
});

test("normalizeStreamReference rejects malformed URLs and random strings", () => {
  const malformedStreams = [
    "not a url",
    "just_a_string",
    "",
  ];

  for (const stream of malformedStreams) {
    const result = normalizeStreamReference(stream);
    assert.deepStrictEqual(result, {
      stream,
      isPlayable: false,
      playabilityError: "Unsupported stream format or malformed URL.",
    });
  }
});

test("normalizeStreamReference handles single-slash malformed URLs gracefully", () => {
  // `new URL("http:/missing.slash")` evaluates to `http://missing.slash/` on Node/Browsers
  const stream = "http:/missing.slash";
  const result = normalizeStreamReference(stream);
  assert.deepStrictEqual(result, {
    stream: "http://missing.slash/",
    isPlayable: true,
    playabilityError: null,
  });
});

test("normalizeStreamReference trims whitespace before processing", () => {
  const result1 = normalizeStreamReference("  http://example.com/stream.m3u8  ");
  assert.deepStrictEqual(result1, {
    stream: "http://example.com/stream.m3u8",
    isPlayable: true,
    playabilityError: null,
  });

  const result2 = normalizeStreamReference("\tC:\\media\\video.mp4\n");
  assert.deepStrictEqual(result2, {
    stream: "C:\\media\\video.mp4",
    isPlayable: false,
    playabilityError: LOCAL_FILE_STREAM_ERROR,
  });
});
