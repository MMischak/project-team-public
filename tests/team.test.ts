import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { DemoTeam } from '../server/demo-team.ts';
import { TeamCoordinator } from '../server/team-coordinator.ts';
import { CodexTeam } from '../server/codex-team.ts';
import { confinedPath } from '../server/artifacts.ts';
import { parsePlan, parseTaskResult, projectPath } from '../server/team-domain.ts';
import type { Agent, Milestone, OutputVersion, Plan, Task, TeamTurn, TurnCallbacks } from '../server/types.ts';

const id = () => randomUUID();
async function until(predicate: () => boolean) { const end = Date.now() + 5000; while (!predicate()) { assert.ok(Date.now() < end, 'team operation finished'); await new Promise(resolve => setTimeout(resolve, 10)); } }
class ObservedDemo extends DemoTeam {
  calls: TeamTurn[] = []; concurrent = 0; maxConcurrent = 0; transform?: (input: TeamTurn, result: any) => void;
  async perform(input: TeamTurn, callbacks: TurnCallbacks) {
    this.calls.push(structuredClone(input)); this.concurrent++; this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try { const result = await super.perform(input, callbacks); const parsed = JSON.parse(result.text); this.transform?.(input, parsed); return { ...result, text: JSON.stringify(parsed) }; }
    finally { this.concurrent--; }
  }
}
async function setup(hireReviewer = true) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'team-test-'))); const folder = join(dir, 'project'); await mkdir(folder); await mkdir(join(dir, 'state'));
  const store = new Store(join(dir, 'state', 'team.sqlite')); const provider = new ObservedDemo(store); provider.delay = 30;
  const coordinator = new TeamCoordinator(store, provider, true);
  await coordinator.configure({ name: 'A note', brief: 'Explain the goal in one short note.', folder, credits: 500 }); await coordinator.connect();
  const hire = (role: Agent['role']) => coordinator.hire({ id: id(), name: role, role, responsibility: role, model: 'demo', effort: 'demo' });
  hire('builder'); if (hireReviewer) hire('reviewer'); coordinator.mode('running');
  const close = async () => { await coordinator.stop(); store.close(); await rm(dir, { recursive: true, force: true }); };
  const plan = async () => { coordinator.proposePlan({ id: id(), instruction: '' }); await coordinator.active; coordinator.mode('paused'); return store.all<Plan>('plans').at(-1)!; };
  return { dir, folder, store, provider, coordinator, close, plan, hire };
}

test('user hires and approves before sequential work; revision preserves snapshots, handoffs and actor ledgers', async () => {
  const c = await setup(); try {
    const plan = await c.plan(); assert.equal(plan.status, 'proposed'); assert.equal(c.provider.calls.length, 1);
    await assert.rejects(readFile(join(c.folder, 'team-note.md')), /ENOENT/);
    const approval = { id: id(), planId: plan.id }; c.coordinator.approvePlan(approval); c.coordinator.approvePlan(approval);
    assert.equal(c.store.all('tasks').length, 2); assert.equal(c.store.all('outputs').length, 0);
    c.coordinator.mode('running'); await until(() => c.store.all<Milestone>('milestones')[0].status === 'review' && !c.coordinator.busy);
    const milestone = c.store.all<Milestone>('milestones')[0], v1 = c.store.all<OutputVersion>('outputs').find(output => output.path)!;
    const firstContent = await c.coordinator.artifacts.content(v1.id); const handoff = c.store.all<any>('handoffs')[0];
    assert.equal(handoff.outputId, v1.id); assert.equal(handoff.draft, true); assert.equal(c.provider.maxConcurrent, 1);
    assert.deepEqual(c.provider.calls.map(call => call.kind), ['plan', 'builder', 'reviewer']);
    await writeFile(join(c.folder, 'team-note.md'), 'Changed on disk after handoff');
    assert.equal(await c.coordinator.artifacts.content(v1.id), firstContent);
    assert.equal(c.provider.calls[2].inputs[0].content, firstContent);
    const revision = { id: id(), outputId: v1.id, feedback: 'Add a clear next step.' };
    c.coordinator.requestRevision(revision); c.coordinator.requestRevision(revision);
    await until(() => c.store.all<OutputVersion>('outputs').some(output => output.path && output.version === 2) && c.store.all<Milestone>('milestones')[0].status === 'review' && !c.coordinator.busy);
    const updated = c.store.all<Milestone>('milestones')[0], v2 = c.store.all<OutputVersion>('outputs').find(output => output.path && output.version === 2)!;
    assert.equal(await c.coordinator.artifacts.content(v1.id), firstContent); assert.match(await c.coordinator.artifacts.content(v2.id), /clear next step/);
    assert.equal(c.store.all<any>('handoffs')[0].outputId, v1.id); assert.ok(!updated.outputIds.includes(v1.id));
    assert.throws(() => c.coordinator.acceptMilestone({ id: id(), milestoneId: milestone.id, outputIds: milestone.outputIds }), /stale_review/);
    c.coordinator.acceptMilestone({ id: id(), milestoneId: milestone.id, outputIds: updated.outputIds });
    assert.equal(c.store.read<OutputVersion>('outputs', v2.id)!.status, 'accepted'); assert.equal(c.store.read<OutputVersion>('outputs', v1.id)!.status, 'draft');
    assert.equal(c.store.balance().used, 5.4); assert.equal(c.store.balance().reserved, 0);
    assert.deepEqual(Object.values(c.store.team().agentCredits), [1.8, 1.8, 1.8]);
    assert.throws(() => c.coordinator.requestRevision({ id: id(), outputId: v2.id, feedback: 'late' }), /stale_review/);
  } finally { await c.close(); }
});

