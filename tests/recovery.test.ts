import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.ts';
import { TeamCoordinator } from '../server/team-coordinator.ts';
import { DemoTeam } from '../server/demo-team.ts';
import { CodexManager, inspectTurns } from '../server/codex.ts';
import { AppError } from '../server/types.ts';
import type { Agent, Plan, Step, Task, TeamTurn, TurnCallbacks, TurnInspection, OutputVersion } from '../server/types.ts';

const id = () => randomUUID();
async function until(predicate: () => boolean) { const end = Date.now() + 5000; while (!predicate()) { assert.ok(Date.now() < end); await new Promise(resolve => setTimeout(resolve, 10)); } }
class RecoveryDemo extends DemoTeam {
  calls = 0; crashReply = false; loseAck = false; inspection?: TurnInspection;
  async perform(input: TeamTurn, callbacks: TurnCallbacks) {
    this.calls++;
    const wrapped = this.loseAck && input.kind === 'builder' ? { ...callbacks, onTurn: () => {}, onEvent: () => {} } : callbacks;
    const result = await super.perform(input, wrapped);
    if (this.crashReply && input.kind === 'builder') throw new AppError('simulated_reply_loss');
    return result;
  }
  async inspect(thread: string, turn: string | null, prompt: string | null) { return this.inspection ?? super.inspect(thread, turn, prompt); }
}
async function setup() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'team-recovery-'))), folder = join(dir, 'project'), stateDir = join(dir, 'state');
  await mkdir(folder); await mkdir(stateDir);
  let store = new Store(join(stateDir, 'team.sqlite')), provider = new RecoveryDemo(store), coordinator = new TeamCoordinator(store, provider, true);
  provider.delay = 10;
  await coordinator.configure({ name: 'Recovery note', brief: 'A saved note.', folder, credits: 500 }); await coordinator.connect();
  for (const role of ['builder', 'reviewer'] as const) coordinator.hire({ id: id(), name: role, role, responsibility: role, model: 'demo', effort: 'demo' });
  coordinator.mode('running'); coordinator.proposePlan({ id: id(), instruction: '' }); await coordinator.active; coordinator.mode('paused');
  coordinator.approvePlan({ id: id(), planId: store.all<Plan>('plans')[0].id });
  return {
    dir, folder, get store() { return store; }, get provider() { return provider; }, get coordinator() { return coordinator; },
    async runCrash(capture = false, loseAck = false) {
      if (capture) { const finish = store.finish.bind(store); store.finish = (...args) => { if (args[1] === 'complete' && args[0].startsWith('task:')) throw new AppError('simulated_commit_loss'); return finish(...args); }; }
      else provider.crashReply = true;
      provider.loseAck = loseAck; coordinator.mode('running'); await until(() => store.project()!.mode === 'recovery' && !coordinator.busy);
      return store.steps().at(-1)!;
    },
    async reopen() {
      coordinator.stopping = true; clearInterval(coordinator.quotaTimer); provider.close(); store.close();
      store = new Store(join(stateDir, 'team.sqlite')); provider = new RecoveryDemo(store); provider.delay = 10; coordinator = new TeamCoordinator(store, provider, true); await coordinator.connect();
    },
    async close() { await coordinator.stop(); store.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('completed task snapshots survive commit loss; recovery is atomic, deduplicated and inference-free', async () => {
  const c = await setup(); try {
    const step = await c.runCrash(true); const saved = c.store.journal(step.id).outputs![0];
    assert.equal(c.store.all('outputs').length, 0);
    await writeFile(join(c.folder, 'team-note.md'), 'Edited after native completion');
    await c.reopen(); assert.equal(c.provider.calls, 0);
    assert.throws(() => c.coordinator.mode('running'), /recovery_required/);
    const check = { id: id(), stepId: step.id, action: 'check' as const };
    await c.coordinator.recoverStep(check); await c.coordinator.recoverStep(check);
    assert.equal(c.store.journal(step.id).state, 'ready'); assert.equal(c.store.journal(step.id).afterCrash, false);
    await assert.rejects(c.coordinator.recoverStep({ id: id(), stepId: step.id, action: 'restore', outputIds: [] }), /stale_recovery/);
    const restore = { id: id(), stepId: step.id, action: 'restore' as const, outputIds: [saved.id] };
    await c.coordinator.recoverStep(restore); await c.coordinator.recoverStep(restore);
    assert.equal(c.provider.calls, 0); assert.equal(c.store.all('outputs').length, 1);
    assert.equal(c.store.read<Task>('tasks', step.taskId!)!.status, 'complete');
    assert.equal(c.store.read<Step>('steps', step.id)!.estimated, false);
    assert.equal(c.store.balance().used, 1.8); assert.equal(c.store.balance().reserved, 0);
    assert.match(await c.coordinator.artifacts.content(saved.id), /A saved note/);
    assert.equal(await readFile(join(c.folder, 'team-note.md'), 'utf8'), 'Edited after native completion');
    c.coordinator.mode('running'); await until(() => !c.coordinator.busy && c.store.all<Task>('tasks')[1].status === 'complete');
    assert.equal(c.provider.calls, 1, 'only dependent reviewer runs after explicit Resume');
    assert.equal(c.store.all<OutputVersion>('outputs').filter(output => output.path).length, 1);
    await c.reopen(); assert.equal(c.provider.calls, 0); assert.equal(c.store.recoveryPending(), false);
  } finally { await c.close(); }
});

test('lost acknowledgement matches the unique saved prompt; post-crash files require an explicit version decision', async () => {
  const c = await setup(); try {
    const step = await c.runCrash(false, true); assert.equal(step.turnId, null); assert.equal(c.store.journal(step.id).result, undefined);
    await writeFile(join(c.folder, 'team-note.md'), 'Current file after the crash'); await c.reopen();
    await c.coordinator.recoverStep({ id: id(), stepId: step.id, action: 'check' });
    const journal = c.store.journal(step.id); assert.equal(journal.state, 'ready'); assert.equal(journal.afterCrash, true);
    assert.ok(c.store.read<Step>('steps', step.id)!.turnId); assert.equal(c.store.read<Step>('steps', step.id)!.estimated, true);
    const candidate = journal.outputs![0]; assert.equal(await c.coordinator.artifacts.verify(candidate), 'Current file after the crash');
    await writeFile(join(c.folder, 'team-note.md'), 'Changed again after checking');
    await c.coordinator.recoverStep({ id: id(), stepId: step.id, action: 'check' });
    assert.equal(c.store.journal(step.id).outputs![0].id, candidate.id, 'rechecking retains the reviewed candidate');
    await c.coordinator.recoverStep({ id: id(), stepId: step.id, action: 'restore', outputIds: [candidate.id] });
    assert.equal(await c.coordinator.artifacts.content(candidate.id), 'Current file after the crash');
    assert.equal(c.store.read<Step>('steps', step.id)!.estimated, true, 'history never invents token usage');
    assert.equal(c.provider.calls, 0);
  } finally { await c.close(); }
});

for (const state of ['unknown', 'active'] as const) test(`${state} history blocks retry, dismissal and Resume without creating a second attempt`, async () => {
  const c = await setup(); try {
    const step = await c.runCrash(); await c.reopen(); c.provider.inspection = { state };
    await c.coordinator.recoverStep({ id: id(), stepId: step.id, action: 'check' });
    for (const action of ['retry', 'keep'] as const) await assert.rejects(c.coordinator.recoverStep({ id: id(), stepId: step.id, action }), /recovery_unverified/);
    assert.throws(() => c.coordinator.mode('running'), /recovery_required/);
    assert.equal(c.store.steps().length, 2); assert.equal(c.provider.calls, 0); assert.equal(c.store.read<Task>('tasks', step.taskId!)!.attempt, 1);
  } finally { await c.close(); }
});

test('explicit retry preserves the prior charge and queues one new attempt until Resume', async () => {
  const c = await setup(); try {
    const step = await c.runCrash(); await c.reopen(); c.provider.inspection = { state: 'ended', turnId: step.turnId! };
    const retry = { id: id(), stepId: step.id, action: 'retry' as const };
    await c.coordinator.recoverStep(retry); await c.coordinator.recoverStep(retry);
    assert.equal(c.provider.calls, 0); assert.equal(c.store.read<Task>('tasks', step.taskId!)!.attempt, 2);
    assert.equal(c.store.read<Step>('steps', step.id)!.used, step.used); assert.equal(c.store.steps().length, 2);
    await c.reopen(); assert.equal(c.provider.calls, 0); c.coordinator.mode('running');
    await until(() => !c.coordinator.busy && c.store.all<Task>('tasks').every(task => task.status === 'complete'));
    assert.equal(c.provider.calls, 2); assert.equal(c.store.steps().length, 4); assert.equal(c.store.read<Task>('tasks', step.taskId!)!.attempt, 2);
    assert.equal(c.store.steps().filter(saved => saved.taskId === step.taskId).length, 2);
    assert.equal(c.store.all<Agent>('agents')[0].threadId === step.threadId, false);
  } finally { await c.close(); }
});

test('keep stopped releases independent work while preserving blocked dependencies', async () => {
  const c = await setup(); try {
    const step = await c.runCrash(); await c.reopen(); c.provider.inspection = { state: 'ended', turnId: step.turnId! };
    await c.coordinator.recoverStep({ id: id(), stepId: step.id, action: 'keep' }); c.coordinator.mode('running');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(c.provider.calls, 0); assert.equal(c.store.all<Task>('tasks')[1].status, 'queued'); assert.equal(c.store.recoveryPending(), false);
    c.coordinator.mode('paused'); c.provider.inspection = undefined;
    await c.coordinator.recoverStep({ id: id(), stepId: step.id, action: 'check' });
    assert.equal(c.store.journal(step.id).state, 'ready'); assert.equal(c.provider.calls, 0);
  } finally { await c.close(); }
});

test('corrupt recovery snapshots cannot be adopted or silently recaptured', async () => {
  const c = await setup(); try {
    const step = await c.runCrash(true); await c.reopen(); await c.coordinator.recoverStep({ id: id(), stepId: step.id, action: 'check' });
    const output = c.store.journal(step.id).outputs![0]; await writeFile(join(c.coordinator.artifacts.directory, `${output.id}.txt`), 'tampered');
    await assert.rejects(c.coordinator.recoverStep({ id: id(), stepId: step.id, action: 'restore', outputIds: [output.id] }), /snapshot_changed/);
    assert.equal(c.store.read<Task>('tasks', step.taskId!)!.status, 'failed'); assert.equal(c.store.all('outputs').length, 0);
    await c.coordinator.recoverStep({ id: id(), stepId: step.id, action: 'check' }); assert.equal(c.store.journal(step.id).state, 'ended');
  } finally { await c.close(); }
});

test('history matching rejects ambiguous, unrelated and partial records and uses only the final answer', () => {
  const turn = { id: 'turn', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'prompt unique-attempt' }] }, { type: 'agentMessage', phase: 'commentary', text: 'Working' }, { type: 'agentMessage', phase: 'final_answer', text: 'Done' }] };
  assert.deepEqual(inspectTurns([turn], null, 'prompt unique-attempt'), { state: 'completed', turnId: 'turn', text: 'Done' });
  assert.equal(inspectTurns([turn, { ...turn, id: 'duplicate' }], null, 'prompt unique-attempt').state, 'unknown');
  assert.equal(inspectTurns([turn], 'other-turn', null).state, 'unknown');
  assert.equal(inspectTurns([{ ...turn, itemsView: 'summary' }], 'turn', null).state, 'unknown');
  assert.equal(inspectTurns([{ ...turn, status: 'inProgress' }], 'turn', null).state, 'active');
});

