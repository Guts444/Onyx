import { test } from "node:test";
import assert from "node:assert";
import {
  beginSourceBusy,
  createSourceOperationCoordinator,
  finishSourceBusy,
} from "./operations.ts";

function operationRequest(sourceId = "source-a") {
  return {
    origin: "saved" as const,
    sourceId,
    expectedFingerprint: `config-${sourceId}`,
  };
}

test("supersession aborts and remotely cancels the old operation without cancelling the new one", () => {
  const cancelled: string[] = [];
  const ids = ["operation-old", "operation-new"];
  const operations = createSourceOperationCoordinator({
    createOperationId: () => ids.shift()!,
    cancelRemote: (operationId) => { cancelled.push(operationId); },
  });
  const oldOperation = operations.start(operationRequest("source-a"));
  const newOperation = operations.start(operationRequest("source-b"));

  assert.equal(oldOperation.signal.aborted, true);
  assert.equal(newOperation.signal.aborted, false);
  assert.deepStrictEqual(cancelled, ["operation-old"]);
  assert.equal(oldOperation.isCurrent(), false);
  assert.equal(newOperation.isCurrent(), true);
});

test("source edit and delete cancellation aborts the matching request and prevents its commit", () => {
  for (const mutation of ["edit", "delete"] as const) {
    const cancelled: string[] = [];
    const operations = createSourceOperationCoordinator({
      createOperationId: () => `operation-${mutation}`,
      cancelRemote: (operationId) => { cancelled.push(operationId); },
    });
    const token = operations.start(operationRequest());

    operations.invalidateSource("source-a");

    assert.equal(token.signal.aborted, true);
    assert.deepStrictEqual(cancelled, [`operation-${mutation}`]);
    assert.equal(operations.canCommit(token, {
      sourceId: "source-a",
      fingerprint: "config-source-a",
      exists: true,
      ready: true,
    }), false);
  }
});

test("component teardown cancels the current operation exactly once", () => {
  const cancelled: string[] = [];
  const operations = createSourceOperationCoordinator({
    createOperationId: () => "operation-teardown",
    cancelRemote: (operationId) => { cancelled.push(operationId); },
  });
  const token = operations.start(operationRequest());

  operations.cancelCurrent();
  operations.cancelCurrent();

  assert.equal(token.signal.aborted, true);
  assert.equal(token.isCurrent(), false);
  assert.deepStrictEqual(cancelled, ["operation-teardown"]);
});

test("the latest source operation is the only current operation", () => {
  const operations = createSourceOperationCoordinator();
  const operationA = operations.start({
    origin: "saved",
    sourceId: "source-a",
    expectedFingerprint: "config-a",
  });
  const operationB = operations.start({
    origin: "saved",
    sourceId: "source-b",
    expectedFingerprint: "config-b",
  });

  assert.equal(operationA.isCurrent(), false);
  assert.equal(operationB.isCurrent(), true);
});

test("editing, disabling, or deleting a source invalidates its operation", () => {
  for (const mutation of ["edit", "disable", "delete"] as const) {
    const operations = createSourceOperationCoordinator();
    const token = operations.start({
      origin: "saved",
      sourceId: "source-a",
      expectedFingerprint: "config-a",
    });

    operations.invalidateSource("source-a");

    assert.equal(token.isCurrent(), false, mutation);
  }
});

test("commit validation checks generation, source identity, fingerprint, existence, and readiness", () => {
  const operations = createSourceOperationCoordinator();
  const token = operations.start({
    origin: "saved",
    sourceId: "source-a",
    expectedFingerprint: "config-a",
  });
  const validState = {
    sourceId: "source-a",
    fingerprint: "config-a",
    exists: true,
    ready: true,
  };

  assert.equal(operations.canCommit(token, validState), true);
  assert.equal(operations.canCommit(token, { ...validState, sourceId: "source-b" }), false);
  assert.equal(operations.canCommit(token, { ...validState, fingerprint: "changed" }), false);
  assert.equal(operations.canCommit(token, { ...validState, exists: false }), false);
  assert.equal(operations.canCommit(token, { ...validState, ready: false }), false);

  operations.start({ origin: "local", sourceId: null, expectedFingerprint: "local-file-b" });
  assert.equal(operations.canCommit(token, validState), false);
});