test('missing expertise blocks only affected work; user assignment releases it', async () => {
  const c = await setup(false); try {
    const plan = await c.plan(); c.coordinator.approvePlan({ id: id(), planId: plan.id }); c.coordinator.mode('running');
    await until(() => c.store.all<Task>('tasks')[0].status === 'complete' && !c.coordinator.busy);
    assert.equal(c.store.all<Task>('tasks')[1].status, 'queued'); assert.equal(c.coordinator.waitingReason, 'hire_required');
    c.hire('reviewer'); const reviewer = c.store.all<Agent>('agents')[1];
    c.coordinator.assignTask({ id: id(), taskId: c.store.all<Task>('tasks')[1].id, agentId: reviewer.id, priority: 90 });
    await until(() => c.store.all<Milestone>('milestones')[0].status === 'review');
  } finally { await c.close(); }
});

test('dependent milestones wait for exact acceptance; independent tasks continue and conflicts need the user', async () => {
  const c = await setup(); try {
    c.provider.transform = (input, result) => {
      if (input.kind === 'plan') {
        const builder = result.milestones[0].tasks[0];
        result.milestones.push({ id: 'dependent', title: 'Dependent delivery', tasks: [{ ...builder, id: 'dependent-note', dependencies: ['write-note'], outputs: ['dependent.md'] }] });
        result.milestones.push({ id: 'independent', title: 'Independent delivery', tasks: [{ ...builder, id: 'independent-note', dependencies: [], outputs: ['independent.md'] }] });
      }
      if (input.kind === 'builder' && input.allowedOutputs[0] === 'independent.md') { result.verdict = 'conflict'; result.alternatives = [{ label: 'A', reasoning: 'Choose A', instruction: 'Use A' }, { label: 'B', reasoning: 'Choose B', instruction: 'Use B' }]; }
    };
    const plan = await c.plan(); c.coordinator.approvePlan({ id: id(), planId: plan.id }); c.coordinator.mode('running');
    await until(() => c.store.all<Milestone>('milestones')[0].status === 'review' && c.store.all<any>('decisions').length === 1 && !c.coordinator.busy);
    assert.equal(c.store.all<Task>('tasks').find(task => task.title === 'Write the note' && task.outputs.includes('dependent.md'))!.status, 'queued');
    assert.equal(c.store.all<any>('decisions')[0].status, 'open');
    const first = c.store.all<Milestone>('milestones')[0]; c.coordinator.acceptMilestone({ id: id(), milestoneId: first.id, outputIds: first.outputIds });
    await until(() => c.store.all<Milestone>('milestones')[1].status === 'review' && !c.coordinator.busy);
    const dependent = c.provider.calls.find(call => call.allowedOutputs.includes('dependent.md'))!;
    assert.equal(dependent.inputs[0].version.status, 'accepted');
    c.provider.transform = undefined; const decision = c.store.all<any>('decisions')[0];
    c.coordinator.resolveDecision({ id: id(), decisionId: decision.id, instruction: decision.alternatives[0].instruction });
    await until(() => c.store.read<any>('decisions', decision.id).status === 'resolved' && !c.coordinator.busy);
    assert.equal(c.provider.maxConcurrent, 1);
  } finally { await c.close(); }
});

