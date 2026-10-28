import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, symlink, lstat, truncate, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.ts';
import { Storage, MiB } from '../server/storage.ts';
import { Coordinator } from '../server/coordinator.ts';
import { MeetingCoordinator } from '../server/meeting-coordinator.ts';
import { CodexManager } from '../server/codex.ts';
import { DemoTeam } from '../server/demo-team.ts';
import { prepareNativeHome } from '../server/native-home.ts';
import { Artifacts } from '../server/artifacts.ts';
import { ProjectExecution } from '../server/project-execution.ts';
import type { Agent, ManagerProvider, MeetingConversation, MeetingTurn, OutputVersion, Step, Task } from '../server/types.ts';
import { serverFor } from '../server/http.ts';
import { once } from 'node:events';

class FastManager implements ManagerProvider {
  cleanupStorage?: ManagerProvider['cleanupStorage'];
  total: number; calls = 0;
  constructor(total = 0) { this.total = total; }
  async connect() { return { status: 'ready' as const, quota: [], model: 'fixture', error: null }; }
  async chat(thread: string | null, _prompt: string, onThread: (id: string) => void, onTurn: (id: string) => void, onEvent: (event: any) => void) {
    this.calls++; const turnId = randomUUID(); onThread(thread ?? 'fixture-thread'); onTurn(turnId); this.total += 900; onEvent({ kind: 'usage', turnId, total: this.total }); return { text: 'A completed result. ' + 'r'.repeat(12000), turnId };
  }
  close() {}
}
const step = (id: string, status: Step['status'] = 'failed', threadId = 'protected-thread'): Step => ({ id, messageId: null, turnId: 'turn', threadId, baseline: 0, reserved: 1000, used: 1000, estimated: true, status });
async function setup() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'team-storage-test-'))), state = join(dir, 'state'), folder = join(dir, 'project'); await mkdir(state); await mkdir(folder);
  const store = new Store(join(state, 'state.sqlite')), provider = new FastManager(), coordinator = new Coordinator(store, provider, true);
  await coordinator.configure({ name: 'Storage test', brief: 'Keep deliverables.', folder, credits: 1000 }); await coordinator.connect();
  return { dir, state, folder, store, provider, coordinator, storage: coordinator.storage, async close() { await coordinator.stop(); store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('usage includes runtime databases, snapshots and project dependencies without following links to shared caches', async () => {
  const c = await setup(); try {
    await mkdir(join(c.state, 'native-home')); await mkdir(join(c.folder, 'node_modules')); await writeFile(join(c.folder, 'node_modules', 'dependency'), 'p'.repeat(5000));
    await writeFile(join(c.state, 'native-home', 'runtime-file'), 'r'.repeat(8000)); await writeFile(join(c.dir, 'unrelated'), 'outside'.repeat(10000)); await symlink(c.dir, join(c.state, 'native-home', 'outside'));
    const usage = c.storage.refresh(); assert.ok(usage.runtimeBytes >= 8000 && usage.runtimeBytes < 20000); assert.ok(usage.projectBytes >= 5000 && usage.projectBytes < 20000); assert.ok(usage.databaseBytes > 0); assert.equal(usage.status, 'ok');
  } finally { await c.close(); }
});

test('native home bridges only sign-in/config paths and leaves global history, credentials and configuration untouched', async () => {
  const c = await setup(); try {
    const source = join(c.dir, 'client'); await mkdir(source); await writeFile(join(source, 'auth.json'), 'fake-auth-only'); await writeFile(join(source, 'config.toml'), '# fake config'); await mkdir(join(source, 'sessions')); await writeFile(join(source, 'sessions', 'unrelated'), 'keep');
    const home = await prepareNativeHome(c.state, true, source); assert.ok((await lstat(join(home, 'auth.json'))).isSymbolicLink()); assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), 'fake-auth-only');
    assert.equal((await c.storage.refresh()).runtimeBytes < 10000, true); c.storage.cleanupFiles(Date.now(), true);
    assert.equal(await readFile(join(source, 'sessions', 'unrelated'), 'utf8'), 'keep'); assert.equal(await readFile(join(source, 'auth.json'), 'utf8'), 'fake-auth-only'); assert.ok((await lstat(join(home, 'auth.json'))).isSymbolicLink());
  } finally { await c.close(); }
});

