// Capture a coherent README gallery using disposable projects and the fake demo provider.
// Run the production build first. No real account, model inference or GitHub export is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkPublicationFile } from './check-publication.mjs';

let chromium;
try { ({ chromium } = await import(process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE ?? 'playwright')); }
catch (error) {
  if (process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE) throw error;
  ({ chromium } = await import(pathToFileURL(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href));
}

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'tinkrew-public-gallery-')));
const folders = { website: join(temporary, 'website'), insights: join(temporary, 'insights') };
const staging = join(temporary, 'captures');
await Promise.all([mkdir(folders.website), mkdir(folders.insights), mkdir(staging)]);
const port = Number(process.env.PROJECT_TEAM_CAPTURE_PORT ?? 4187);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 4173, 'use an isolated capture port, never the live preview');
const base = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts', '--demo', '--state-dir', join(temporary, 'state'), '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, page;
const errors = [], externalRequests = [], captures = [];

async function state() {
  const response = await page.request.get(base + '/api/state');
  assert.ok(response.ok(), 'the disposable demo is available');
  return response.json();
}
async function post(route, data = {}) {
  const response = await page.request.post(base + '/api/' + route, {
    headers: { 'X-Project-Team': '1', 'X-Project-Id': (await state()).workspace?.activeProjectId ?? 'none' },
    data,
  });
  assert.ok(response.ok(), route + ' succeeded: ' + await response.text());
  return response.json();
}
async function until(predicate, description = 'demo operation finishes') {
  const deadline = Date.now() + 15000;
  while (true) {
    const value = await state();
    if (await predicate(value)) return value;
    assert.ok(Date.now() < deadline, description);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
const crewIdentity = value => value.team.agents.map(({ id, avatarId, name, role, responsibility, model, effort }) => ({ id, avatarId, name, role, responsibility, model, effort })).sort((a, b) => a.name.localeCompare(b.name));

async function capture(name, view, width = 1440, height = 1040) {
  await page.setViewportSize({ width, height });
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: view, exact: true }).click();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.decode()));
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await page.mouse.move(width - 1, height - 1);
  if (view === 'Meeting room') {
    // Use normal document scrolling to show the project context and more of the discussion.
    await page.evaluate(() => {
      const context = document.querySelector('.meeting-project-context');
      const header = document.querySelector('.topbar');
      if (!context || !header) throw new Error('Meeting framing requires the real project context and header.');
      window.scrollTo({ top: window.scrollY + context.getBoundingClientRect().top - header.getBoundingClientRect().bottom - 16, behavior: 'instant' });
    });
    assert.ok(await page.locator('.meeting-project-context').isVisible(), 'meeting project identity remains visible');
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name + ' has no horizontal overflow');
  const filename = name + '.png';
  await page.screenshot({ path: join(staging, filename), fullPage: false, animations: 'disabled', caret: 'hide' });
  const bytes = await readFile(join(staging, filename));
  assert.equal(bytes.readUInt32BE(16), width);
  assert.equal(bytes.readUInt32BE(20), height);
  assert.deepEqual(checkPublicationFile('docs/assets/' + filename, bytes), [], 'captured image contains no publication metadata');
  captures.push({ file: filename, width, height, bytes: bytes.length });
}
async function discussion(title, contribution, speakers) {
  const id = randomUUID();
  await post('meeting', { id, title, participantIds: (await state()).team.agents.map(member => member.id) });
  await post('meeting-message', { id: randomUUID(), meetingId: id, text: contribution, recipientIds: speakers, attachment: 'brief' });
  await until(value => !value.busy && value.meetings.turns.filter(turn => turn.meetingId === id).length === speakers.length && value.meetings.turns.filter(turn => turn.meetingId === id).every(turn => turn.status === 'complete'), 'all deterministic demo participants finish replying');
  return id;
}

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Disposable gallery demo startup timed out.')), 10000);
    const finish = fn => value => { clearTimeout(timer); fn(value); };
    child.once('error', finish(reject));
    child.once('exit', finish(code => reject(new Error('Gallery demo exited before startup: ' + code))));
    child.stdout.on('data', data => { if (String(data).includes('is open at')) finish(resolve)(); });
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== base) externalRequests.push(request.url());
  });
  assert.equal((await state()).demo, true, 'gallery creation never uses live inference');

  // Save both projects before taking any picture so the same dropdown is present throughout.
  let value = await post('projects', { id: randomUUID(), name: 'Customer insights', brief: 'Turn early customer conversations into a concise research note and a useful next step.', folder: folders.insights, credits: 250 });
  const insightsId = value.workspace.activeProjectId;
  value = await post('projects', { id: randomUUID(), name: 'Website launch', brief: 'Create a clear product guide, with useful examples and one next step.', folder: folders.website, credits: 500 });
  const websiteId = value.workspace.activeProjectId;
  await post('connect');
  const roles = [
    { role: 'builder', name: 'Alex', avatarId: '01', responsibility: 'Create clear, useful deliverables from approved briefs.' },
    { role: 'reviewer', name: 'Sam', avatarId: '02', responsibility: 'Review exact versions for clarity and completeness.' },
    { role: 'builder', name: 'Jordan', avatarId: '03', responsibility: 'Explore alternatives and turn feedback into focused improvements.' },
  ];
  for (const member of roles) await post('hire', { id: randomUUID(), ...member, model: 'demo', effort: 'demo' });
  const crew = crewIdentity(await state());
  assert.equal(new Set(crew.map(member => member.id)).size, 3);
  assert.deepEqual(crew.map(member => member.avatarId).sort(), ['01', '02', '03']);
  const alex = crew.find(member => member.name === 'Alex'), sam = crew.find(member => member.name === 'Sam');
  await post('resume');
  await post('plan', { id: randomUUID(), instruction: 'A concise product guide, followed by an independent review of its exact captured version.' });
  await until(value => !value.busy && value.team.plans.some(plan => plan.status === 'proposed'));
  await discussion('Launch planning', 'Keep the guide focused: who is it for, what should readers understand, and what should they do next?', ['manager', alex.id, sam.id]);
  const website = await state();
  assert.equal(website.workspace.activeProjectId, websiteId);
  assert.equal(website.team.tasks.length, 0, 'screenshots do not pretend an unapproved plan has run');
  assert.equal(website.team.outputs.length, 0);

  await page.goto(base);
  await page.getByRole('heading', { name: 'Website launch', exact: true }).waitFor();
  await capture('workspace', 'Project');
  await page.getByRole('button', { name: 'Review plan', exact: true }).waitFor();
  await capture('team', 'Team');
  await capture('meetings', 'Meeting room');
  await capture('mobile', 'Project', 390, 844);
  assert.deepEqual((await state()).credits, website.credits, 'all Website launch captures share the same ledger');
  assert.deepEqual(crewIdentity(await state()), crew);

  // The real dropdown switches the same crew into a separate project and separate discussion.
  await page.setViewportSize({ width: 1440, height: 1040 });
  await page.getByRole('combobox', { name: 'Active project', exact: true }).selectOption(insightsId);
  value = await until(value => value.workspace.activeProjectId === insightsId && !value.workspace.switching);
  assert.deepEqual(crewIdentity(value), crew);
  assert.equal(value.project.mode, 'paused');
  assert.equal(value.connection.status, 'offline');
  assert.equal(value.messages.length, 0);
  assert.equal(value.meetings.rooms.length, 0);
  assert.equal(value.credits.used, 0);
  await post('connect');
  await post('resume');
  await discussion('Customer discovery', 'Which customer problems should we explore first, and what would make a useful research note?', ['manager', alex.id, sam.id]);
  await until(async value => value.workspace.activeProjectId === insightsId && (await page.locator('.eyebrow').innerText()).includes('Customer insights'));
  await capture('project-switch', 'Meeting room');
  assert.deepEqual(crewIdentity(await state()), crew);
  assert.deepEqual(errors, [], 'the captured demo has no browser errors before deliberate shutdown');
  assert.deepEqual(externalRequests, [], 'gallery creation makes no external browser requests');

  // Publish the gallery together only after every new capture has succeeded.
  await mkdir(join(root, 'docs/assets'), { recursive: true });
  for (const item of captures) await copyFile(join(staging, item.file), join(root, 'docs/assets', item.file));
  const exited = once(child, 'exit');
  await post('stop');
  const [code] = await exited;
  assert.equal(code, 0);
  console.log(JSON.stringify({ mode: 'synthetic demo gallery; no account data, live inference or GitHub export', crew: roles.map(({ name, role, avatarId }) => ({ name, role, avatarId })), websiteCreditsUsed: website.credits.used, captures }, null, 2));
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.kill('SIGTERM');
    await exited;
    clearTimeout(timer);
  }
  await rm(temporary, { recursive: true, force: true });
}
