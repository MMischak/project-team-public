import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// The default check makes no inference or auth requests. --live explicitly adds
// one subscription-backed tool turn. All commands touch disposable fixtures.
const expected = {
  inside_read: 'allowed', inside_write: 'allowed', metadata_write: 'denied',
  outside_read: 'denied', outside_write: 'denied',
  traversal_read: 'denied', traversal_write: 'denied',
  symlink_read: 'denied', symlink_write: 'denied',
};
const probe = `
read_probe() { if /bin/cat "$2" >/dev/null 2>&1; then printf '%s=allowed\\n' "$1"; else printf '%s=denied\\n' "$1"; fi; }
write_probe() { if (printf 'fixture-write' > "$2") 2>/dev/null; then printf '%s=allowed\\n' "$1"; else printf '%s=denied\\n' "$1"; fi; }
read_probe inside_read inside.txt
write_probe inside_write "$1-inside-write.txt"
write_probe metadata_write ".git/$1-protected.txt"
read_probe outside_read "$2/outside.txt"
write_probe outside_write "$2/$1-outside-write.txt"
read_probe traversal_read ../unrelated/outside.txt
write_probe traversal_write "../unrelated/$1-traversal-write.txt"
read_probe symlink_read escape/outside.txt
write_probe symlink_write "escape/$1-symlink-write.txt"
`;

export function evaluateProbe(result) {
  const observations = {};
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const [key, value, extra] = line.split('=');
    if (extra !== undefined || !(key in expected) || key in observations || !['allowed', 'denied'].includes(value)) return { passed: false, observations, failures: ['invalid_probe_output'] };
    observations[key] = value;
  }
  const failures = Object.entries(expected).filter(([key, value]) => observations[key] !== value).map(([key]) => key);
  if (result.exitCode !== 0) failures.unshift('sandbox_command_failed');
  return { passed: failures.length === 0, observations, failures };
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'CODEX_MODEL_PROVIDER', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']) delete env[key];
  return env;
}

function execute(command, args, cwd) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env: cleanEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('command_timeout')); }, 20000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', exitCode => { clearTimeout(timer); resolveResult({ exitCode, stdout, stderr }); });
  });
}