test('app budget pauses all reservation paths before inference or credits and cleanup requires explicit reconnect/Resume', async () => {
  const c = await setup(); try {
    c.coordinator.saveStoragePolicy({ appMiB: 64, projectMiB: 64, logsMiB: 1, retentionDays: 7 }); c.coordinator.mode('running');
    await mkdir(join(c.state, 'codex-logs')); const log = join(c.state, 'codex-logs', 'large.log'); await writeFile(log, ''); await truncate(log, 49 * MiB);
    assert.throws(() => c.coordinator.send('blocked-manager', 'Start', null), /app_storage_limit/); assert.equal(c.store.project()!.mode, 'paused');
    const task = { id: 'builder', estimateTokens: 1000 } as Task, agent = { id: 'writer', threadId: null, lastTotal: 0 } as Agent;
    assert.throws(() => c.store.beginTask('blocked-task', task, agent), /app_storage_limit/);
    assert.throws(() => c.store.beginMeeting({ id: 'blocked-meeting' } as MeetingTurn, {} as MeetingConversation, 1000), /app_storage_limit/);
    assert.equal(c.provider.calls, 0); assert.equal(c.store.steps().length, 0); assert.equal(c.store.balance().reserved, 0);
    await c.coordinator.cleanupStorage(); assert.equal(c.storage.current.status, 'ok'); assert.equal(c.coordinator.connection.status, 'offline'); assert.equal(c.store.project()!.mode, 'paused');
    await c.coordinator.connect(); c.coordinator.mode('running'); c.coordinator.send('allowed-manager', 'Start now', null); await c.coordinator.active; assert.equal(c.provider.calls, 1);
  } finally { await c.close(); }
});

test('project size guard counts generated build files and never removes project data', async () => {
  const c = await setup(); try {
    let cutoff = 0; c.provider.cleanupStorage = async (_protected, before) => { cutoff = before; return []; };
    c.coordinator.saveStoragePolicy({ appMiB: 64, projectMiB: 64, logsMiB: 1, retentionDays: 7 }); const file = join(c.folder, 'large-build.bin'); await writeFile(file, ''); await truncate(file, 64 * MiB);
    assert.throws(() => c.coordinator.mode('running'), /project_storage_limit/); await c.coordinator.cleanupStorage(); assert.equal((await lstat(file)).size, 64 * MiB); assert.equal(c.storage.current.reason, 'project_storage_limit'); assert.equal(c.provider.calls, 0); assert.ok(cutoff < Date.now() - 6 * 86400000, 'project pressure does not discard recent native history');
  } finally { await c.close(); }
});

test('cleanup protects all published versions, recovery candidates and pending exports, and removes only unreferenced snapshots', async () => {
  const c = await setup(); try {
    const artifacts = new Artifacts(c.store), task = { id: 'task', milestoneId: 'milestone' } as Task;
    const accepted = await artifacts.capture(task, 'writer', 'Accepted', 'accepted.md', 'Accepted content'); c.store.write('outputs', accepted.id, { ...accepted, status: 'accepted' });
    const recovery = await artifacts.capture(task, 'writer', 'Recovery', 'recovery.md', 'Keep recovery'); c.store.write('steps', 'interrupted', step('interrupted')); c.store.checkpoint('interrupted', { outputs: [recovery], state: 'unknown', prompt: 'Keep exact recovery context' });
    const pending = await artifacts.capture(task, 'writer', 'Pending export', 'pending.md', 'Keep export'); c.store.write('checkpoints', 'pending', { payload: { outputs: [{ version: pending }] }, status: 'unsynced' });
    const orphan = await artifacts.capture(task, 'writer', 'Unused', 'unused.md', 'Orphan'); const original = await artifacts.content(accepted.id);
    await c.coordinator.cleanupStorage(); assert.equal(await artifacts.content(accepted.id), original); assert.equal(await artifacts.verify(recovery), 'Keep recovery'); assert.equal(await artifacts.verify(pending), 'Keep export');
    assert.equal(await artifacts.verify(orphan), 'Orphan', 'young orphans remain during normal cleanup'); c.storage.cleanupFiles(Date.now(), true);
    await assert.rejects(artifacts.verify(orphan), /ENOENT/); assert.equal(c.store.journal('interrupted').prompt, 'Keep exact recovery context'); assert.equal(c.store.read<any>('checkpoints', 'pending')!.status, 'unsynced');
  } finally { await c.close(); }
});

test('completed journals and activity are pruned while ledger, messages, recovered attempts and deduplication survive', async () => {
  const c = await setup(); try {
    for (let index = 0; index < 30; index++) { const s = step(`completed-${index}`, 'complete'); c.store.write('steps', s.id, s); c.store.checkpoint(s.id, { prompt: 'Redundant ' + 'p'.repeat(10000), result: { text: 'Result', turnId: 'turn' } }); }
    c.store.checkpoint('completed-0', { state: 'recovered', summary: 'User restored this.' }); c.store.write('steps', 'failed', step('failed')); c.store.checkpoint('failed', { prompt: 'Preserve failed context' });
    c.store.once('durable-command', () => {}); for (let i = 0; i < 800; i++) c.store.log('Activity'); const used = c.store.balance().used;
    const removed = c.storage.cleanupFiles(); assert.ok(removed.records >= 309); assert.equal(c.store.all('steps').length, 31); assert.equal(c.store.balance().used, used); assert.equal(c.store.journal('failed').prompt, 'Preserve failed context'); assert.equal(c.store.journal('completed-0').state, 'recovered'); assert.equal(c.store.journal('completed-1').prompt, undefined); assert.equal(c.store.journal('completed-29').result?.text, 'Result'); assert.equal(c.store.read('settings', 'command:durable-command'), true);
    assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM activity').get()?.n, 500);
  } finally { await c.close(); }
});

