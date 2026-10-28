import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../server/store.ts';
let chromium;
try { ({ chromium } = await import(process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE ?? 'playwright')); }
catch (error) { if (process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE) throw error; ({ chromium } = await import(pathToFileURL(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href)); }
const root = fileURLToPath(new URL('..', import.meta.url)), dir = await mkdtemp(join(tmpdir(), 'team-checkpoint-browser-')), folder = join(dir, 'project'), base = 'http://127.0.0.1:4181';
await mkdir(folder);
let child, browser, page;
const report = { date: new Date().toISOString(), mode: 'isolated demo team and deterministic GitHub fixture; no inference or external export', checks: [], passed: false };
const launch = async () => {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'tests/checkpoint-server.mjs', dir, root], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Checkpoint fixture startup timed out')), 10000); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Startup exited: ${code}`)); }); child.stdout.on('data', data => { if (String(data).includes('is open')) { clearTimeout(timer); resolve(); } }); });
};
const stop = async () => { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; child = null; };
await mkdir(join(root, '.test-artifacts'), { recursive: true });
try {
  await launch(); browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = [];
  const observe = () => page.on('pageerror', error => errors.push(error.message)); observe();
  const state = async () => (await page.request.get(`${base}/api/state`)).json();
  const post = async (route, input = {}) => { const response = await page.request.post(`${base}/api/${route}`, { headers: { 'X-Project-Team': '1' }, data: input }); assert.ok(response.ok(), `${route} succeeded`); return response.json(); };
  const waitState = async predicate => { const end = Date.now() + 10000; while (true) { const value = await state(); if (predicate(value)) return value; assert.ok(Date.now() < end, 'checkpoint operation completed'); await new Promise(resolve => setTimeout(resolve, 30)); } };
  await post('project', { name: 'Checkpoint browser check', brief: 'A usable local note.', folder, credits: 500 }); await post('connect');
  for (const role of ['builder', 'reviewer']) await post('hire', { id: randomUUID(), name: `Demo ${role}`, role, responsibility: role, model: 'demo', effort: 'demo' });
  await post('resume'); await post('plan', { id: randomUUID(), instruction: '' }); let value = await waitState(value => !value.busy && value.team.plans.length);
  await post('approve-plan', { id: randomUUID(), planId: value.team.plans[0].id }); value = await waitState(value => !value.busy && value.team.milestones[0].status === 'review'); await post('pause');
  const selected = value.team.outputs.find(output => output.path), original = await readFile(join(folder, selected.path), 'utf8'); await writeFile(join(folder, selected.path), 'Unrelated newer local edit');
  await page.goto(base); await page.getByRole('button', { name: 'Outputs', exact: true }).click(); await page.getByRole('button', { name: 'Create checkpoint', exact: true }).click();
  let dialog = page.getByRole('dialog'); await dialog.getByRole('checkbox', { name: /Project note · v1/ }).check(); await dialog.getByLabel('Milestone summary', { exact: true }).fill('First note ready for review.');
  await dialog.getByRole('button', { name: 'Preview checkpoint', exact: true }).click(); await dialog.getByText('Destination: fixture/checkpoints', { exact: true }).waitFor();
  assert.equal((await state()).checkpoints.length, 0, 'preview never publishes'); assert.ok((await dialog.locator('.checkpoint-review').textContent()).includes(original)); assert.ok(!(await dialog.locator('.checkpoint-review').textContent()).includes('Unrelated newer local edit'));
  await dialog.getByRole('button', { name: 'Save demo checkpoint', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await browser.close(); browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); observe(); await page.goto(base); await page.getByRole('button', { name: 'Outputs', exact: true }).click();
  value = await waitState(value => value.checkpoints[0]?.status === 'unsynced'); assert.equal(value.checkpoints[0].attempts, 1); assert.equal(value.checkpoints[0].payload.outputs.length, 1);
  await page.getByRole('button', { name: 'Retry saved checkpoint', exact: true }).waitFor(); await page.getByRole('button', { name: 'Check GitHub status', exact: true }).waitFor(); report.checks.push('explicit exact-version selection, content/manifest preview, snapshot instead of mutable file, no export during preview, browser closure and visible unsynced failure');
  await stop(); await launch(); await page.reload(); await page.getByRole('button', { name: 'Outputs', exact: true }).click();
  assert.equal((await state()).checkpoints[0].status, 'unsynced'); assert.equal((await state()).project.mode, 'stopped');
  await page.getByRole('button', { name: 'Retry saved checkpoint', exact: true }).click(); value = await waitState(value => value.checkpoints[0].status === 'synced');
  assert.equal(value.checkpoints.length, 1); assert.equal(value.checkpoints[0].attempts, 2); assert.equal(value.credits.used, 2.7); assert.equal(await readFile(join(folder, selected.path), 'utf8'), 'Unrelated newer local edit');
  await page.getByRole('link', { name: 'Open on GitHub' }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Retry saved checkpoint', exact: true }).count(), 0);
  await page.locator('.checkpoint-card summary').click();
  for (const width of [320, 390, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `checkpoint history fits ${width}px`); }
  await page.screenshot({ path: join(root, '.test-artifacts/checkpoints-desktop.png'), fullPage: true });
  report.checks.push('coordinator restart does not replay export; explicit retry recognizes lost publish acknowledgement; one record and commit; no extra credits or local file changes; responsive history at 320–1440px');
  // A second export waits on the fixture's delayed publish while Stop drains it.
  await page.getByRole('button', { name: 'Create checkpoint', exact: true }).click(); dialog = page.getByRole('dialog'); await dialog.getByRole('checkbox', { name: /Project note · v1/ }).check(); await dialog.getByLabel('Milestone summary', { exact: true }).fill('A second checkpoint to test shutdown.');
  for (const width of [320, 390, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `checkpoint dialog fits ${width}px`); }
  await dialog.getByRole('button', { name: 'Preview checkpoint', exact: true }).click(); await dialog.getByText('Destination: fixture/checkpoints', { exact: true }).waitFor(); await dialog.getByRole('button', { name: 'Save demo checkpoint', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Connection and settings', exact: true }).click(); const stopped = once(child, 'exit'); await page.getByRole('button', { name: 'Stop local coordinator', exact: true }).click(); await stopped; child = null;
  const store = new Store(join(dir, 'fixture.sqlite')); try { assert.equal(store.all('checkpoints').length, 2); assert.ok(store.all('checkpoints').every(item => item.status === 'synced')); assert.equal(store.read('settings', 'fixture-commit-count'), 2); assert.equal(Object.keys(store.read('settings', 'fixture-refs')).length, 2); assert.equal(store.project().mode, 'stopped'); } finally { store.close(); }
  assert.deepEqual(errors, []); report.checks.push('preview dialog fits 320–1440px; Stop drains active checkpoint before closing; no browser exceptions'); report.passed = true;
} finally {
  if (!report.passed && page && !page.isClosed()) { await page.screenshot({ path: join(root, '.test-artifacts/checkpoints-failure.png'), fullPage: true }).catch(() => {}); console.log('Checkpoint browser state:', await page.locator('main').textContent().catch(() => 'unavailable')); }
  await browser?.close(); if (child && child.exitCode === null) await stop(); await rm(dir, { recursive: true, force: true });
  await writeFile(join(root, '.test-artifacts/checkpoints-browser-2026-10-16.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
