import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Use an installed Playwright, or the desktop app's bundled runtime.
let chromium;
try { ({ chromium } = await import(process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE ?? 'playwright')); }
catch (error) {
  if (process.env.PROJECT_TEAM_PLAYWRIGHT_MODULE) throw error;
  ({ chromium } = await import(pathToFileURL(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href));
}

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'project-team-project-browser-')));
const firstFolder = join(temporary, 'first-project');
const secondFolder = join(temporary, 'second-project');
const nestedFolder = join(firstFolder, 'nested');
await Promise.all([mkdir(nestedFolder, { recursive: true }), mkdir(secondFolder)]);
const port = Number(process.env.PROJECT_TEAM_PROJECTS_QA_PORT ?? 4188);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 4173, 'use a separate valid QA port, never the user preview');
const base = 'http://127.0.0.1:' + port;
const artifacts = join(root, '.test-artifacts');
await mkdir(artifacts, { recursive: true });
const report = { date: new Date().toISOString(), mode: 'isolated saved-project and fixed-character demo; no AI inference', checks: [], passed: false };
let child, browser, page;
let intentionalShutdown = false, expectedStreamClosures = 0;
const browserErrors = [], externalRequests = [], expected409 = new Set();

async function launch() {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts', '--demo', '--state-dir', join(temporary, 'state'), '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated project demo startup timed out.')), 10000);
    const finish = fn => value => { clearTimeout(timer); fn(value); };
    child.once('error', finish(reject));
    child.once('exit', finish(code => reject(new Error('Project demo exited before startup: ' + code))));
    child.stdout.on('data', data => { if (String(data).includes('is open at')) finish(resolve)(); });
  });
}
async function state() {
  const response = await page.request.get(base + '/api/state');
  assert.ok(response.ok(), 'workspace state is readable');
  return response.json();
}
async function until(predicate, description = 'workspace operation completed') {
  const deadline = Date.now() + 15000;
  while (true) {
    const value = await state();
    if (await predicate(value)) return value;
    assert.ok(Date.now() < deadline, description);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
async function headers(scope) {
  return { 'X-Project-Team': '1', 'X-Project-Id': scope ?? (await state()).workspace.activeProjectId ?? 'none' };
}
async function post(route, data = {}, scope) {
  const response = await page.request.post(base + '/api/' + route, { headers: await headers(scope), data });
  assert.ok(response.ok(), route + ' succeeded: ' + await response.text());
  return response.json();
}
const identities = value => value.team.agents.map(({ id, avatarId, name, role, responsibility, model, effort }) => ({ id, avatarId, name, role, responsibility, model, effort })).sort((a, b) => a.id.localeCompare(b.id));
const history = value => ({
  messages: value.messages, credits: value.credits, plans: value.team.plans,
  tasks: value.team.tasks, outputs: value.team.outputs, milestones: value.team.milestones,
  handoffs: value.team.handoffs, reviews: value.team.reviews, decisions: value.team.decisions,
  meetings: { rooms: value.meetings.rooms, messages: value.meetings.messages, turns: value.meetings.turns, proposals: value.meetings.proposals, credits: value.meetings.credits },
  checkpoints: value.checkpoints, recovery: value.recovery,
});
async function fillProject(name, folder, credits) {
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Project name', { exact: true }).fill(name);
  await dialog.getByLabel('What do you want to achieve?').fill('Create a useful guide for ' + name + '. This is disposable demo data.');
  await dialog.getByLabel(/^Project folder/).fill(folder);
  await dialog.getByLabel(/^Project credit allowance/).fill(String(credits));
  return dialog;
}
async function selectProject(name, id) {
  const dropdown = page.getByRole('combobox', { name: 'Active project', exact: true });
  await dropdown.selectOption(id);
  const value = await until(async value =>
    value.workspace.activeProjectId === id && !value.workspace.switching &&
    await dropdown.inputValue() === id &&
    (await page.locator('.eyebrow').innerText()).includes(name) &&
    await dropdown.evaluate(element => document.activeElement === element),
  'the requested project is active in the dropdown and focus returns to it');
  assert.equal(await dropdown.locator('option:checked').textContent(), name);
  assert.equal(value.project.mode, 'paused', 'a project switch never resumes work');
  assert.equal(value.connection.status, 'offline', 'switching never reconnects the team automatically');
  assert.equal(value.busy, false);
  return value;
}
async function meetingContext(name, count) {
  const meeting = page.locator('.meeting-workspace');
  assert.equal(await meeting.isVisible(), true, 'Meeting room remains visible across project switching');
  assert.equal(await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Meeting room', exact: true }).getAttribute('aria-current'), 'page');
  const context = meeting.getByRole('region', { name: 'Project meeting context', exact: true });
  await context.getByText(name, { exact: true }).waitFor();
  assert.match(await context.innerText(), new RegExp(String(count) + ' saved meeting'));
  assert.equal(await page.locator('.manager-heading p').innerText(), name, 'the conversation header also identifies the active project');
  return meeting;
}
async function capture(name, fullPage = false) {
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.screenshot({ path: join(artifacts, name), fullPage });
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  intentionalShutdown = true;
  const exited = once(child, 'exit');
  const response = await page.request.post(base + '/api/stop', { headers: await headers(), data: {} });
  assert.equal(response.status(), 202);
  const [code] = await exited;
  assert.equal(code, 0, 'isolated coordinator exits gracefully');
  child = null;
}
try {
  await launch();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    // Ending our own coordinator deliberately closes its open event stream.
    if (intentionalShutdown && message.location().url === base + '/api/events' && /ERR_INCOMPLETE_CHUNKED_ENCODING/.test(message.text())) { expectedStreamClosures++; return; }
    if (expected409.has(message.location().url) && /status of 409/.test(message.text())) return;
    browserErrors.push({ text: message.text(), url: message.location().url });
  });
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== base) externalRequests.push(request.url());
  });
  await page.goto(base);
  await page.getByRole('heading', { name: 'Manager', exact: true }).waitFor();
  assert.equal((await state()).demo, true, 'never exercise a live AI provider');
  assert.equal((await state()).workspace.activeProjectId, null);

  let dialog = await fillProject('First product guide', firstFolder, 50);
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  let value = await until(value => value.project?.name === 'First product guide' && !value.workspace.switching);
  const firstId = value.workspace.activeProjectId;
  assert.equal(value.project.mode, 'paused');
  assert.equal(value.connection.status, 'offline');
  await page.getByRole('button', { name: 'Start manager', exact: true }).click();
  await page.getByRole('button', { name: 'Resume project', exact: true }).click();
  await until(value => value.connection.status === 'ready' && value.project.mode === 'running');

  // Same-role members must acquire distinct stable characters, not a role-wide image.
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  for (const [name, role] of [['Shared builder one', 'builder'], ['Shared builder two', 'builder'], ['Shared reviewer', 'reviewer']]) {
    await page.getByRole('button', { name: 'Hire member', exact: true }).click();
    const hire = page.getByRole('dialog');
    await hire.getByLabel('Name', { exact: true }).fill(name);
    await hire.getByLabel('Role', { exact: true }).selectOption(role);
    await hire.getByLabel('Responsibility', { exact: true }).fill(role === 'builder' ? 'Produce approved deliverables with a focused scope.' : 'Independently review exact captured versions.');
    await hire.getByRole('button', { name: 'Hire member', exact: true }).click();
    await hire.waitFor({ state: 'hidden' });
  }
  // Complete the fixed eight-person catalog without consuming model turns.
  for (let index = 4; index <= 8; index++) await post('hire', { id: randomUUID(), name: 'Shared member ' + index, role: index % 2 ? 'reviewer' : 'builder', responsibility: 'Help with the approved work in a clear reusable role.', model: 'demo', effort: 'demo' });
  value = await until(value => value.team.agents.length === 8);
  const sharedTeam = identities(value);
  assert.equal(new Set(sharedTeam.map(member => member.avatarId)).size, 8);
  assert.deepEqual(sharedTeam.map(member => member.avatarId).sort(), ['01', '02', '03', '04', '05', '06', '07', '08']);
  const actualSources = [];
  for (const member of sharedTeam) {
    const image = page.locator('.member-card').filter({ has: page.getByRole('heading', { name: member.name, exact: true }) }).locator('img.agent-avatar');
    await image.waitFor();
    const source = await image.getAttribute('src');
    assert.equal(source, '/avatars/character-' + member.avatarId + '.png');
    await image.evaluate(image => image.decode());
    assert.ok(await image.evaluate(image => image.complete && image.naturalWidth > 0));
    actualSources.push(source);
  }
  assert.equal(new Set(actualSources).size, 8, 'every hired person has a distinct actual PNG');
  const sameRole = sharedTeam.filter(member => member.name.startsWith('Shared builder'));
  assert.equal(sameRole.length, 2);
  assert.notEqual(sameRole[0].avatarId, sameRole[1].avatarId);
  const ninth = await page.request.post(base + '/api/hire', { headers: await headers(), data: { id: randomUUID(), name: 'An unavailable ninth hire', role: 'builder', responsibility: 'This must be rejected.', model: 'demo', effort: 'demo' } });
  assert.equal(ninth.status(), 400);
  assert.equal((await ninth.json()).error, 'team_limit');
  assert.deepEqual(identities(await state()), sharedTeam);

  const assetPaths = ['/avatars/manager.png', ...Array.from({ length: 8 }, (_, index) => '/avatars/character-' + String(index + 1).padStart(2, '0') + '.png')];
  const decoded = await page.evaluate(paths => Promise.all(paths.map(src => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ src, width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('Character could not decode: ' + src));
    image.src = src;
  }))), assetPaths);
  const imageHashes = [];
  for (const asset of decoded) {
    assert.ok(asset.width >= 512 && asset.width === asset.height, 'each fixed avatar is a decodable square image');
    const response = await page.request.get(base + asset.src);
    assert.ok(response.ok()); assert.match(response.headers()['content-type'], /^image\/png/);
    const bytes = await response.body();
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    imageHashes.push(createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal(new Set(imageHashes).size, 9, 'all nine served character images are genuinely different');
  report.checks.push('eight shared hires, distinct same-role PNG identities, team cap, and all nine local character assets decode correctly');

  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('button', { name: 'Attach current item', exact: true }).click();
  await page.getByLabel('Message your project manager').fill('Only the first project should remember this discussion.');
  await page.getByRole('button', { name: 'Send instruction', exact: true }).click();
  await until(value => !value.busy && value.messages.length === 2);
  await post('plan', { id: randomUUID(), instruction: 'Write and independently review a small first-project note.' });
  value = await until(value => !value.busy && value.team.plans.some(plan => plan.status === 'proposed'));
  await post('approve-plan', { id: randomUUID(), planId: value.team.plans.find(plan => plan.status === 'proposed').id });
  value = await until(value => !value.busy && value.team.milestones[0]?.status === 'review');
  const firstOutput = value.team.outputs.find(output => output.path);
  assert.ok(firstOutput);
  const originalResponse = await page.request.get(base + '/api/output/' + firstOutput.id, { headers: await headers(firstId) });
  assert.ok(originalResponse.ok());
  const originalOutput = await originalResponse.json();
  assert.match(originalOutput.content, /First product guide/);
  const meetingId = randomUUID();
  await post('meeting', { id: meetingId, title: 'First-project review discussion', participantIds: sharedTeam.map(member => member.id) });
  await post('meeting-message', { id: randomUUID(), meetingId, text: 'Discuss this captured version only in this project.', recipientIds: ['manager'], attachment: 'output:' + firstOutput.id });
  await until(value => !value.busy && value.meetings.turns[0]?.status === 'complete');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await until(value => value.project.mode === 'paused');
  const firstHistory = history(await state());
  assert.ok(firstHistory.credits.used > 0);
  assert.ok(firstHistory.messages.length && firstHistory.tasks.length && firstHistory.outputs.length && firstHistory.meetings.messages.length);

  await page.getByRole('button', { name: 'Outputs', exact: true }).click();
  await page.getByRole('button', { name: /Project note · v1/ }).first().click();
  await page.locator('.output-preview pre').waitFor();
  await page.getByRole('button', { name: 'Attach current item', exact: true }).click();
  await page.getByRole('button', { name: 'Project note · v1 attached · remove', exact: true }).waitFor();
  await page.getByLabel('Message your project manager').fill('Unsent first-project draft');

  // Validation must leave A selected and its history untouched.
  dialog = await fillProject('Second launch note', nestedFolder, 80);
  expected409.add(base + '/api/projects');
  const overlap = page.waitForResponse(response => response.url() === base + '/api/projects' && response.status() === 409);
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  assert.equal((await (await overlap).json()).error, 'project_folder_overlap');
  await dialog.getByRole('alert').getByText('Choose a separate folder for each project so their files stay apart.', { exact: true }).waitFor();
  assert.equal((await state()).workspace.projects.length, 1);
  assert.equal((await state()).workspace.activeProjectId, firstId);
  assert.deepEqual(history(await state()), firstHistory);
  await dialog.getByLabel(/^Project folder/).fill(secondFolder);
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  expected409.delete(base + '/api/projects');
  value = await until(value => value.project?.name === 'Second launch note' && !value.workspace.switching);
  const secondId = value.workspace.activeProjectId;
  assert.notEqual(secondId, firstId);
  assert.equal(value.workspace.projects.length, 2);
  assert.equal(value.project.mode, 'paused');
  assert.equal(value.connection.status, 'offline');
  assert.equal(value.busy, false);
  assert.deepEqual(identities(value), sharedTeam);
  assert.ok(value.team.agents.every(member => member.threadId === null && member.lastTotal === 0), 'member runtime bindings start clean in a new project');
  assert.equal(value.project.threadId, null);
  assert.deepEqual(value.messages, []);
  for (const field of ['plans', 'tasks', 'outputs', 'milestones', 'handoffs', 'reviews', 'decisions']) assert.deepEqual(value.team[field], [], 'new project has no prior ' + field);
  for (const field of ['rooms', 'messages', 'turns', 'proposals']) assert.deepEqual(value.meetings[field], [], 'new project has no prior meeting ' + field);
  assert.deepEqual(value.checkpoints, []);
  assert.deepEqual(value.recovery, []);
  assert.equal(value.credits.used, 0);
  assert.equal(value.credits.reserved, 0);
  assert.equal(value.credits.available, 80);
  assert.ok(Object.values(value.team.agentCredits).every(used => used === 0));
  assert.equal(await page.getByLabel('Message your project manager').inputValue(), '');
  assert.equal(await page.getByRole('button', { name: 'Project note · v1 attached · remove', exact: true }).count(), 0);
  assert.match(await page.locator('.current-item > button').first().innerText(), /Project brief/);
  assert.equal(await page.getByRole('button', { name: 'Send instruction', exact: true }).isDisabled(), true);
  report.checks.push('UI creation rejects overlapping folders; the second project starts paused/offline with the shared team and isolated messages, outputs, tasks, meetings, credits and runtime bindings');

  // The screen stays in Meeting room while its project context and saved discussion change.
  await page.getByRole('button', { name: 'Meeting room', exact: true }).click();
  let meeting = await meetingContext('Second launch note', 0);
  assert.equal(await meeting.getByRole('combobox', { name: 'Meeting', exact: true }).count(), 0);
  assert.equal(await meeting.locator('.meeting-message').count(), 0);
  assert.ok(!(await meeting.innerText()).includes('First-project review discussion'));
  assert.ok(!(await meeting.innerText()).includes('Discuss this captured version only in this project.'));
  await meeting.getByRole('button', { name: 'New meeting', exact: true }).click();
  const newMeeting = page.getByRole('dialog');
  await newMeeting.getByLabel('Meeting title', { exact: true }).fill('Second-project planning discussion');
  await newMeeting.getByRole('button', { name: 'Create meeting', exact: true }).click();
  await newMeeting.waitFor({ state: 'hidden' });
  await until(value => value.meetings.rooms.length === 1);
  meeting = await meetingContext('Second launch note', 1);
  assert.deepEqual(await meeting.getByRole('combobox', { name: 'Meeting', exact: true }).locator('option').allTextContents(), ['Second-project planning discussion']);
  assert.equal(await meeting.locator('.meeting-message').count(), 0);

  value = await selectProject('First product guide', firstId);
  assert.deepEqual(history(value), firstHistory, 'entering another project’s Meeting room cannot change saved work');
  meeting = await meetingContext('First product guide', 1);
  assert.deepEqual(await meeting.getByRole('combobox', { name: 'Meeting', exact: true }).locator('option').allTextContents(), ['First-project review discussion']);
  await meeting.getByText('Discuss this captured version only in this project.', { exact: true }).waitFor();
  assert.equal(await meeting.locator('.meeting-message').count(), firstHistory.meetings.messages.length);
  assert.ok(!(await meeting.innerText()).includes('Second-project planning discussion'));
  await capture('projects-meeting-first.png');
  await meeting.getByLabel('Meeting message', { exact: true }).fill('Unsent first-project meeting thought');
  await meeting.getByLabel('Address meeting message', { exact: true }).selectOption(sharedTeam.find(member => member.role === 'builder').id);
  await meeting.getByRole('button', { name: 'Attach current item to meeting', exact: true }).click();
  assert.equal(await meeting.locator('.attachment-chip').count(), 1);
  assert.equal(await meeting.getByRole('button', { name: 'Request replies', exact: true }).isDisabled(), true);

  await selectProject('Second launch note', secondId);
  meeting = await meetingContext('Second launch note', 1);
  assert.deepEqual(await meeting.getByRole('combobox', { name: 'Meeting', exact: true }).locator('option').allTextContents(), ['Second-project planning discussion']);
  assert.equal(await meeting.locator('.meeting-message').count(), 0);
  assert.equal(await meeting.getByLabel('Meeting message', { exact: true }).inputValue(), '');
  assert.equal(await meeting.getByLabel('Address meeting message', { exact: true }).inputValue(), 'all');
  assert.equal(await meeting.locator('.attachment-chip').count(), 0);
  assert.ok(!(await meeting.innerText()).includes('Discuss this captured version only in this project.'));
  assert.equal(await meeting.getByRole('button', { name: 'Request replies', exact: true }).isDisabled(), true);
  await capture('projects-meeting-second.png');

  await selectProject('First product guide', firstId);
  meeting = await meetingContext('First product guide', 1);
  await meeting.getByText('Discuss this captured version only in this project.', { exact: true }).waitFor();
  assert.equal(await meeting.getByLabel('Meeting message', { exact: true }).inputValue(), '', 'unsent meeting form state is reset rather than carried across projects');
  assert.equal(await meeting.locator('.attachment-chip').count(), 0);
  assert.deepEqual(history(await state()), firstHistory);
  await selectProject('Second launch note', secondId);
  meeting = await meetingContext('Second launch note', 1);
  report.checks.push('the native project dropdown retains Meeting room and restores focus while project labels, meeting lists, transcripts and composer state change to the selected project; switching requires explicit reconnect/Resume');
  await meeting.getByRole('region', { name: 'Project meeting context', exact: true }).getByRole('button', { name: 'Open project', exact: true }).click();
  await page.getByRole('heading', { name: 'Second launch note', exact: true }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Active project', exact: true }).inputValue(), secondId);

  await page.getByLabel('Message your project manager').fill('Unsent second-project draft');
  value = await selectProject('First product guide', firstId);
  assert.deepEqual(history(value), firstHistory);
  await page.getByRole('button', { name: 'Write the note', exact: true }).waitFor();
  assert.equal(await page.locator('.task-row').count(), firstHistory.tasks.length, 'the first project’s processes return with its saved state');
  assert.deepEqual(identities(value), sharedTeam);
  assert.equal(value.project.mode, 'paused');
  assert.equal(value.connection.status, 'offline');
  assert.equal(await page.getByLabel('Message your project manager').inputValue(), 'Unsent first-project draft');
  assert.equal(await page.getByRole('button', { name: 'Attach current item', exact: true }).count(), 1, 'an old attachment is not silently restored');
  assert.match(await page.locator('.current-item > button').first().innerText(), /Project brief/);
  const restoredOutput = await page.request.get(base + '/api/output/' + firstOutput.id, { headers: await headers(firstId) });
  assert.deepEqual(await restoredOutput.json(), originalOutput);
  await selectProject('Second launch note', secondId);
  assert.equal(await page.locator('.task-row').count(), 0, 'the second project does not show the first project’s process queue');
  assert.equal(await page.getByLabel('Message your project manager').inputValue(), 'Unsent second-project draft');
  const secondEmpty = history(await state());
  const staleWrite = await page.request.post(base + '/api/message', { headers: await headers(firstId), data: { id: randomUUID(), text: 'A stale window must never send this.' } });
  assert.equal(staleWrite.status(), 409);
  assert.equal((await staleWrite.json()).error, 'stale_project');
  const staleRead = await page.request.get(base + '/api/output/' + firstOutput.id, { headers: await headers(firstId) });
  assert.equal(staleRead.status(), 409);
  assert.equal((await staleRead.json()).error, 'stale_project');
  const crossProjectRead = await page.request.get(base + '/api/output/' + firstOutput.id, { headers: await headers(secondId) });
  assert.equal(crossProjectRead.status(), 404);
  assert.equal((await crossProjectRead.json()).error, 'output_not_found');
  assert.deepEqual(history(await state()), secondEmpty, 'rejected stale operations cannot alter the active project');
  report.checks.push('A history and exact output return unchanged; unsent drafts remain separate, attachments reset, stale writes/reads return 409 and foreign outputs cannot be read');

  await page.getByRole('button', { name: 'Start manager', exact: true }).click();
  await page.getByRole('button', { name: 'Resume project', exact: true }).click();
  await page.getByRole('button', { name: 'Send instruction', exact: true }).click();
  value = await until(value => !value.busy && value.messages.length === 2);
  assert.equal(value.messages[0].text, 'Unsent second-project draft');
  assert.equal(value.credits.used, 0.9);
  assert.equal(value.credits.available, 79.1);
  const secondHistory = history(value);
  await selectProject('First product guide', firstId);
  assert.deepEqual(history(await state()), firstHistory, 'spending in B cannot change A credits or saved work');
  await selectProject('Second launch note', secondId);
  assert.deepEqual(history(await state()), secondHistory);
  await page.reload();
  await page.getByRole('heading', { name: 'Second launch note', exact: true }).waitFor();
  value = await state();
  assert.equal(value.workspace.activeProjectId, secondId);
  assert.deepEqual(identities(value), sharedTeam);
  assert.deepEqual(history(value), secondHistory);
  assert.equal(value.project.mode, 'paused');
  assert.equal(value.connection.status, 'offline');
  assert.equal(value.busy, false);

  for (const view of ['Project', 'Team', 'Meeting room']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, view + ' with saved projects fits ' + width + 'px');
      assert.equal(await page.locator('.credit-bar').isVisible(), true);
      assert.equal(await page.getByRole('button', { name: 'New project', exact: true }).isVisible(), true);
      const projectDropdown = page.getByRole('combobox', { name: 'Active project', exact: true });
      assert.equal(await projectDropdown.isVisible(), true);
      assert.equal(await projectDropdown.inputValue(), secondId);
      assert.deepEqual(await projectDropdown.locator('option').allTextContents(), ['First product guide', 'Second launch note']);
    }
  }
  report.checks.push('independent credit ledgers, selected-project/roster/history reload persistence and saved-project navigation at 320–1440px');

  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capture('projects-desktop.png', true);
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('projects-mobile.png');
  await page.setViewportSize({ width: 1440, height: 1000 });

  await stop();
  await launch();
  await page.reload();
  await page.getByRole('heading', { name: 'Second launch note', exact: true }).waitFor();
  value = await state();
  intentionalShutdown = false;
  assert.equal(value.workspace.activeProjectId, secondId);
  assert.equal(value.workspace.projects.length, 2);
  assert.deepEqual(identities(value), sharedTeam);
  assert.deepEqual(history(value), secondHistory);
  assert.notEqual(value.project.mode, 'running');
  assert.equal(value.connection.status, 'offline');
  assert.equal(value.busy, false);
  await selectProject('First product guide', firstId);
  assert.deepEqual(history(await state()), firstHistory);
  assert.deepEqual(identities(await state()), sharedTeam);
  await stop();
  assert.deepEqual(browserErrors, [], 'no unexpected console or page exceptions');
  assert.deepEqual(externalRequests, [], 'browser never requests an external network service');
  report.checks.push('graceful coordinator restart restores both projects and their single team without inference, replay, external requests or browser errors');
  report.expectedStreamClosures = expectedStreamClosures;
  report.artifacts = ['projects-desktop.png', 'projects-mobile.png', 'projects-meeting-first.png', 'projects-meeting-second.png'];
  report.passed = true;
} finally {
  if (!report.passed && page && !page.isClosed()) await page.screenshot({ path: join(artifacts, 'projects-failure.png'), fullPage: false }).catch(() => {});
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child?.kill('SIGKILL'), 15000);
    child.kill('SIGTERM');
    await exited;
    clearTimeout(timer);
  }
  await rm(temporary, { recursive: true, force: true });
  await writeFile(join(artifacts, 'projects-browser.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