test('native history reads page without starting or resuming a turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-history-fixture-'));
  const provider = new CodexManager(dir, process.execPath, [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))]);
  try {
    await provider.connect();
    await provider.chat(null, 'one', () => {}, () => {}, () => {});
    assert.deepEqual(await provider.inspect('fixture-thread', 'fixture-1', null), { state: 'completed', turnId: 'fixture-1', text: 'Saved conversation 1.' });
    assert.equal((await provider.inspect('fixture-thread', null, 'one')).state, 'completed');
    assert.equal((await provider.chat('fixture-thread', 'two', () => {}, () => {}, () => {})).text, 'Saved conversation 2.');
  } finally { provider.close(); await rm(dir, { recursive: true, force: true }); }
});

test('manager plan and conversation recover without duplicating proposals or messages', async () => {
  const c = await setup(); try {
    // Remove the fixture plan/tasks so the manager can propose the first plan.
    c.store.db.exec('DELETE FROM tasks; DELETE FROM milestones; DELETE FROM plans;');
    const finish = c.store.finish.bind(c.store); let fail = true;
    c.store.finish = (...args) => { if (fail && args[1] === 'complete') throw new AppError('simulated_commit_loss'); return finish(...args); };
    c.coordinator.mode('running'); const planId = id(); c.coordinator.proposePlan({ id: planId, instruction: 'One short note.' }); await c.coordinator.active;
    await c.reopen(); await c.coordinator.recoverStep({ id: id(), stepId: planId, action: 'check' });
    const restore = { id: id(), stepId: planId, action: 'restore' as const, outputIds: [] };
    await c.coordinator.recoverStep(restore); await c.coordinator.recoverStep(restore);
    assert.equal(c.provider.calls, 0); assert.equal(c.store.all<Plan>('plans').length, 1); assert.equal(c.store.all('tasks').length, 0); assert.equal(c.store.all<Plan>('plans')[0].status, 'proposed');
    c.store.finish = (...args) => { if (fail && args[1] === 'complete') throw new AppError('simulated_commit_loss'); return Store.prototype.finish.call(c.store, ...args); };
    c.coordinator.mode('running'); const chatId = id(); c.coordinator.send(chatId, 'Discuss the saved plan.', null); await c.coordinator.active;
    fail = false; await c.reopen(); await c.coordinator.recoverStep({ id: id(), stepId: chatId, action: 'check' });
    await c.coordinator.recoverStep({ id: id(), stepId: chatId, action: 'restore', outputIds: [] });
    assert.equal(c.store.messages().filter(message => message.id === `reply:${chatId}`).length, 1); assert.equal(c.provider.calls, 0);
    assert.equal(c.store.balance().estimated, 0);
  } finally { await c.close(); }
});

