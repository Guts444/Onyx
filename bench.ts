import { performance } from "perf_hooks";

interface Channel {
  id: string;
  name: string;
}

const channels: Channel[] = Array.from({ length: 50000 }, (_, i) => ({
  id: `channel_${i}`,
  name: `Channel ${i}`
}));

const recentIds: string[] = Array.from({ length: 12 }, (_, i) => `channel_${Math.floor(Math.random() * 50000)}`);

function benchOld() {
  const start = performance.now();
  for (let iter = 0; iter < 1000; iter++) {
    recentIds
      .map((recentId) => channels.find((channel) => channel.id === recentId) ?? null)
      .filter((channel): channel is Channel => channel !== null);
  }
  return performance.now() - start;
}

function benchNew() {
  // map generation is cached
  const startMap = performance.now();
  const map = new Map<string, Channel>();
  for (const channel of channels) {
    map.set(channel.id, channel);
  }
  const mapTime = performance.now() - startMap;

  const start = performance.now();
  for (let iter = 0; iter < 1000; iter++) {
    recentIds
      .map((recentId) => map.get(recentId) ?? null)
      .filter((channel): channel is Channel => channel !== null);
  }
  return { mapTime, lookupTime: performance.now() - start };
}

const oldTime = benchOld();
const { mapTime, lookupTime } = benchNew();

console.log(`Old implementation (1000 iterations): ${oldTime.toFixed(2)}ms`);
console.log(`New implementation (Map generation): ${mapTime.toFixed(2)}ms`);
console.log(`New implementation (1000 iterations): ${lookupTime.toFixed(2)}ms`);
console.log(`Improvement per iteration (excluding map caching): ${(oldTime / 1000).toFixed(4)}ms -> ${(lookupTime / 1000).toFixed(4)}ms`);