test('cleanup refuses changed directory roots and does not follow snapshot/log symlinks outside managed storage', async () => {
  const c = await setup(); try {
    const outside = join(c.dir, 'outside'); await mkdir(outside); await writeFile(join(outside, 'important.log'), 'Keep me'); await symlink(outside, join(c.state, 'codex-logs'));
    assert.equal(c.storage.refresh().status, 'unavailable'); await assert.rejects(c.coordinator.cleanupStorage(), /storage_scan_incomplete/); assert.equal(await readFile(join(outside, 'important.log'), 'utf8'), 'Keep me');
  } finally { await c.close(); }
});

test('native cleanup deletes only eligible private threads, protects recovery ancestors and resets actor references before deletion', async () => {
  const c = await setup(); try {
    const home = await prepareNativeHome(c.state, false); await mkdir(join(home, 'sessions'), { recursive: true }); const fixture = join(c.dir, 'threads.json');
    const make = (id: string, path = join(home, 'sessions', `${id}.jsonl`)) => ({ id, path, updatedAt: 1, status: { type: 'idle' } });
    const threads = [make('completed'), make('protected'), make('parent'), { ...make('protected-child'), parentThreadId: 'parent' }, make('unrelated', join(c.dir, 'global-chat.jsonl'))]; await writeFile(fixture, JSON.stringify(threads));
    for (const thread of threads) await writeFile(thread.path, 'fixture history');
    c.store.saveProject({ ...c.store.project()!, threadId: 'completed', lastTotal: 123 });
    const driver = new CodexManager(c.state, process.execPath, [fileURLToPath(new URL('./storage-codex.mjs', import.meta.url)), fixture]);
    const removed = await driver.cleanupStorage(new Set(['protected', 'protected-child']), Date.now(), id => c.storage.forgetThread(id));
    assert.deepEqual(removed, ['completed']); assert.equal(c.store.project()!.threadId, null); assert.equal(c.store.project()!.lastTotal, 0);
    const calls = await readFile(fixture + '.calls', 'utf8'); assert.equal(calls.includes('turn/start'), false); assert.equal(calls.includes('thread/resume'), false); assert.equal(calls.split('\n').filter(m => m === 'thread/delete').length, 1);
    assert.equal(await readFile(join(c.dir, 'global-chat.jsonl'), 'utf8'), 'fixture history'); assert.ok(JSON.parse(await readFile(fixture, 'utf8')).some((t: any) => t.id === 'parent'));
  } finally { await c.close(); }
});

test('legacy migration retains native attempt identity and recovery while moving future conversations into private history', async () => {
  const c = await setup(); try {
    c.store.saveProject({ ...c.store.project()!, threadId: 'old-manager', lastTotal: 100 }); c.store.write('steps', 'legacy-failure', step('legacy-failure', 'interrupted', 'old-worker')); c.store.checkpoint('legacy-failure', { prompt: 'Exact old prompt' });
    assert.deepEqual(c.storage.migrateLegacyThreads().sort(), ['old-manager', 'old-worker']); assert.equal(c.store.project()!.threadId, null); assert.equal(c.store.read<Step>('steps', 'legacy-failure')!.threadId, 'old-worker'); assert.equal(c.store.journal('legacy-failure').prompt, 'Exact old prompt');
    c.store.saveProject({ ...c.store.project()!, threadId: 'new-private-thread' }); c.storage.migrateLegacyThreads(); assert.equal(c.store.project()!.threadId, 'new-private-thread', 'migration is one-time');
  } finally { await c.close(); }
});

test('worker commands recheck capacity before and after execution and stop further command dispatch', async () => {
  let allowed = true, calls = 0;
  const c = await setup(); try {
    const execution = new ProjectExecution(c.folder, 'test', c.state, async () => { calls++; allowed = false; return { exitCode: 0, stdout: '', stderr: '' }; }, () => { if (!allowed) throw new Error('project_storage_limit'); }); execution.verified = true;
    await assert.rejects(execution.command(['/usr/bin/true']), /project_storage_limit/); await assert.rejects(execution.command(['/usr/bin/true']), /project_storage_limit/); assert.equal(calls, 1);
  } finally { await c.close(); }
});

