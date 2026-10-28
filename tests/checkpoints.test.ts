import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.ts';
import { MeetingCoordinator } from '../server/meeting-coordinator.ts';
import { DemoTeam } from '../server/demo-team.ts';
import { GitHubRemote, GitHubError, githubRepository, originRepository, githubRequest } from '../server/github.ts';
import type { CheckpointRemote, GitHubRequest } from '../server/github.ts';
import { AppError } from '../server/types.ts';
import type { CheckpointFile, GitHubCheckpoint, Milestone, OutputVersion, Task } from '../server/types.ts';
import { serverFor } from '../server/http.ts';
import { once } from 'node:events';

const exec = promisify(execFile), id = () => randomUUID();
class FakeRemote implements CheckpointRemote {
  refs = new Map<string, string>(); commits: { id: string; files: CheckpointFile[] }[] = []; publishes = 0;
  fail = false; loseAck = false; beforePublish: (() => Promise<void>) | null = null;
  async find(record: GitHubCheckpoint) { if (this.fail) throw new AppError('github_unavailable'); return this.refs.get(record.branch) ?? null; }
  async commit(record: GitHubCheckpoint, files: CheckpointFile[]) { this.commits.push({ id: record.id, files: structuredClone(files) }); return 'a'.repeat(40); }
  async publish(record: GitHubCheckpoint) { await this.beforePublish?.(); this.publishes++; this.refs.set(record.branch, record.commit!); if (this.loseAck) { this.loseAck = false; throw new AppError('github_unavailable'); } }
}
async function setup() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'checkpoint-test-'))), folder = join(dir, 'project'), path = join(dir, 'state.sqlite'); await mkdir(folder);
  let store = new Store(path), coordinator = new MeetingCoordinator(store, new DemoTeam(store), true);
  const remote = new FakeRemote();
  const wire = () => { coordinator.checkpoints.demo = false; coordinator.checkpoints.remote = remote; coordinator.checkpoints.destination = async () => 'owner/project'; }; wire();
  await coordinator.configure({ name: 'A test project', brief: 'Local brief is not exported implicitly.', folder, credits: 100 });
  const task = { id: 'builder', milestoneId: 'm1' } as Task;
  const version = await coordinator.artifacts.capture(task, 'builder', 'A usable file', 'note.md', '# Immutable note\n');
  store.write('outputs', version.id, version); store.write('agents', 'builder', { id: 'builder', name: 'Writer' });
  store.write('milestones', 'm1', { id: 'm1', title: 'A working milestone', status: 'review', outputIds: [version.id], acceptedIds: [], taskIds: [], planId: 'p1' } satisfies Milestone);
  const selection = { outputIds: [version.id], summary: 'First milestone for review.' };
  return {
    dir, folder, remote, version, selection, get store() { return store; }, get coordinator() { return coordinator; },
    async create(command = id()) { const preview = await coordinator.checkpoints.preview(selection); await coordinator.checkpoints.create({ id: command, ...selection, previewHash: preview.hash }); return command; },
    record() { return store.all<GitHubCheckpoint>('checkpoints')[0]; },
    async idle() { await coordinator.checkpoints.active; },
    async reopen() { coordinator.stopping = true; clearInterval(coordinator.quotaTimer); store.close(); store = new Store(path); coordinator = new MeetingCoordinator(store, new DemoTeam(store), true); wire(); },
    async close() { await coordinator.stop(); store.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('checkpoint exports exact selected immutable versions and frozen summary metadata; duplicate commands do not export twice', async () => {
  const c = await setup(); try {
    await writeFile(join(c.folder, 'note.md'), 'Different mutable content');
    const command = await c.create(); await c.idle(); const record = c.record();
    assert.equal(record.status, 'synced'); assert.equal(record.payload.repository, 'owner/project'); assert.equal(record.payload.outputs[0].author, 'Writer');
    assert.equal(record.url, `https://github.com/owner/project/tree/${record.branch}`);
    assert.equal(c.remote.commits[0].files.length, 3); assert.equal(c.remote.commits[0].files[0].content, '# Immutable note\n');
    assert.ok(c.remote.commits[0].files[1].content.includes('A working milestone')); assert.ok(!JSON.stringify(c.remote.commits).includes('Local brief is not exported'));
    await c.create(command); assert.equal(c.remote.commits.length, 1); assert.equal(c.store.all('checkpoints').length, 1);
    assert.equal(c.store.steps().length, 0); assert.equal(c.store.balance().used, 0); assert.equal(c.store.project()!.mode, 'paused');
  } finally { await c.close(); }
});

test('offline exports persist and explicit retries survive restart without changing chosen versions, destination or summary', async () => {
  const c = await setup(); try {
    c.remote.fail = true; const checkpointId = await c.create(); await c.idle(); assert.equal(c.record().status, 'unsynced');
    await c.reopen(); assert.equal(c.remote.commits.length, 0); assert.equal(c.coordinator.checkpoints.active, null);
    c.store.write('outputs', c.version.id, { ...c.version, status: 'accepted' }); c.store.saveProject({ ...c.store.project()!, name: 'Renamed' });
    c.coordinator.checkpoints.destination = async () => 'another/destination'; c.remote.fail = false;
    const retry = { id: id(), checkpointId }; c.coordinator.checkpoints.retry(retry); c.coordinator.checkpoints.retry(retry); await c.idle();
    assert.equal(c.record().status, 'synced'); assert.equal(c.record().attempts, 2); assert.equal(c.record().payload.repository, 'owner/project');
    assert.equal(c.record().payload.projectName, 'A test project'); assert.equal(c.record().payload.outputs[0].version.status, 'draft');
    assert.equal(c.remote.publishes, 1); assert.equal(c.store.steps().length, 0);
  } finally { await c.close(); }
});

test('a lost publish acknowledgement reconciles the saved branch instead of creating a second commit or ref', async () => {
  const c = await setup(); try {
    c.remote.loseAck = true; const checkpointId = await c.create(); await c.idle(); assert.equal(c.record().status, 'unsynced'); assert.equal(c.record().commit, 'a'.repeat(40));
    await c.reopen(); c.coordinator.checkpoints.retry({ id: id(), checkpointId }); await c.idle();
    assert.equal(c.record().status, 'synced'); assert.equal(c.remote.commits.length, 1); assert.equal(c.remote.publishes, 1); assert.equal(c.remote.refs.size, 1);
  } finally { await c.close(); }
});

test('an interrupted journal remains unsynced after restart and reconciles only on an explicit retry', async () => {
  const c = await setup(); try {
    c.remote.loseAck = true; const checkpointId = await c.create(); await c.idle(); c.store.write('checkpoints', checkpointId, { ...c.record(), status: 'syncing' });
    await c.reopen(); assert.equal(c.record().error, 'checkpoint_interrupted'); assert.equal(c.record().status, 'unsynced'); assert.equal(c.remote.publishes, 1);
    c.coordinator.checkpoints.retry({ id: id(), checkpointId }); await c.idle(); assert.equal(c.record().status, 'synced'); assert.equal(c.remote.publishes, 1);
  } finally { await c.close(); }
});

test('retry reuses a journalled commit when the branch was never created', async () => {
  const c = await setup(); try {
    c.remote.publish = async () => { throw new AppError('github_unavailable'); };
    const checkpointId = await c.create(); await c.idle(); assert.equal(c.record().commit, 'a'.repeat(40));
    c.remote.publish = FakeRemote.prototype.publish.bind(c.remote); c.coordinator.checkpoints.retry({ id: id(), checkpointId }); await c.idle();
    assert.equal(c.remote.commits.length, 1); assert.equal(c.record().status, 'synced');
  } finally { await c.close(); }
});

test('a conflicting existing checkpoint branch is never overwritten', async () => {
  const c = await setup(); try {
    const checkpointId = id(); c.remote.refs.set(`codex/checkpoint-${checkpointId}`, 'b'.repeat(40)); await c.create(checkpointId); await c.idle();
    assert.equal(c.record().error, 'github_ref_conflict'); assert.equal(c.remote.publishes, 0); assert.equal(c.remote.commits.length, 0); assert.equal(c.remote.refs.get(c.record().branch), 'b'.repeat(40));
  } finally { await c.close(); }
});

test('failed export attempts are bounded to three, and do not consume model credits', async () => {
  const c = await setup(); try {
    c.remote.fail = true; const checkpointId = await c.create(); await c.idle();
    for (let i = 0; i < 2; i++) { c.coordinator.checkpoints.retry({ id: id(), checkpointId }); await c.idle(); }
    assert.equal(c.record().attempts, 3); assert.throws(() => c.coordinator.checkpoints.retry({ id: id(), checkpointId }), /checkpoint_retry_unavailable/);
    assert.equal(c.store.balance().used, 0); assert.equal(c.store.all('checkpoints').length, 1);
  } finally { await c.close(); }
});

test('changed selection metadata requires a fresh preview, and corrupt snapshots cannot be exported', async () => {
  const c = await setup(); try {
    const preview = await c.coordinator.checkpoints.preview(c.selection); c.store.write('outputs', c.version.id, { ...c.version, status: 'accepted' });
    await assert.rejects(c.coordinator.checkpoints.create({ id: id(), ...c.selection, previewHash: preview.hash }), /stale_checkpoint/); assert.equal(c.store.all('checkpoints').length, 0);
    await writeFile(join(c.coordinator.artifacts.directory, `${c.version.id}.txt`), 'Corrupt');
    await assert.rejects(c.coordinator.checkpoints.preview(c.selection), /snapshot_changed/); assert.equal(c.remote.commits.length, 0);
  } finally { await c.close(); }
});

test('a corrupted frozen payload or snapshot blocks a retry before any publishing', async () => {
  const c = await setup(); try {
    c.remote.fail = true; const checkpointId = await c.create(); await c.idle(); c.remote.fail = false;
    await writeFile(join(c.coordinator.artifacts.directory, `${c.version.id}.txt`), 'Corrupt'); c.coordinator.checkpoints.retry({ id: id(), checkpointId }); await c.idle();
    assert.equal(c.record().error, 'snapshot_changed'); assert.equal(c.remote.commits.length, 0);
    c.store.write('checkpoints', checkpointId, { ...c.record(), payload: { ...c.record().payload, repository: 'changed/repo' } });
    c.coordinator.checkpoints.retry({ id: id(), checkpointId }); await c.idle(); assert.equal(c.record().error, 'snapshot_changed'); assert.equal(c.remote.publishes, 0);
  } finally { await c.close(); }
});

test('historical versions of the same path remain distinct; traversal/protected paths and oversized selections are rejected', async () => {
  const c = await setup(); try {
    const other = await c.coordinator.artifacts.capture({ id: 'builder', milestoneId: 'm1' } as Task, 'builder', 'A newer file', 'note.md', 'Version two'); c.store.write('outputs', other.id, other);
    const preview = await c.coordinator.checkpoints.preview({ ...c.selection, outputIds: [c.version.id, other.id] }); assert.equal(new Set(preview.files.map(file => file.path)).size, 4);
    for (const path of ['../outside', '.git/config', '.env', '.aws/credentials', '.codex/auth.json']) {
      c.store.write('outputs', other.id, { ...other, path }); await assert.rejects(c.coordinator.checkpoints.preview({ ...c.selection, outputIds: [other.id] }), /invalid_output_path/);
    }
    for (const path of ['auth.json', 'project-team.sqlite', 'logs/rollout-native.jsonl', 'keys/private.pem', '.GIT/config', '.ENV', '.SSH/ID_RSA']) {
      c.store.write('outputs', other.id, { ...other, path }); await assert.rejects(c.coordinator.checkpoints.preview({ ...c.selection, outputIds: [other.id] }), /checkpoint_protected_file/);
    }
    await assert.rejects(c.coordinator.checkpoints.preview({ ...c.selection, outputIds: [c.version.id, c.version.id] }), /invalid_checkpoint/);
    await assert.rejects(c.coordinator.checkpoints.preview({ ...c.selection, summary: '' }), /invalid_checkpoint/);
    c.store.write('outputs', other.id, { ...other, bytes: 2_000_000 }); await assert.rejects(c.coordinator.checkpoints.preview({ ...c.selection, outputIds: [other.id] }), /checkpoint_too_large/);
  } finally { await c.close(); }
});

test('Stop drains the active checkpoint and rejects new work; another checkpoint cannot run concurrently', async () => {
  const c = await setup(); try {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); c.remote.beforePublish = () => gate;
    await c.create(); await assert.rejects(c.create(), /checkpoint_busy/);
    let ended = false; const stopped = c.coordinator.stop().then(() => { ended = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(ended, false); await assert.rejects(c.create(), /coordinator_stopping/);
    release(); await stopped; assert.equal(c.record().status, 'synced'); assert.equal(c.store.project()!.mode, 'stopped');
  } finally { await c.close(); }
});

test('demo checkpoints remain local and never call a GitHub adapter', async () => {
  const c = await setup(); try {
    c.coordinator.checkpoints.demo = true; c.coordinator.checkpoints.remote.find = async () => { throw new Error('No network'); };
    await c.create(); await c.idle(); assert.equal(c.record().status, 'synced'); assert.equal(c.record().url, null); assert.equal(c.record().demo, true); assert.equal(c.record().payload.repository, 'demo/project-team');
  } finally { await c.close(); }
});

test('GitHub origin detection ignores inherited Git settings and never changes dirty files, staging, HEAD or remotes', async () => {
  const c = await setup(); const git = (...args: string[]) => exec('git', ['-C', c.folder, ...args]);
  try {
    await git('init'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid'); await git('remote', 'add', 'origin', 'git@github.com:owner/project.git');
    await writeFile(join(c.folder, 'staged.txt'), 'Staged'); await git('add', 'staged.txt'); await writeFile(join(c.folder, 'staged.txt'), 'Unstaged edit'); await writeFile(join(c.folder, 'untracked.txt'), 'Keep me');
    const status = (await git('status', '--porcelain=v1')).stdout, index = await readFile(join(c.folder, '.git/index')), head = await readFile(join(c.folder, '.git/HEAD')), config = await readFile(join(c.folder, '.git/config'));
    c.coordinator.checkpoints.destination = originRepository; const previous = process.env.GIT_DIR; process.env.GIT_DIR = '/does-not-exist';
    try { assert.equal(await originRepository(c.folder), 'owner/project'); } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
    await c.create(); await c.idle(); assert.equal(c.record().status, 'synced');
    assert.equal((await git('status', '--porcelain=v1')).stdout, status); assert.deepEqual(await readFile(join(c.folder, '.git/index')), index); assert.deepEqual(await readFile(join(c.folder, '.git/HEAD')), head); assert.deepEqual(await readFile(join(c.folder, '.git/config')), config);
    await mkdir(join(c.folder, 'nested')); await assert.rejects(originRepository(join(c.folder, 'nested')), /github_origin_required/);
    for (const remote of [['https://token', 'github.com/owner/repo.git'].join('@'), 'https://example.com/owner/repo', 'file:///tmp/repo', 'git@github.com:../repo']) assert.throws(() => githubRepository(remote), /github_origin_required/);
    for (const remote of ['https://github.com/owner/repo.git', 'ssh://git@github.com/owner/repo.git', 'git@github.com:owner/repo']) assert.equal(githubRepository(remote), 'owner/repo');
  } finally { await c.close(); }
});

test('GitHub adapter creates only selected blobs, a root commit and a new ref; failures are not mistaken for absent refs', async () => {
  const c = await setup(); try {
    const calls: { method: string; path: string; input: any }[] = [];
    const request: GitHubRequest = async (method, path, input) => { calls.push({ method, path, input }); if (path.includes('/git/ref/')) throw new GitHubError('github_unavailable', 404); if (path.endsWith('/git/trees')) return { sha: 'b'.repeat(40) }; if (path.endsWith('/git/commits')) return { sha: 'a'.repeat(40) }; return {}; };
    const remote = new GitHubRemote(request); c.remote.fail = true; await c.create(); await c.idle(); const record = c.record(), signal = AbortSignal.timeout(10000);
    assert.equal(await remote.find(record, signal), null); const files = (await c.coordinator.checkpoints.preview(c.selection)).files;
    const commit = await remote.commit(record, files, signal); await remote.publish({ ...record, commit }, signal);
    assert.deepEqual(calls.map(call => call.method), ['GET', 'GET', 'POST', 'POST', 'POST']);
    const tree = calls[2].input; assert.deepEqual(tree.tree.map((entry: any) => entry.content), files.map(file => file.content)); assert.equal('base_tree' in tree, false);
    assert.deepEqual(calls[3].input.parents, []); assert.equal(calls[3].input.author.date, record.createdAt); assert.equal(calls[4].input.ref, `refs/heads/${record.branch}`);
    remote.request = async () => { throw new GitHubError('github_access_denied', 403); }; await assert.rejects(remote.find(record, signal), /github_access_denied/);
    remote.request = async () => { throw new GitHubError('github_unavailable', 404); }; await assert.rejects(remote.find(record, signal), /github_unavailable/);
  } finally { await c.close(); }
});

test('checkpoint HTTP preview/export/retry require same-origin command requests and retain failures in snapshots', async () => {
  const c = await setup(), server = serverFor(c.coordinator, { port: 4183, root: c.dir, demo: true });
  try {
    server.listen(4183, '127.0.0.1'); await once(server, 'listening'); const base = 'http://127.0.0.1:4183';
    const post = (route: string, body: unknown, origin = base) => fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Project-Team': '1', Origin: origin }, body: JSON.stringify(body) });
    assert.equal((await post('checkpoint-preview', c.selection, 'https://other.invalid')).status, 403);
    const preview = await (await post('checkpoint-preview', c.selection)).json(); assert.equal(c.store.all('checkpoints').length, 0);
    c.remote.fail = true; const checkpointId = id(), request = { id: checkpointId, ...c.selection, previewHash: preview.hash };
    assert.equal((await post('checkpoint', request)).status, 200); await c.idle(); assert.equal(c.coordinator.snapshot().checkpoints[0].status, 'unsynced');
    assert.equal((await post('checkpoint', request)).status, 200); assert.equal(c.record().attempts, 1);
    c.remote.fail = false; assert.equal((await post('checkpoint-retry', { id: id(), checkpointId })).status, 200); await c.idle(); assert.equal(c.record().status, 'synced');
    c.store.write('checkpoints', checkpointId, { ...c.record(), status: 'unsynced' });
    assert.equal((await post('checkpoint-check', { id: id(), checkpointId })).status, 200); await c.idle(); assert.equal(c.record().status, 'synced'); assert.equal(c.remote.publishes, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await c.close(); }
});

test('GitHub CLI transport uses argv/stdin, suppresses debug output and returns only sanitized errors', async () => {
  const c = await setup(), keys = ['PATH', 'GH_DEBUG', 'CHECKPOINT_FIXTURE_CAPTURE', 'CHECKPOINT_FIXTURE_STATUS'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    const bin = join(c.dir, 'bin'); await mkdir(bin); const capture = join(c.dir, 'request.json');
    await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs'); let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.CHECKPOINT_FIXTURE_CAPTURE, JSON.stringify({ args: process.argv.slice(2), input, debug: process.env.GH_DEBUG ?? null }));
  if (process.env.CHECKPOINT_FIXTURE_STATUS) { process.stderr.write('PRIVATE-DIAGNOSTIC (HTTP ' + process.env.CHECKPOINT_FIXTURE_STATUS + ')'); process.exit(1); }
  process.stdout.write('{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}');
});
`); await chmod(join(bin, 'gh'), 0o700);
    process.env.PATH = bin + ':' + process.env.PATH; process.env.GH_DEBUG = 'api'; process.env.CHECKPOINT_FIXTURE_CAPTURE = capture;
    const payload = { tree: [{ path: 'safe.txt', content: 'Literal $() and `backticks`\nText' }] };
    const result = await githubRequest('POST', 'repos/owner/repo/git/trees', payload, AbortSignal.timeout(10000));
    assert.equal(result.sha, 'a'.repeat(40)); const request = JSON.parse(await readFile(capture, 'utf8'));
    assert.deepEqual(JSON.parse(request.input), payload); assert.equal(request.debug, null);
    assert.deepEqual(request.args, ['api', '--hostname', 'github.com', '--method', 'POST', '-H', 'Accept: application/vnd.github+json', 'repos/owner/repo/git/trees', '--input', '-']);
    for (const status of ['403', '404', '422']) {
      process.env.CHECKPOINT_FIXTURE_STATUS = status;
      await assert.rejects(githubRequest('GET', 'repos/owner/repo', undefined, AbortSignal.timeout(10000)), error => error instanceof GitHubError && error.httpStatus === Number(status) && !error.message.includes('PRIVATE-DIAGNOSTIC'));
    }
  } finally { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } await c.close(); }
});

test('read-only reconciliation remains available after the final lost acknowledgement, and never publishes a missing ref', async () => {
  const c = await setup(); try {
    c.remote.fail = true; const checkpointId = await c.create(); await c.idle();
    c.coordinator.checkpoints.retry({ id: id(), checkpointId }); await c.idle();
    c.remote.fail = false; c.remote.loseAck = true; c.coordinator.checkpoints.retry({ id: id(), checkpointId }); await c.idle();
    assert.equal(c.record().attempts, 3); assert.equal(c.record().status, 'unsynced');
    const request = { id: id(), checkpointId }; c.coordinator.checkpoints.check(request); c.coordinator.checkpoints.check(request); await c.idle();
    assert.equal(c.record().status, 'synced'); assert.equal(c.record().attempts, 3); assert.equal(c.remote.publishes, 1); assert.equal(c.remote.commits.length, 1);
    c.store.write('checkpoints', checkpointId, { ...c.record(), status: 'unsynced' }); c.remote.refs.clear();
    c.coordinator.checkpoints.check({ id: id(), checkpointId }); await c.idle();
    assert.equal(c.record().error, 'checkpoint_not_published'); assert.equal(c.record().attempts, 3); assert.equal(c.remote.publishes, 1); assert.equal(c.remote.commits.length, 1);
  } finally { await c.close(); }
});