test('pause and graceful Stop drain only the active team task; reopening cannot replay interrupted work', async () => {
  const c = await setup(); try {
    const plan = await c.plan(); c.coordinator.approvePlan({ id: id(), planId: plan.id }); c.provider.delay = 100;
    c.coordinator.mode('running'); await until(() => c.coordinator.busy); c.coordinator.mode('paused'); await c.coordinator.active;
    assert.equal(c.provider.calls.filter(call => call.kind === 'reviewer').length, 0);
    c.coordinator.mode('running'); await until(() => c.coordinator.busy); await c.coordinator.stop();
    assert.equal(c.store.all<Task>('tasks')[1].status, 'complete'); assert.equal(c.store.project()!.mode, 'stopped');
    const task = c.store.all<Task>('tasks')[0], agent = c.store.all<Agent>('agents')[0];
    c.store.saveProject({ ...c.store.project()!, mode: 'running' }); c.store.beginTask('interrupted-fixture', task, agent); c.store.dispatched('interrupted-fixture', 'interrupted-turn');
    const restored = new TeamCoordinator(c.store, c.provider, true); assert.equal(c.store.project()!.mode, 'recovery'); assert.equal(c.store.read<Task>('tasks', task.id)!.status, 'interrupted'); assert.ok(c.store.balance().estimated > 0); await restored.stop();
  } finally { await c.close(); }
});

test('paths and captured outputs reject traversal, metadata, escaping symlinks and corrupt versions', async () => {
  const c = await setup(); try {
    for (const path of ['../outside', '/tmp/x', '.git/config', '.env', 'a/.aws/key', 'a//b']) assert.throws(() => projectPath(path), /invalid_output_path/);
    await writeFile(join(c.dir, 'outside.txt'), 'private'); await symlink(c.dir, join(c.folder, 'escape'));
    await assert.rejects(confinedPath(c.folder, 'escape/outside.txt'), /path_outside_project/);
    await assert.rejects(confinedPath(c.folder, 'escape/new.txt', true), /path_outside_project/);
    const plan = await c.plan(); c.coordinator.approvePlan({ id: id(), planId: plan.id }); c.coordinator.mode('running'); await until(() => c.store.all<Milestone>('milestones')[0].status === 'review');
    const output = c.store.all<OutputVersion>('outputs')[0]; await writeFile(join(c.coordinator.artifacts.directory, `${output.id}.txt`), 'corrupted');
    await assert.rejects(c.coordinator.artifacts.content(output.id), /snapshot_changed/);
  } finally { await c.close(); }
});

test('structured agent replies cannot assign an unhired member or change authority; reviewers cannot execute', async () => {
  const c = await setup(); try {
    const plan = await c.plan(); const proposal = { summary: plan.summary, milestones: plan.milestones, suggestedHires: plan.suggestedHires };
    const copy = structuredClone(proposal); copy.milestones[0].tasks[0].agentId = 'invented'; assert.throws(() => parsePlan(JSON.stringify(copy), c.store.all('agents')), /unhired_agent/);
    copy.milestones[0].tasks[0].agentId = proposal.milestones[0].tasks[0].agentId; copy.milestones[0].tasks[0].dependencies = ['review-note']; assert.throws(() => parsePlan(JSON.stringify(copy), c.store.all('agents')), /invalid_dependencies/);
    assert.throws(() => parsePlan(JSON.stringify({ ...proposal, approve: true }), c.store.all('agents')), /invalid_agent_result/);
    assert.throws(() => parseTaskResult(JSON.stringify({ summary: 'Approved', outputs: [], verdict: 'ready', findings: '', alternatives: [], hire: 'invented' }), [], true), /invalid_agent_result/);
    const provider = new CodexTeam(join(c.dir, 'native'));
    const context = { input: { kind: 'reviewer', inputs: [] } as unknown as TeamTurn, threadId: 'thread', turnId: 'turn', toolCalls: 0, pending: [], toolTail: Promise.resolve() }; provider.context = context;
    await assert.rejects(provider.executeTool('project_exec', { command: ['/bin/pwd'] }, context), /unexpected_tool_identity/);
    provider.close();
  } finally { await c.close(); }
});

