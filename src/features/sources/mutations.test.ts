import { test } from "node:test";
import assert from "node:assert";
import { createSourceMutationCoordinator } from "./mutations.ts";

interface SourceState {
  id: string;
  credential: string;
}

function source(id: string, credential: string): SourceState {
  return { id, credential };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("a delayed credential clear performs deletion but cannot overwrite a newer replacement edit", async () => {
  const mutations = createSourceMutationCoordinator<SourceState>();
  const original = source("source-a", "old-credential");
  let current = original;
  let deletionCompleted = false;
  const deletion = deferred();
  const clear = mutations.begin(original.id, original);
  const delayedClear = deletion.promise.then(() => {
    deletionCompleted = true;
    if (mutations.canCommit(clear, current)) current = source(original.id, "");
  });

  const replacement = mutations.begin(original.id, original);
  assert.equal(mutations.canCommit(replacement, current), true);
  current = source(original.id, "replacement-credential");
  deletion.resolve();
  await delayedClear;

  assert.equal(deletionCompleted, true);
  assert.equal(current.credential, "replacement-credential");
});

test("an edit started while source deletion waits prevents the delayed removal", async () => {
  const mutations = createSourceMutationCoordinator<SourceState>();
  const original = source("source-a", "credential");
  let current: SourceState | undefined = original;
  const deletion = deferred();
  const removal = mutations.begin(original.id, original);
  const delayedRemoval = deletion.promise.then(() => {
    if (mutations.canCommit(removal, current)) current = undefined;
  });

  const edit = mutations.begin(original.id, original);
  assert.equal(mutations.canCommit(edit, current), true);
  current = source(original.id, "edited-credential");
  deletion.resolve();
  await delayedRemoval;

  assert.equal(current.credential, "edited-credential");
});

test("mutations for independent sources remain current", () => {
  const mutations = createSourceMutationCoordinator<SourceState>();
  const sourceA = source("source-a", "credential-a");
  const sourceB = source("source-b", "credential-b");
  const mutationA = mutations.begin(sourceA.id, sourceA);
  const mutationB = mutations.begin(sourceB.id, sourceB);

  assert.equal(mutations.canCommit(mutationA, sourceA), true);
  assert.equal(mutations.canCommit(mutationB, sourceB), true);
});

test("the current delayed credential clear commits after deletion", async () => {
  const mutations = createSourceMutationCoordinator<SourceState>();
  const original = source("source-a", "credential");
  let current = original;
  const deletion = deferred();
  const clear = mutations.begin(original.id, original);
  const delayedClear = deletion.promise.then(() => {
    if (mutations.canCommit(clear, current)) current = source(original.id, "");
  });

  deletion.resolve();
  await delayedClear;

  assert.equal(current.credential, "");
});

test("a mutation cannot commit after the source disappears or its object identity changes", () => {
  const mutations = createSourceMutationCoordinator<SourceState>();
  const original = source("source-a", "credential");
  const mutation = mutations.begin(original.id, original);

  assert.equal(mutations.canCommit(mutation, source(original.id, "credential")), false);
  assert.equal(mutations.canCommit(mutation, undefined), false);
});

test("a failed credential deletion remains retryable", async () => {
  const mutations = createSourceMutationCoordinator<SourceState>();
  const original = source("source-a", "credential");
  let current = original;
  let attempts = 0;
  const deleteCredential = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("keyring unavailable");
  };
  const attemptClear = async () => {
    const mutation = mutations.begin(original.id, current);
    await deleteCredential();
    if (mutations.canCommit(mutation, current)) current = source(original.id, "");
  };

  await assert.rejects(attemptClear(), /keyring unavailable/);
  assert.equal(current.credential, "credential");

  await attemptClear();
  assert.equal(attempts, 2);
  assert.equal(current.credential, "");
});

test("explicit invalidation rejects a pending mutation before asynchronous deletion", () => {
  const mutations = createSourceMutationCoordinator<SourceState>();
  const original = source("source-a", "credential");
  const pending = mutations.begin(original.id, original);

  mutations.invalidate(original.id);

  assert.equal(mutations.canCommit(pending, original), false);
});
