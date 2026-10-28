import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.ts';
import { Coordinator } from '../server/coordinator.ts';
import { CodexManager, DemoManager, quotaWindows } from '../server/codex.ts';
import { serverFor } from '../server/http.ts';
import type { ManagerProvider, Connection, ProviderEvent } from '../server/types.ts';
import { fileURLToPath } from 'node:url';

for (const testCase of ['disconnect-account', 'disconnect-thread']) test(`failure during ${testCase} releases an undispatched reservation`, async () => {
  const context = await setup();
  process.env.PROJECT_TEAM_TEST_CASE = testCase;
  const provider = new CodexManager(context.dir, process.execPath, [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))]);
  try {
    const coordinator = new Coordinator(context.store, provider);
    await coordinator.connect(); delete process.env.PROJECT_TEAM_TEST_CASE;
    coordinator.mode('running'); coordinator.send('setup-failure', 'Hello', null); await coordinator.active;
    assert.equal(context.store.read<any>('steps', 'setup-failure').status, 'failed');
    assert.equal(coordinator.snapshot().connection.error, 'provider_closed');
    assert.equal(context.store.balance().reserved, 0);
    assert.equal(context.store.balance().used, 0);
    assert.equal(context.store.balance().estimated, 0);
  } finally { delete process.env.PROJECT_TEAM_TEST_CASE; provider.close(); await context.close(); }
});

test('a late event after listener eviction cannot charge the current response', async () => {
  const context = await setup();
  process.env.PROJECT_TEAM_TEST_CASE = 'evicted-event';
  const provider = new CodexManager(context.dir, process.execPath, [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))]);
  try {
    const coordinator = new Coordinator(context.store, provider);
    await coordinator.connect(); delete process.env.PROJECT_TEAM_TEST_CASE; coordinator.mode('running');
    for (let index = 1; index <= 35; index++) {
      coordinator.send(`eviction-${index}`, `Instruction ${index}`, null); await coordinator.active;
      assert.equal(context.store.read<any>('steps', `eviction-${index}`).status, 'complete');
    }
    assert.equal(context.store.read<any>('steps', 'eviction-35').turnId, 'fixture-35');
    assert.equal(context.store.balance().used, 42);
    assert.equal(context.store.balance().estimated, 0);
    assert.equal(coordinator.snapshot().connection.model, 'fixture-model');
  } finally { delete process.env.PROJECT_TEAM_TEST_CASE; provider.close(); await context.close(); }
});

test('a disconnect after dispatch attempts retains estimated usage and recovery', async () => {
  const context = await setup(); process.env.PROJECT_TEAM_TEST_CASE = 'disconnect-dispatch';
  const provider = new CodexManager(context.dir, process.execPath, [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))]);
  try {
    const coordinator = new Coordinator(context.store, provider);
    await coordinator.connect(); delete process.env.PROJECT_TEAM_TEST_CASE; coordinator.mode('running');
    coordinator.send('uncertain-dispatch', 'Hello', null); await coordinator.active;
    const step = context.store.read<any>('steps', 'uncertain-dispatch');
    assert.equal(step.status, 'failed'); assert.equal(step.turnId, null);
    assert.equal(context.store.balance().reserved, 0); assert.equal(context.store.balance().estimated, 1.44);
    assert.equal(context.store.project()!.mode, 'recovery');
  } finally { delete process.env.PROJECT_TEAM_TEST_CASE; provider.close(); await context.close(); }
});

test('the coordinator ignores provider events with an unrelated turn identity', async () => {
  const context = await setup();
  const provider: ManagerProvider = {
    connect: async () => ({ status: 'ready', quota: [], model: null, error: null }),
    chat: async (_thread, _prompt, onThread, onTurn, onEvent, onDispatchAttempt) => {
      onThread('thread'); onDispatchAttempt?.(); onTurn('current-turn');
      onEvent({ kind: 'usage', turnId: 'unrelated-turn', total: 900000 });
      onEvent({ kind: 'usage', turnId: 'current-turn', total: 900 });
      return { text: 'Correct reply', turnId: 'current-turn' };
    }, close() {},
  };
  try {
    const coordinator = new Coordinator(context.store, provider); await coordinator.connect(); coordinator.mode('running');
    coordinator.send('identity-check', 'Hello', null); await coordinator.active;
    assert.equal(context.store.balance().used, .9); assert.equal(context.store.balance().estimated, 0);
  } finally { await context.close(); }
});

