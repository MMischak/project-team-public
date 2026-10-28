import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateProbe, runPermissionCheck } from '../scripts/check-project-permissions.mjs';

const isolated = 'inside_read=allowed\ninside_write=allowed\nmetadata_write=denied\noutside_read=denied\noutside_write=denied\ntraversal_read=denied\ntraversal_write=denied\nsymlink_read=denied\nsymlink_write=denied\n';
test('permission gate requires working inside access and every outside denial', () => {
  assert.equal(evaluateProbe({ exitCode: 0, stdout: isolated }).passed, true);
  const escaped = evaluateProbe({ exitCode: 0, stdout: isolated.replace('symlink_read=denied', 'symlink_read=allowed') });
  assert.equal(escaped.passed, false); assert.deepEqual(escaped.failures, ['symlink_read']);
  assert.equal(evaluateProbe({ exitCode: 0, stdout: isolated.replace('inside_write=allowed', 'inside_write=denied') }).passed, false);
});
test('sandbox startup failure and partial output cannot pass as successful isolation', () => {
  assert.equal(evaluateProbe({ exitCode: 65, stdout: '' }).passed, false);
  assert.equal(evaluateProbe({ exitCode: 65, stdout: isolated }).passed, false);
  assert.equal(evaluateProbe({ exitCode: 0, stdout: isolated.replace('outside_read=denied\n', '') }).passed, false);
});
test('duplicate or unexpected probe output cannot hide a permission violation', () => {
  assert.equal(evaluateProbe({ exitCode: 0, stdout: isolated + 'outside_read=allowed\n' }).passed, false);
  assert.equal(evaluateProbe({ exitCode: 0, stdout: isolated + 'unexpected=allowed\n' }).passed, false);
  assert.equal(evaluateProbe({ exitCode: 0, stdout: isolated.replace('inside_read=allowed', 'inside_read=allowed=extra') }).passed, false);
});

test('an unverifiable effective profile prevents command dispatch and live inference', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'project-team-profile-rejection-'));
  const executable = join(dir, 'fixture-codex.mjs'), dispatched = join(dir, 'dispatched');
  await writeFile(executable, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('fixture-codex 1.0'); process.exit(0); }
if (process.argv.includes('sandbox')) process.exit(65);
const selected = JSON.parse(process.argv.find(value => value.startsWith('default_permissions=')).split('=')[1]);
createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line); if (message.id === undefined) return;
  let result = {};
  if (message.method === 'config/read') result = { config: { default_permissions: selected, sandbox_mode: null, web_search: 'disabled', features: { code_mode_host: true, ...Object.fromEntries(['multi_agent','apps','plugins','computer_use','browser_use','in_app_browser','hooks','shell_tool'].map(name=>[name,false])) }, permissions: { [selected]: { extends: ':workspace', filesystem: { ':root': 'read', ':minimal': 'read', ':tmpdir': 'deny', ':slash_tmp': 'deny', [process.cwd()]: 'write' }, network: { enabled: false } } } } };
  if (message.method === 'permissionProfile/list') result = { data: [{ id: selected, allowed: true }] };
  if (['thread/start', 'turn/start', 'command/exec', 'account/read'].includes(message.method)) appendFileSync(${JSON.stringify(dispatched)}, message.method+'\\n');
  console.log(JSON.stringify({ id: message.id, result }));
});
`, { mode: 0o700 });
  try {
    const result = await runPermissionCheck(executable, { live: true });
    assert.equal(result.passed, false);
    assert.equal(result.effective.configVerified, false);
    assert.equal(result.appServer.error, 'effective_profile_not_verified');
    assert.equal(result.inferenceTurns, 0);
    await assert.rejects(readFile(dispatched), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
