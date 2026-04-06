import { performance } from "perf_hooks";

// Mock data
const channels = Array.from({ length: 50000 }, (_, i) => ({ id: `channel-${i}` }));
const resolvedEpgMatchesByChannelId: Record<string, any> = {};
const epgSnapshotsByChannelKey: Record<string, any> = {};

for (let i = 0; i < 50000; i++) {
  if (i % 2 === 0) {
    const uniqueId = `epg-${i}`;
    resolvedEpgMatchesByChannelId[`channel-${i}`] = { epgChannel: { uniqueId }, matchSource: "auto" };
    epgSnapshotsByChannelKey[uniqueId] = { current: { title: "Current" }, next: { title: "Next" } };
  }
}

// Baseline: calculate all upfront
function baseline() {
  const start = performance.now();
  const nextGuides: Record<string, any> = {};

  for (const channel of channels) {
    const resolvedMatch = resolvedEpgMatchesByChannelId[channel.id];

    if (!resolvedMatch) {
      continue;
    }

    const guideSnapshot = epgSnapshotsByChannelKey[resolvedMatch.epgChannel.uniqueId];

    nextGuides[channel.id] = {
      ...resolvedMatch,
      current: guideSnapshot?.current ?? null,
      next: guideSnapshot?.next ?? null,
    };
  }
  const end = performance.now();
  return { time: end - start, result: nextGuides };
}

// Optimized: getter function
function optimized() {
  const start = performance.now();
  const getGuideForChannelId = (channelId: string) => {
    const resolvedMatch = resolvedEpgMatchesByChannelId[channelId];

    if (!resolvedMatch) {
      return null;
    }

    const guideSnapshot = epgSnapshotsByChannelKey[resolvedMatch.epgChannel.uniqueId];

    return {
      ...resolvedMatch,
      current: guideSnapshot?.current ?? null,
      next: guideSnapshot?.next ?? null,
    };
  };

  // Simulate rendering just the visible channels (e.g., 50 channels)
  const visibleChannels = channels.slice(0, 50);
  for (const channel of visibleChannels) {
    getGuideForChannelId(channel.id);
  }

  const end = performance.now();
  return { time: end - start };
}

const b = baseline();
console.log(`Baseline time: ${b.time.toFixed(2)} ms`);
const o = optimized();
console.log(`Optimized time: ${o.time.toFixed(2)} ms`);
