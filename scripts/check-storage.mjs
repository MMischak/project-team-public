// No inference: verify native history isolation, protection and deletion using one named empty thread.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { CodexManager } from '../server/codex.ts';
import { CodexTeam } from '../server/codex-team.ts';
const dir = await realpath(await mkdtemp(join(tmpdir(), 'team-storage-native-check-'))), driver = new CodexManager(dir);
let worker;
const report = { date: new Date().toISOString(), mode: 'native metadata-only check; no model turns', runtime: null, checks: [], passed: false };
try {
  const binary = process.env.PROJECT_TEAM_CODEX_BIN ?? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
  report.runtime = (await promisify(execFile)(binary, ['--version'])).stdout.trim();
  const connection = await driver.connect(); assert.equal(connection.status, 'ready'); report.checks.push('existing ChatGPT sign-in works with private runtime home');
  const result = await driver.request('thread/start', { cwd: join(dir, 'manager'), ephemeral: false, approvalPolicy: 'never', sandbox: 'read-only', environments: [], developerInstructions: 'Storage verification only. No model turns requested.' });
  assert.ok(result.thread.path.startsWith(join(dir, 'native-home', 'sessions') + '/')); await driver.request('thread/name/set', { threadId: result.thread.id, name: 'Project Team storage verification' }); await driver.rememberThread(result.thread); await driver.closeForStorage();
  report.checks.push('named empty thread and ownership registry stay under private app runtime, outside shared chats');
  assert.deepEqual(await driver.cleanupStorage(new Set([result.thread.id]), Date.now() + 10000, () => { throw new Error('Protected identity must not be reset'); }), []);
  report.checks.push('protected native thread survives cleanup');
  assert.deepEqual(await driver.cleanupStorage(new Set(), Date.now() + 10000, () => {}), [result.thread.id]); assert.deepEqual(await driver.nativeRegistry(), []);
  report.checks.push('completed native trace removed through thread/delete; registry updated; zero inference');
  const project = join(dir, 'project'); await mkdir(project); worker = new CodexTeam(join(dir, 'worker-state')); await worker.configureProject(await realpath(project));
  assert.equal((await CodexManager.prototype.connect.call(worker)).status, 'ready'); await worker.prepareExecution(await realpath(project));
  report.checks.push('private worker runtime verifies project-only profile and fixed filesystem probes; no model turn'); report.passed = true;
} finally {
  await driver.closeForStorage(); await worker?.closeForStorage(); await rm(dir, { recursive: true, force: true });
  const index = process.argv.indexOf('--report'); if (index >= 0) { const path = resolve(process.argv[index + 1]); await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2));
}