test('manager retries stay queued across reopening and create a single proposed plan after Resume', async () => {
  const c = await setup(); try {
    c.store.db.exec('DELETE FROM tasks; DELETE FROM milestones; DELETE FROM plans;');
    c.coordinator.mode('running'); const stepId = id();
    const perform = c.provider.perform.bind(c.provider); c.provider.perform = async (...args) => { await perform(...args); throw new AppError('simulated_reply_loss'); };
    c.coordinator.proposePlan({ id: stepId, instruction: 'One short note.' }); await c.coordinator.active; await c.reopen();
    c.provider.inspection = { state: 'ended', turnId: c.store.read<Step>('steps', stepId)!.turnId! };
    const command = { id: id(), stepId, action: 'retry' as const }; await c.coordinator.recoverStep(command); await c.coordinator.recoverStep(command);
    await c.reopen(); assert.equal(c.provider.calls, 0); assert.equal(c.store.all('plans').length, 0);
    c.coordinator.mode('running'); await until(() => c.store.all('plans').length === 1 && !c.coordinator.busy);
    assert.equal(c.provider.calls, 1); assert.equal(c.store.steps().length, 3); assert.equal(c.store.all('tasks').length, 0);
  } finally { await c.close(); }
});

test('reviewer recovery preserves exact inputs and recreates a lost-ack handoff once', async () => {
  const c = await setup(); try {
    const finish = c.store.finish.bind(c.store);
    c.store.finish = (...args) => { const step = c.store.read<Step>('steps', args[0]); const task = step?.taskId ? c.store.read<Task>('tasks', step.taskId) : null; if (args[1] === 'complete' && task?.role === 'reviewer') throw new AppError('simulated_commit_loss'); return finish(...args); };
    c.coordinator.mode('running'); await until(() => !c.coordinator.busy && c.store.project()!.mode === 'recovery');
    const step = c.store.steps().at(-1)!, reviewer = c.store.read<Task>('tasks', step.taskId!)!, input = c.store.all<OutputVersion>('outputs')[0];
    assert.deepEqual(reviewer.inputIds, [input.id]);
    c.store.db.exec('DELETE FROM handoffs;'); await c.reopen();
    await c.coordinator.recoverStep({ id: id(), stepId: step.id, action: 'check' });
    const report = c.store.journal(step.id).outputs![0]; const command = { id: id(), stepId: step.id, action: 'restore' as const, outputIds: [report.id] };
    await c.coordinator.recoverStep(command); await c.coordinator.recoverStep(command);
    assert.equal(c.provider.calls, 0); assert.equal(c.store.all('reviews').length, 1); assert.equal(c.store.all('handoffs').length, 1);
    assert.deepEqual(c.store.all<any>('reviews')[0].outputIds, [input.id]); assert.match(await c.coordinator.artifacts.content(report.id), new RegExp(input.id));
  } finally { await c.close(); }
});

