import { test } from 'node:test';
import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { Storage, MiB, scanStorageRoots } from '../server/storage.ts';
import { CatalogStorageBudget } from '../server/catalog-storage.ts';
import { Coordinator } from '../server/coordinator.ts';
import { CodexManager, DemoManager } from '../server/codex.ts';
import { ProjectExecution } from '../server/project-execution.ts';
import { prepareNativeHome } from '../server/native-home.ts';
import type { Agent, MeetingConversation, MeetingTurn, OutputVersion, Task } from '../server/types.ts';

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'team-catalog-storage-')));
  const root = join(dir, 'state'), child = join(root, 'projects', randomUUID()), folder = join(dir, 'selected-project'), otherFolder = join(dir, 'other-project');
  await Promise.all([mkdir(child, { recursive: true }), mkdir(folder), mkdir(otherFolder)]);
  const registry = new Store(join(root, 'workspace.sqlite')), legacy = new Store(join(root, 'project-team.sqlite')), inactive = new Store(join(child, 'project-team.sqlite'));
  legacy.saveProject({ name: 'Selected', brief: 'Synthetic active project', folder, credits: 100, mode: 'paused', threadId: null, lastTotal: 0 });
  inactive.saveProject({ name: 'Other', brief: 'Synthetic inactive project', folder: otherFolder, credits: 200, mode: 'paused', threadId: null, lastTotal: 0 });
  const budget = new CatalogStorageBudget(root, registry, () => [root, child, child]);
  const storage = new Storage(legacy); storage.useCatalogBudget(budget);
  return { dir, root, child, folder, otherFolder, registry, legacy, inactive, budget, storage, async close() { registry.close(); legacy.close(); inactive.close(); await rm(dir, { recursive: true, force: true }); } };
}
const sparse = async (path: string, bytes: number) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, ''); await truncate(path, bytes); };
const diskBytes = async (path: string) => { try { const info = await lstat(path); return Math.max(info.size, info.blocks * 512); } catch (error: any) { if (error.code === 'ENOENT') return 0; throw error; } };

test('catalog app allowance is one shared budget and inactive data gates every active reservation before credits or inference', async () => {
  const c = await fixture(); const provider = new DemoManager(), coordinator = new Coordinator(c.legacy, provider, true);
  try {
    coordinator.storage.useCatalogBudget(c.budget);
    coordinator.saveStoragePolicy({ appMiB: 64, projectMiB: 64, logsMiB: 1, retentionDays: 7 });
    await coordinator.connect(); coordinator.mode('running');
    const before = c.legacy.balance();
    await sparse(join(c.child, 'native-home', 'sessions', 'retained.trace'), 49 * MiB);
    assert.ok(new Storage(c.legacy).refresh().appBytes < MiB, 'selected project alone is small');
    assert.ok(coordinator.storage.refresh().appBytes >= 49 * MiB, 'inactive native history consumes the same app allowance');
    assert.throws(() => coordinator.send('catalog-blocked-manager', 'Do not dispatch', null), /app_storage_limit/);
    assert.equal(c.legacy.project()!.mode, 'paused');
    const task = { id: 'task', estimateTokens: 1000 } as Task, agent = { id: 'builder', threadId: null, lastTotal: 0 } as Agent;
    assert.throws(() => c.legacy.beginTask('catalog-blocked-task', task, agent), /app_storage_limit/);
    assert.throws(() => c.legacy.beginMeeting({ id: 'catalog-blocked-meeting' } as MeetingTurn, {} as MeetingConversation, 1000), /app_storage_limit/);
    assert.equal(c.legacy.steps().length, 0); assert.equal(c.legacy.messages().length, 0); assert.deepEqual(c.legacy.balance(), before);
  } finally { await coordinator.stop(); await c.close(); }
});

test('active worker commands recheck aggregate capacity after growth and block the next dispatch', async () => {
  const c = await fixture(), coordinator = new Coordinator(c.legacy, new DemoManager(), true);
  try {
    coordinator.storage.useCatalogBudget(c.budget);
    coordinator.saveStoragePolicy({ appMiB: 64, projectMiB: 64, logsMiB: 1, retentionDays: 7 });
    await coordinator.connect(); coordinator.mode('running');
    let calls = 0;
    const execution = new ProjectExecution(c.folder, 'fixture-profile', c.root, async () => {
      calls++; await sparse(join(c.child, 'native-home', 'sessions', 'grown.trace'), 49 * MiB);
      return { exitCode: 0, stdout: '', stderr: '' };
    }, () => coordinator.guardStorage());
    execution.verified = true;
    await assert.rejects(execution.command(['/usr/bin/true']), /app_storage_limit/);
    assert.equal(c.legacy.project()!.mode, 'paused');
    await assert.rejects(execution.command(['/usr/bin/true']), /app_storage_limit/);
    assert.equal(calls, 1, 'the second command never reaches the worker');
  } finally { await coordinator.stop(); await c.close(); }
});

