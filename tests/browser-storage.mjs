import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile, lstat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
let chromium;
try { ({ chromium } = await import(process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE ?? 'playwright')); }
catch (error) { if (process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE) throw error; ({ chromium } = await import(pathToFileURL(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href)); }
const root = fileURLToPath(new URL('..', import.meta.url)), dir = await mkdtemp(join(tmpdir(), 'team-storage-browser-')), folder = join(dir, 'project'), stateDir = join(dir, 'state'), base = 'http://127.0.0.1:4186'; await mkdir(folder);
let child, browser, page;
const report = { date: new Date().toISOString(), mode: 'isolated demo storage workflow; no inference or shared-cache cleanup', checks: [], passed: false };
const launch = async () => {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts', '--demo', '--state-dir', stateDir, '--port', '4186'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Storage fixture startup timed out')), 10000); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Startup exited: ${code}`)); }); child.stdout.on('data', data => { if (String(data).includes('is open')) { clearTimeout(timer); resolve(); } }); });
};
const stop = async () => { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; child = null; };
await mkdir(join(root, '.test-artifacts'), { recursive: true });
try {
  await launch(); browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
  const state = async () => (await page.request.get(`${base}/api/state`)).json();
  const post = async (route, input = {}) => { const response = await page.request.post(`${base}/api/${route}`, { headers: { 'X-Project-Team': '1' }, data: input }); assert.ok(response.ok(), `${route} succeeded`); return response.json(); };
  const until = async predicate => { const deadline = Date.now() + 10000; while (true) { const value = await state(); if (predicate(value)) return value; assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 30)); } };
  await post('project', { name: 'Storage browser check', brief: 'Keep the accepted note and its conversation.', folder, credits: 500 }); await post('connect');
  for (const role of ['builder', 'reviewer']) await post('hire', { id: randomUUID(), name: role, role, responsibility: role, model: 'demo', effort: 'demo' });
  await post('resume'); await post('plan', { id: randomUUID(), instruction: '' }); let value = await until(s => !s.busy && s.team.plans.length);
  await post('approve-plan', { id: randomUUID(), planId: value.team.plans[0].id }); value = await until(s => !s.busy && s.team.milestones[0].status === 'review'); await post('accept-milestone', { id: randomUUID(), milestoneId: value.team.milestones[0].id, outputIds: value.team.milestones[0].outputIds });
  const outputs = (await state()).team.outputs, messages = (await state()).messages, saved = await (await page.request.get(`${base}/api/output/${outputs[0].id}`)).json();
  await writeFile(join(folder, 'keep-my-work.txt'), 'Important user work');
  await page.goto(base); await page.getByRole('button', { name: 'Connection and settings', exact: true }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Run data budget (MiB)', { exact: true }).fill('64'); await dialog.getByLabel('Project folder budget (MiB)', { exact: true }).fill('64'); await dialog.getByLabel('Diagnostic log budget (MiB)', { exact: true }).fill('1'); await dialog.getByLabel('Keep completed run traces (days)', { exact: true }).fill('1'); await dialog.getByRole('button', { name: 'Save storage limits', exact: true }).click();
  await until(s => s.storage.policy.appMiB === 64); assert.equal((await state()).project.mode, 'running');
  await mkdir(join(stateDir, 'codex-logs'), { recursive: true }); const log = join(stateDir, 'codex-logs', 'disposable.log'); await writeFile(log, ''); await truncate(log, 49 * 1048576);
  await dialog.getByRole('button', { name: 'Refresh disk usage', exact: true }).click(); value = await until(s => s.storage.status === 'blocked'); assert.equal(value.project.mode, 'paused'); assert.equal(value.storage.reason, 'app_storage_limit');
  await dialog.getByText(/Saved run data has reached its limit/).waitFor(); await dialog.getByRole('button', { name: 'Clean disposable data', exact: true }).click(); await until(s => !s.busy && s.storage.status === 'ok');
  await assert.rejects(lstat(log), /ENOENT/); value = await state(); assert.equal(value.connection.status, 'offline'); assert.equal(value.project.mode, 'paused'); assert.equal(value.credits.used, 2.7); assert.deepEqual(value.team.outputs, outputs); assert.deepEqual(value.messages, messages);
  const after = await (await page.request.get(`${base}/api/output/${outputs[0].id}`)).json(); assert.equal(after.content, saved.content); assert.equal(await readFile(join(folder, 'keep-my-work.txt'), 'utf8'), 'Important user work');
  report.checks.push('visible disk usage and saved budgets; app overflow pauses work; cleanup reclaims diagnostics without losing accepted versions, messages or credits; reconnect/Resume remain explicit');
  const build = join(folder, 'generated-build.bin'); await writeFile(build, ''); await truncate(build, 64 * 1048576); await dialog.getByRole('button', { name: 'Refresh disk usage', exact: true }).click(); await until(s => s.storage.reason === 'project_storage_limit');
  await dialog.getByRole('button', { name: 'Clean disposable data', exact: true }).click(); assert.equal((await lstat(build)).size, 64 * 1048576); assert.equal((await state()).storage.reason, 'project_storage_limit');
  await rm(build); await dialog.getByRole('button', { name: 'Refresh disk usage', exact: true }).click(); await until(s => s.storage.status === 'ok');
  for (const width of [320, 390, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 1100 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `storage settings fit ${width}px`); }
  await dialog.evaluate(element => element.scrollTop = 0); await page.screenshot({ path: join(root, '.test-artifacts/storage-desktop.png'), fullPage: false });
  report.checks.push('project overflow remains blocked after cleanup; no project files deleted; settings fit 320–1440px');
  await stop(); await launch(); await page.reload(); await page.getByRole('button', { name: 'Connection and settings', exact: true }).click();
  assert.equal(await page.getByLabel('Run data budget (MiB)', { exact: true }).inputValue(), '64'); value = await state(); assert.equal(value.project.mode, 'stopped'); assert.deepEqual(value.team.outputs, outputs); assert.deepEqual(value.messages, messages); assert.equal(value.storage.status, 'ok');
  await page.getByRole('button', { name: 'Stop local coordinator', exact: true }).click(); const exited = once(child, 'exit'); await exited; child = null;
  assert.deepEqual(errors, []); report.checks.push('budgets and protected data survive shutdown/startup cleanup; no automatic Resume, inference or browser exceptions'); report.passed = true;
} finally {
  if (!report.passed && page && !page.isClosed()) await page.screenshot({ path: join(root, '.test-artifacts/storage-failure.png'), fullPage: false }).catch(() => {});
  await browser?.close(); if (child && child.exitCode === null) await stop(); await rm(dir, { recursive: true, force: true });
  await writeFile(join(root, '.test-artifacts/storage-browser-2026-10-28.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