test('manager revision recovery keeps prior outputs and queues revised work without inference', async () => {
  const c = await setup(); try {
    c.coordinator.mode('running'); await until(() => !c.coordinator.busy && c.store.all<Task>('tasks').every(task => task.status === 'complete'));
    const source = c.store.all<OutputVersion>('outputs').find(output => output.path)!, finish = c.store.finish.bind(c.store);
    c.store.finish = (...args) => { if (args[1] === 'complete' && c.store.read<Step>('steps', args[0])?.kind === 'revision') throw new AppError('simulated_commit_loss'); return finish(...args); };
    const stepId = id(); c.coordinator.requestRevision({ id: stepId, outputId: source.id, feedback: 'Add a next step.' }); await c.coordinator.active;
    await c.reopen(); await c.coordinator.recoverStep({ id: id(), stepId, action: 'check' });
    await c.coordinator.recoverStep({ id: id(), stepId, action: 'restore', outputIds: [] });
    assert.equal(c.provider.calls, 0); assert.equal(c.store.all('outputs').length, 2);
    assert.equal(c.store.all<Task>('tasks').filter(task => task.status === 'queued').length, 2);
    assert.ok(await c.coordinator.artifacts.content(source.id)); assert.equal(c.store.project()!.mode, 'recovery');
  } finally { await c.close(); }
});

