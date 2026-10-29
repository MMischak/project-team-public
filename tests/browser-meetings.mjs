import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let chromium;
try { ({ chromium } = await import(process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE ?? 'playwright')); }
catch (error) { if (process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE) throw error; ({ chromium } = await import(pathToFileURL(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href)); }
const root = fileURLToPath(new URL('..', import.meta.url)), dir = await mkdtemp(join(tmpdir(), 'team-meeting-browser-')), folder = join(dir, 'project'), port = 4180, base = `http://127.0.0.1:${port}`;
await mkdir(folder);
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts', '--demo', '--state-dir', join(dir, 'state'), '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
const report = { date: new Date().toISOString(), mode: 'isolated demo meeting workflow; no inference', checks: [], passed: false };
await mkdir(join(root, '.test-artifacts'), { recursive: true });
try {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Meeting demo startup timed out')), 10000); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Startup exited: ${code}`)); }); child.stdout.on('data', data => { if (String(data).includes('is open')) { clearTimeout(timer); resolve(); } }); });
  browser = await chromium.launch({ headless: true }); let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = [];
  const observe = page => page.on('pageerror', error => errors.push(error.message)); observe(page);
  const state = async () => (await page.request.get(`${base}/api/state`)).json();
  const post = async (route, input = {}) => { const response = await page.request.post(`${base}/api/${route}`, { headers: { 'X-Project-Team': '1', 'X-Project-Id': (await state()).workspace?.activeProjectId ?? 'none' }, data: input }); assert.ok(response.ok(), `${route} succeeded`); return response.json(); };
  const waitState = async predicate => { const end = Date.now() + 10000; while (true) { const value = await state(); if (predicate(value)) return value; assert.ok(Date.now() < end, 'meeting browser operation completed'); await new Promise(resolve => setTimeout(resolve, 30)); } };
  // Seed the already-verified team workflow; exercise every new meeting control through the UI.
  await post('project', { name: 'Meeting browser check', brief: 'A short usable note.', folder, credits: 500 }); await post('connect');
  for (const role of ['builder', 'reviewer']) await post('hire', { id: randomUUID(), name: `Demo ${role}`, role, responsibility: role, model: 'demo', effort: 'demo' });
  await post('resume'); await post('plan', { id: randomUUID(), instruction: '' }); let value = await waitState(value => !value.busy && value.team.plans.length);
  await post('approve-plan', { id: randomUUID(), planId: value.team.plans[0].id }); await waitState(value => !value.busy && value.team.milestones[0].status === 'review');
  await page.goto(base); await page.getByRole('heading', { name: 'Manager', exact: true }).waitFor(); await page.getByRole('button', { name: 'Meeting room', exact: true }).click();
  await page.getByRole('button', { name: 'New meeting', exact: true }).click(); const dialog = page.getByRole('dialog'); await dialog.getByLabel('Meeting title', { exact: true }).fill('A clearer next step');
  await dialog.getByRole('button', { name: 'Create meeting', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  value = await state(); const room = value.meetings.rooms[0], builder = value.team.agents.find(agent => agent.role === 'builder'); assert.equal(room.participantIds.length, 3);
  const compose = page.locator('.meeting-compose'); await compose.getByLabel('Meeting message', { exact: true }).fill('Would a clear next step make this note more useful?');
  await compose.getByRole('button', { name: 'Attach current item to meeting', exact: true }).click(); await page.getByRole('button', { name: 'Outputs', exact: true }).click();
  await page.getByRole('button', { name: /Project note · v1/ }).first().click(); await page.getByRole('button', { name: 'Meeting room', exact: true }).click();
  assert.equal(await compose.getByLabel('Meeting message', { exact: true }).inputValue(), 'Would a clear next step make this note more useful?'); assert.equal(await compose.getByRole('button', { name: /Project brief attached/ }).count(), 1, 'navigation preserves the explicit meeting attachment');
  await compose.getByRole('button', { name: /Project brief attached/ }).click(); await compose.getByRole('button', { name: 'Attach current item to meeting', exact: true }).click();
  await compose.getByLabel('Address meeting message').selectOption(builder.id); await compose.getByRole('button', { name: 'Request replies', exact: true }).click();
  await browser.close(); browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); observe(page);
  await page.goto(base); await page.getByRole('button', { name: 'Meeting room', exact: true }).click();
  value = await waitState(value => !value.busy && value.meetings.turns.length === 1 && value.meetings.turns[0].status === 'complete'); assert.equal(value.meetings.messages.length, 2); assert.equal(value.meetings.messages[0].attachment.startsWith('output:'), true); assert.equal(value.meetings.messages[1].speakerId, builder.id);
  report.checks.push('participant selection, addressed reply, exact output attachment and draft/attachment preservation across navigation; browser closure does not stop work');
  await page.getByLabel('Address meeting message').selectOption('all'); await page.getByLabel('Meeting message', { exact: true }).fill('Everyone, discuss adding a clear next step and repeating the review.'); await page.getByRole('button', { name: 'Request replies', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click(); value = await waitState(value => !value.busy);
  const savedCount = value.meetings.messages.length; assert.ok(value.meetings.turns.some(turn => turn.status === 'queued')); await page.reload(); await page.getByRole('button', { name: 'Meeting room', exact: true }).click(); assert.equal((await state()).meetings.messages.length, savedCount);
  await page.getByRole('button', { name: 'Resume', exact: true }).click(); value = await waitState(value => !value.busy && value.meetings.turns.every(turn => turn.status === 'complete'));
  assert.equal(value.meetings.messages.length, 6); assert.equal(value.meetings.credits[room.id].used, 3.6); const tasksBefore = value.team.tasks.length, outputsBefore = value.team.outputs.length;
  await page.getByRole('button', { name: 'Summarize actions and pause', exact: true }).click(); value = await waitState(value => !value.busy && value.meetings.proposals.length === 1);
  assert.equal(value.project.mode, 'paused'); assert.equal(value.team.tasks.length, tasksBefore); assert.equal(value.team.outputs.length, outputsBefore); assert.equal(value.meetings.proposals[0].status, 'proposed');
  for (const width of [320, 390, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `meeting view fits ${width}px`); }
  await page.screenshot({ path: join(root, '.test-artifacts/meetings-desktop.png'), fullPage: true });
  await page.reload(); await page.getByRole('button', { name: 'Meeting room', exact: true }).click(); assert.equal((await state()).team.tasks.length, tasksBefore);
  await page.getByRole('button', { name: 'Confirm proposed changes', exact: true }).click(); value = await waitState(value => value.meetings.proposals[0].status === 'confirmed');
  assert.equal(value.project.mode, 'paused'); assert.equal(value.team.outputs.length, outputsBefore); assert.equal(value.team.tasks.filter(task => task.status === 'queued').length, 2);
  report.checks.push('open round uses serial participant replies; Pause/reload holds queued replies; manager summary pauses explicitly and applies no work until confirmation');
  await page.getByRole('button', { name: 'Resume', exact: true }).click(); value = await waitState(value => !value.busy && value.team.outputs.length === 4);
  assert.equal(value.credits.used, 9); assert.equal(value.credits.reserved, 0); assert.equal(value.credits.estimated, 0); assert.equal(value.meetings.credits[room.id].used, 4.5);
  await page.getByRole('button', { name: 'End meeting', exact: true }).click(); assert.equal((await state()).meetings.rooms[0].status, 'closed');
  await page.getByRole('button', { name: 'Project', exact: true }).click(); await page.getByRole('button', { name: 'Accept milestone', exact: true }).click(); await waitState(value => value.team.milestones[0].status === 'accepted');
  report.checks.push('confirmed revision preserves earlier versions and waits for Resume; meeting close retains history; milestone acceptance remains a separate user action');
  assert.deepEqual(errors, []); await page.getByRole('button', { name: 'Connection and settings', exact: true }).click(); const exit = once(child, 'exit'); await page.getByRole('button', { name: 'Stop local coordinator', exact: true }).click(); assert.equal((await exit)[0], 0);
  report.checks.push('responsive meeting views at 320–1440px, no browser exceptions and clean Stop'); report.passed = true;
} catch (error) { report.error = error.message; throw error; }
finally { await browser?.close(); if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; } await rm(dir, { recursive: true, force: true }); await writeFile(join(root, '.test-artifacts/meetings-browser-2026-10-16.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); }
