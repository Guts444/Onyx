import { test } from "node:test";
import assert from "node:assert";
import {
  beginEpgSourceOperation,
  createEpgOperationCoordinator,
  finishEpgSourceOperation,
  getEpgSourceCommitState,
} from "./operations.ts";

const source = (id: string, updatedAt: string) => ({ id, updatedAt });

test("delete or disable invalidates source-specific completion", () => {
  const coordinator = createEpgOperationCoordinator();
  const token = coordinator.start("epg-a", "rev-a");
  coordinator.invalidate("epg-a");
  assert.equal(token.isCurrent(), false);
  assert.equal(coordinator.canCommit(token, getEpgSourceCommitState([], "epg-a", "rev-a")), false);
});

test("source revision edit prevents an old refresh from committing", () => {
  const coordinator = createEpgOperationCoordinator();
  const token = coordinator.start("epg-a", "rev-a");
  assert.equal(
    coordinator.canCommit(token, getEpgSourceCommitState([source("epg-a", "rev-b")], "epg-a", "rev-b")),
    false,
  );
});

test("latest refresh wins independently for duplicate-URL source profiles", () => {
  const coordinator = createEpgOperationCoordinator();
  const firstA = coordinator.start("epg-a", "rev-a");
  const latestA = coordinator.start("epg-a", "rev-a");
  const sourceB = coordinator.start("epg-b", "rev-b");
  assert.equal(coordinator.canCommit(firstA, getEpgSourceCommitState([source("epg-a", "rev-a")], "epg-a", "rev-a")), false);
  assert.equal(coordinator.canCommit(latestA, getEpgSourceCommitState([source("epg-a", "rev-a")], "epg-a", "rev-a")), true);
  assert.equal(coordinator.canCommit(sourceB, getEpgSourceCommitState([source("epg-b", "rev-b")], "epg-b", "rev-b")), true);
});

test("operation identity and busy fingerprints contain no EPG URL", () => {
  const privateUrl = "https://guide.invalid/feed?token=secret";
  const coordinator = createEpgOperationCoordinator();
  const token = coordinator.start("epg-a", "rev-a");
  const busy = beginEpgSourceOperation(token);
  assert.equal(JSON.stringify(token).includes(privateUrl), false);
  assert.equal(JSON.stringify(busy).includes(privateUrl), false);
  assert.equal(Object.prototype.hasOwnProperty.call(token, "urlKey"), false);
});

test("stale finally cannot clear the latest source updating state", () => {
  const coordinator = createEpgOperationCoordinator();
  const first = coordinator.start("epg-a", "rev-a");
  const firstBusy = beginEpgSourceOperation(first);
  const latest = coordinator.start("epg-a", "rev-a");
  const latestBusy = beginEpgSourceOperation(latest);
  assert.strictEqual(finishEpgSourceOperation(latestBusy, first), latestBusy);
  assert.equal(finishEpgSourceOperation(firstBusy, first), null);
  assert.equal(finishEpgSourceOperation(latestBusy, latest), null);
});