test('undispatched reservation can be retried with no charge and no history guess', async () => {
  const c = await setup(); try {
    // Reserve directly without yielding to the task pump or sending a native request.
    c.store.saveProject({ ...c.store.project()!, mode: 'running' }); const task = c.store.all<Task>('tasks')[0], agent = c.store.all<Agent>('agents')[0], stepId = `task:${task.id}:${task.attempt}`;
    c.store.beginTask(stepId, task, agent); await c.reopen();
    assert.equal(c.store.read<Step>('steps', stepId)!.used, 0); assert.equal(c.store.read<Step>('steps', stepId)!.status, 'interrupted');
    await c.coordinator.recoverStep({ id: id(), stepId, action: 'retry' });
    assert.equal(c.store.read<Task>('tasks', task.id)!.attempt, 2); assert.equal(c.provider.calls, 0);
  } finally { await c.close(); }
});

test('a bounded history search cannot prove a lost acknowledgement when older pages remain', async () => {
  const provider = new CodexManager('/tmp/unused-history-fixture'); let requests = 0;
  provider.request = async method => { requests++; return method === 'thread/read' ? { thread: { id: 'thread', status: { type: 'idle' } } } : { data: [{ id: 'one', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'attempt' }] }] }], nextCursor: 'more' }; };
  assert.equal((await provider.readTurn('thread', null, 'attempt')).state, 'unknown'); assert.equal(requests, 11);
});
