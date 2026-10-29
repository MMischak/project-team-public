import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let chromium;
try { ({ chromium } = await import(process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE ?? 'playwright')); }
catch (error) {
  if (process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE) throw error;
  ({ chromium } = await import(pathToFileURL(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href));
}
const root = fileURLToPath(new URL('..', import.meta.url)), dir = await mkdtemp(join(tmpdir(), 'team-browser-recovery-')), folder = join(dir, 'project'), stateDir = join(dir, 'state'), port = 4179, base = `http://127.0.0.1:${port}`;
await mkdir(folder); await mkdir(stateDir);
let child, browser;
const launch = args => {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Recovery fixture startup timed out')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Startup exited: ${code}`)); });
    child.stdout.on('data', data => { if (String(data).includes('is open')) { clearTimeout(timer); resolve(); } });
  });
};
const report = { date: new Date().toISOString(), mode: 'isolated demo; abrupt exit and browser recovery', checks: [], passed: false };
await mkdir(join(root, '.test-artifacts'), { recursive: true });
try {
  await launch(['tests/recovery-server.mjs', stateDir, folder, String(port)]);
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const state = async () => (await page.request.get(`${base}/api/state`)).json();
  const waitState = async predicate => { const end = Date.now() + 10000; while (true) { const value = await state(); if (predicate(value)) return value; assert.ok(Date.now() < end); await new Promise(resolve => setTimeout(resolve, 50)); } };
  await page.goto(base); await page.getByRole('heading', { name: 'Manager', exact: true }).waitFor();
  const exit = once(child, 'exit'); await page.getByRole('button', { name: 'Resume project', exact: true }).click(); assert.equal((await exit)[0], 75);
  await launch(['server/main.ts', '--demo', '--state-dir', stateDir, '--port', String(port)]);
  await page.reload(); await page.getByRole('heading', { name: 'Recovery review', exact: true }).waitFor();
  let value = await state(); assert.equal(value.project.mode, 'recovery'); assert.equal(value.team.outputs.length, 0); assert.equal(value.credits.reserved, 0); assert.ok(value.credits.estimated > 0);
  assert.equal(await page.getByRole('button', { name: 'Resume', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Start manager', exact: true }).click();
  value = await state(); assert.equal(value.team.outputs.length, 0); assert.equal(value.project.mode, 'recovery');
  await page.getByRole('button', { name: 'Check saved turn', exact: true }).click();
  await waitState(value => value.recovery[0].state === 'ready');
  assert.equal(await page.getByRole('button', { name: 'Restore reviewed work', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Inspect team-note.md', exact: true }).click();
  await page.getByText('Saved recovery candidate', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Restore reviewed work', exact: true }).click();
  value = await waitState(value => value.recovery[0].state === 'recovered');
  assert.equal(value.project.mode, 'recovery'); assert.equal(value.team.outputs.length, 1); assert.equal(value.credits.estimated, 0); assert.equal(value.credits.used, 1.8);
  assert.equal(value.team.tasks[1].status, 'queued'); report.checks.push('abrupt exit preserves journal/snapshot; reconnect and restore do not start a new task');
  await page.reload(); await page.getByRole('heading', { name: 'Recovery review', exact: true }).waitFor();
  assert.equal((await state()).team.outputs.length, 1);
  // A different command cannot repeat an already completed recovery.
  const kept = value.recovery[0], command = { id: randomUUID(), stepId: kept.id, action: 'check', outputIds: [] };
  const response = await page.request.post(`${base}/api/recovery`, { headers: { 'X-Project-Team': '1', 'X-Project-Id': (await state()).workspace?.activeProjectId ?? 'none' }, data: command }); assert.equal(response.status(), 409, 'a new command cannot restore a completed attempt twice');
  for (const width of [320, 390, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `recovery fits ${width}px`); }
  await page.getByRole('button', { name: 'Resume project', exact: true }).click();
  value = await waitState(value => value.team.milestones[0].status === 'review' && !value.busy);
  assert.equal(value.team.outputs.filter(output => output.path).length, 1); assert.equal(value.credits.used, 2.7);
  await page.getByRole('button', { name: 'Accept milestone', exact: true }).click(); await waitState(value => value.team.milestones[0].status === 'accepted');
  report.checks.push('explicit Resume runs only the dependent reviewer; the user separately accepts exact milestone versions');
  await page.screenshot({ path: join(root, '.test-artifacts/recovery-desktop.png'), fullPage: true });
  assert.deepEqual(errors, []); report.checks.push('reload and responsive recovery views at 320–1440px; no browser exceptions');
  await page.getByRole('button', { name: 'Connection and settings', exact: true }).click();
  const stop = once(child, 'exit'); await page.getByRole('button', { name: 'Stop local coordinator', exact: true }).click(); assert.equal((await stop)[0], 0);
  report.checks.push('Stop drains recovery services and exits cleanly'); report.passed = true;
} catch (error) { report.error = error.message; throw error; }
finally {
  await browser?.close(); if (child?.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
  await rm(dir, { recursive: true, force: true });
  await writeFile(join(root, '.test-artifacts/recovery-browser-2026-10-03.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