test('catalog inventory includes all app databases, snapshots and abandoned child state exactly once', async () => {
  const c = await fixture();
  try {
    await mkdir(join(c.root, 'snapshots')); await mkdir(join(c.child, 'snapshots'));
    const legacySnapshot = join(c.root, 'snapshots', `${randomUUID()}.txt`), childSnapshot = join(c.child, 'snapshots', `${randomUUID()}.txt`);
    await writeFile(legacySnapshot, 'legacy captured version'); await writeFile(childSnapshot, 'child captured version');
    const abandoned = join(c.root, 'projects', randomUUID(), 'native-home', 'sessions', 'creation.trace'); await sparse(abandoned, 2 * MiB);
    const usage = c.budget.usage();
    let databases = 0;
    for (const store of [c.registry, c.legacy, c.inactive]) for (const suffix of ['', '-wal', '-shm']) databases += await diskBytes(store.path + suffix);
    assert.equal(usage.complete, true); assert.equal(usage.databaseBytes, databases);
    assert.equal(usage.snapshotBytes, await diskBytes(legacySnapshot) + await diskBytes(childSnapshot));
    assert.equal(usage.appBytes, usage.databaseBytes + usage.snapshotBytes + await diskBytes(abandoned));
    assert.equal(c.storage.refresh().appBytes, usage.appBytes, 'legacy root does not absorb/recount its child projects');
  } finally { await c.close(); }
});

test('shared policy survives project switching while project folder allowances remain independent', async () => {
  const c = await fixture();
  try {
    c.storage.savePolicy({ appMiB: 128, projectMiB: 64, logsMiB: 2, retentionDays: 3 });
    c.inactive.write('settings', 'storage:policy', { projectMiB: 256 });
    const other = new Storage(c.inactive); other.useCatalogBudget(c.budget);
    assert.deepEqual(other.policy(), { appMiB: 128, projectMiB: 256, logsMiB: 2, retentionDays: 3 });
    other.savePolicy({ appMiB: 256, projectMiB: 128, logsMiB: 3, retentionDays: 5 });
    assert.deepEqual(c.storage.policy(), { appMiB: 256, projectMiB: 64, logsMiB: 3, retentionDays: 5 });
    assert.deepEqual(c.registry.read('settings', 'storage:policy'), { appMiB: 256, logsMiB: 3, retentionDays: 5 });
    await sparse(join(c.otherFolder, 'unselected-build.bin'), 300 * MiB);
    assert.ok(c.storage.refresh().projectBytes < MiB, 'inactive project folders are outside the selected folder budget');
    await sparse(join(c.folder, 'selected-build.bin'), 64 * MiB);
    assert.equal(c.storage.refresh().reason, 'project_storage_limit');
    assert.equal(other.refresh().reason, 'project_storage_limit');
    c.storage.cleanupFiles(); assert.equal((await lstat(join(c.folder, 'selected-build.bin'))).size, 64 * MiB);
  } finally { await c.close(); }
});

test('global diagnostic cap accounts inactive logs while active cleanup preserves inactive output, history and recovery', async () => {
  const c = await fixture();
  try {
    c.storage.savePolicy({ appMiB: 1024, projectMiB: 2048, logsMiB: 1, retentionDays: 7 });
    const inactiveLog = join(c.child, 'codex-logs', 'inactive.log'), activeLog = join(c.root, 'codex-logs', 'active.log');
    await sparse(inactiveLog, 2 * MiB); await sparse(activeLog, MiB);
    const id = randomUUID(), snapshot = join(c.child, 'snapshots', `${id}.txt`);
    await mkdir(join(c.child, 'snapshots')); await writeFile(snapshot, 'Protected inactive output');
    const output: OutputVersion = { id, title: 'Saved output', path: 'guide.md', url: null, version: 1, hash: 'synthetic-hash', authorId: 'builder', taskId: 'task', milestoneId: 'milestone', status: 'accepted', bytes: 25, createdAt: new Date().toISOString() };
    c.inactive.write('outputs', id, output);
    c.inactive.write('settings', 'recovery:interrupted', { state: 'unknown', outputs: [output], prompt: 'Saved private recovery context' });
    c.inactive.write('settings', 'retained-history', { messages: ['Keep this conversation'], credits: 12 });
    const history = join(c.child, 'native-home', 'sessions', 'protected.trace'); await mkdir(join(history, '..'), { recursive: true }); await writeFile(history, 'Protected native history');
    const before = c.inactive.read('settings', 'recovery:interrupted');
    assert.ok(c.budget.usage().diagnosticBytes >= 3 * MiB);
    assert.equal(c.storage.refresh().reason, 'diagnostic_storage_limit');
    const result = c.storage.cleanupFiles(); assert.ok(result.files >= 1);
    await assert.rejects(readFile(activeLog), /ENOENT/);
    assert.equal((await lstat(inactiveLog)).size, 2 * MiB, 'active cleanup does not cross into an inactive state root');
    assert.equal(await readFile(snapshot, 'utf8'), 'Protected inactive output');
    assert.equal(await readFile(history, 'utf8'), 'Protected native history');
    assert.deepEqual(c.inactive.read('settings', 'recovery:interrupted'), before);
    assert.deepEqual(c.inactive.read('settings', 'retained-history'), { messages: ['Keep this conversation'], credits: 12 });
    assert.equal(c.storage.refresh().reason, 'diagnostic_storage_limit', 'inactive diagnostics remain visible and still gate work');
    const reopened = new Storage(c.inactive); reopened.useCatalogBudget(c.budget); reopened.cleanupFiles();
    assert.equal(c.storage.refresh().status, 'ok');
    assert.equal(await readFile(snapshot, 'utf8'), 'Protected inactive output'); assert.equal(await readFile(history, 'utf8'), 'Protected native history');
  } finally { await c.close(); }
});