test('100 saved sessions keep disposable data bounded without losing conversations, credits or commands', async () => {
  const c = await setup(); let store = c.store, coordinator = c.coordinator, peakBytes = 0;
  try {
    coordinator.saveStoragePolicy({ appMiB: 64, projectMiB: 64, logsMiB: 1, retentionDays: 7 }); await mkdir(join(c.state, 'codex-logs'));
    for (let index = 0; index < 100; index++) {
      if (index) { store = new Store(join(c.state, 'state.sqlite')); coordinator = new Coordinator(store, new FastManager(store.project()!.lastTotal), true); await coordinator.connect(); }
      coordinator.mode('running'); coordinator.send(`session-${index}`, `Session ${index}`, null); await coordinator.active;
      await writeFile(join(c.state, 'codex-logs', `session-${index}.log`), 'l'.repeat(512 * 1024)); await coordinator.stop(); await coordinator.cleanupStorage(true);
      const usage = coordinator.storage.current; peakBytes = Math.max(peakBytes, usage.appBytes); assert.ok(usage.appBytes < 16 * MiB, '100 sessions stay within the small fixture budget'); assert.equal(usage.status, 'ok');
      if (index < 99) store.close();
    }
    assert.equal(store.messages().length, 200); assert.equal(store.steps().length, 100); assert.equal(store.balance().used, 90); assert.equal(store.read<Step>('steps', 'session-0')!.status, 'complete');
    if (process.env.PROJECT_TEAM_STORAGE_REPORT) await writeFile(process.env.PROJECT_TEAM_STORAGE_REPORT, JSON.stringify({ date: new Date().toISOString(), mode: '100 simulated saved sessions; no AI inference', sessions: 100, messagesRetained: store.messages().length, stepsRetained: store.steps().length, creditsUsed: store.balance().used, generatedDiagnosticBytes: 100 * 512 * 1024, peakManagedBytesAfterCleanup: peakBytes, finalManagedBytes: coordinator.storage.current.appBytes, policy: coordinator.storage.policy(), passed: true }, null, 2) + '\n');
    const prior = coordinator.snapshot().credits.used; coordinator.send('session-0', 'Retry old request', null); assert.equal(store.balance().used, prior); assert.equal(store.messages().length, 200);
  } finally { await coordinator.stop(); store.close(); await rm(c.dir, { recursive: true, force: true }); }
});

test('storage API protects origins and validates budgets; project/state overlap is refused for file workers', async () => {
  const c = await setup(), server = serverFor(c.coordinator, { port: 4185, root: c.dir, demo: true });
  try {
    server.listen(4185, '127.0.0.1'); await once(server, 'listening');
    const post = (route: string, body = {}, origin = 'http://127.0.0.1:4185') => fetch(`http://127.0.0.1:4185/api/${route}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Project-Team': '1' }, body: JSON.stringify(body) });
    assert.equal((await post('storage-cleanup', {}, 'https://foreign.invalid')).status, 403); assert.equal((await post('storage-policy', { appMiB: 0 })).status, 400); assert.equal((await post('storage-refresh')).status, 200);
    assert.equal((await post('storage-policy', { appMiB: 64, projectMiB: 64, logsMiB: 1, retentionDays: 1 })).status, 200); assert.equal((await post('storage-cleanup')).status, 200);
    const team = new MeetingCoordinator(c.store, new DemoTeam(c.store), true); try { await assert.rejects(team.configure({ name: 'Unsafe', folder: c.dir, brief: '', credits: 100 }), /state_inside_project/); } finally { await team.stop(); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await c.close(); }
});

test('diagnostic retention removes expired logs below the size limit and keeps recent files', async () => {
  const c = await setup(); try {
    await mkdir(join(c.state, 'codex-logs')); const old = join(c.state, 'codex-logs', 'old.log'), recent = join(c.state, 'codex-logs', 'recent.log');
    await writeFile(old, 'Expired diagnostic'); await writeFile(recent, 'Recent diagnostic'); const date = new Date(Date.now() - 8 * 86400000); await utimes(old, date, date);
    c.storage.cleanupFiles(); await assert.rejects(readFile(old), /ENOENT/); assert.equal(await readFile(recent, 'utf8'), 'Recent diagnostic');
  } finally { await c.close(); }
});

test('legacy history reader rejects execution and new conversations before starting a process', async () => {
  const c = await setup(); try {
    const reader = new CodexManager(c.state, undefined, [], false);
    for (const method of ['thread/start', 'thread/resume', 'turn/start', 'command/exec']) await assert.rejects(reader.request(method), /storage_legacy_readonly/);
    assert.equal(reader.child, null);
  } finally { await c.close(); }
});
