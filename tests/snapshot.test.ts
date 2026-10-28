import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestSnapshot } from '../src/snapshot.ts';
import { Store } from '../server/store.ts';
import { Coordinator } from '../server/coordinator.ts';
import { DemoManager } from '../server/codex.ts';

test('a delayed HTTP snapshot cannot replace a newer event-stream result, including across a coordinator restart', () => {
  const store = new Store(':memory:');
  try {
    const coordinator = new Coordinator(store, new DemoManager());
    const exporting = coordinator.snapshot(), synced = coordinator.snapshot();
    assert.equal(latestSnapshot(synced, exporting), synced); assert.equal(latestSnapshot(exporting, synced), synced); assert.equal(latestSnapshot(null, synced), synced);
    const restarted = new Coordinator(store, new DemoManager()).snapshot();
    assert.equal(latestSnapshot(synced, restarted), restarted);
    assert.equal(latestSnapshot(restarted, { ...restarted, revision: undefined }).revision, undefined, 'older local coordinators remain compatible');
  } finally { store.close(); }
});