async function setup() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'project-team-test-')));
  const store = new Store(join(dir, 'state.sqlite'));
  store.saveProject({ name: 'Test', folder: dir, brief: 'A small assignment', credits: 100, mode: 'running', threadId: null, lastTotal: 0 });
  return { dir, store, close: async () => { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('reservations, duplicate dispatch and cumulative usage settle once, including late corrections', async () => {
  const context = await setup(); const { store } = context;
  try {
    const first = store.begin('command-1', 'Hello', null, 1000);
    assert.equal(first.reserved, 1200);
    assert.equal(store.begin('command-1', 'Hello', null, 1000).id, first.id);
    assert.equal(store.messages().length, 1);
    assert.equal(store.balance().available, 98.8);
    store.thread(first.id, 'thread-1'); store.dispatched(first.id, 'turn-1');
    store.usage(first.id, 800); store.usage(first.id, 800);
    store.finish(first.id, 'complete', 'Reply'); store.finish(first.id, 'complete', 'Reply');
    assert.equal(store.balance().used, .8); assert.equal(store.messages().length, 2);
    store.begin('command-2', 'Again', null, 1000); store.thread('command-2', 'thread-1'); store.dispatched('command-2', 'turn-2'); store.finish('command-2', 'complete', 'Second reply');
    assert.equal(store.balance().used, 2); // reserve settled as estimate
    store.usage('command-2', 1300); store.usage('command-2', 1300);
    assert.equal(store.balance().used, 1.3); assert.equal(store.balance().reserved, 0);
  } finally { await context.close(); }
});

test('pause, budget caps and interrupted recovery do not dispatch or lose reserved credits', async () => {
  const context = await setup(); const { store } = context;
  try {
    store.saveProject({ ...store.project()!, credits: 1 });
    assert.throws(() => store.begin('limited', 'Hi', null, 1000), /credit_limit/);
    assert.equal(store.messages().length, 0);
    store.saveProject({ ...store.project()!, credits: 100, mode: 'paused' });
    assert.throws(() => store.begin('paused', 'Hi', null, 1000), /project_paused/);
    store.saveProject({ ...store.project()!, mode: 'running' });
    store.begin('reserved', 'Hi', null, 1000); store.recover();
    assert.equal(store.project()!.mode, 'recovery'); assert.equal(store.balance().used, 0);
    store.saveProject({ ...store.project()!, mode: 'running' });
    store.begin('started', 'Hi', null, 1000); store.dispatched('started', 'turn'); store.recover();
    assert.equal(store.balance().used, 1.2); assert.equal(store.balance().reserved, 0); assert.equal(store.messages().at(-1)!.status, 'interrupted');
  } finally { await context.close(); }
});

test('saved conversation and recovery state survive reopening the database', async () => {
  const context = await setup();
  context.store.begin('restart-1', 'Keep this instruction', 'brief', 1000);
  context.store.dispatched('restart-1', 'running-turn'); context.store.close();
  const reopened = new Store(join(context.dir, 'state.sqlite'));
  try {
    reopened.recover(); assert.equal(reopened.messages()[0].text, 'Keep this instruction');
    assert.equal(reopened.project()!.mode, 'recovery'); assert.equal(reopened.balance().used, 1.2);
  } finally { reopened.close(); await rm(context.dir, { recursive: true, force: true }); }
});

test('provider metadata is sanitized and out-of-order completion supports a second turn', async () => {
  const context = await setup();
  const provider = new CodexManager(context.dir, process.execPath, [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))]);
  try {
    const connection = await provider.connect(); assert.equal(connection.status, 'ready');
    assert.equal(JSON.stringify(connection).includes('FAKE-PRIVATE'), false);
    assert.equal(connection.quota[0].usedPercent, 71);
    const events: ProviderEvent[] = [];
    assert.equal((await provider.chat(null, 'one', () => {}, () => {}, event => events.push(event))).text, 'Saved conversation 1.');
    assert.equal((await provider.chat('fixture-thread', 'two', () => {}, () => {}, event => events.push(event))).text, 'Saved conversation 2.');
    assert.deepEqual(events.filter(event => event.kind === 'usage').map(event => event.total), [1200, 2400]);
  } finally { provider.close(); await context.close(); }
});

