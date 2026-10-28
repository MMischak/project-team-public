import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Use an installed Playwright, or the desktop app's bundled browser automation runtime.
let chromium;
try { ({ chromium } = await import(process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE ?? 'playwright')); }
catch (error) {
  if (process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE) throw error;
  const bundled = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  ({ chromium } = await import(pathToFileURL(bundled).href));
}

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'project-team-browser-'));
const folder = join(dir, 'project');
await mkdir(folder);
const port = Number(process.env.PROJECT_TEAM_QA_PORT ?? 4177);
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts', '--demo', '--state-dir', join(dir, 'state'), '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
await mkdir(join(root, '.test-artifacts'), { recursive: true });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local demo startup timed out.')), 10000);
    const finish = fn => value => { clearTimeout(timer); fn(value); };
    child.once('error', finish(reject));
    child.once('exit', finish(() => reject(new Error('Local demo could not start. Check the QA port.'))));
    child.stdout.on('data', data => { if (String(data).includes('is open at')) finish(resolve)(); });
  });
  browser = await chromium.launch({ headless: true });
  let page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const issues = [];
  const observe = target => {
    target.on('pageerror', error => issues.push(error.message));
    target.on('console', message => { if (message.type() === 'error') issues.push(message.text()); });
  };
  observe(page);
  const state = async () => (await page.request.get(`${base}/api/state`)).json();
  await page.goto(base); await page.getByRole('heading', { name: 'Manager', exact: true }).waitFor();
  assert.equal((await state()).demo, true, 'browser checks must never use a live provider');
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal overflow at ${width}`);
    assert.equal(await page.locator('.credit-bar').isVisible(), true, `credits visible at ${width}`);
  }
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Project name', { exact: true }).fill('Browser validation');
  await dialog.getByLabel('What do you want to achieve?').fill('Verify saved conversation and browser-independent work.');
  await dialog.getByLabel(/^Project folder/).fill(folder);
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Start manager', exact: true }).click();
  await page.getByRole('button', { name: 'Resume project', exact: true }).click();
  await page.getByRole('button', { name: 'Attach current item', exact: true }).click();
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Project brief attached · remove', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Meeting room', exact: true }).click();
  await page.getByRole('heading', { name: 'Bring your team into the conversation', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Outputs', exact: true }).click();
  await page.getByRole('heading', { name: 'Your outputs will live here', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByLabel('Message your project manager').fill('Finish this demo reply while the browser is closed.');
  await page.getByRole('button', { name: 'Send instruction', exact: true }).click();
  assert.equal((await state()).busy, true, 'response active before browser closure');
  await browser.close();
  browser = await chromium.launch({ headless: true }); page = await browser.newPage(); observe(page);
  await page.goto(base); await page.getByRole('heading', { name: 'Manager', exact: true }).waitFor();
  const deadline = Date.now() + 10000;
  let result;
  do {
    result = await state(); if (!result.busy) break;
    assert.ok(Date.now() < deadline, 'demo response finishes within timeout');
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (true);
  assert.equal(result.messages.length, 2); assert.equal(result.messages[0].attachment, 'brief');
  assert.equal(result.messages[1].status, 'complete'); assert.equal(result.credits.used, .9);
  assert.equal(result.credits.reserved, 0);
  await page.reload(); await page.getByRole('heading', { name: 'Manager', exact: true }).waitFor();
  assert.equal((await state()).messages.length, 2, 'reload does not dispatch again');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  assert.equal((await state()).project.mode, 'paused');
  await page.getByLabel('Message your project manager').fill('Paused draft');
  assert.equal(await page.getByRole('button', { name: 'Send instruction', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  // Exercise the same user controls that authorize real team work, without inference.
  const waitState = async predicate => { const deadline = Date.now() + 10000; while (true) { const value = await state(); if (predicate(value)) return value; assert.ok(Date.now() < deadline, 'team UI operation finishes'); await new Promise(resolve => setTimeout(resolve, 50)); } };
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  for (const role of ['builder', 'reviewer']) {
    await page.getByRole('button', { name: 'Hire member', exact: true }).click();
    const hire = page.getByRole('dialog'); await hire.getByLabel('Name', { exact: true }).fill(`Demo ${role}`);
    await hire.getByLabel('Role', { exact: true }).selectOption(role);
    await hire.getByLabel('Responsibility', { exact: true }).fill(`${role} for this note`);
    await hire.getByRole('button', { name: 'Hire member', exact: true }).click(); await hire.waitFor({ state: 'hidden' });
  }
  assert.equal((await state()).team.agents.length, 2);
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('button', { name: 'Ask for a plan', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Additional direction').fill('Write and review a tiny note.');
  await page.getByRole('dialog').getByRole('button', { name: 'Propose plan', exact: true }).click();
  await waitState(value => value.team.plans.some(plan => plan.status === 'proposed') && !value.busy);
  assert.equal((await state()).team.tasks.length, 0, 'proposal alone cannot dispatch work');
  await page.getByRole('button', { name: 'Approve plan', exact: true }).click();
  const first = await waitState(value => value.team.milestones[0]?.status === 'review' && !value.busy);
  const v1 = first.team.outputs.find(output => output.path); assert.equal(v1.version, 1);
  await page.getByRole('button', { name: 'Request changes', exact: true }).click();
  await page.getByRole('dialog').getByLabel('What should change?').fill('Add a clear next step.');
  await page.getByRole('dialog').getByRole('button', { name: 'Send feedback', exact: true }).click();
  const revised = await waitState(value => value.team.outputs.some(output => output.path && output.version === 2) && value.team.milestones[0].status === 'review' && !value.busy);
  const v2 = revised.team.outputs.find(output => output.path && output.version === 2);
  assert.ok(!revised.team.milestones[0].outputIds.includes(v1.id));
  await page.getByRole('button', { name: 'Accept milestone', exact: true }).click();
  await waitState(value => value.team.milestones[0].status === 'accepted');
  await page.getByRole('button', { name: 'Outputs', exact: true }).click();
  await page.getByRole('button', { name: /Project note · v2/ }).click();
  await page.locator('.output-preview pre').waitFor();
  assert.match(await page.locator('.output-preview pre').innerText(), /clear next step/);
  await page.getByRole('button', { name: 'Attach current item', exact: true }).click();
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Project note · v2 attached · remove', exact: true }).count(), 1);
  await page.getByLabel('Message your project manager').fill('Discuss this exact version.');
  await page.getByRole('button', { name: 'Send instruction', exact: true }).click();
  await waitState(value => !value.busy && value.messages.at(-2)?.attachment === `output:${v2.id}`);
  await page.reload(); await page.getByRole('heading', { name: 'Manager', exact: true }).waitFor();
  assert.equal((await state()).team.outputs.length, 4, 'reload does not reproduce outputs');
  for (const view of ['Project', 'Team', 'Outputs']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `populated ${view} has no overflow at ${width}`);
    }
  }
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.screenshot({ path: join(root, '.test-artifacts/team-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Connection and settings', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes('Stop local coordinator')), true, 'dialog focus wraps');
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: 'Connection and settings', exact: true }).evaluate(el => document.activeElement === el), true, 'dialog restores focus');
  assert.deepEqual(issues, [], 'no browser errors');
  await page.getByRole('button', { name: 'Connection and settings', exact: true }).click();
  const exited = once(child, 'exit');
  await page.getByRole('button', { name: 'Stop local coordinator', exact: true }).click();
  const [code] = await exited; assert.equal(code, 0);
  console.log('Browser checks pass: 320–1440px, visible credits, project creation, attachment/navigation, saved reply after browser closure, reload, Pause/Resume, keyboard focus, hiring, approved sequential team work, immutable revision/review, milestone acceptance and Stop. No AI calls.');
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    await exited; clearTimeout(timer);
  }
  await rm(dir, { recursive: true, force: true });
}
