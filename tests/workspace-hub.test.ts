import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.ts';
import { DemoTeam } from '../server/demo-team.ts';
import { WorkspaceHub } from '../server/workspace-hub.ts';
import { serverFor } from '../server/http.ts';
import { Coordinator } from '../server/coordinator.ts';
import { CatalogStorageBudget } from '../server/catalog-storage.ts';
import { AppError } from '../server/types.ts';
import type { Agent, GitHubCheckpoint, OutputVersion, Plan, Step, TeamTurn, TurnCallbacks } from '../server/types.ts';

const id = () => randomUUID();
const scope = (hub: WorkspaceHub) => hub.activeProjectId ?? 'none';
const until = async (predicate: () => boolean) => {
  const end = Date.now() + 6000;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'workspace operation finished');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'project-team-workspaces-')));
  const state = join(dir, 'state'), folderA = join(dir, 'project-a'), folderB = join(dir, 'project-b');
  for (const path of [state, folderA, folderB]) await mkdir(path);
  const lifecycle: string[] = [], providers: ObservedDemo[] = [];
  let concurrent = 0, maximumConcurrent = 0;
  class ObservedDemo extends DemoTeam {
    calls: TeamTurn[] = [];
    async perform(input: TeamTurn, callbacks: TurnCallbacks) {
      this.calls.push(structuredClone(input));
      concurrent++;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      try { return await super.perform(input, callbacks); }
      finally { concurrent--; }
    }
    async closeForStorage() { lifecycle.push(`closed:${this.store.project()?.name ?? 'empty'}`); }
  }
  const factory = (store: Store) => {
    lifecycle.push(`opened:${store.project()?.name ?? 'empty'}`);
    const provider = new ObservedDemo(store);
    provider.delay = 20;
    providers.push(provider);
    return provider;
  };
  let hub = new WorkspaceHub(state, factory, true);
  const create = async (name: string, folder: string) => {
    await hub.createProject(scope(hub), { id: id(), name, brief: `A synthetic brief for ${name}.`, folder, credits: 500 });
    return hub.activeProjectId!;
  };
  const switchTo = async (projectId: string) => hub.switchProject(scope(hub), { id: id(), projectId });
  const hire = (role: Agent['role']) => hub.current.hire({ id: id(), name: `Shared ${role}`, role, responsibility: `A synthetic ${role} responsibility.`, model: 'demo', effort: 'demo' });
  const plan = async () => {
    hub.current.proposePlan({ id: id(), instruction: '' });
    await hub.current.active;
    return hub.current.store.all<Plan>('plans').at(-1)!;
  };
  return {
    dir, state, folderA, folderB, lifecycle, providers, factory, create, switchTo, hire, plan,
    get hub() { return hub; },
    get maximumConcurrent() { return maximumConcurrent; },
    async restart() { await hub.stop(); hub.close(); hub = new WorkspaceHub(state, factory, true); },
    async close() { await hub.stop(); hub.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

async function savedOutput(store: Store, content = 'Synthetic captured output') {
  const output: OutputVersion = { id: id(), path: 'result.md', url: null, title: 'Captured result', version: 1, hash: createHash('sha256').update(content).digest('hex'), authorId: 'manager', taskId: 'fixture-task', milestoneId: 'fixture-milestone', status: 'accepted', bytes: Buffer.byteLength(content), createdAt: new Date().toISOString() };
  const directory = join(dirname(store.path), 'snapshots');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${output.id}.txt`), content);
  store.write('outputs', output.id, output);
  return output;
}

function pendingCheckpoint(output: OutputVersion): GitHubCheckpoint {
  return { id: id(), payload: { repository: 'fixture/workspace', projectName: 'Legacy', summary: 'Saved checkpoint', outputs: [{ version: output, author: 'manager', exportPath: output.path! }], milestones: [] }, hash: 'fixture', branch: 'fixture-snapshot', createdAt: new Date().toISOString(), status: 'unsynced', attempts: 1, error: 'github_unavailable', commit: null, url: null, demo: true };
}

test('legacy import keeps its DB/native history, recovery, outputs and pending exports in place across restart', async () => {
  const c = await fixture();
  try {
    await c.hub.stop(); c.hub.close();
    const path = join(c.state, 'project-team.sqlite'), store = new Store(path);
    store.saveProject({ name: 'Legacy', brief: 'A saved synthetic project', folder: c.folderA, credits: 200, mode: 'paused', threadId: 'legacy-thread', lastTotal: 900 });
    const actor: Agent = { id: id(), name: 'Existing builder', role: 'builder', responsibility: 'Preserve saved work', model: 'demo', effort: 'demo', threadId: 'legacy-worker', lastTotal: 1000, createdAt: new Date().toISOString() };
    store.write('agents', actor.id, { ...actor, privateContext: 'Do not copy this synthetic private actor context.' });
    const output = await savedOutput(store);
    const step: Step = { id: id(), messageId: null, agentId: actor.id, taskId: 'fixture-task', kind: 'task', turnId: 'legacy-turn', threadId: 'legacy-worker', baseline: 0, reserved: 1000, used: 900, estimated: false, dispatchAttempted: true, status: 'failed' };
    store.write('steps', step.id, step); store.checkpoint(step.id, { state: 'ready', outputs: [output], captured: true, result: { text: 'Saved result', turnId: 'legacy-turn' } });
    const checkpoint = pendingCheckpoint(output); store.write('checkpoints', checkpoint.id, checkpoint);
    await mkdir(join(c.state, 'native-home', 'sessions'), { recursive: true });
    await writeFile(join(c.state, 'native-home', 'sessions', 'legacy-trace'), 'synthetic old trace');
    const registry = new Store(join(c.state, 'workspace.sqlite'));
    registry.write('settings', 'workspace:initialized', false); registry.write('settings', 'workspace:projects', []); registry.close(); store.close();
    const imported = new WorkspaceHub(c.state, c.factory, true);
    try {
      const first = imported.snapshot();
      assert.equal(first.workspace!.projects.length, 1);
      assert.equal(imported.current.store.path, path);
      assert.equal(first.team.outputs[0].hash, output.hash);
      assert.equal(first.recovery[0].id, step.id);
      assert.equal(first.checkpoints[0].id, checkpoint.id);
      assert.equal(imported.current.store.steps()[0].threadId, 'legacy-worker');
      assert.equal(first.team.agents[0].id, actor.id);
      assert.equal(first.team.agents[0].avatarId, '01');
      assert.ok(!JSON.stringify(imported.registry.read('settings', 'workspace:members')).includes('privateContext'));
      assert.ok(!('threadId' in first.workspace!.projects[0]));
      assert.ok(!('lastTotal' in first.workspace!.projects[0]));
      assert.equal(await readFile(join(c.state, 'native-home', 'sessions', 'legacy-trace'), 'utf8'), 'synthetic old trace');
      await imported.stop(); const projectId = imported.activeProjectId; imported.close();
      const reopened = new WorkspaceHub(c.state, c.factory, true);
      try {
        assert.equal(reopened.activeProjectId, projectId);
        assert.equal(reopened.snapshot().workspace!.projects.length, 1);
        assert.equal(reopened.snapshot().team.agents[0].avatarId, '01');
        assert.equal(reopened.snapshot().recovery[0].id, step.id);
        assert.equal(reopened.snapshot().checkpoints[0].status, 'unsynced');
        assert.equal(reopened.snapshot().connection.status, 'offline');
      } finally { await reopened.stop(); reopened.close(); }
    } finally { /* imported has already closed above on the passing path. */ }
  } finally { await rm(c.dir, { recursive: true, force: true }); }
});

test('one roster retains identity/avatar/model/responsibility while usage, conversations and outputs stay project-specific', async () => {
  const c = await fixture();
  try {
    const projectA = await c.create('Alpha', c.folderA);
    await c.hub.current.connect(); c.hire('builder'); c.hire('reviewer'); c.hub.current.mode('running');
    const proposal = await c.plan(); c.hub.current.approvePlan({ id: id(), planId: proposal.id });
    await until(() => !c.hub.current.busy && c.hub.current.store.team().milestones[0]?.status === 'review');
    const savedA = c.hub.snapshot(), actorA = savedA.team.agents[0], revision = savedA.revision!;
    assert.ok(actorA.threadId); assert.ok(actorA.lastTotal > 0); assert.ok(savedA.credits.used > 0);
    const projectB = await c.create('Beta', c.folderB), freshB = c.hub.snapshot();
    assert.notEqual(projectA, projectB);
    assert.equal(freshB.revision!.instanceId, revision.instanceId);
    assert.ok(freshB.revision!.sequence > revision.sequence);
    assert.deepEqual(freshB.team.agents.map(({ id, avatarId, model, effort, responsibility }) => ({ id, avatarId, model, effort, responsibility })), savedA.team.agents.map(({ id, avatarId, model, effort, responsibility }) => ({ id, avatarId, model, effort, responsibility })));
    assert.ok(freshB.team.agents.every(agent => agent.threadId === null && agent.lastTotal === 0));
    assert.equal(freshB.messages.length, 0); assert.equal(freshB.team.outputs.length, 0); assert.equal(freshB.recovery.length, 0); assert.equal(freshB.checkpoints.length, 0); assert.equal(freshB.credits.used, 0);
    assert.equal(freshB.project!.mode, 'paused'); assert.equal(freshB.connection.status, 'offline');
    await c.hub.current.connect(); c.hire('builder');
    const newcomer = c.hub.snapshot().team.agents[2]; assert.equal(newcomer.avatarId, '03');
    await c.switchTo(projectA);
    const restored = c.hub.snapshot();
    assert.equal(restored.team.agents[0].threadId, actorA.threadId);
    assert.equal(restored.team.agents[0].lastTotal, actorA.lastTotal);
    assert.equal(restored.credits.used, savedA.credits.used);
    assert.equal(restored.team.outputs[0].hash, savedA.team.outputs[0].hash);
    assert.equal(restored.team.agents[2].id, newcomer.id); assert.equal(restored.team.agents[2].threadId, null);
    assert.equal(new Set(restored.team.agents.map(agent => agent.avatarId)).size, 3);
    assert.equal(restored.project!.mode, 'paused'); assert.equal(restored.connection.status, 'offline');
    await c.restart();
    assert.equal(c.hub.activeProjectId, projectA); assert.equal(c.hub.snapshot().workspace!.projects.length, 2);
    assert.deepEqual(c.hub.snapshot().team.agents.map(agent => agent.avatarId), ['01', '02', '03']);
  } finally { await c.close(); }
});

test('switch pauses and drains active work plus exports before closing the old provider and never starts the next queued task', async () => {
  const c = await fixture(); const exported = deferred();
  try {
    const projectA = await c.create('Alpha', c.folderA), projectB = await c.create('Beta', c.folderB);
    await c.switchTo(projectA); await c.hub.current.connect(); c.hire('builder'); c.hire('reviewer'); c.hub.current.mode('running');
    const proposed = await c.plan(); const old = c.hub.current, oldProvider = c.providers.at(-1)!;
    oldProvider.delay = 120; old.approvePlan({ id: id(), planId: proposed.id });
    await until(() => !!old.store.team().activeTask);
    old.checkpoints.active = exported.promise;
    const switching = c.hub.switchProject(projectA, { id: id(), projectId: projectB });
    assert.equal(c.hub.switching, true); assert.equal(old.store.project()!.mode, 'paused');
    await until(() => !old.busy);
    assert.equal(c.hub.activeProjectId, projectA, 'export drain holds the old project open');
    const count = c.providers.length;
    exported.resolve(); await switching;
    assert.equal(c.providers.length, count + 1);
    assert.equal(c.hub.activeProjectId, projectB);
    assert.deepEqual(oldProvider.calls.map(call => call.kind), ['plan', 'builder']);
    assert.equal(c.maximumConcurrent, 1);
    assert.equal(c.hub.snapshot().project!.mode, 'paused'); assert.equal(c.hub.snapshot().connection.status, 'offline');
    const closedIndex = c.lifecycle.lastIndexOf('closed:Alpha'), openedIndex = c.lifecycle.lastIndexOf('opened:Beta');
    assert.ok(closedIndex < openedIndex);
    await c.switchTo(projectA);
    assert.equal(c.hub.snapshot().team.tasks.find(task => task.role === 'reviewer')!.status, 'queued');
    assert.equal(c.hub.snapshot().connection.status, 'offline');
  } finally { exported.resolve(); await c.close(); }
});

test('scope leases reject a queued mutation after switch begins and drain in-flight reads without delivering stale project output', async () => {
  const c = await fixture(); const entered = deferred(), release = deferred();
  const options = { port: 0, root: c.dir, demo: true };
  const server = serverFor(c.hub, options); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  options.port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${options.port}`;
  const post = (route: string, projectId: string, input = {}) => fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Project-Team': '1', 'X-Project-Id': projectId }, body: JSON.stringify(input) });
  try {
    const projectA = await c.create('Alpha', c.folderA), projectB = await c.create('Beta', c.folderB); await c.switchTo(projectA);
    const output = await savedOutput(c.hub.current.store);
    const original = c.hub.current.artifacts.content.bind(c.hub.current.artifacts);
    c.hub.current.artifacts.content = async id => { entered.resolve(); await release.promise; return original(id); };
    const reading = fetch(`${base}/api/output/${output.id}`, { headers: { 'X-Project-Id': projectA } });
    await entered.promise;
    let mutationStarted = false;
    const mutation = c.hub.scoped(projectA, async () => { mutationStarted = true; }).catch(error => error);
    const switching = post('project-switch', projectA, { id: id(), projectId: projectB });
    await until(() => c.hub.switching);
    // The HTTP switch arrives after the already queued lease microtask, so prove the direct race separately below.
    await mutation;
    assert.equal(c.hub.activeProjectId, projectA);
    release.resolve(); assert.equal((await reading).status, 409);
    assert.equal((await switching).status, 200);
    assert.equal(c.hub.activeProjectId, projectB);
    assert.equal((await post('message', projectA, { id: id(), text: 'Do not send this to Beta' })).status, 409);
    assert.equal((await fetch(`${base}/api/output/${output.id}`, { headers: { 'X-Project-Id': projectA } })).status, 409);
    assert.equal((await fetch(`${base}/api/recovery-output/${output.id}`, { headers: { 'X-Project-Id': projectA } })).status, 409);
    assert.equal((await post('pause', 'none')).status, 409);
    assert.equal(c.hub.snapshot().messages.length, 0);
    mutationStarted = false;
    const stale = c.hub.scoped(projectB, () => { mutationStarted = true; }).catch(error => error);
    const directSwitch = c.hub.switchProject(projectB, { id: id(), projectId: projectA });
    assert.equal((await stale).code, 'stale_project'); assert.equal(mutationStarted, false);
    await directSwitch;
  } finally { release.resolve(); server.close(); server.closeAllConnections(); await c.close(); }
});

test('saved folders are disjoint from each other and the whole app state, including inactive stores', async () => {
  const c = await fixture();
  try {
    const projectA = await c.create('Alpha', c.folderA);
    const create = (folder: string) => c.hub.createProject(scope(c.hub), { id: id(), name: 'Invalid', brief: '', folder, credits: 50 });
    await assert.rejects(create(c.folderA), /project_folder_in_use/);
    const child = join(c.folderA, 'child'); await mkdir(child);
    await assert.rejects(create(child), /project_folder_overlap/);
    await assert.rejects(create(c.dir), /state_inside_project/);
    await assert.rejects(create(join(c.state, 'projects')), /state_inside_project/);
    const projectB = await c.create('Beta', c.folderB);
    await assert.rejects(c.hub.scoped(projectB, coordinator => c.hub.configured(coordinator, { name: 'Beta', brief: '', folder: c.folderA, credits: 50 })), /project_folder_in_use/);
    await c.hub.scoped(projectB, coordinator => c.hub.configured(coordinator, { name: 'Beta renamed', brief: 'Only this project', folder: c.folderB, credits: 50 }));
    assert.equal(c.hub.snapshot().project!.name, 'Beta renamed'); assert.equal(c.hub.snapshot().workspace!.projects.find(project => project.id === projectA)!.name, 'Alpha');
  } finally { await c.close(); }
});

test('a created project whose first provider load fails can be selected on an idempotent retry without duplicating it', async () => {
  const c = await fixture();
  let fail = false;
  const hub = new WorkspaceHub(join(c.dir, 'failure-state'), (store, root) => {
    if (fail && store.project()?.name === 'Retry target') { fail = false; throw new Error('fixture_open_failed'); }
    return c.factory(store);
  }, true);
  try {
    await hub.createProject('none', { id: id(), name: 'Original', brief: '', folder: c.folderA, credits: 50 });
    const original = hub.activeProjectId!;
    const input = { id: id(), name: 'Retry target', brief: '', folder: c.folderB, credits: 50 };
    fail = true;
    await assert.rejects(hub.createProject(original, input), /fixture_open_failed/);
    assert.equal(hub.activeProjectId, original); assert.equal(hub.snapshot().workspace!.projects.length, 2);
    await hub.createProject(original, input);
    assert.notEqual(hub.activeProjectId, original); assert.equal(hub.snapshot().workspace!.projects.length, 2); assert.equal(hub.snapshot().project!.name, 'Retry target');
    await hub.createProject(scope(hub), input);
    assert.equal(hub.snapshot().workspace!.projects.length, 2);
  } finally { await hub.stop(); hub.close(); await c.close(); }
});

test('one global app allowance counts inactive project runtime data before allowing active-project inference', async () => {
  const c = await fixture();
  try {
    await c.create('Alpha', c.folderA); const oldRoot = dirname(c.hub.current.store.path);
    await c.create('Beta', c.folderB); await c.hub.current.connect();
    c.hub.current.saveStoragePolicy({ appMiB: 64, projectMiB: 64, logsMiB: 1, retentionDays: 7 });
    await mkdir(join(oldRoot, 'native-home'), { recursive: true });
    const dump = join(oldRoot, 'native-home', 'synthetic-runtime.bin'); await writeFile(dump, ''); await truncate(dump, 52 * 1048576);
    const usage = c.hub.storage.refresh(); assert.ok(usage.appBytes >= 52 * 1048576); assert.equal(usage.reason, 'app_storage_limit');
    assert.throws(() => c.hub.current.mode('running'), /app_storage_limit/);
    assert.equal(c.hub.current.store.steps().length, 0); assert.equal(c.providers.at(-1)!.calls.length, 0);
    const policy = c.hub.storage.policy(); assert.equal(policy.appMiB, 64);
    const alpha = c.hub.snapshot().workspace!.projects.find(project => project.name === 'Alpha')!;
    await c.switchTo(alpha.id);
    assert.equal(c.hub.storage.policy().appMiB, 64); assert.equal(c.hub.storage.policy().logsMiB, 1);
  } finally { await c.close(); }
});


test('shared hires assign all eight unique appearances before publishing and reject duplicate avatar choices', async () => {
  const c = await fixture();
  try {
    const projectA = await c.create('Alpha', c.folderA); await c.hub.current.connect();
    c.hub.current.hire({ id: id(), avatarId: '01', name: 'First builder', role: 'builder', responsibility: '', model: 'demo', effort: 'demo' });
    assert.throws(() => c.hub.current.hire({ id: id(), avatarId: '01', name: 'Duplicate', role: 'reviewer', responsibility: '', model: 'demo', effort: 'demo' }), /avatar_unavailable/);
    for (let index = 1; index < 8; index++) c.hire(index % 2 ? 'reviewer' : 'builder');
    assert.deepEqual(c.hub.snapshot().team.agents.map(agent => agent.avatarId), ['01','02','03','04','05','06','07','08']);
    await c.create('Beta', c.folderB); await c.hub.current.connect();
    assert.throws(() => c.hire('builder'), /team_limit/);
    await c.switchTo(projectA);
    assert.equal(c.hub.snapshot().team.agents.length, 8);
    assert.equal(new Set(c.hub.snapshot().team.agents.map(agent => agent.id)).size, 8);
  } finally { await c.close(); }
});


test('project creation revalidates destination folders after leased writes drain', async () => {
  const c = await fixture(), entered = deferred(), release = deferred();
  try {
    const projectA = await c.create('Alpha', c.folderA);
    // Simulate an already accepted asynchronous metadata mutation committing before its lease ends.
    const changing = c.hub.scoped(projectA, async coordinator => {
      entered.resolve(); await release.promise;
      coordinator.store.saveProject({ ...coordinator.store.project()!, folder: c.folderB });
      coordinator.publish();
    }).catch(error => error);
    await entered.promise;
    const creating = c.hub.createProject(projectA, { id: id(), name: 'Beta', brief: '', folder: c.folderB, credits: 50 });
    await until(() => c.hub.switching);
    release.resolve();
    assert.equal((await changing).code, 'stale_project');
    await assert.rejects(creating, /project_folder_in_use/);
    assert.equal(c.hub.activeProjectId, projectA);
    assert.equal(c.hub.snapshot().workspace!.projects.length, 1);
    assert.equal(c.hub.snapshot().project!.folder, c.folderB);
    assert.equal(c.hub.snapshot().connection.status, 'offline');
  } finally { release.resolve(); await c.close(); }
});

test('configuration rechecks the stopped fence after asynchronous filesystem validation', async () => {
  const c = await fixture();
  try {
    await c.create('Alpha', c.folderA);
    const current = c.hub.current;
    const changing = Coordinator.prototype.configure.call(current, { name: 'Changed too late', brief: '', folder: c.folderB, credits: 100 });
    current.stopping = true;
    await assert.rejects(changing, /manager_busy/);
    assert.equal(current.store.project()!.name, 'Alpha'); assert.equal(current.store.project()!.folder, c.folderA);
    current.stopping = false;
  } finally { await c.close(); }
});

test('SQLite paths reject dangling links, sidecar links, nonregular files and hardlinked aliases before touching targets', async () => {
  const c = await fixture();
  try {
    for (const [index, name] of ['workspace.sqlite', 'project-team.sqlite', 'workspace.sqlite-wal', 'workspace.sqlite-shm'].entries()) {
      const root = join(c.dir, `unsafe-${index}`), outside = join(c.dir, `outside-${index}.sqlite`);
      await mkdir(root); await symlink(outside, join(root, name));
      assert.throws(() => new WorkspaceHub(root, c.factory, true), /storage_path_changed/);
      await assert.rejects(readFile(outside), { code: 'ENOENT' });
    }
    const hardlinkRoot = join(c.dir, 'hardlinked'), outside = join(c.dir, 'external-sentinel');
    await mkdir(hardlinkRoot); await writeFile(outside, 'Keep this file intact'); await link(outside, join(hardlinkRoot, 'workspace.sqlite'));
    assert.throws(() => new WorkspaceHub(hardlinkRoot, c.factory, true), /storage_path_changed/);
    assert.equal(await readFile(outside, 'utf8'), 'Keep this file intact');
    const directoryRoot = join(c.dir, 'directory-db'); await mkdir(directoryRoot); await mkdir(join(directoryRoot, 'workspace.sqlite'));
    assert.throws(() => new WorkspaceHub(directoryRoot, c.factory, true), /storage_path_changed/);
  } finally { await c.close(); }
});

test('an unconfirmed native close fences inference but leaves project-switch and Stop retries reachable', async () => {
  const c = await fixture();
  try {
    const projectA = await c.create('Alpha', c.folderA), projectB = await c.create('Beta', c.folderB); await c.switchTo(projectA);
    const old = c.hub.current;
    let closeAttempts = 0;
    old.provider.closeForStorage = async () => { if (++closeAttempts === 1) throw new AppError('storage_native_busy', 409); };
    const input = { id: id(), projectId: projectB };
    await assert.rejects(c.hub.switchProject(projectA, input), /storage_native_busy/);
    assert.equal(c.hub.snapshot().stopping, false);
    assert.equal(c.hub.snapshot().workspace!.switching, false);
    assert.equal(old.stopping, true);
    assert.equal(c.hub.snapshot().connection.error, 'storage_native_busy');
    await assert.rejects(old.connect(), /manager_busy/);
    await c.hub.switchProject(projectA, input);
    assert.equal(closeAttempts, 2); assert.equal(c.hub.activeProjectId, projectB);
    assert.equal(c.hub.snapshot().project!.mode, 'paused'); assert.equal(c.hub.snapshot().connection.status, 'offline');
  } finally { await c.close(); }
});

test('a failed global Stop does not invoke shutdown callback and can be retried successfully', async () => {
  const c = await fixture(); let onStopCalls = 0;
  const options = { port: 0, root: c.dir, demo: true, onStop: () => { onStopCalls++; } };
  const server = serverFor(c.hub, options); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  options.port = (server.address() as { port: number }).port;
  try {
    const project = await c.create('Alpha', c.folderA);
    let attempts = 0;
    c.hub.current.provider.closeForStorage = async () => { if (++attempts === 1) throw new AppError('storage_native_busy', 409); };
    const stop = () => fetch(`http://127.0.0.1:${options.port}/api/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Project-Team': '1', 'X-Project-Id': project }, body: '{}' });
    assert.equal((await stop()).status, 202);
    await until(() => !c.hub.stopping && c.hub.snapshot().connection.error === 'storage_native_busy');
    assert.equal(onStopCalls, 0); assert.equal(c.hub.snapshot().stopping, false);
    assert.equal((await stop()).status, 202);
    await until(() => onStopCalls === 1);
    assert.equal(c.hub.snapshot().stopping, true); assert.equal(attempts, 2);
  } finally { server.close(); server.closeAllConnections(); await c.close(); }
});

test('incomplete catalog maintenance still leaves a paused inspection/settings surface without allowing inference', async () => {
  const c = await fixture();
  try {
    await c.create('Alpha', c.folderA);
    c.hub.current.storage.useCatalogBudget(new CatalogStorageBudget(c.state, c.hub.registry, () => c.hub.storageRoots(), 1));
    await c.hub.startupMaintenance();
    const state = c.hub.snapshot();
    assert.equal(state.storage!.status, 'unavailable'); assert.equal(state.stopping, false); assert.equal(state.busy, false);
    assert.equal(state.project!.mode, 'paused'); assert.equal(state.connection.status, 'offline');
    await c.hub.current.connect();
    assert.throws(() => c.hub.current.mode('running'), /storage_scan_incomplete/);
    assert.equal(c.providers.at(-1)!.calls.length, 0);
  } finally { await c.close(); }
});
