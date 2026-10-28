import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.ts';
import { CodexTeam } from '../server/codex-team.ts';
import { TeamCoordinator } from '../server/team-coordinator.ts';
import { AppError } from '../server/types.ts';

if (!process.argv.includes('--live')) { console.log('This check makes one bounded builder turn using the Codex subscription. Run with --live to opt in.'); process.exit(0); }
const root = fileURLToPath(new URL('..', import.meta.url)), folder = await realpath(await mkdtemp(join(root, '.team-recovery-live-'))), stateDir = await realpath(await mkdtemp(join(tmpdir(), 'team-recovery-live-state-')));
let store = new Store(join(stateDir, 'team.sqlite')), provider = new CodexTeam(stateDir), coordinator = new TeamCoordinator(store, provider);
const report = { date: new Date().toISOString(), mode: 'live Codex subscription; isolated one-task recovery fixture', checks: [], passed: false };
try {
  await coordinator.configure({ name: 'Recovery check', brief: 'Write one tiny note. This is a disposable recovery check.', folder, credits: 200 }); await coordinator.connect(); assert.equal(coordinator.connection.status, 'ready');
  const model = coordinator.modelChoices.find(model => model.model === 'gpt-6.1-sol') ?? coordinator.modelChoices.find(model => model.isDefault), effort = model.efforts.includes('low') ? 'low' : model.defaultEffort;
  report.model = model.model; report.effort = effort;
  coordinator.hire({ id: randomUUID(), name: 'Recovery builder', role: 'builder', responsibility: 'Write only the declared tiny note with project_write.', model: model.model, effort });
  const agent = store.all('agents')[0], planId = randomUUID();
  store.write('plans', planId, { id: planId, status: 'proposed', createdAt: new Date().toISOString(), summary: 'Deterministic recovery test fixture; one builder task.', suggestedHires: [], milestones: [{ id: 'note', title: 'Recovery note', tasks: [{ id: 'write', title: 'Write recovery note', instruction: 'Use project_write exactly once to write note.md with this single line: Completed work survives interruption. Return the required structured result. Do not run commands, read other files, or create any other output.', role: 'builder', agentId: agent.id, dependencies: [], estimateTokens: 30000, outputs: ['note.md'] }] }] });
  const finish = store.finish.bind(store);
  store.finish = (...args) => { if (args[1] === 'complete') throw new AppError('simulated_commit_interruption'); return finish(...args); };
  coordinator.approvePlan({ id: randomUUID(), planId }); coordinator.mode('running');
  const end = Date.now() + 240000;
  while (store.project().mode !== 'recovery' || coordinator.busy) { assert.ok(Date.now() < end, 'bounded turn completed'); await new Promise(resolve => setTimeout(resolve, 100)); }
  const step = store.steps()[0]; assert.ok(store.journal(step.id).captured); assert.equal(store.all('outputs').length, 0);
  report.checks.push('native completion and hashed snapshots saved before simulated local commit loss');
  clearInterval(coordinator.quotaTimer); provider.close(); store.close();
  store = new Store(join(stateDir, 'team.sqlite')); provider = new CodexTeam(stateDir); coordinator = new TeamCoordinator(store, provider); await coordinator.connect();
  let newTurns = 0; const request = provider.request.bind(provider); provider.request = (method, ...args) => { if (method === 'turn/start' || method === 'thread/resume') newTurns++; return request(method, ...args); };
  assert.throws(() => coordinator.mode('running'), /recovery_required/);
  await coordinator.recoverStep({ id: randomUUID(), stepId: step.id, action: 'check' });
  assert.equal(store.journal(step.id).state, 'ready', store.journal(step.id).summary);
  const output = store.journal(step.id).outputs[0];
  const command = { id: randomUUID(), stepId: step.id, action: 'restore', outputIds: [output.id] };
  await coordinator.recoverStep(command); await coordinator.recoverStep(command);
  assert.equal(newTurns, 0); assert.equal(store.steps().length, 1); assert.equal(store.all('outputs').length, 1);
  assert.match(await coordinator.artifacts.content(output.id), /Completed work survives interruption/);
  assert.equal(store.read('steps', step.id).status, 'complete'); assert.equal(store.balance().reserved, 0); assert.equal(store.balance().estimated, 0);
  assert.equal(store.project().mode, 'recovery'); report.checks.push('fresh native process reads the exact stored turn without resume/inference; restoration is deduplicated and waits for explicit Resume');
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  report.credits = store.balance(); report.recovery = store.recovery().map(({ title, state, afterCrash, used, estimated }) => ({ title, state, afterCrash, used, estimated }));
  report.steps = store.steps().map(({ kind, status, used, estimated }) => ({ kind, status, tokens: used, estimated }));
  await coordinator.stop(); store.close(); await rm(folder, { recursive: true, force: true }); await rm(stateDir, { recursive: true, force: true });
  const at = process.argv.indexOf('--report'); if (at >= 0) { const target = resolve(process.argv[at + 1]); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2));
}