for (const [testCase, expected] of [['api-auth', 'wrong_authentication'], ['signed-out', 'sign_in_required'], ['unsafe-tools', 'tool_configuration_unverified']] as const) test(`provider refuses ${testCase} before inference`, async () => {
  const context = await setup();
  process.env.PROJECT_TEAM_TEST_CASE = testCase;
  const provider = new CodexManager(context.dir, process.execPath, [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))]);
  delete process.env.PROJECT_TEAM_TEST_CASE; // spawn reads env at connect; set until spawned below
  try {
    process.env.PROJECT_TEAM_TEST_CASE = testCase;
    if (testCase === 'unsafe-tools') await assert.rejects(provider.connect(), new RegExp(expected));
    else { assert.equal((await provider.connect()).status, expected); await assert.rejects(provider.chat(null, 'never run', () => {}, () => {}, () => {}), new RegExp(expected)); }
  } finally { delete process.env.PROJECT_TEAM_TEST_CASE; provider.close(); await context.close(); }
});

test('graceful Stop waits for the response; pause blocks new work but saves the active response', async () => {
  const context = await setup(); let finish: (() => void) | undefined; let closed = false;
  const provider: ManagerProvider = {
    connect: async (): Promise<Connection> => ({ status: 'ready', quota: [], model: null, error: null }),
    chat: async (_thread, _prompt, onThread, onTurn) => { onThread('thread'); onTurn('turn'); await new Promise<void>(resolve => { finish = resolve; }); return { text: 'Finished safely', turnId: 'turn' }; },
    close: () => { closed = true; },
  };
  try {
    const coordinator = new Coordinator(context.store, provider); await coordinator.connect(); coordinator.mode('running');
    coordinator.send('command-stop', 'An instruction', null); coordinator.mode('paused');
    assert.throws(() => coordinator.send('another-command', 'Another', null), /manager_busy/);
    const stopping = coordinator.stop(); assert.equal(closed, false);
    await new Promise(resolve => setImmediate(resolve));
    finish!(); await stopping; assert.equal(closed, true); assert.equal(context.store.messages().at(-1)!.text, 'Finished safely');
    assert.equal(context.store.project()!.mode, 'stopped');
  } finally { await context.close(); }
});