function appServer(command, args, cwd) {
  const child = spawn(command, [...args, 'app-server', '--listen', 'stdio://'], { cwd, env: cleanEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let sequence = 0, diagnostic = '', closed = false, toolHandler = null, notificationHandler = null;
  const fail = error => { closed = true; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); notificationHandler?.({ method: 'check/closed', params: { error: error.message } }); };
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
  child.on('error', () => fail(new Error('app_server_unavailable')));
  child.stdin.on('error', () => fail(new Error('app_server_closed')));
  child.on('exit', () => fail(new Error('app_server_closed')));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const item = pending.get(message.id); if (!item) return;
      clearTimeout(item.timer); pending.delete(message.id);
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
    } else if (message.id !== undefined) {
      if (message.method !== 'item/tool/call' || !toolHandler) { fail(new Error('unexpected_tool_or_approval_request')); child.kill(); return; }
      void toolHandler(message.params).then(result => {
        if (!closed) child.stdin.write(JSON.stringify({ id: message.id, result }) + '\n');
      }).catch(error => { fail(error); child.kill(); });
    } else notificationHandler?.(message);
  });
  return {
    request(method, params = {}) {
      if (closed) return Promise.reject(new Error('app_server_closed'));
      return new Promise((resolveResult, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { fail(new Error('app_server_timeout')); child.kill(); }, 20000);
        pending.set(id, { resolve: resolveResult, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    initialized() { child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n'); },
    onTool(handler) { toolHandler = handler; },
    onNotification(handler) { notificationHandler = handler; },
    abort(error) { fail(error); child.kill(); },
    diagnostic() { return diagnostic; },
    async close() {
      lines.close(); fail(new Error('check_finished'));
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise(resolveResult => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolveResult(); }, 2000);
        child.once('exit', () => { clearTimeout(timer); resolveResult(); }); child.kill();
      });
    },
  };
}

export async function runPermissionCheck(command, { live = false, fixtureBase = tmpdir() } = {}) {
  const root = await realpath(await mkdtemp(join(fixtureBase, 'project-team-permissions-')));
  const folder = join(root, 'project with spaces'), outside = join(root, 'unrelated');
  const profileId = `project_team_check_${randomUUID().replaceAll('-', '')}`;
  const report = { checkedAt: new Date().toISOString(), platform: process.platform, executionRoute: 'app-server-command-exec', passed: false, inferenceTurns: 0, profile: profileId, effective: null, nativeHelper: null, appServer: null, live: null };
  try {
    for (const path of [join(folder, '.git'), outside, join(root, 'state')]) await mkdir(path, { recursive: true });
    await writeFile(join(folder, 'inside.txt'), 'inside-fixture');
    await writeFile(join(outside, 'outside.txt'), 'outside-fixture');
    await symlink(outside, join(folder, 'escape'));
    const policy = { extends: ':workspace', filesystem: { ':root': 'deny', ':minimal': 'read', ':tmpdir': 'deny', ':slash_tmp': 'deny', [folder]: 'write' }, network: { enabled: false } };
    const policyToml = `{extends=":workspace",filesystem={${Object.entries(policy.filesystem).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}},network={enabled=false}}`;
    const disabled = ['multi_agent', 'apps', 'plugins', 'computer_use', 'browser_use', 'in_app_browser', 'hooks', 'shell_tool'];
    if (!live) disabled.push('code_mode_host');
    const configArgs = ['-c', `default_permissions=${JSON.stringify(profileId)}`, '-c', `permissions.${profileId}=${policyToml}`, '-c', `sqlite_home=${JSON.stringify(join(root, 'state'))}`, '-c', `log_dir=${JSON.stringify(join(root, 'logs'))}`, '-c', 'web_search="disabled"', ...disabled.flatMap(name => ['--disable', name]), ...(live ? ['--enable', 'code_mode_host'] : [])];
    report.version = (await execute(command, ['--version'], folder)).stdout.trim();
    if (process.platform === 'darwin') report.os = (await execute('/usr/bin/sw_vers', ['-productVersion'], folder)).stdout.trim();
    const summarize = async (result, route) => {
      const assessment = evaluateProbe(result);
      const outsideWrites = [];
      for (const name of ['outside', 'traversal', 'symlink']) {
        try { await access(join(outside, `${route}-${name}-write.txt`)); outsideWrites.push(name); } catch { /* absent */ }
      }
      let insideWriteVerified = false;
      try { insideWriteVerified = await readFile(join(folder, `${route}-inside-write.txt`), 'utf8') === 'fixture-write'; } catch { /* absent */ }
      const fixtureUnchanged = await readFile(join(outside, 'outside.txt'), 'utf8') === 'outside-fixture';
      const passed = assessment.passed && insideWriteVerified && outsideWrites.length === 0 && fixtureUnchanged;
      return { ...assessment, passed, exitCode: result.exitCode, diagnostic: result.stderr.slice(0, 2000), insideWriteVerified, outsideWrites, fixtureUnchanged };
    };
    // Diagnostic only: workers will use command/exec, never this helper/fallback.
    report.nativeHelper = await summarize(await execute(command, [...configArgs, 'sandbox', '-C', folder, '-P', profileId, '/bin/sh', '-c', probe, 'permission-probe', 'native', outside], folder), 'native');
    const server = appServer(command, configArgs, folder);
    try {
      await server.request('initialize', { clientInfo: { name: 'project_team_permission_check', version: '0.1.0' }, capabilities: { experimentalApi: true } }); server.initialized();
      const { config } = await server.request('config/read', { includeLayers: false });
      const active = config?.permissions?.[profileId];
      const toolsVerified = disabled.every(name => config?.features?.[name] === false) && config?.web_search === 'disabled' && (!live || config?.features?.code_mode_host === true);
      const filesystemMatches = Object.keys(active?.filesystem ?? {}).filter(key => key !== 'glob_scan_max_depth').length === Object.keys(policy.filesystem).length && Object.entries(policy.filesystem).every(([key, value]) => active.filesystem[key] === value);
      const profiles = await server.request('permissionProfile/list', { cwd: folder });
      const allowed = profiles.data?.some(profile => profile.id === profileId && profile.allowed === true);
      const configVerified = toolsVerified && config?.sandbox_mode == null && config?.default_permissions === profileId && active?.extends === ':workspace' && !Object.values(active?.workspace_roots ?? {}).some(Boolean) && active?.network?.enabled === false && filesystemMatches && allowed;
      report.effective = { configVerified, allowed: Boolean(allowed), legacySandboxMode: config?.sandbox_mode ?? null, filesystem: { ...policy.filesystem, [folder]: undefined, '<selected-folder>': policy.filesystem[folder] }, networkEnabled: active?.network?.enabled ?? null, threadProfileVerified: false };
      if (!configVerified) throw new Error('effective_profile_not_verified');
      const mcpOverrides = Object.fromEntries(Object.keys(config?.mcp_servers ?? {}).map(name => [`mcp_servers.${name}.enabled`, false]));
      const tools = live ? [{ type: 'function', name: 'project_permission_probe', description: 'Run the one fixed native permission probe against disposable fixtures. Call exactly once with {}.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, deferLoading: false }] : [];
      const opened = await server.request('thread/start', { cwd: folder, runtimeWorkspaceRoots: [folder], permissions: profileId, approvalPolicy: 'never', ephemeral: true, environments: [], dynamicTools: tools, developerInstructions: 'Permission integration test only. When asked, call project_permission_probe exactly once with an empty object, then summarize its returned result and end. No other tools, retries, commands, delegation or bypasses.', config: mcpOverrides });
      report.effective.threadProfileVerified = opened.activePermissionProfile?.id === profileId && opened.activePermissionProfile?.extends === ':workspace' && opened.approvalPolicy === 'never' && opened.cwd === folder;
      if (!report.effective.threadProfileVerified) throw new Error('thread_profile_not_verified');
      const commandParams = route => ({ command: ['/bin/sh', '-c', probe, 'permission-probe', route, outside], cwd: folder, permissionProfile: profileId, timeoutMs: 10000, outputBytesCap: 8192 });
      report.appServer = await summarize(await server.request('command/exec', commandParams('app-server')), 'app-server');
      if (live && report.appServer.passed) {
        if ((await server.request('account/read', { refreshToken: false }))?.account?.type !== 'chatgpt') throw new Error('subscription_required');
        const liveResult = { passed: false, toolCalls: 0, model: opened.model, reportedTokens: null, turnStatus: null, probe: null };
        report.live = liveResult;
        let finished, rejected, activeTurn = null, toolTurn = null;
        const done = new Promise((resolveResult, reject) => { finished = resolveResult; rejected = reject; }); done.catch(() => {});
        const timer = setTimeout(() => rejected(new Error('live_turn_timeout')), 120000);
        server.onNotification(message => {
          const params = message.params ?? {};
          if (message.method === 'check/closed') { rejected(new Error(params.error)); return; }
          if (params.threadId && params.threadId !== opened.thread.id) return;
          if (['commandExecution', 'fileChange', 'mcpToolCall'].includes(params.item?.type)) { const error = new Error('unexpected_builtin_execution'); rejected(error); server.abort(error); return; }
          if (message.method === 'thread/tokenUsage/updated') liveResult.reportedTokens = params.tokenUsage?.total?.totalTokens ?? null;
          if (message.method === 'turn/completed') { liveResult.turnStatus = params.turn?.status; finished(); }
        });
        server.onTool(async params => {
          if (params.tool !== 'project_permission_probe' || params.namespace != null || params.threadId !== opened.thread.id || (activeTurn && params.turnId !== activeTurn) || !params.arguments || Array.isArray(params.arguments) || typeof params.arguments !== 'object' || Object.keys(params.arguments).length || liveResult.toolCalls) throw new Error('unexpected_dynamic_tool');
          toolTurn = params.turnId; liveResult.toolCalls++;
          try {
            const result = await server.request('command/exec', commandParams('live'));
            liveResult.probe = await summarize(result, 'live');
            return { contentItems: [{ type: 'inputText', text: JSON.stringify(liveResult.probe) }], success: liveResult.probe.passed };
          } catch (error) { rejected(error); throw error; }
        });
        try {
          report.inferenceTurns = 1;
          const started = await server.request('turn/start', { threadId: opened.thread.id, permissions: profileId, approvalPolicy: 'never', input: [{ type: 'text', text: 'Call the provided project_permission_probe tool exactly once with {}. Report the returned result briefly and end. Do not use tools.exec_command or any other tool.' }] });
          activeTurn = started.turn?.id;
          await done;
          liveResult.passed = Boolean(activeTurn && toolTurn === activeTurn && liveResult.turnStatus === 'completed' && liveResult.toolCalls === 1 && liveResult.probe?.passed);
        } catch (error) { liveResult.error = error.message; }
        finally { clearTimeout(timer); }
      }
    } catch (error) { report.appServer = { passed: false, error: error.message, diagnostic: server.diagnostic().slice(0, 2000) }; }
    finally { await server.close(); }
    report.passed = Boolean(report.appServer.passed && report.effective?.configVerified && report.effective?.threadProfileVerified && (!live || report.live?.passed));
  } catch (error) { report.error = error.message; }
  finally { await rm(root, { recursive: true, force: true }); }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const live = args[0] === '--live'; if (live) args.shift();
  if (args.length && (args.length !== 2 || args[0] !== '--report')) throw new Error('Usage: npm run check:permissions -- [--live] [--report path.json]');
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
  let command = process.env.PROJECT_TEAM_CODEX_BIN;
  if (!command) { try { await access(bundled, constants.X_OK); command = bundled; } catch { command = 'codex'; } }
  const report = await runPermissionCheck(command, { live, fixtureBase: process.cwd() });
  if (args[1]) { const target = resolve(args[1]); await mkdir(dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
