#!/usr/bin/env node
// Dev-only fault-injection stream server for Onyx player recovery tests.
//
//   node scripts/harness/stream-server.mjs [--port 4318] [--media-dir <dir>]
//
// Serves a credential-free playlist plus MPEG-TS and HLS streams that stall,
// close, reset, respond slowly, refuse (403/500), or fail once and recover.
// GET /stats returns connection counts so the one-connection invariant can be
// measured; POST /stats/reset clears them.
//
// Media is generated with ffmpeg on first start and cached in the media dir.

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_PORT = 4318;
const TS_BITRATE = 1_200_000;
const VOD_SECONDS = 120;

function parseArgs(argv) {
  const options = { port: DEFAULT_PORT, mediaDir: path.join(os.tmpdir(), "onyx-stream-harness") };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--port") options.port = Number(argv[++index]);
    else if (value === "--media-dir") options.mediaDir = path.resolve(argv[++index]);
    else if (value === "--help") {
      console.log("Usage: node scripts/harness/stream-server.mjs [--port N] [--media-dir DIR]");
      process.exit(0);
    }
  }
  return options;
}

function run(command, args, label) {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${command} exited ${result.status}\n${result.stderr}`);
  }
}

function ensureMediaFiles(mediaDir) {
  fs.mkdirSync(mediaDir, { recursive: true });
  const source = ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"];

  const loopTs = path.join(mediaDir, "loop.ts");
  if (!fs.existsSync(loopTs)) {
    run("ffmpeg", ["-y", ...source, "-t", "30", "-c:v", "libx264", "-preset", "veryfast",
      "-tune", "zerolatency", "-b:v", "1200k", "-g", "60", "-c:a", "aac", "-b:a", "128k",
      "-f", "mpegts", loopTs], "ffmpeg loop.ts");
  }

  const audioTs = path.join(mediaDir, "audio.ts");
  if (!fs.existsSync(audioTs)) {
    run("ffmpeg", ["-y", ...source, "-t", "30", "-vn", "-c:a", "aac", "-b:a", "128k",
      "-f", "mpegts", audioTs], "ffmpeg audio.ts");
  }

  const vodMp4 = path.join(mediaDir, "vod.mp4");
  if (!fs.existsSync(vodMp4)) {
    run("ffmpeg", ["-y", ...source, "-t", String(VOD_SECONDS), "-c:v", "libx264", "-preset",
      "veryfast", "-b:v", "500k", "-g", "60", "-c:a", "aac", "-b:a", "96k", "-movflags",
      "+faststart", vodMp4], "ffmpeg vod.mp4");
  }

  const shortMp4 = path.join(mediaDir, "short.mp4");
  if (!fs.existsSync(shortMp4)) {
    run("ffmpeg", ["-y", ...source, "-t", "10", "-c:v", "libx264", "-preset", "veryfast",
      "-b:v", "500k", "-g", "30", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart",
      shortMp4], "ffmpeg short.mp4");
  }

  const vodMkv = path.join(mediaDir, "vod.mkv");
  if (!fs.existsSync(vodMkv)) {
    run("ffmpeg", ["-y", "-i", vodMp4, "-c", "copy", "-f", "matroska", vodMkv], "ffmpeg vod.mkv");
  }

  const vodTs = path.join(mediaDir, "vod.ts");
  if (!fs.existsSync(vodTs)) {
    run("ffmpeg", ["-y", "-i", vodMp4, "-c", "copy", "-f", "mpegts", vodTs], "ffmpeg vod.ts");
  }

  const hlsDir = path.join(mediaDir, "hls");
  const hlsPlaylist = path.join(hlsDir, "index.m3u8");
  if (!fs.existsSync(hlsPlaylist)) {
    fs.mkdirSync(hlsDir, { recursive: true });
    run("ffmpeg", ["-y", ...source, "-t", "30", "-c:v", "libx264", "-preset", "veryfast",
      "-g", "60", "-b:v", "800k", "-c:a", "aac", "-b:a", "96k", "-f", "hls",
      "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_segment_filename",
      path.join(hlsDir, "seg%03d.ts"), hlsPlaylist], "ffmpeg hls");
  }

  const hlsSegments = fs.readdirSync(hlsDir).filter((name) => name.endsWith(".ts")).sort();
  if (hlsSegments.length === 0) throw new Error("ffmpeg produced no HLS segments");

  return {
    loopTs: fs.readFileSync(loopTs),
    audioTs: fs.readFileSync(audioTs),
    vodMp4: fs.readFileSync(vodMp4),
    shortMp4: fs.readFileSync(shortMp4),
    vodMkv: fs.readFileSync(vodMkv),
    vodTs: fs.readFileSync(vodTs),
    hlsDir,
    hlsSegments,
  };
}

const MODES = new Set(["stall", "close", "reset", "slow", "forbidden", "error", "flaky", "clean", "live", "drop-once"]);
const stats = new Map();

function recordConnection(key) {
  const entry = stats.get(key) ?? { key, requests: 0, active: 0, maxActive: 0, completed: 0, bytes: 0, ranges: [] };
  entry.requests += 1;
  entry.active += 1;
  entry.maxActive = Math.max(entry.maxActive, entry.active);
  stats.set(key, entry);
  return entry;
}

function countBytes(key, length) {
  const entry = stats.get(key);
  if (entry) entry.bytes += length;
}

function noteRange(key, range) {
  const entry = stats.get(key);
  if (entry && range) entry.ranges.push(range);
}

function finishConnection(key) {
  const entry = stats.get(key);
  if (entry && entry.active > 0) entry.active -= 1;
  if (entry) entry.completed += 1;
}

function parseControl(url, defaultAfter) {
  const afterParam = url.searchParams.get("after");
  const delayParam = url.searchParams.get("delay");
  return {
    afterMs: (afterParam === null ? defaultAfter : Number(afterParam)) * 1000,
    delayMs: (delayParam === null ? 0 : Number(delayParam)) * 1000,
  };
}

function sendStatus(response, status, body) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

function streamBuffer(request, response, buffer, key, options = {}) {
  const {
    chunkBytes = 16 * 1024,
    bytesPerSecond = TS_BITRATE / 8,
    stopAfterMs = null,
    endAfterMs = null,
    loop = true,
  } = options;
  const startedAt = Date.now();
  let offset = 0;
  let timer = null;
  let closed = false;

  function stop() {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  response.on("close", () => {
    stop();
    finishConnection(key);
  });
  request.on("error", () => {
    stop();
  });

  function tick() {
    if (closed) return;
    if (endAfterMs !== null && Date.now() - startedAt >= endAfterMs) {
      stop();
      response.end();
      return;
    }
    if (stopAfterMs !== null && Date.now() - startedAt >= stopAfterMs) {
      stop();
      return;
    }
    if (offset >= buffer.length) {
      if (!loop) {
        stop();
        response.end();
        return;
      }
      offset = 0;
    }
    const end = Math.min(offset + chunkBytes, buffer.length);
    const chunk = buffer.subarray(offset, end);
    offset = end;
    countBytes(key, chunk.length);
    const ok = response.write(chunk);
    const delay = Math.max(0, (chunk.length / bytesPerSecond) * 1000);
    if (!ok) {
      response.once("drain", schedule);
    } else {
      schedule();
    }
    function schedule() {
      if (closed) return;
      timer = setTimeout(tick, delay);
    }
  }

  tick();
}

function sendMedia(request, response, body, contentType, key) {
  const range = request.headers.range;
  countBytes(key, body.length);
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const start = match[1] === "" ? Math.max(0, body.length - Number(match[2])) : Number(match[1]);
      const end = match[1] !== "" && match[2] !== "" ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
      if (start <= end && start < body.length) {
        const chunk = body.subarray(start, end + 1);
        response.writeHead(206, {
          "content-type": contentType,
          "content-length": String(chunk.length),
          "content-range": `bytes ${start}-${end}/${body.length}`,
          "accept-ranges": "bytes",
          "cache-control": "no-store",
        });
        response.end(request.method === "HEAD" ? undefined : chunk);
        return;
      }
    }
    response.writeHead(416, { "content-range": `bytes */${body.length}` });
    response.end();
    return;
  }
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": String(body.length),
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

const serverState = { media: null, port: DEFAULT_PORT, flakyAttempts: new Map(), startedAt: Date.now() };

function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${serverState.port}`);

  if (url.pathname === "/stats") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({
      now: Date.now(),
      connections: [...stats.values()].sort((left, right) => left.key.localeCompare(right.key)),
    }));
    return;
  }
  if (url.pathname === "/stats/reset") {
    stats.clear();
    serverState.flakyAttempts.clear();
    response.writeHead(204);
    response.end();
    return;
  }

  if (url.pathname === "/harness.m3u") {
    const base = `http://127.0.0.1:${serverState.port}`;
    const lines = [
      "#EXTM3U",
      `#EXTINF:-1 tvg-id="stall" tvg-name="Harness Stall" group-title="Harness",Harness Stall`,
      `${base}/ts/stall`,
      `#EXTINF:-1 tvg-id="close" tvg-name="Harness Close" group-title="Harness",Harness Close`,
      `${base}/ts/close`,
      `#EXTINF:-1 tvg-id="reset" tvg-name="Harness Reset" group-title="Harness",Harness Reset`,
      `${base}/ts/reset`,
      `#EXTINF:-1 tvg-id="slow" tvg-name="Harness Slow" group-title="Harness",Harness Slow`,
      `${base}/ts/slow?delay=12`,
      `#EXTINF:-1 tvg-id="forbidden" tvg-name="Harness 403" group-title="Harness",Harness 403`,
      `${base}/ts/forbidden`,
      `#EXTINF:-1 tvg-id="error" tvg-name="Harness 500" group-title="Harness",Harness 500`,
      `${base}/ts/error`,
      `#EXTINF:-1 tvg-id="flaky" tvg-name="Harness Flaky" group-title="Harness",Harness Flaky`,
      `${base}/ts/flaky`,
      `#EXTINF:-1 tvg-id="audio" tvg-name="Harness Audio" group-title="Harness",Harness Audio`,
      `${base}/ts/audio`,
      `#EXTINF:-1 tvg-id="live" tvg-name="Harness Live" group-title="Harness",Harness Live`,
      `${base}/ts/live`,
      `#EXTINF:-1 tvg-id="drop-once" tvg-name="Harness Drop Once" group-title="Harness",Harness Drop Once`,
      `${base}/ts/drop-once?after=6`,
      `#EXTINF:-1 tvg-id="hls-stall" tvg-name="Harness HLS Stall" group-title="Harness",Harness HLS Stall`,
      `${base}/hls/stall/index.m3u8`,
      `#EXTINF:-1 tvg-id="hls-live" tvg-name="Harness HLS Live" group-title="Harness",Harness HLS Live`,
      `${base}/hls/live/index.m3u8`,
      `#EXTINF:-1 tvg-id="hls-close" tvg-name="Harness HLS Close" group-title="Harness",Harness HLS Close`,
      `${base}/hls/close/index.m3u8`,
      `#EXTINF:-1 tvg-id="hls-reset" tvg-name="Harness HLS Reset" group-title="Harness",Harness HLS Reset`,
      `${base}/hls/reset/index.m3u8`,
      `#EXTINF:-1 tvg-id="hls-slow" tvg-name="Harness HLS Slow" group-title="Harness",Harness HLS Slow`,
      `${base}/hls/slow/index.m3u8?delay=12`,
      `#EXTINF:-1 tvg-id="hls-forbidden" tvg-name="Harness HLS 403" group-title="Harness",Harness HLS 403`,
      `${base}/hls/forbidden/index.m3u8`,
      `#EXTINF:-1 tvg-id="hls-error" tvg-name="Harness HLS 500" group-title="Harness",Harness HLS 500`,
      `${base}/hls/error/index.m3u8`,
      `#EXTINF:-1 tvg-id="hls-flaky" tvg-name="Harness HLS Flaky" group-title="Harness",Harness HLS Flaky`,
      `${base}/hls/flaky/index.m3u8`,
      `#EXTINF:-1 tvg-id="hls-clean" tvg-name="Harness HLS Clean" group-title="Harness",Harness HLS Clean`,
      `${base}/hls/clean/index.m3u8`,
    ];
    response.writeHead(200, { "content-type": "audio/x-mpegurl", "cache-control": "no-store" });
    response.end(lines.join("\n") + "\n");
    return;
  }

  if (url.pathname === "/player_api.php") {
    const action = url.searchParams.get("action") ?? "";
    const auth = {
      user_info: {
        auth: 1,
        status: "Active",
        username: "harness",
        password: "harness",
        message: "",
        allowed_output_formats: ["ts", "m3u8"],
      },
      server_info: {
        url: "127.0.0.1",
        port: String(serverState.port),
        https_port: "443",
        server_protocol: "http",
        timezone: "UTC",
      },
    };
    const movies = [
      { stream_id: 101, name: "Harness Movie", category_id: "1", container_extension: "mp4",
        stream_icon: null, plot: "Two minutes of test pattern.", rating: "7.5", year: "2026",
        added: "1760000000" },
      { stream_id: 102, name: "Harness Short", category_id: "1", container_extension: "mp4",
        stream_icon: null, plot: "Ten seconds, so it can finish.", rating: "6.0", year: "2025",
        added: "1760000001" },
      { stream_id: 103, name: "Harness Drop Movie", category_id: "1", container_extension: "mp4",
        stream_icon: null, plot: "Drops once after eighteen seconds.", rating: "7.0", year: "2024",
        added: "1760000002" },
      { stream_id: 104, name: "Harness Stall Movie", category_id: "1", container_extension: "mp4",
        stream_icon: null, plot: "Stalls once after eighteen seconds.", rating: "7.1", year: "2024",
        added: "1760000003" },
      { stream_id: 105, name: "Harness Refuse Movie", category_id: "1", container_extension: "mp4",
        stream_icon: null, plot: "Refuses once, then plays.", rating: "7.2", year: "2024",
        added: "1760000004" },
      { stream_id: 106, name: "Harness MKV Drop", category_id: "1", container_extension: "mkv",
        stream_icon: null, plot: "MKV that closes at seventy percent.", rating: "7.3", year: "2024",
        added: "1760000005" },
      { stream_id: 107, name: "Harness TS Drop", category_id: "1", container_extension: "ts",
        stream_icon: null, plot: "TS that closes at seventy percent.", rating: "7.4", year: "2024",
        added: "1760000006" },
    ];
    const series = [
      { series_id: 501, name: "Harness Series", category_id: "10", cover: null,
        plot: "Two episodes.", year: "2024", rating: "8.0" },
    ];
    let body;
    switch (action) {
      case "":
        body = auth;
        break;
      case "get_live_categories":
        body = [{ category_id: "1", category_name: "Harness Live", parent_id: 0 }];
        break;
      case "get_live_streams":
        body = [
          { num: 1, name: "Harness Live", stream_id: 901, stream_icon: null, category_id: "1" },
          { num: 2, name: "Harness Stall", stream_id: 902, stream_icon: null, category_id: "1" },
        ];
        break;
      case "get_vod_categories":
        body = [{ category_id: "1", category_name: "Harness Movies", parent_id: 0 }];
        break;
      case "get_vod_streams":
        body = movies;
        break;
      case "get_vod_info": {
        const id = Number(url.searchParams.get("vod_id"));
        const movie = movies.find((row) => row.stream_id === id);
        body = movie
          ? {
            info: { name: movie.name, plot: movie.plot, movie_image: null, rating: movie.rating,
              year: movie.year, duration: id === 102 ? "0:10" : "2:00" },
            movie_data: { stream_id: movie.stream_id, container_extension: movie.container_extension },
          }
          : {};
        break;
      }
      case "get_series_categories":
        body = [{ category_id: "10", category_name: "Harness Series", parent_id: 0 }];
        break;
      case "get_series":
        body = series;
        break;
      case "get_series_info": {
        const id = Number(url.searchParams.get("series_id"));
        body = id === 501
          ? {
            info: { name: "Harness Series", plot: "Two episodes.", cover: null },
            seasons: [{ season_number: 1, name: "Season 1", cover: null }],
            episodes: {
              1: [
                { id: 201, title: "Pilot", season: 1, episode_num: 1, container_extension: "mp4",
                  info: { plot: "Ten seconds.", duration: "0:10" } },
                { id: 202, title: "Second", season: 1, episode_num: 2, container_extension: "mp4",
                  info: { plot: "Two minutes.", duration: "2:00" } },
              ],
            },
          }
          : {};
        break;
      }
      default:
        body = {};
        break;
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
    return;
  }

  const xtreamStream = url.pathname.match(/^\/(?:movie|series|live)\/[^/]+\/[^/]+\/(\d+)\.(?:mp4|mkv|ts)$/);
  if (xtreamStream) {
    const id = Number(xtreamStream[1]);
    if (id >= 103 && id <= 105) {
      const key = `xtream/${id}`;
      recordConnection(key);
      response.on("close", () => finishConnection(key));
      noteRange(key, request.headers.range);
      const body = serverState.media.vodMp4;
      if (request.method === "HEAD") {
        response.writeHead(200, {
          "content-type": "video/mp4",
          "content-length": String(body.length),
          "accept-ranges": "bytes",
          "cache-control": "no-store",
        });
        response.end();
        return;
      }
      const attempts = serverState.flakyAttempts.get(key) ?? 0;
      serverState.flakyAttempts.set(key, attempts + 1);
      if (id === 105 && attempts === 0) {
        finishConnection(key);
        return sendStatus(response, 403, "forbidden once\n");
      }
      const total = body.length;
      let startOffset = 0;
      let endOffset = total - 1;
      const range = request.headers.range;
      let status = 200;
      const headers = {
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      };
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (match) {
          startOffset = match[1] === "" ? 0 : Number(match[1]);
          endOffset = match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1);
          if (startOffset > endOffset) {
            response.writeHead(416, { "content-range": `bytes */${total}` });
            return response.end();
          }
          status = 206;
          headers["content-range"] = `bytes ${startOffset}-${endOffset}/${total}`;
        }
      }
      headers["content-length"] = String(endOffset - startOffset + 1);
      response.writeHead(status, headers);
      let offset = startOffset;
      let sent = 0;
      let closed = false;
      const chunk = 32 * 1024;
      const timer = () => {
        if (closed) return;
        if (id === 103 && attempts === 0 && sent >= chunk * 60) {
          closed = true;
          if (request.socket && !request.socket.destroyed) request.socket.resetAndDestroy();
          return;
        }
        if (id === 104 && attempts === 0 && sent >= chunk * 60) {
          closed = true;
          return;
        }
        if (offset > endOffset) {
          closed = true;
          response.end();
          return;
        }
        const end = Math.min(offset + chunk, endOffset + 1);
        response.write(body.subarray(offset, end));
        countBytes(key, end - offset);
        sent += end - offset;
        offset = end;
        setTimeout(timer, 250);
      };
      response.on("close", () => {
        closed = true;
      });
      timer();
      return;
    }
    if (id === 106 || id === 107) {
      const key = `xtream/${id}`;
      recordConnection(key);
      response.on("close", () => finishConnection(key));
      noteRange(key, request.headers.range);
      const body = id === 106 ? serverState.media.vodMkv : serverState.media.vodTs;
      const contentType = id === 106 ? "video/x-matroska" : "video/mp2t";
      if (request.method === "HEAD") {
        response.writeHead(200, {
          "content-type": contentType,
          "content-length": String(body.length),
          "accept-ranges": "none",
        });
        response.end();
        return;
      }
      const attempts = serverState.flakyAttempts.get(key) ?? 0;
      serverState.flakyAttempts.set(key, attempts + 1);
      const total = body.length;
      const startOffset = 0;
      const endOffset = total - 1;
      const headers = { "content-type": contentType, "accept-ranges": "none",
        "content-length": String(total) };
      response.writeHead(200, headers);
      let offset = startOffset;
      let sent = 0;
      let closed = false;
      const chunk = 64 * 1024;
      const limit = Math.floor(total * 0.15);
      const timer = () => {
        if (closed) return;
        if (attempts === 0 && sent >= limit) {
          closed = true;
          response.end();
          return;
        }
        if (offset > endOffset) {
          closed = true;
          response.end();
          return;
        }
        const end = Math.min(offset + chunk, endOffset + 1);
        response.write(body.subarray(offset, end));
        countBytes(key, end - offset);
        sent += end - offset;
        offset = end;
        setTimeout(timer, 125);
      };
      response.on("close", () => {
        closed = true;
      });
      timer();
      return;
    }
    if (id === 901 || id === 902) {
      const key = `xtream/live/${id}`;
      recordConnection(key);
      response.on("close", () => finishConnection(key));
      response.writeHead(200, { "content-type": "video/mp2t", "cache-control": "no-store" });
      streamBuffer(request, response, serverState.media.loopTs, key,
        id === 902 ? { stopAfterMs: 8000 } : {});
      return;
    }
    const body = id === 101 || id === 202
      ? serverState.media.vodMp4
      : id === 102 || id === 201
      ? serverState.media.shortMp4
      : null;
    if (body === null) return sendStatus(response, 404, "no stream\n");
    const key = `xtream/${id}`;
    recordConnection(key);
    response.on("close", () => finishConnection(key));
    sendMedia(request, response, body, "video/mp4", key);
    return;
  }

  if (url.pathname === "/vod/short.mp4" || url.pathname === "/vod/movie.mp4") {
    const key = url.pathname === "/vod/short.mp4" ? "vod/short" : "vod/movie";
    recordConnection(key);
    response.on("close", () => finishConnection(key));
    const body = url.pathname === "/vod/short.mp4" ? serverState.media.shortMp4 : serverState.media.vodMp4;
    sendMedia(request, response, body, "video/mp4", key);
    return;
  }

  const tsMatch = url.pathname.match(/^\/ts\/([a-z-]+)$/);
  if (tsMatch && MODES.has(tsMatch[1])) {
    const mode = tsMatch[1];
    const key = `ts/${mode}`;
    recordConnection(key);
    response.on("close", () => finishConnection(key));
    const { afterMs, delayMs } = parseControl(url, mode === "stall" ? 8 : 6);

    if (mode === "forbidden") return sendStatus(response, 403, "forbidden\n");
    if (mode === "error") return sendStatus(response, 500, "internal error\n");
    if (mode === "flaky") {
      const attempts = serverState.flakyAttempts.get(key) ?? 0;
      serverState.flakyAttempts.set(key, attempts + 1);
      if (attempts === 0) {
        finishConnection(key);
        return sendStatus(response, 403, "forbidden once\n");
      }
    }

    response.writeHead(200, { "content-type": "video/mp2t", "cache-control": "no-store" });
    const start = () => {
      if (mode === "stall") {
        streamBuffer(request, response, serverState.media.loopTs, key, { stopAfterMs: afterMs });
        return;
      }
      if (mode === "close" || mode === "clean") {
        streamBuffer(request, response, serverState.media.loopTs, key, { endAfterMs: afterMs });
        return;
      }
      if (mode === "reset") {
        const startedAt = Date.now();
        const timer = setTimeout(() => {
          if (request.socket && !request.socket.destroyed) {
            request.socket.resetAndDestroy();
          }
        }, afterMs);
        response.on("close", () => clearTimeout(timer));
        streamBuffer(request, response, serverState.media.loopTs, key, {});
        void startedAt;
        return;
      }
      if (mode === "drop-once") {
        const attempts = serverState.flakyAttempts.get(key) ?? 0;
        serverState.flakyAttempts.set(key, attempts + 1);
        if (attempts === 0) {
          const timer = setTimeout(() => {
            if (request.socket && !request.socket.destroyed) request.socket.resetAndDestroy();
          }, afterMs);
          response.on("close", () => clearTimeout(timer));
        }
        streamBuffer(request, response, serverState.media.loopTs, key, {});
        return;
      }
      streamBuffer(request, response, serverState.media.loopTs, key, {});
    };
    if (delayMs > 0) setTimeout(start, delayMs);
    else start();
    return;
  }

  if (url.pathname === "/ts/audio") {
    const key = "ts/audio";
    recordConnection(key);
    response.on("close", () => finishConnection(key));
    response.writeHead(200, { "content-type": "video/mp2t", "cache-control": "no-store" });
    streamBuffer(request, response, serverState.media.audioTs, key, {});
    return;
  }

  const hlsMatch = url.pathname.match(/^\/hls\/([a-z-]+)\/(index\.m3u8|seg\d+\.ts)$/);
  if (hlsMatch && MODES.has(hlsMatch[1])) {
    const mode = hlsMatch[1];
    const file = hlsMatch[2];
    const key = `hls/${mode}`;
    recordConnection(key);
    response.on("close", () => finishConnection(key));
    const { afterMs, delayMs } = parseControl(url, mode === "stall" ? 8 : 6);

    if (mode === "forbidden") return sendStatus(response, 403, "forbidden\n");
    if (mode === "error") return sendStatus(response, 500, "internal error\n");
    if (mode === "flaky") {
      const attempts = serverState.flakyAttempts.get(key) ?? 0;
      serverState.flakyAttempts.set(key, attempts + 1);
      if (attempts === 0) {
        finishConnection(key);
        return sendStatus(response, 403, "forbidden once\n");
      }
    }

    const respond = () => {
      if (file === "index.m3u8") {
        if (mode === "live") {
          const windowSize = 3;
          const segmentCount = serverState.media.hlsSegments.length;
          const position = Math.floor((Date.now() - serverState.startedAt) / 2_000);
          const first = Math.max(0, position - windowSize + 1);
          const lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            "#EXT-X-TARGETDURATION:2",
            `#EXT-X-MEDIA-SEQUENCE:${first}`,
          ];
          for (let index = first; index <= position; index += 1) {
            lines.push("#EXTINF:2.000000,", serverState.media.hlsSegments[index % segmentCount]);
          }
          response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" });
          response.end(lines.join("\n") + "\n");
          return;
        }
        const wanted = ["seg000.ts", "seg001.ts", "seg002.ts"];
        const lines = [
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          "#EXT-X-TARGETDURATION:2",
          "#EXT-X-MEDIA-SEQUENCE:0",
        ];
        if (mode !== "stall") lines.push("#EXT-X-PLAYLIST-TYPE:VOD");
        for (const segment of wanted) {
          lines.push("#EXTINF:2.000000,", segment);
        }
        if (mode === "clean" || mode === "close" || mode === "reset") lines.push("#EXT-X-ENDLIST");
        response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" });
        response.end(lines.join("\n") + "\n");
        return;
      }
      const segmentPath = path.join(serverState.media.hlsDir, file);
      if (!fs.existsSync(segmentPath)) return sendStatus(response, 404, "no segment\n");
      const body = fs.readFileSync(segmentPath);
      countBytes(key, body.length);
      response.writeHead(200, { "content-type": "video/mp2t", "cache-control": "no-store" });
      if (mode === "stall" && file === "seg002.ts") {
        response.write(body.subarray(0, Math.floor(body.length / 2)));
        return;
      }
      if (mode === "reset" && file === "seg002.ts" && request.socket && !request.socket.destroyed) {
        request.socket.resetAndDestroy();
        return;
      }
      response.end(body);
      if (mode === "close" && file === "seg002.ts") {
        setTimeout(() => response.destroy(), afterMs);
      }
    };
    if (delayMs > 0) setTimeout(respond, delayMs);
    else respond();
    return;
  }

  sendStatus(response, 404, "not found\n");
}

const options = parseArgs(process.argv.slice(2));
serverState.port = options.port;
serverState.media = ensureMediaFiles(options.mediaDir);

const server = http.createServer(handleRequest);
server.on("connection", (socket) => {
  socket.setNoDelay(true);
});
server.listen(options.port, "127.0.0.1", () => {
  console.log(`onyx stream harness listening on http://127.0.0.1:${options.port}`);
  console.log(`playlist: http://127.0.0.1:${options.port}/harness.m3u`);
  console.log(`stats:    http://127.0.0.1:${options.port}/stats`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