test('local HTTP protects the coordinator from foreign origins and persists a real request flow', async () => {
  const context = await setup(); const coordinator = new Coordinator(context.store, new DemoManager(), true);
  const server = serverFor(coordinator, { port: 4178, root: context.dir, demo: true });
  await new Promise<void>(resolve => server.listen(4178, '127.0.0.1', resolve));
  const post = (route: string, input: unknown = {}) => fetch(`http://127.0.0.1:4178/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Project-Team': '1' }, body: JSON.stringify(input) });
  try {
    const bad = await fetch('http://127.0.0.1:4178/api/state', { headers: { Origin: 'https://unrelated.example' } }); assert.equal(bad.status, 403);
    const missingHeader = await fetch('http://127.0.0.1:4178/api/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(missingHeader.status, 403);
    assert.equal((await post('connect')).status, 200); assert.equal((await post('resume')).status, 200);
    const message = { id: 'http-command', text: 'Plan this project', attachment: 'brief' };
    assert.equal((await post('message', message)).status, 200); assert.equal((await post('message', message)).status, 200);
    await coordinator.active;
    const snapshot = await (await fetch('http://127.0.0.1:4178/api/state')).json();
    assert.equal(snapshot.messages.length, 2); assert.equal(snapshot.demo, true); assert.equal(snapshot.messages[1].text.includes('demo response'), true); assert.equal(snapshot.credits.used, .9);
    assert.equal((await post('pause')).status, 200); assert.equal((await post('message', { id: 'paused-http', text: 'Hi' })).status, 409);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await context.close(); }
});

test('quota percentages do not become project credits', () => { assert.deepEqual(quotaWindows({ rateLimits: { primary: { usedPercent: 71, balance: 'PRIVATE' } } }), [{ usedPercent: 71, windowDurationMins: null, resetsAt: null }]); });

test('a late prior-turn report adjusts the following baseline without double charging', async () => {
  const context = await setup(); const { store } = context;
  try {
    store.begin('late-first', 'one', null, 1000); store.thread('late-first', 'thread'); store.dispatched('late-first', 'turn-one'); store.usage('late-first', 800); store.finish('late-first', 'complete', 'one');
    store.begin('late-second', 'two', null, 1000); store.thread('late-second', 'thread'); store.dispatched('late-second', 'turn-two'); store.usage('late-second', 1500); store.finish('late-second', 'complete', 'two');
    store.usage('late-first', 1000); store.usage('late-first', 1000);
    assert.equal(store.read<any>('steps', 'late-first').used, 1000);
    assert.equal(store.read<any>('steps', 'late-second').used, 500);
    assert.equal(store.balance().used, 1.5);
  } finally { await context.close(); }
});

test('reported overruns block the next start and interrupted partial usage stays estimated', async () => {
  const context = await setup(); const { store } = context;
  try {
    store.saveProject({ ...store.project()!, credits: 2 });
    store.begin('overrun-one', 'one', null, 1000); store.thread('overrun-one', 'thread'); store.dispatched('overrun-one', 'turn'); store.usage('overrun-one', 3000); store.finish('overrun-one', 'complete', 'one');
    assert.equal(store.balance().available, -1); assert.throws(() => store.begin('overrun-two', 'two', null, 1000), /credit_limit/);
    store.saveProject({ ...store.project()!, credits: 10 });
    store.begin('partial-turn', 'partial', null, 1000); store.thread('partial-turn', 'thread'); store.dispatched('partial-turn', 'turn-two'); store.usage('partial-turn', 3100); store.recover();
    assert.equal(store.balance().estimated, 1.2); assert.equal(store.project()!.threadId, null);
    store.usage('partial-turn', 3500); assert.equal(store.balance().estimated, 0); assert.equal(store.balance().used, 3.5);
  } finally { await context.close(); }
});

test('unexpected tool activity terminates the conversation rather than accepting a result', async () => {
  const context = await setup(); process.env.PROJECT_TEAM_TEST_CASE = 'tool-activity';
  const provider = new CodexManager(context.dir, process.execPath, [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))]);
  try { await provider.connect(); await assert.rejects(provider.chat(null, 'only discuss', () => {}, () => {}, () => {}), /tool_activity_blocked/); }
  finally { delete process.env.PROJECT_TEAM_TEST_CASE; provider.close(); await context.close(); }
});

test('a new event stream restores the saved state without dispatching another response', async () => {
  const context = await setup(); const coordinator = new Coordinator(context.store, new DemoManager(), true);
  const server = serverFor(coordinator, { port: 4179, root: context.dir, demo: true });
  await new Promise<void>(resolve => server.listen(4179, '127.0.0.1', resolve));
  try {
    await coordinator.connect(); coordinator.mode('running'); coordinator.send('sse-message', 'hello', null); await coordinator.active;
    const response = await fetch('http://127.0.0.1:4179/api/events');
    const reader = response.body!.getReader(); const chunk = await reader.read();
    const data = new TextDecoder().decode(chunk.value).split('\n').find(line => line.startsWith('data:'))!;
    const state = JSON.parse(data.slice(5)); assert.equal(state.messages.length, 2); assert.equal(state.busy, false); assert.equal(context.store.steps().length, 1);
    await reader.cancel();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await context.close(); }
});

test('native services do not inherit GitHub publishing tokens from the coordinator', async () => {
  const context = await setup(), keys = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'PROJECT_TEAM_TEST_CASE'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const provider = new CodexManager(context.dir, process.execPath, [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))]);
  try {
    for (const key of keys) process.env[key] = 'test-publishing-token'; process.env.PROJECT_TEAM_TEST_CASE = 'publishing-env';
    assert.equal((await provider.connect()).status, 'ready');
  } finally { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } provider.close(); await context.close(); }
});
