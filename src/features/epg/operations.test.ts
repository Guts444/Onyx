import { test } from "node:test";
import assert from "node:assert";
import {
  beginEpgSourceOperation,
  createEpgOperationCoordinator,
  finishEpgSourceOperation,
  getEpgSourceCommitState,
  shouldDeleteSharedEpgCache,
} from "./operations.ts";

const source = (id: string, url: string, enabled = true) => ({ id, url, enabled });

test("delete during refresh invalidates source-specific completion before cache deletion", () => {
  const coordinator = createEpgOperationCoordinator();
  const token = coordinator.start("epg-a", "https://guide.test/feed", "rev-a");
  coordinator.invalidate("epg-a");

  assert.equal(token.isCurrent(), false);
  assert.equal(
    coordinator.canCommit(token, getEpgSourceCommitState([], token.sourceId, token.urlKey, "rev-a")),
    false,
  );
});

test("URL edit prevents the old directory and status from committing", () => {
  const coordinator = createEpgOperationCoordinator();
  const token = coordinator.start("epg-a", "https://old.test/feed", "rev-a");
  coordinator.invalidate("epg-a");

  const current = [source("epg-a", "https://new.test/feed")];
  assert.equal(
    coordinator.canCommit(token, getEpgSourceCommitState(current, "epg-a", "https://new.test/feed", "rev-b")),
    false,
  );
});

test("latest refresh wins for one EPG source", () => {
  const coordinator = createEpgOperationCoordinator();
  const first = coordinator.start("epg-a", "https://guide.test/feed", "rev-a");
  const latest = coordinator.start("epg-a", "https://guide.test/feed", "rev-a");
  const state = getEpgSourceCommitState(
    [source("epg-a", "https://guide.test/feed")],
    "epg-a",
    "https://guide.test/feed",
    "rev-a",
  );

  assert.equal(coordinator.canCommit(first, state), false);
  assert.equal(coordinator.canCommit(latest, state), true);
});

test("stale finally cannot clear the latest source updating state", () => {
  const coordinator = createEpgOperationCoordinator();
  const first = coordinator.start("epg-a", "https://guide.test/feed", "rev-a");
  const firstBusy = beginEpgSourceOperation(first);
  const latest = coordinator.start("epg-a", "https://guide.test/feed", "rev-a");
  const latestBusy = beginEpgSourceOperation(latest);

  assert.strictEqual(finishEpgSourceOperation(latestBusy, first), latestBusy);
  assert.equal(finishEpgSourceOperation(firstBusy, first), null);
  assert.equal(finishEpgSourceOperation(latestBusy, latest), null);
});

test("shared normalized URL is deleted only after its last profile is removed", () => {
  const sources = [
    source("epg-a", " HTTPS://Guide.Test/feed "),
    source("epg-b", "https://guide.test/feed"),
    source("epg-c", "https://other.test/feed"),
  ];

  assert.equal(shouldDeleteSharedEpgCache(sources, "epg-a"), false);
  assert.equal(shouldDeleteSharedEpgCache(sources, "epg-c"), true);
});

test("cache deletion does not collide case-sensitive paths or queries", () => {
  const sources = [
    source("epg-a", "https://guide.test/Guide.xml?Token=A"),
    source("epg-b", "https://guide.test/guide.xml?token=a"),
  ];

  assert.equal(shouldDeleteSharedEpgCache(sources, "epg-a"), true);
});

test("operation commit deduplicates equivalent scheme and host casing", () => {
  const coordinator = createEpgOperationCoordinator();
  const token = coordinator.start("epg-a", "HTTPS://Guide.Test:443/Guide.xml?Token=A#one", "rev-a");
  const state = getEpgSourceCommitState(
    [source("epg-a", "https://guide.test/Guide.xml?Token=A#two")],
    "epg-a",
    "https://ignored.test",
    "rev-a",
  );

  assert.equal(coordinator.canCommit(token, state), true);
});
