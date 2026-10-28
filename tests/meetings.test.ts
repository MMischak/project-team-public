import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { MeetingCoordinator } from '../server/meeting-coordinator.ts';
import { DemoTeam } from '../server/demo-team.ts';
import { CodexTeam } from '../server/codex-team.ts';
import { AppError } from '../server/types.ts';
import { parseMeetingResult } from '../server/meeting-domain.ts';
import type { Agent, Meeting, MeetingAction, MeetingConversation, MeetingMessage, MeetingProposal, MeetingTurn, Plan, Step, Task, TeamTurn, TurnCallbacks, TurnInspection } from '../server/types.ts';

const id = () => randomUUID();
async function until(predicate: () => boolean) { const end = Date.now() + 5000; while (!predicate()) { assert.ok(Date.now() < end, 'meeting operation finished'); await new Promise(resolve => setTimeout(resolve, 10)); } }
class ObservedMeeting extends DemoTeam {
  calls: TeamTurn[] = []; concurrent = 0; maximum = 0; transform?: (input: TeamTurn, result: any) => void; inspection?: TurnInspection;
  async perform(input: TeamTurn, callbacks: TurnCallbacks) {
    this.calls.push(structuredClone(input)); this.concurrent++; this.maximum = Math.max(this.maximum, this.concurrent);
    try { const result = await super.perform(input, callbacks), parsed = JSON.parse(result.text); this.transform?.(input, parsed); return { ...result, text: JSON.stringify(parsed) }; } finally { this.concurrent--; }
  }
  async inspect(thread: string, turn: string | null, prompt: string | null) { return this.inspection ?? super.inspect(thread, turn, prompt); }
}
async function setup() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'meeting-test-'))), folder = join(dir, 'project'), path = join(dir, 'state', 'team.sqlite'); await mkdir(folder); await mkdir(join(dir, 'state'));
  let store = new Store(path), provider = new ObservedMeeting(store), coordinator = new MeetingCoordinator(store, provider, true); provider.delay = 15;
  await coordinator.configure({ name: 'A team note', brief: 'Explain the goal clearly.', folder, credits: 500 }); await coordinator.connect();
  for (const role of ['builder', 'reviewer'] as const) coordinator.hire({ id: id(), name: role, role, responsibility: role, model: 'demo', effort: 'demo' }); coordinator.mode('running');
  const roomId = id(); coordinator.createMeeting({ id: roomId, title: 'Open project discussion', participantIds: store.all<Agent>('agents').map(agent => agent.id) });
  return {
    folder, dir, roomId, get store() { return store; }, get coordinator() { return coordinator; }, get provider() { return provider; },
    post(recipientIds = store.read<Meeting>('meetings', roomId)!.participantIds, text = 'What should we improve?', attachment: string | null = null) { const command = { id: id(), meetingId: roomId, text, recipientIds, attachment }; coordinator.postMeeting(command); return command; },
    async idle() { await until(() => !coordinator.busy && !store.all<MeetingTurn>('meetingTurns').some(turn => ['running', 'queued'].includes(turn.status))); },
    async plan() { coordinator.proposePlan({ id: id(), instruction: '' }); await coordinator.active; coordinator.mode('paused'); const plan = store.all<Plan>('plans').at(-1)!; coordinator.approvePlan({ id: id(), planId: plan.id }); return plan; },
    async reopen() { coordinator.stopping = true; clearInterval(coordinator.quotaTimer); provider.close(); store.close(); store = new Store(path); provider = new ObservedMeeting(store); provider.delay = 15; coordinator = new MeetingCoordinator(store, provider, true); await coordinator.connect(); },
    async close() { await coordinator.stop(); store.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('open meetings address participants without manager moderation; each reply is serial, attributed and discussion-only', async () => {
  const c = await setup(); try {
    assert.equal(c.provider.calls.length, 0, 'creating a meeting never infers');
    const room = c.store.read<Meeting>('meetings', c.roomId)!, command = c.post([...room.participantIds].reverse()); c.coordinator.postMeeting(command);
    await c.idle(); const messages = c.store.all<MeetingMessage>('meetingMessages');
    assert.deepEqual(messages.slice(1).map(message => message.speakerId), [...room.participantIds].reverse()); assert.equal(messages.length, 4); assert.equal(c.provider.maximum, 1);
    assert.equal(c.store.messages().length, 0, 'meeting transcript is separate from manager chat'); assert.equal(c.store.all('tasks').length, 0); assert.equal(c.store.all('outputs').length, 0);
    assert.equal(c.store.balance().used, 2.7); assert.equal(c.store.balance().reserved, 0); assert.equal(c.coordinator.snapshot().meetings.credits[room.id].used, 2.7);
    assert.ok(Object.values(c.store.team().agentCredits).every(value => value === .9));
    const builder = c.store.all<Agent>('agents')[0]; assert.equal(builder.threadId, null, 'discussion does not replace a worker thread');
    assert.equal(new Set(c.store.all<MeetingConversation>('conversations').map(conversation => conversation.threadId)).size, 3);
    assert.ok(c.provider.calls.every(call => !call.allowedOutputs.length && !call.inputs.length));
    const finalContext = JSON.parse(c.provider.calls[2].prompt); assert.ok(finalContext.transcript.some((message: MeetingMessage) => message.speakerId === room.participantIds[2]));
    await assert.rejects(readFile(join(c.folder, 'team-note.md')), /ENOENT/);
  } finally { await c.close(); }
});

test('manager proposals wait for exact user confirmation; confirmation is atomic and deduplicated', async () => {
  const c = await setup(); try {
    await c.plan(); c.coordinator.mode('running'); c.post(['manager']); await c.idle();
    // The original team work has completed before the meeting summary is requested.
    await until(() => !c.coordinator.busy && c.store.all<Task>('tasks').every(task => task.status === 'complete'));
    const previous = c.store.all<Task>('tasks'), outputs = c.store.all('outputs');
    const command = { id: id(), meetingId: c.roomId, pauseAfter: true }; c.coordinator.summarizeMeeting(command); c.coordinator.summarizeMeeting(command); await c.idle();
    const proposal = c.store.all<MeetingProposal>('meetingProposals')[0]; assert.equal(proposal.status, 'proposed'); assert.equal(proposal.actions[0].kind, 'revise');
    assert.equal(c.store.project()!.mode, 'paused'); assert.deepEqual(c.store.all('tasks'), previous); assert.deepEqual(c.store.all('outputs'), outputs);
    const decision = { id: id(), proposalId: proposal.id, action: 'confirm' as const }; c.coordinator.decideMeeting(decision); c.coordinator.decideMeeting(decision);
    assert.equal(c.store.read<MeetingProposal>('meetingProposals', proposal.id)!.status, 'confirmed');
    assert.equal(c.store.all<Task>('tasks').filter(task => !task.supersededBy && task.status === 'queued').length, 2); assert.deepEqual(c.store.all('outputs'), outputs);
    const calls = c.provider.calls.length; await c.reopen(); assert.equal(c.provider.calls.length, 0); assert.equal(c.store.all<MeetingProposal>('meetingProposals')[0].status, 'confirmed');
    c.coordinator.mode('running'); await until(() => !c.coordinator.busy && c.store.all<Task>('tasks').filter(task => !task.supersededBy).every(task => task.status === 'complete'));
    assert.equal(c.provider.calls.length, 2); assert.ok(calls >= 5); assert.equal(c.store.all('outputs').length, 4);
  } finally { await c.close(); }
});

test('assignment, brief and budget proposals apply together only on confirmation; stale or rejected proposals change nothing', async () => {
  const c = await setup(); try {
    await c.plan(); const task = c.store.all<Task>('tasks')[0], agent = c.store.all<Agent>('agents')[0];
    // Unassign the fixture so background work cannot consume the proposed assignment.
    c.store.write('tasks', task.id, { ...task, agentId: null }); c.coordinator.mode('running'); c.post(['manager']); await c.idle();
    const actions: MeetingAction[] = [{ kind: 'assign', taskId: task.id, agentId: agent.id, priority: 91 }, { kind: 'brief', instruction: 'A clear goal and next step.' }, { kind: 'budget', credits: 750 }];
    c.provider.transform = (input, result) => { if (input.kind === 'meeting-summary') result.actions = actions; };
    c.coordinator.summarizeMeeting({ id: id(), meetingId: c.roomId, pauseAfter: true }); await c.idle(); let proposal = c.store.all<MeetingProposal>('meetingProposals').at(-1)!;
    assert.equal(c.store.project()!.credits, 500); c.coordinator.decideMeeting({ id: id(), proposalId: proposal.id, action: 'dismiss' }); assert.equal(c.store.project()!.credits, 500);
    c.coordinator.mode('running'); c.coordinator.summarizeMeeting({ id: id(), meetingId: c.roomId, pauseAfter: true }); await c.idle(); proposal = c.store.all<MeetingProposal>('meetingProposals').at(-1)!;
    c.coordinator.decideMeeting({ id: id(), proposalId: proposal.id, action: 'confirm' });
    assert.equal(c.store.project()!.credits, 750); assert.equal(c.store.project()!.brief, 'A clear goal and next step.'); assert.equal(c.store.read<Task>('tasks', task.id)!.priority, 91); assert.equal(c.store.project()!.mode, 'paused');
    assert.throws(() => c.coordinator.decideMeeting({ id: id(), proposalId: proposal.id, action: 'confirm' }), /stale_meeting_proposal/);
  } finally { await c.close(); }
});

test('new discussion or changed project facts invalidate a manager proposal before it can affect work', async () => {
  const c = await setup(); try {
    c.post(['manager']); await c.idle();
    c.provider.transform = (input, result) => { if (input.kind === 'meeting-summary') result.actions = [{ kind: 'budget', credits: 900 }]; };
    c.coordinator.summarizeMeeting({ id: id(), meetingId: c.roomId, pauseAfter: true }); await c.idle(); const proposal = c.store.all<MeetingProposal>('meetingProposals')[0];
    await c.coordinator.configure({ ...c.store.project()!, credits: 600 });
    assert.equal(c.coordinator.snapshot().meetings.proposals[0].status, 'stale'); assert.throws(() => c.coordinator.decideMeeting({ id: id(), proposalId: proposal.id, action: 'confirm' }), /stale_meeting_proposal/); assert.equal(c.store.project()!.credits, 600);
    c.coordinator.mode('running'); c.coordinator.summarizeMeeting({ id: id(), meetingId: c.roomId, pauseAfter: true }); await c.idle(); const fresh = c.store.all<MeetingProposal>('meetingProposals').at(-1)!;
    c.coordinator.mode('running'); c.post([c.store.all<Agent>('agents')[0].id], 'A new idea since the summary.'); await c.idle();
    assert.throws(() => c.coordinator.decideMeeting({ id: id(), proposalId: fresh.id, action: 'confirm' }), /stale_meeting_proposal/); assert.equal(c.store.project()!.credits, 600);
  } finally { await c.close(); }
});

test('Pause, browser-independent queue persistence, explicit Resume and Stop apply to meeting replies', async () => {
  const c = await setup(); try {
    c.provider.delay = 100; c.post(); await until(() => c.coordinator.busy); c.coordinator.mode('paused'); await c.coordinator.active;
    assert.equal(c.provider.calls.length, 1); assert.equal(c.store.all<MeetingTurn>('meetingTurns').filter(turn => turn.status === 'queued').length, 2);
    await c.reopen(); assert.equal(c.provider.calls.length, 0); c.coordinator.mode('running'); await c.idle(); assert.equal(c.provider.calls.length, 2);
    c.provider.delay = 100; c.post(); await until(() => c.coordinator.busy); await c.coordinator.stop(); assert.equal(c.store.project()!.mode, 'stopped'); assert.equal(c.provider.calls.length, 3);
    assert.equal(c.store.all<MeetingTurn>('meetingTurns').filter(turn => turn.status === 'queued').length, 2);
  } finally { await c.close(); }
});

test('ending a meeting drains its active response, cancels only undispatched replies and retains its transcript', async () => {
  const c = await setup(); try {
    c.provider.delay = 100; c.post(); await until(() => c.coordinator.busy); const command = { id: id(), meetingId: c.roomId }; c.coordinator.closeMeeting(command); c.coordinator.closeMeeting(command); await c.coordinator.active;
    assert.equal(c.provider.calls.length, 1); assert.equal(c.store.all<MeetingTurn>('meetingTurns').filter(turn => turn.status === 'cancelled').length, 2); assert.equal(c.store.all<MeetingMessage>('meetingMessages').length, 2);
    assert.throws(() => c.post(), /meeting_closed/); assert.equal(c.store.balance().reserved, 0); assert.equal(c.store.balance().used, .9);
  } finally { await c.close(); }
});

test('meeting quota and credit waits reserve nothing; available budget releases the same queued turn once', async () => {
  const c = await setup(); try {
    c.coordinator.connection.quota = [{ usedPercent: 100, windowDurationMins: 300, resetsAt: null }]; c.post(['manager']); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(c.provider.calls.length, 0); assert.equal(c.store.balance().reserved, 0);
    c.coordinator.connection.quota = []; c.store.saveProject({ ...c.store.project()!, credits: 1 }); c.coordinator.pump(); assert.equal(c.coordinator.snapshot().meetings.waitingReason, 'credit_limit'); assert.equal(c.provider.calls.length, 0);
    await c.coordinator.configure({ ...c.store.project()!, credits: 50 }); await c.idle(); assert.equal(c.provider.calls.length, 1); assert.equal(c.store.steps().length, 1);
  } finally { await c.close(); }
});

test('meeting history recovery restores a missed local commit without a new turn or automatic action confirmation', async () => {
  const c = await setup(); try {
    const finish = c.store.finish.bind(c.store); c.store.finish = (...args) => { if (args[1] === 'complete') throw new AppError('simulated_commit_loss'); return finish(...args); };
    c.post([c.store.all<Agent>('agents')[0].id]); await until(() => !c.coordinator.busy && c.store.project()!.mode === 'recovery');
    const step = c.store.steps()[0]; assert.equal(c.store.all<MeetingMessage>('meetingMessages').length, 1); await c.reopen();
    assert.throws(() => c.coordinator.mode('running'), /recovery_required/);
    await c.coordinator.recoverStep({ id: id(), stepId: step.id, action: 'check' }); assert.equal(c.store.journal(step.id).state, 'ready');
    const restore = { id: id(), stepId: step.id, action: 'restore' as const, outputIds: [] }; await c.coordinator.recoverStep(restore); await c.coordinator.recoverStep(restore);
    assert.equal(c.provider.calls.length, 0); assert.equal(c.store.all<MeetingMessage>('meetingMessages').length, 2); assert.equal(c.store.all('meetingProposals').length, 0); assert.equal(c.store.read<Step>('steps', step.id)!.estimated, false);
    assert.equal(c.store.all<Agent>('agents')[0].lastTotal, 0, 'meeting accounting never corrupts worker baselines'); assert.equal(c.store.project()!.mode, 'recovery');
  } finally { await c.close(); }
});

test('verified meeting retry is deduplicated and waits for Resume; unverified turns cannot be retried', async () => {
  const c = await setup(); try {
    const perform = c.provider.perform.bind(c.provider); c.provider.perform = async (...args) => { await perform(...args); throw new AppError('simulated_disconnect'); };
    c.post(['manager']); await until(() => !c.coordinator.busy && c.store.project()!.mode === 'recovery'); const step = c.store.steps()[0]; await c.reopen();
    c.provider.inspection = { state: 'unknown' }; await assert.rejects(c.coordinator.recoverStep({ id: id(), stepId: step.id, action: 'retry' }), /recovery_unverified/);
    c.provider.inspection = { state: 'ended', turnId: step.turnId! }; const retry = { id: id(), stepId: step.id, action: 'retry' as const }; await c.coordinator.recoverStep(retry); await c.coordinator.recoverStep(retry);
    assert.equal(c.store.all('meetingTurns').length, 2); assert.equal(c.provider.calls.length, 0); await c.reopen(); c.coordinator.mode('running'); await c.idle(); assert.equal(c.provider.calls.length, 1); assert.equal(c.store.steps().length, 2);
  } finally { await c.close(); }
});

test('native meeting adapter selects hired model and effort, disables tools and keeps the discussion in its own thread', async () => {
  const provider = new CodexTeam('/tmp/meeting-native-fixture'); const calls: { method: string; params: any }[] = []; let workerConnected = false;
  provider.prepareExecution = async () => { workerConnected = true; throw new Error('file execution forbidden'); };
  provider.managerService.rememberThread = async thread => { assert.equal(thread.id, 'meeting-only-thread'); };
  provider.managerService.connect = async () => ({ status: 'ready', model: null, quota: [], error: null });
  provider.managerService.request = async (method, params) => { calls.push({ method, params }); return { thread: { id: 'meeting-only-thread' }, modelProvider: 'openai', model: 'chosen-model' }; };
  provider.managerService.dispatch = async (params, onTurn) => { calls.push({ method: 'turn/start', params }); onTurn('turn'); return { text: '{"reply":"Discussion only"}', turnId: 'turn' }; };
  const callbacks: TurnCallbacks = { onThread: () => {}, onTurn: () => {}, onEvent: () => {}, onDispatchAttempt: () => {} };
  const input: TeamTurn = { kind: 'meeting', model: 'chosen-model', effort: 'low', threadId: null, prompt: 'discussion', outputSchema: {}, folder: '/tmp/project', inputs: [], allowedOutputs: [] };
  await provider.perform(input, callbacks); await provider.perform({ ...input, threadId: 'meeting-only-thread' }, callbacks);
  assert.equal(workerConnected, false); assert.equal(calls[0].params.model, 'chosen-model'); assert.equal(calls[0].params.allowProviderModelFallback, false); assert.deepEqual(calls[0].params.dynamicTools, []); assert.equal(calls[0].params.sandbox, 'read-only'); assert.equal(calls[1].params.effort, 'low'); assert.equal(calls[2].method, 'thread/resume'); assert.equal('allowProviderModelFallback' in calls[2].params, false); assert.ok(calls.every(call => !('permissions' in call.params))); provider.close();
});

test('meeting results cannot hire, execute, approve milestones or smuggle extra actions', () => {
  for (const value of [{ reply: 'Claimed', approve: true }, { summary: 'Unsafe', actions: [{ kind: 'hire', role: 'builder' }] }, { summary: 'Unsafe', actions: [{ kind: 'budget', credits: 100, execute: true }] }, { summary: 'Unsafe', actions: [{ kind: 'assign', taskId: 'one', agentId: 'agent', priority: 20 }, { kind: 'revise', taskId: 'one', instruction: 'Change', estimateTokens: 1000 }] }]) assert.throws(() => parseMeetingResult(JSON.stringify(value), !('reply' in value)), /invalid_meeting_result/);
});

test('meetings share the active worker queue and attach immutable output versions', async () => {
  const c = await setup(); try {
    await c.plan(); c.provider.delay = 100; c.coordinator.mode('running'); await until(() => c.coordinator.busy);
    c.post([c.store.all<Agent>('agents')[1].id], 'Discuss this project brief while the builder finishes.', 'brief');
    await c.idle(); await until(() => !c.coordinator.busy && c.store.all<Task>('tasks').every(task => task.status === 'complete'));
    assert.equal(c.provider.maximum, 1); assert.deepEqual(c.provider.calls.map(call => call.kind), ['plan', 'builder', 'meeting', 'reviewer']);
    const output = c.store.all<any>('outputs').find(output => output.path), content = await c.coordinator.artifacts.content(output.id);
    await writeFile(join(c.folder, output.path), 'New mutable project file');
    c.post(['manager'], 'Read this captured version.', `output:${output.id}`); await c.idle();
    const call = c.provider.calls.at(-1)!; assert.ok(JSON.parse(call.prompt).attachment.includes(JSON.stringify(content))); assert.equal(c.store.all('outputs').length, 2);
    const before = c.store.all<Agent>('agents').map(agent => ({ threadId: agent.threadId, lastTotal: agent.lastTotal }));
    c.post([c.store.all<Agent>('agents')[0].id], 'Another discussion turn.'); await c.idle();
    assert.deepEqual(c.store.all<Agent>('agents').map(agent => ({ threadId: agent.threadId, lastTotal: agent.lastTotal })), before);
  } finally { await c.close(); }
});

test('a recovered manager summary remains a proposal; restoration never confirms actions or resumes work', async () => {
  const c = await setup(); try {
    c.post(['manager']); await c.idle();
    c.provider.transform = (input, result) => { if (input.kind === 'meeting-summary') result.actions = [{ kind: 'budget', credits: 800 }]; };
    const finish = c.store.finish.bind(c.store); c.store.finish = (...args) => { if (args[1] === 'complete' && c.store.read<Step>('steps', args[0])?.kind === 'meeting-summary') throw new AppError('simulated_commit_loss'); return finish(...args); };
    const stepId = id(); c.coordinator.summarizeMeeting({ id: stepId, meetingId: c.roomId, pauseAfter: true }); await until(() => !c.coordinator.busy && c.store.project()!.mode === 'recovery'); await c.reopen();
    await c.coordinator.recoverStep({ id: id(), stepId, action: 'check' }); await c.coordinator.recoverStep({ id: id(), stepId, action: 'restore', outputIds: [] });
    assert.equal(c.store.project()!.credits, 500); assert.equal(c.store.project()!.mode, 'recovery'); assert.equal(c.provider.calls.length, 0); assert.equal(c.store.all<MeetingProposal>('meetingProposals')[0].status, 'proposed');
    c.coordinator.decideMeeting({ id: id(), proposalId: stepId, action: 'confirm' }); assert.equal(c.store.project()!.credits, 800); assert.equal(c.store.project()!.mode, 'recovery');
  } finally { await c.close(); }
});

test('confirmation rejects invalid or overlapping assignments atomically, including earlier valid budget actions', async () => {
  const c = await setup(); try {
    await c.plan(); const task = c.store.all<Task>('tasks')[0];
    const proposalId = id(); c.store.write('meetingProposals', proposalId, { id: proposalId, meetingId: c.roomId, summary: 'Invalid member', actions: [{ kind: 'budget', credits: 900 }, { kind: 'assign', taskId: task.id, agentId: 'unhired', priority: 90 }], baseHash: c.coordinator.projectFingerprint(), transcriptVersion: 0, status: 'proposed', createdAt: new Date().toISOString() });
    assert.throws(() => c.coordinator.decideMeeting({ id: id(), proposalId, action: 'confirm' }), /invalid_assignment/); assert.equal(c.store.project()!.credits, 500);
    const reviewer = c.store.all<Task>('tasks')[1];
    assert.throws(() => c.coordinator.validateActions([{ kind: 'revise', taskId: task.id, instruction: 'Revise this note', estimateTokens: 1000 }, { kind: 'assign', taskId: reviewer.id, agentId: reviewer.agentId!, priority: 90 }]), /invalid_meeting_result/);
    assert.throws(() => c.coordinator.createMeeting({ id: id(), title: 'Unknown participant', participantIds: ['unhired'] }), /invalid_meeting/);
    assert.throws(() => c.coordinator.postMeeting({ id: id(), meetingId: c.roomId, text: 'Invite', recipientIds: ['unhired'] }), /project_paused|invalid_meeting_message/);
  } finally { await c.close(); }
});
