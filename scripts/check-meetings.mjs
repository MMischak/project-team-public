import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.ts';
import { CodexTeam } from '../server/codex-team.ts';
import { MeetingCoordinator } from '../server/meeting-coordinator.ts';

if (!process.argv.includes('--live')) { console.log('This check makes two conversation-only Codex subscription turns. Run with --live to opt in.'); process.exit(0); }
const dir = await realpath(await mkdtemp(join(tmpdir(), 'team-live-meetings-'))), folder = join(dir, 'project'), stateDir = join(dir, 'state'); await mkdir(folder); await mkdir(stateDir);
const store = new Store(join(stateDir, 'team.sqlite')), provider = new CodexTeam(stateDir), coordinator = new MeetingCoordinator(store, provider);
const report = { date: new Date().toISOString(), mode: 'live subscription; two conversation-only meeting turns in isolated state', checks: [], passed: false };
try {
  await coordinator.configure({ name: 'Meeting validation', brief: 'Make a project note.', folder, credits: 250 }); await coordinator.connect(); assert.equal(coordinator.connection.status, 'ready');
  const model = coordinator.modelChoices.find(model => model.model === 'gpt-6.1-sol') ?? coordinator.modelChoices.find(model => model.isDefault), effort = model.efforts.includes('low') ? 'low' : model.defaultEffort;
  report.memberModel = model.model; report.memberEffort = effort;
  coordinator.hire({ id: randomUUID(), name: 'Clarity reviewer', role: 'reviewer', responsibility: 'Discuss whether the goal is clear; do not perform file work.', model: model.model, effort });
  const reviewer = store.all('agents')[0], meetingId = randomUUID(); coordinator.createMeeting({ id: meetingId, title: 'Clarify the note goal', participantIds: [reviewer.id] }); coordinator.mode('running');
  coordinator.postMeeting({ id: randomUUID(), meetingId, recipientIds: [reviewer.id], text: 'Discuss this proposed brief with me: Make a concise project note with a clear next step. I want the manager to propose replacing our current project brief with that exact sentence after hearing your short perspective. This is discussion, not approval. Do not create tasks or use tools.' });
  const wait = async predicate => { const end = Date.now() + 240000; while (!predicate()) { if (store.project().mode === 'recovery') throw new Error(`Meeting stopped: ${coordinator.connection.error}`); assert.ok(Date.now() < end, 'bounded meeting check finished'); await new Promise(resolve => setTimeout(resolve, 100)); } };
  await wait(() => !coordinator.busy && store.all('meetingTurns')[0]?.status === 'complete');
  assert.equal(store.project().brief, 'Make a project note.'); assert.equal(store.all('meetingMessages')[1].speakerId, reviewer.id); assert.equal(store.all('tasks').length, 0); assert.equal(provider.child, null, 'file-worker native service never starts'); report.checks.push('addressed hired participant replies with exact selected model/effort, saved identity and no file tools');
  coordinator.summarizeMeeting({ id: randomUUID(), meetingId, pauseAfter: true }); await wait(() => !coordinator.busy && store.all('meetingProposals').length === 1);
  const proposal = store.all('meetingProposals')[0]; assert.equal(proposal.status, 'proposed'); assert.equal(store.project().mode, 'paused'); assert.equal(store.project().brief, 'Make a project note.'); assert.ok(proposal.actions.some(action => action.kind === 'brief'));
  const decision = { id: randomUUID(), proposalId: proposal.id, action: 'confirm' }; coordinator.decideMeeting(decision); coordinator.decideMeeting(decision);
  assert.match(store.project().brief, /clear next step/i); assert.equal(store.project().mode, 'paused'); assert.equal(store.all('tasks').length, 0); assert.deepEqual(await readdir(folder), []); assert.equal(store.steps().length, 2); assert.equal(store.balance().estimated, 0); assert.equal(store.balance().reserved, 0);
  report.checks.push('manager summarizes the shared transcript; explicit user confirmation changes only the listed brief, once; no files/tasks/approvals are fabricated'); report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  report.credits = store.balance(); report.steps = store.steps().map(({ kind, status, used, estimated, agentId }) => ({ kind, status, tokens: used, estimated, actor: agentId ? 'reviewer' : 'manager' })); report.actions = store.all('meetingProposals').flatMap(proposal => proposal.actions.map(action => action.kind));
  await coordinator.stop(); store.close(); await rm(dir, { recursive: true, force: true }); const at = process.argv.indexOf('--report'); if (at >= 0) { const target = resolve(process.argv[at + 1]); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, JSON.stringify(report, null, 2) + '\n'); } console.log(JSON.stringify(report, null, 2));
}