test('credit headroom and account quota guard the shared queue, including user priority overrides', async () => {
  const c = await setup(); try {
    const plan = await c.plan(); c.coordinator.approvePlan({ id: id(), planId: plan.id });
    const tasks = c.store.all<Task>('tasks'), builder = c.store.all<Agent>('agents')[0];
    c.coordinator.assignTask({ id: id(), taskId: tasks[0].id, agentId: builder.id, priority: 95 });
    assert.equal(c.store.read<Task>('tasks', tasks[0].id)!.priority, 95);
    await c.coordinator.configure({ ...c.store.project()!, credits: 2 }); c.coordinator.mode('running');
    await until(() => c.coordinator.waitingReason === 'credit_limit'); assert.equal(c.provider.calls.length, 1);
    c.coordinator.mode('paused'); await c.coordinator.configure({ ...c.store.project()!, credits: 500 });
    c.coordinator.connection.quota = [{ usedPercent: 100, windowDurationMins: 300, resetsAt: null }]; c.coordinator.mode('running');
    await until(() => c.coordinator.waitingReason === 'quota_exhausted'); assert.equal(c.provider.calls.length, 1);
    c.coordinator.mode('paused'); c.coordinator.connection.quota = []; c.provider.delay = 80;
    c.coordinator.mode('running'); await until(() => c.coordinator.busy); assert.equal(c.store.balance().reserved, 2.4);
    assert.throws(() => c.coordinator.send(id(), 'Competing manager turn', null), /manager_busy/);
    await until(() => c.store.all<Milestone>('milestones')[0].status === 'review' && !c.coordinator.busy);
    assert.equal(c.store.balance().reserved, 0); assert.equal(c.provider.maxConcurrent, 1);
  } finally { await c.close(); }
});

test('dynamic handoff tools bind to the exact thread, turn, request id and permitted captured version', async () => {
  const provider = new CodexTeam('/tmp/unused-team-protocol'); const replies: any[] = [];
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, stdin: { write: (value: string) => replies.push(JSON.parse(value)) }, kill: () => child.emit('exit', 0) });
  provider.child = child as any;
  const context = { input: { kind: 'reviewer', inputs: [{ version: { id: 'version-one' }, content: 'Frozen v1' }] } as unknown as TeamTurn, threadId: 'reviewer-thread', turnId: null as string | null, toolCalls: 0, pending: [] as any[], toolTail: Promise.resolve() };
  provider.context = context;
  const message = { id: 49, method: 'item/tool/call', params: { threadId: context.threadId, turnId: 'reviewer-turn', callId: 'not-the-request-id', tool: 'read_output', arguments: { versionId: 'version-one' } } };
  provider.serverRequest(message); assert.equal(replies.length, 0); assert.equal(context.pending.length, 1);
  context.turnId = 'reviewer-turn'; for (const pending of context.pending.splice(0)) provider.serverRequest(pending); await context.toolTail;
  assert.equal(replies[0].id, 49); assert.equal(replies[0].result.success, true); assert.match(replies[0].result.contentItems[0].text, /Frozen v1/);
  provider.serverRequest({ ...message, id: 50, params: { ...message.params, arguments: { versionId: 'not-handed-off' } } }); await context.toolTail;
  assert.equal(replies[1].result.success, false);
  provider.serverRequest({ ...message, id: 51, params: { ...message.params, turnId: 'foreign-turn' } });
  assert.equal(provider.child, null); assert.equal(provider.connection.error, 'unexpected_tool_identity');
  provider.close();
});