test("an older operation finally cannot clear a newer busy state", () => {
  const operations = createSourceOperationCoordinator();
  const operationA = operations.start({
    origin: "saved",
    sourceId: "source-a",
    expectedFingerprint: "config-a",
  });
  const busyA = beginSourceBusy(operationA);
  const operationB = operations.start({
    origin: "local",
    sourceId: null,
    expectedFingerprint: "file-b",
  });
  const busyB = beginSourceBusy(operationB);

  assert.deepStrictEqual(finishSourceBusy(busyB, operationA), busyB);
  assert.equal(finishSourceBusy(busyA, operationA), null);
  assert.equal(finishSourceBusy(busyB, operationB), null);
});

test("a foreign coordinator token with the same generation cannot clear busy state", () => {
  const first = createSourceOperationCoordinator();
  const second = createSourceOperationCoordinator();
  const firstToken = first.start({
    origin: "saved",
    sourceId: "source-a",
    expectedFingerprint: "config-a",
  });
  const foreignToken = second.start({
    origin: "saved",
    sourceId: "source-a",
    expectedFingerprint: "config-a",
  });
  const busy = beginSourceBusy(firstToken);

  assert.equal(firstToken.generation, foreignToken.generation);
  assert.strictEqual(finishSourceBusy(busy, foreignToken), busy);
  assert.equal(finishSourceBusy(busy, firstToken), null);
});

test("busy state rejects forged tokens and coordinator tokens cannot be mutated", () => {
  const operations = createSourceOperationCoordinator();
  const token = operations.start({
    origin: "saved",
    sourceId: "source-a",
    expectedFingerprint: "config-a",
  });
  const busy = beginSourceBusy(token);
  const forged = { ...token } as typeof token;

  assert.throws(() => beginSourceBusy(forged), TypeError);
  assert.strictEqual(finishSourceBusy(busy, forged), busy);
  assert.throws(() => Object.assign(token, { generation: 999 }), TypeError);
  assert.equal(token.generation, 1);
});

test("coordinators are isolated and do not accept tokens from another instance", () => {
  const first = createSourceOperationCoordinator();
  const second = createSourceOperationCoordinator();
  const firstToken = first.start({ origin: "local", sourceId: null, expectedFingerprint: "a" });
  const secondToken = second.start({ origin: "local", sourceId: null, expectedFingerprint: "b" });

  assert.equal(first.isCurrent(firstToken), true);
  assert.equal(first.isCurrent(secondToken), false);
  assert.equal(second.isCurrent(firstToken), false);
  assert.equal(second.isCurrent(secondToken), true);
});

test("a startup operation cannot overwrite a later manual source selection", () => {
  const operations = createSourceOperationCoordinator();
  const startup = operations.start({
    origin: "startup",
    sourceId: "source-a",
    expectedFingerprint: "config-a",
  });
  const manual = operations.start({
    origin: "saved",
    sourceId: "source-b",
    expectedFingerprint: "config-b",
  });

  assert.equal(
    operations.canCommit(startup, {
      sourceId: "source-a",
      fingerprint: "config-a",
      exists: true,
      ready: true,
    }),
    false,
  );
  assert.equal(
    operations.canCommit(manual, {
      sourceId: "source-b",
      fingerprint: "config-b",
      exists: true,
      ready: true,
    }),
    true,
  );
});

test("local and saved imports advance the same operation generation", () => {
  const operations = createSourceOperationCoordinator();
  const local = operations.start({
    origin: "local",
    sourceId: null,
    expectedFingerprint: "local-file",
  });
  const saved = operations.start({
    origin: "saved",
    sourceId: "source-a",
    expectedFingerprint: "saved-config",
  });

  assert.equal(saved.generation, local.generation + 1);
  assert.equal(local.isCurrent(), false);
  assert.equal(saved.isCurrent(), true);
});