test('shared auth caches are never followed or deleted and a registered linked project root fails closed', async () => {
  const c = await fixture();
  try {
    const shared = join(c.dir, 'shared-client'); await mkdir(shared); await sparse(join(shared, 'huge-cache'), 100 * MiB); await writeFile(join(shared, 'auth.json'), 'synthetic-auth-data');
    const home = join(c.child, 'native-home'); await mkdir(home); await symlink(join(shared, 'auth.json'), join(home, 'auth.json')); await symlink(shared, join(home, 'shared-cache'));
    assert.ok(c.budget.usage().appBytes < MiB);
    c.storage.cleanupFiles(Date.now(), true);
    assert.equal(await readFile(join(shared, 'auth.json'), 'utf8'), 'synthetic-auth-data'); assert.equal((await lstat(join(shared, 'huge-cache'))).size, 100 * MiB);
    const linked = join(c.root, 'projects', randomUUID()); await symlink(shared, linked);
    const unsafe = new CatalogStorageBudget(c.root, c.registry, () => [c.root, linked]);
    c.storage.useCatalogBudget(unsafe);
    assert.equal(c.storage.refresh().status, 'unavailable'); assert.throws(() => c.storage.assertCapacity(), /storage_scan_incomplete/);
  } finally { await c.close(); }
});

test('native service initialization rejects linked, dangling or non-directory state roots before creating runtime data', async () => {
  const c = await fixture();
  try {
    const outside = join(c.dir, 'unowned-client'), service = join(c.root, 'manager-service');
    await mkdir(outside); await symlink(outside, service);
    await assert.rejects(prepareNativeHome(service, false), /storage_path_changed/);
    const provider = new CodexManager(service, '/missing-fixture-codex', ['--fixture']);
    try { await assert.rejects(provider.connect(), /storage_path_changed/); assert.equal(provider.child, null, 'linked service root is rejected before launching a process'); }
    finally { provider.close(); }
    await assert.rejects(lstat(join(outside, 'native-home')), /ENOENT/);
    await assert.rejects(lstat(join(outside, 'manager')), /ENOENT/);
    const missing = join(c.dir, 'missing-client'), dangling = join(c.root, 'dangling-service');
    await symlink(missing, dangling);
    await assert.rejects(prepareNativeHome(dangling, false), /storage_path_changed/);
    await assert.rejects(lstat(missing), /ENOENT/);
    const file = join(c.root, 'not-a-service'); await writeFile(file, 'Keep this file');
    await assert.rejects(prepareNativeHome(file, false), /storage_path_changed/);
    assert.equal(await readFile(file, 'utf8'), 'Keep this file');
  } finally { await c.close(); }
});

test('one scan ceiling bounds the complete catalog and refuses work and cleanup on incomplete inventory', async () => {
  const c = await fixture();
  try {
    for (let i = 0; i < 30; i++) await writeFile(join(c.child, `entry-${i}`), 'bounded data');
    const bounded = new CatalogStorageBudget(c.root, c.registry, () => [c.root, c.child], 20);
    c.storage.useCatalogBudget(bounded);
    assert.equal(bounded.usage().complete, false); assert.equal(c.storage.refresh().status, 'unavailable');
    assert.throws(() => c.storage.assertCapacity(), /storage_scan_incomplete/); assert.throws(() => c.storage.cleanupFiles(), /storage_scan_incomplete/);
    assert.equal(await readFile(join(c.child, 'entry-29'), 'utf8'), 'bounded data');
  } finally { await c.close(); }
});

test('overlapping roots and hard links have one physical byte count without following directory links', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'team-storage-scan-')));
  try {
    const child = join(dir, 'child'); await mkdir(child); const source = join(child, 'saved.txt'); await writeFile(source, 'One physical file'); await link(source, join(child, 'same-data.txt'));
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'team-storage-outside-')));
    try {
      await sparse(join(outside, 'cache'), 4 * MiB); await symlink(outside, join(child, 'external'));
      const result = scanStorageRoots([dir, child, source]); assert.equal(result.complete, true); assert.equal(result.files.length, 1); assert.equal(result.bytes, await diskBytes(source));
      assert.equal(scanStorageRoots([dir], 2).complete, false);
    } finally { await rm(outside, { recursive: true, force: true }); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