test('revisions invalidate transitive consumers and cannot replace versions accepted during manager planning', async () => {
  const c = await setup(); try {
    c.provider.transform = (input, result) => { if (input.kind === 'plan') {
      const tasks = result.milestones[0].tasks; tasks.splice(1, 0, { ...tasks[0], id: 'extend-note', title: 'Extend the note', dependencies: ['write-note'], outputs: ['extended.md'] }); tasks[2].dependencies = ['extend-note'];
    } };
    const plan = await c.plan(); c.coordinator.approvePlan({ id: id(), planId: plan.id }); c.coordinator.mode('running');
    await until(() => c.store.all<Milestone>('milestones')[0].status === 'review' && !c.coordinator.busy);
    const output = c.store.all<OutputVersion>('outputs')[0], originalTasks = c.store.all<Task>('tasks');
    c.coordinator.requestRevision({ id: id(), outputId: output.id, feedback: 'Revise the goal.' });
    await until(() => c.store.all<OutputVersion>('outputs').length === 6 && !c.coordinator.busy);
    assert.ok(originalTasks.every(task => !!c.store.read<Task>('tasks', task.id)!.supersededBy));
    const milestone = c.store.all<Milestone>('milestones')[0]; const currentOutput = c.store.all<OutputVersion>('outputs').find(output => output.path === 'team-note.md' && output.version === 2)!;
    c.provider.delay = 80; c.coordinator.requestRevision({ id: id(), outputId: currentOutput.id, feedback: 'A late change.' });
    c.coordinator.acceptMilestone({ id: id(), milestoneId: milestone.id, outputIds: milestone.outputIds }); await c.coordinator.active;
    assert.equal(c.store.all<Milestone>('milestones')[0].status, 'accepted'); assert.equal(c.store.all<OutputVersion>('outputs').length, 6);
    assert.equal(c.store.steps().at(-1)!.estimated, false, 'a completed invalid proposal settles its reported usage');
  } finally { await c.close(); }
});

test('feedback on a later review creates follow-up work without invalidating an accepted producing milestone', async () => {
  const c = await setup(); try {
    c.provider.transform = (input, result) => { if (input.kind === 'plan') {
      const reviewer = result.milestones[0].tasks.pop(); result.milestones.push({ id: 'later-review', title: 'Later review', tasks: [reviewer] });
    } };
    const plan = await c.plan(); c.coordinator.approvePlan({ id: id(), planId: plan.id }); c.coordinator.mode('running');
    await until(() => c.store.all<Milestone>('milestones')[0].status === 'review' && !c.coordinator.busy);
    const first = c.store.all<Milestone>('milestones')[0], producer = c.store.all<Task>('tasks')[0], v1 = c.store.all<OutputVersion>('outputs')[0];
    c.coordinator.acceptMilestone({ id: id(), milestoneId: first.id, outputIds: first.outputIds });
    await until(() => c.store.all<Milestone>('milestones')[1].status === 'review' && !c.coordinator.busy);
    const review = c.store.all<OutputVersion>('outputs').find(output => output.path === null)!;
    c.coordinator.requestRevision({ id: id(), outputId: review.id, feedback: 'Add a next step to the note.' });
    await until(() => c.store.all<OutputVersion>('outputs').some(output => output.path && output.version === 2) && c.store.all<Milestone>('milestones')[1].status === 'review' && !c.coordinator.busy);
    assert.equal(c.store.read<Task>('tasks', producer.id)!.supersededBy, undefined);
    assert.equal(c.store.read<OutputVersion>('outputs', v1.id)!.status, 'accepted'); assert.equal(c.store.read<Milestone>('milestones', first.id)!.status, 'accepted');
    assert.deepEqual(c.store.read<Milestone>('milestones', first.id)!.acceptedIds, [v1.id]);
  } finally { await c.close(); }
});

test('acyclic task graphs cannot create circular milestone acceptance gates', async () => {
  const c = await setup(); try {
    const plan = await c.plan(), builder = plan.milestones[0].tasks[0];
    const proposal = { summary: 'Deadlocked gates', suggestedHires: [], milestones: [
      { id: 'first', title: 'First', tasks: [{ ...builder, id: 'first-producer' }, { ...builder, id: 'first-consumer', dependencies: ['second-producer'] }] },
      { id: 'second', title: 'Second', tasks: [{ ...builder, id: 'second-producer', dependencies: ['first-producer'] }] },
    ] };
    assert.throws(() => parsePlan(JSON.stringify(proposal), c.store.all('agents')), /invalid_dependencies/);
  } finally { await c.close(); }
});

test('Stop closes native services even when storage cannot save the stopped state', async () => {
  const c = await setup(); const save = c.store.saveProject.bind(c.store); let closed = false;
  try {
    c.provider.close = () => { closed = true; }; c.store.saveProject = () => { throw new Error('disk is full'); };
    await assert.rejects(c.coordinator.stop(), /disk is full/); assert.equal(closed, true); assert.equal(c.coordinator.connection.status, 'offline');
  } finally { c.store.saveProject = save; await c.close(); }
});
