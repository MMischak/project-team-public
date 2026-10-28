import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.ts';
import { CodexTeam } from '../server/codex-team.ts';
import { TeamCoordinator } from '../server/team-coordinator.ts';

if (!process.argv.includes('--live')) { console.log('This check makes six Codex subscription turns. Run with --live to opt in.'); process.exit(0); }
const root = fileURLToPath(new URL('..', import.meta.url));
const folder = await realpath(await mkdtemp(join(root, '.team-live-')));
const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'team-live-state-')));
const store = new Store(join(stateDir, 'team.sqlite'));
const provider = new CodexTeam(stateDir), coordinator = new TeamCoordinator(store, provider);
const request = provider.request.bind(provider);
provider.request = async (method, ...args) => { try { return await request(method, ...args); } catch (error) { console.error(`Native request failed: ${method} (${error.code ?? error.name})`); throw error; } };
const receive = provider.receive.bind(provider);
provider.receive = line => { try { const event = JSON.parse(line); if (process.env.PROJECT_TEAM_QA_DEBUG && event.method === 'item/started') console.log('Native item:', event.params?.item?.type); if (event.method === 'turn/completed' && event.params?.turn?.status !== 'completed') console.log('Native turn status:', event.params?.turn?.status, event.params?.turn?.error?.message); } catch {} receive(line); };
const id = () => randomUUID();
const wait = async predicate => { const deadline = Date.now() + 240000; while (!predicate()) { if (store.project()?.mode === 'recovery') throw new Error(`Turn stopped: ${coordinator.waitingReason ?? coordinator.connection.error}`); assert.ok(Date.now() < deadline, 'stage completed within timeout'); await new Promise(resolve => setTimeout(resolve, 100)); } };
const report = { date: new Date().toISOString(), mode: 'live Codex subscription, isolated note assignment', checks: [], passed: false };
try {
  await coordinator.configure({ name: 'Live team validation', brief: 'Write a tiny plain-text project note in note.md. It should say: This team produces usable notes. A reviewer checks clarity. This is only an isolated workflow test, not the football game.', folder, credits: 500 });
  await coordinator.connect(); assert.equal(coordinator.connection.status, 'ready');
  const models = coordinator.modelChoices;
  const model = models.find(item => item.model === process.env.PROJECT_TEAM_QA_MODEL) ?? models.find(item => item.model === 'gpt-6.1-sol') ?? models.find(item => item.isDefault) ?? models[0]; assert.ok(model);
  const effort = model.efforts.includes('low') ? 'low' : model.defaultEffort;
  report.model = model.model; report.effort = effort;
  for (const role of ['builder', 'reviewer']) coordinator.hire({ id: id(), name: role, role, responsibility: role === 'builder' ? 'Write the declared tiny note, using project_write.' : 'Review only captured output snapshots.', model: model.model, effort });
  coordinator.mode('running');
  coordinator.proposePlan({ id: id(), instruction: 'Propose exactly one milestone containing exactly two sequential tasks: a builder writes only note.md, and a reviewer depends on that builder and has outputs: []. Assign the hired builder and reviewer. Estimate 25000 tokens for each. Keep both instructions short. This is a tiny permission and workflow test. No shell commands or other files are needed.' });
  await coordinator.active; if (store.project().mode === 'recovery') throw new Error(`Plan stopped: ${coordinator.waitingReason}`);
  const plan = store.all('plans').at(-1); assert.equal(plan.milestones.length, 1); assert.equal(plan.milestones[0].tasks.length, 2);
  assert.deepEqual(plan.milestones[0].tasks.find(task => task.role === 'builder').outputs, ['note.md']);
  assert.equal(store.all('tasks').length, 0); report.checks.push('plan waits for user approval');
  console.log('Live plan saved; approving the isolated two-task test.');
  coordinator.approvePlan({ id: id(), planId: plan.id });
  await wait(() => store.all('milestones')[0].status === 'review' && !coordinator.busy);
  const v1 = store.all('outputs').find(output => output.path === 'note.md'); assert.ok(v1);
  const content = await coordinator.artifacts.content(v1.id); assert.match(content, /usable notes/i);
  assert.equal(store.all('handoffs')[0].outputId, v1.id); report.checks.push('builder file and reviewer handoff captured');
  const threads = store.all('agents').map(agent => agent.threadId); assert.equal(new Set(threads).size, 2); assert.ok(threads.every(Boolean));
  console.log('Live builder and reviewer completed; requesting one versioned revision.');
  coordinator.requestRevision({ id: id(), outputId: v1.id, feedback: 'Add a second line saying: Next step: review the note together. Keep the original sentence.' });
  await wait(() => store.all('outputs').some(output => output.path === 'note.md' && output.version === 2) && store.all('milestones')[0].status === 'review' && !coordinator.busy);
  const v2 = store.all('outputs').find(output => output.path === 'note.md' && output.version === 2); assert.match(await coordinator.artifacts.content(v2.id), /review the note together/i);
  assert.equal(await coordinator.artifacts.content(v1.id), content); assert.deepEqual(store.all('agents').map(agent => agent.threadId), threads);
  report.checks.push('revision preserves old versions and persistent member threads');
  const milestone = store.all('milestones')[0]; coordinator.acceptMilestone({ id: id(), milestoneId: milestone.id, outputIds: milestone.outputIds });
  assert.equal(store.all('milestones')[0].status, 'accepted'); assert.equal(store.balance().reserved, 0); assert.equal(store.balance().estimated, 0);
  assert.equal(store.steps().length, 6); assert.ok(store.steps().every(step => step.status === 'complete'));
  report.checks.push('exact current milestone versions accepted; six turns settled'); report.passed = true;
} catch (error) { report.error = String(error.message); report.recoveryReason = coordinator.waitingReason; process.exitCode = 1; }
finally {
  report.credits = store.balance(); report.actorCredits = store.team().agentCredits;
  report.steps = store.steps().map(({ kind, status, used, estimated, agentId }) => ({ kind: kind ?? 'chat', status, tokens: used, estimated, actor: agentId ? store.read('agents', agentId)?.role : 'manager' }));
  report.outputs = store.all('outputs').map(({ path, title, version, hash, status, bytes }) => ({ path, title, version, hash, status, bytes }));
  await coordinator.stop(); store.close(); await rm(folder, { recursive: true, force: true }); await rm(stateDir, { recursive: true, force: true });
  const at = process.argv.indexOf('--report'); if (at >= 0) { const target = resolve(process.argv[at + 1]); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2));
}
