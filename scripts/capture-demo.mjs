// Generate the README image using only disposable demo data and fresh neutral assets.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
let chromium;
try { ({ chromium } = await import(process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE ?? 'playwright')); }
catch (error) { if (process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE) throw error; ({ chromium } = await import(pathToFileURL(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href)); }
const root = fileURLToPath(new URL('..', import.meta.url)), temporary = await mkdtemp(join(tmpdir(), 'project-team-public-demo-')), folder = join(temporary, 'project'), base = 'http://127.0.0.1:4187'; await mkdir(folder);
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts', '--demo', '--state-dir', join(temporary, 'state'), '--port', '4187'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Demo startup timed out')), 10000); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Demo exited: ${code}`)); }); child.stdout.on('data', data => { if (String(data).includes('is open')) { clearTimeout(timer); resolve(); } }); });
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, deviceScaleFactor: 1 }); const errors = []; page.on('pageerror', error => errors.push(error.message));
  const state = async () => (await page.request.get(`${base}/api/state`)).json();
  const post = async (route, data = {}) => { const response = await page.request.post(`${base}/api/${route}`, { headers: { 'X-Project-Team': '1' }, data }); assert.ok(response.ok(), route); return response.json(); };
  const until = async predicate => { const end = Date.now() + 10000; while (true) { const value = await state(); if (predicate(value)) return value; assert.ok(Date.now() < end); await new Promise(resolve => setTimeout(resolve, 30)); } };
  assert.equal((await state()).demo, true);
  await post('project', { name: 'Product guide', brief: 'Write a short product guide with a clear goal and a useful next step.', folder, credits: 500 }); await post('connect');
  for (const [role, name, responsibility] of [['builder', 'Focused builder', 'Create the guide from the approved brief. Keep this task focused.'], ['reviewer', 'Independent reviewer', 'Check clarity, completeness and the exact captured version.']]) await post('hire', { id: randomUUID(), name, role, responsibility, model: 'demo', effort: 'demo' });
  await post('resume'); await post('plan', { id: randomUUID(), instruction: 'A small deliverable and an independent review.' }); let value = await until(s => !s.busy && s.team.plans.length);
  await post('approve-plan', { id: randomUUID(), planId: value.team.plans[0].id }); await until(s => !s.busy && s.team.milestones[0].status === 'review');
  await page.goto(base); await page.getByRole('heading', { name: 'Manager', exact: true }).waitFor(); await page.getByRole('button', { name: /Project note · v1/ }).first().click();
  await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); }); assert.deepEqual(errors, []);
  await mkdir(join(root, 'docs/assets'), { recursive: true }); await page.screenshot({ path: join(root, 'docs/assets/workspace.png'), fullPage: false });
  const exited = once(child, 'exit'); await post('stop'); await exited;
  console.log('Synthetic README screenshot captured; no account data or AI inference used.');
} finally { await browser?.close(); if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } await rm(temporary, { recursive: true, force: true }); }
