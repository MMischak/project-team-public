import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access, mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { prepareNativeHome } from './native-home.ts';
import { once } from 'node:events';
import type { Connection, ManagerProvider, ProviderEvent, QuotaWindow, TurnInspection } from './types.ts';
import { AppError } from './types.ts';

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Turn = { texts: Map<string, string>; done?: any; listener: (event: ProviderEvent) => void; resolve?: (value: { text: string; turnId: string }) => void; reject?: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };
const DISABLED_FEATURES = ['shell_tool', 'multi_agent', 'apps', 'plugins', 'computer_use', 'code_mode_host', 'browser_use', 'in_app_browser', 'hooks'];
function privateThreadPath(home: string, path: string) {
  if (!path.startsWith(home + '/sessions/') || resolve(path) !== path) return false;
  let existing = path; while (!existsSync(existing) && existing !== home) existing = dirname(existing);
  return realpathSync(existing) === existing;
}

// Match the acknowledged turn, or one exact journalled prompt when its acknowledgement was lost.
export function inspectTurns(turns: any[], turnId: string | null, prompt: string | null, active = false): TurnInspection {
  if (active) return { state: 'active' };
  const matches = turns.filter(turn => turnId ? turn.id === turnId : prompt && (turn.items ?? []).some((item: any) => item.type === 'userMessage' && (item.content ?? []).some((part: any) => part.type === 'text' && part.text === prompt)));
  if (matches.length !== 1) return { state: 'unknown' };
  const turn = matches[0];
  if (turn.itemsView && turn.itemsView !== 'full') return { state: 'unknown' };
  if (turn.status === 'failed' || turn.status === 'interrupted') return { state: 'ended', turnId: turn.id };
  if (turn.status !== 'completed') return { state: 'active', turnId: turn.id };
  const messages = (turn.items ?? []).filter((item: any) => item.type === 'agentMessage');
  const final = messages.filter((item: any) => item.phase === 'final_answer');
  const text = (final.length ? final : messages.filter((item: any) => item.phase == null).slice(-1)).map((item: any) => item.text ?? '').join('\n\n').trim();
  return { state: 'completed', turnId: turn.id, text };
}

export function quotaWindows(limits: any): QuotaWindow[] {
  const buckets = limits?.rateLimitsByLimitId ? Object.values(limits.rateLimitsByLimitId) : [limits?.rateLimits];
  return buckets.flatMap((bucket: any) => [bucket?.primary, bucket?.secondary]).filter(window => window && Number.isFinite(window.usedPercent)).map(window => ({ usedPercent: window.usedPercent, windowDurationMins: Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null, resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null }));
}

export class CodexManager implements ManagerProvider {
  closingChildren = new Set<ChildProcessWithoutNullStreams>();
  guardStorage = () => {};
  legacyThreads = new Set<string>();
  legacyReader: CodexManager | null = null;
  isolated: boolean;
  child: ChildProcessWithoutNullStreams | null = null;
  pending = new Map<number, Pending>();
  turns = new Map<string, Turn>();
  sequence = 0;
  pendingTurnEvents: any[] | null = null;
  connection: Connection = { status: 'offline', quota: [], model: null, error: null };
  stateDir: string;
  command?: string;
  extraArgs: string[];
  mcpOverrides: Record<string, unknown> = {};
  constructor(stateDir: string, command?: string, extraArgs: string[] = [], isolated = true) { this.stateDir = stateDir; this.command = command; this.extraArgs = extraArgs; this.isolated = isolated; }
  setStorageGuard(guard: () => void, legacyThreads: string[]) { this.guardStorage = guard; this.legacyThreads = new Set(legacyThreads); }
  featurePolicy(): Record<string, boolean> { return Object.fromEntries(DISABLED_FEATURES.map(name => [name, false])); }
  launchArgs(): string[] {
    return this.extraArgs.length ? this.extraArgs : [
      '-c', `sqlite_home=${JSON.stringify(join(this.stateDir, 'codex'))}`, '-c', `log_dir=${JSON.stringify(join(this.stateDir, 'codex-logs'))}`,
      '-c', 'history.persistence="none"', '-c', 'model_provider="openai"', '-c', 'web_search="disabled"', ...Object.entries(this.featurePolicy()).flatMap(([name, enabled]) => [enabled ? '--enable' : '--disable', name]), 'app-server', '--listen', 'stdio://',
    ];
  }
  serverRequest(message: any) {
    this.child?.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Tools and approvals are disabled in manager chat.' } }) + '\n');
    this.abort('tool_request_blocked');
  }
  allowsItem(type: string, _turnId: string) { return ['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(type); }
  abort(code: string) {
    const error = new AppError(code, 503);
    this.connection = { ...this.connection, status: 'unavailable', error: code };
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    for (const item of this.turns.values()) { if (item.timer) clearTimeout(item.timer); item.reject?.(error); }
    this.turns.clear(); this.pendingTurnEvents = null;
    if (this.child) { const child = this.child; if (child.exitCode === null && child.signalCode === null) { this.closingChildren.add(child); child.once('exit', () => this.closingChildren.delete(child)); child.kill(); } this.child = null; }
  }
  request(method: string, params: unknown = {}, beforeWrite?: () => void): Promise<any> {
    if (!this.isolated && !['initialize', 'config/read', 'account/read', 'account/rateLimits/read', 'thread/read', 'thread/turns/list', 'thread/items/list'].includes(method)) return Promise.reject(new AppError('storage_legacy_readonly', 409));
    if (!this.child) return Promise.reject(new AppError('codex_unavailable', 503));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      beforeWrite?.();
      const timeout = method === 'command/exec' ? Math.min(45000, Number((params as any)?.timeoutMs) || 30000) + 5000 : 20000;
      const timer = setTimeout(() => this.abort('provider_timeout'), timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async connect() {
    if (!this.child) {
      await mkdir(join(this.stateDir, 'manager'), { recursive: true, mode: 0o700 });
      const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
      let command = this.command ?? process.env.PROJECT_TEAM_CODEX_BIN ?? 'codex';
      if (!this.command && !process.env.PROJECT_TEAM_CODEX_BIN) try { await access(bundled, constants.X_OK); command = bundled; } catch { /* use PATH */ }
      const env = { ...process.env };
      if (this.isolated) env.CODEX_HOME = await prepareNativeHome(this.stateDir, !this.extraArgs.length);
      for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'CODEX_MODEL_PROVIDER', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[key];
      const args = this.launchArgs();
      const child = spawn(command, args, { cwd: join(this.stateDir, 'manager'), env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.on('error', () => this.abort('codex_unavailable'));
      child.stdin.on('error', () => this.abort('provider_closed'));
      child.on('exit', () => { if (this.child === child) this.abort('provider_closed'); });
      child.stderr.on('data', chunk => { if (/^Error:.*(?:Operation not permitted|Permission denied)/im.test(String(chunk))) this.abort('permission_denied'); });
      createInterface({ input: child.stdout }).on('line', line => this.receive(line));
      await this.request('initialize', { clientInfo: { name: 'project_team', title: 'Project Team', version: '0.2.0' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      const config = await this.request('config/read', { includeLayers: false });
      const features = config?.config?.features ?? {};
      // Fail closed if inherited tool configuration did not accept the text-only overrides.
      for (const [name, enabled] of Object.entries(this.featurePolicy())) if (features[name] !== enabled) { this.abort('tool_configuration_unverified'); throw new AppError('tool_configuration_unverified', 503); }
      this.mcpOverrides = {};
      for (const name of Object.keys(config?.config?.mcp_servers ?? {})) this.mcpOverrides[`mcp_servers.${name}.enabled`] = false;
    }
    const account = (await this.request('account/read', { refreshToken: false }))?.account;
    const status = !account ? 'sign_in_required' : account.type === 'chatgpt' ? 'ready' : 'wrong_authentication';
    let quota: QuotaWindow[] = [];
    if (status === 'ready') try { quota = quotaWindows(await this.request('account/rateLimits/read')); } catch (error) { if (!this.child) throw error; /* quota unknown */ }
    this.connection = { status, quota, model: this.connection.model, error: null };
    return this.connection;
  }
  receive(line: string) {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      message.error ? pending.reject(new AppError('provider_request_rejected', 503)) : pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined) {
      this.serverRequest(message); return;
    }
    const params = message.params ?? {};
    const turnId = params.turnId ?? params.turn?.id;
    if (!turnId) return;
    if (message.method === 'item/started' && !this.allowsItem(params.item?.type, turnId)) { this.abort('tool_activity_blocked'); return; }
    const turn = this.turns.get(turnId);
    if (!turn) {
      // A start acknowledgement identifies the new turn. Unknown older turns never inherit its listener.
      if (this.pendingTurnEvents) {
        if (this.pendingTurnEvents.length >= 256) { this.abort('provider_event_overflow'); return; }
        this.pendingTurnEvents.push(message);
      }
      return;
    }
    if (message.method === 'item/agentMessage/delta') {
      turn.texts.set(params.itemId, (turn.texts.get(params.itemId) ?? '') + (params.delta ?? ''));
      turn.listener({ kind: 'text', turnId, text: [...turn.texts.values()].join('\n\n') });
    }
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
      turn.texts.set(params.item.id, params.item.text ?? '');
      turn.listener({ kind: 'text', turnId, text: [...turn.texts.values()].join('\n\n') });
    }
    if (message.method === 'thread/tokenUsage/updated') turn.listener({ kind: 'usage', turnId, total: params.tokenUsage?.total?.totalTokens });
    if (message.method === 'turn/completed') { turn.done = params.turn; this.resolveTurn(turnId); }
  }
  resolveTurn(id: string) {
    const turn = this.turns.get(id)!;
    if (!turn.done || !turn.resolve) return;
    if (turn.timer) clearTimeout(turn.timer);
    if (turn.done.status !== 'completed') { turn.reject?.(new AppError('provider_turn_failed', 503)); return; }
    const messages = (turn.done.items ?? []).filter((item: any) => item.type === 'agentMessage');
    const final = messages.filter((item: any) => item.phase === 'final_answer');
    const items = final.length ? final : messages.filter((item: any) => item.phase == null);
    const text = (items.length ? items.map((item: any) => item.text) : [...turn.texts.values()]).join('\n\n').trim();
    if (!text) { turn.reject?.(new AppError('empty_reply', 503)); return; }
    turn.resolve({ text, turnId: id });
  }
  async chat(threadId: string | null, prompt: string, onThread: (id: string) => void, onTurn: (id: string) => void, onEvent: (event: ProviderEvent) => void, onDispatchAttempt?: () => void) {
    this.guardStorage();
    const connection = await this.connect();
    if (connection.status !== 'ready') throw new AppError(connection.status, 409);
    if (connection.quota.some(window => window.usedPercent >= 100)) throw new AppError('quota_exhausted', 409);
    const params = { modelProvider: 'openai', approvalPolicy: 'never', sandbox: 'read-only', cwd: join(this.stateDir, 'manager'), config: this.mcpOverrides };
    const instructions = 'You are the Project Manager in Project Team. Discuss goals, propose plans and explain tradeoffs using the supplied saved state. Ordinary chat is discussion; work proposals and revisions use separate structured coordinator actions. You cannot execute work, inspect live files, use tools, browse, hire agents, approve plans or milestones, resolve conflicts, or change credits. Never treat discussion as approval. Do not invent teammates, completed work, outputs, quota or approvals. The user chooses hires and settles conflicts. Keep answers practical and concise.';
    const opened = threadId ? await this.request('thread/resume', { ...params, threadId, developerInstructions: instructions }) : await this.request('thread/start', { ...params, ephemeral: false, developerInstructions: instructions });
    await this.rememberThread(opened.thread);
    if (!opened.thread?.id || opened.modelProvider !== 'openai') throw new AppError('unexpected_provider', 503);
    this.connection.model = opened.model ?? null;
    onThread(opened.thread.id);
    const result = await this.dispatch({ threadId: opened.thread.id, input: [{ type: 'text', text: prompt }], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } }, onTurn, onEvent, onDispatchAttempt);
    return { ...result, connection: { ...this.connection } };
  }
  async inspect(threadId: string, turnId: string | null, prompt: string | null, _worker = false): Promise<TurnInspection> {
    if (this.legacyThreads.has(threadId)) {
      this.legacyReader ??= new CodexManager(this.stateDir, this.command, this.extraArgs, false);
      return this.legacyReader.inspect(threadId, turnId, prompt);
    }
    try { if ((await this.connect()).status !== 'ready') return { state: 'unknown' }; return await this.readTurn(threadId, turnId, prompt); }
    catch { return { state: 'unknown' }; }
  }
  async readTurn(threadId: string, turnId: string | null, prompt: string | null): Promise<TurnInspection> {
    const summary = await this.request('thread/read', { threadId, includeTurns: false });
    if (summary.thread?.id !== threadId) return { state: 'unknown' };
    if (summary.thread.status?.type === 'active') return { state: 'active' };
    const turns: any[] = []; let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await this.request('thread/turns/list', { threadId, limit: 50, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) return { state: 'unknown' };
      turns.push(...result.data); cursor = result.nextCursor;
      if (turnId && turns.some(turn => turn.id === turnId) || !cursor) return inspectTurns(turns, turnId, prompt);
    }
    return { state: 'unknown' };
  }
  async dispatch(params: unknown, onTurn: (id: string) => void, onEvent: (event: ProviderEvent) => void, onDispatchAttempt?: () => void) {
    this.guardStorage();
    this.pendingTurnEvents = [];
    let started: any;
    try { started = await this.request('turn/start', params, onDispatchAttempt); }
    catch (error) { this.pendingTurnEvents = null; throw error; }
    const earlyEvents = this.pendingTurnEvents ?? [];
    this.pendingTurnEvents = null;
    const id = started.turn?.id;
    if (!id) throw new AppError('missing_turn', 503);
    onTurn(id);
    if (!this.turns.has(id)) this.turns.set(id, { texts: new Map(), listener: onEvent });
    const turn = this.turns.get(id)!;
    turn.listener = onEvent;
    for (const event of earlyEvents) if ((event.params?.turnId ?? event.params?.turn?.id) === id) this.receive(JSON.stringify(event));
    if (!this.child) throw new AppError('tool_activity_blocked', 503);
    // Keep recent listeners for late accounting reports without retaining every reply forever.
    for (const [oldId, oldTurn] of this.turns) if (this.turns.size > 32 && oldId !== id && oldTurn.done) this.turns.delete(oldId);
    const result = await new Promise<{ text: string; turnId: string }>((resolve, reject) => {
      turn.resolve = resolve; turn.reject = reject;
      turn.timer = setTimeout(() => this.abort('provider_timeout'), 180000);
      this.resolveTurn(id);
    });
    return result;
  }
  close() { this.legacyReader?.close(); this.abort('provider_stopped'); this.connection = { status: 'offline', quota: [], model: null, error: null }; }
  async closeForStorage() {
    const children = [...new Set([this.child, this.legacyReader?.child, ...this.closingChildren, ...(this.legacyReader?.closingChildren ?? [])])].filter((child): child is ChildProcessWithoutNullStreams => !!child && child.exitCode === null && child.signalCode === null);
    const waits = children.map(child => new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new AppError('storage_native_busy', 409)), 5000); once(child, 'exit').then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); }); }));
    CodexManager.prototype.close.call(this); await Promise.all(waits);
  }
  async cleanupStorage(protectedThreads: Set<string>, before: number, forget: (id: string) => void) {
    const root = existsSync(this.stateDir) ? realpathSync(this.stateDir) : this.stateDir, home = join(root, 'native-home');
    if (!existsSync(home) || !existsSync(join(home, 'sessions')) && !existsSync(join(this.stateDir, 'codex'))) return [];
    if (realpathSync(home) !== home) throw new AppError('storage_path_changed');
    const reader = new CodexManager(root, this.command, this.extraArgs), removed: string[] = [];
    const deadline = setTimeout(() => reader.abort('storage_native_timeout'), 15000);
    try {
      await reader.connect(); let cursor: string | null = null;
      const threads = new Map<string, any>();
      for (const entry of await reader.nativeRegistry()) { try { const result = await reader.request('thread/read', { threadId: entry.id, includeTurns: false }); if (result.thread?.id === entry.id) threads.set(entry.id, result.thread); } catch { /* Missing or unverifiable history remains untouched. */ } }
      for (let page = 0; page < 20; page++) {
        const result = await reader.request('thread/list', { limit: 100, archived: false, sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'], ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result.data)) throw new AppError('storage_native_unavailable');
        for (const thread of result.data) threads.set(thread.id, thread);
        cursor = result.nextCursor; if (!cursor) break;
      }
      if (cursor) throw new AppError('storage_native_unavailable');
      // Deleting a root also deletes its descendants. Protect every ancestor of unresolved work.
      const protectedIds = new Set(protectedThreads);
      for (const thread of threads.values()) if (typeof thread.path !== 'string' || !privateThreadPath(home, thread.path) || typeof thread.updatedAt !== 'number' || thread.updatedAt * 1000 >= before || thread.status?.type === 'active') protectedIds.add(thread.id);
      for (const id of [...protectedIds]) { let current = threads.get(id); const seen = new Set<string>(); while (current && !seen.has(current.id)) { seen.add(current.id); const parent = current.parentThreadId ?? current.forkedFromId; if (!parent) break; protectedIds.add(parent); current = threads.get(parent); } }
      for (const thread of threads.values()) {
          if (typeof thread.id !== 'string' || protectedIds.has(thread.id) || typeof thread.updatedAt !== 'number' || thread.updatedAt * 1000 >= before || thread.status?.type === 'active') continue;
          const path = thread.path;
          // Legacy shared transcripts are never deleted, even if present in this service's SQLite index.
          if (typeof path !== 'string' || !privateThreadPath(home, path)) continue;
          forget(thread.id); await reader.request('thread/delete', { threadId: thread.id }); removed.push(thread.id);
      }
      const kept = (await reader.nativeRegistry()).filter(entry => !removed.includes(entry.id)); await reader.writeNativeRegistry(kept);
      return removed;
    } finally { clearTimeout(deadline); await reader.closeForStorage(); }
  }
  async nativeRegistry(): Promise<{ id: string; path: string }[]> {
    try { const value = JSON.parse(await readFile(join(this.stateDir, 'native-home', 'project-team-threads.json'), 'utf8')); if (!Array.isArray(value) || value.length > 10000 || value.some(v => typeof v.id !== 'string' || typeof v.path !== 'string')) throw new Error(); return value; }
    catch (error: any) { if (error.code === 'ENOENT') return []; throw new AppError('storage_native_unavailable'); }
  }
  async writeNativeRegistry(entries: { id: string; path: string }[]) {
    const home = await realpath(join(this.stateDir, 'native-home')), path = join(home, 'project-team-threads.json'), temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(entries), { mode: 0o600, flag: 'wx' }); await rename(temporary, path);
  }
  async rememberThread(thread: any) {
    if (this.extraArgs.length) return; // Deterministic protocol fixtures never bridge the user's credentials or native history.
    const home = await realpath(join(this.stateDir, 'native-home'));
    if (!thread?.id || typeof thread.path !== 'string' || !privateThreadPath(home, thread.path)) throw new AppError('storage_native_unverified', 503);
    const entries = await this.nativeRegistry();
    if (!entries.some(entry => entry.id === thread.id)) { if (entries.length >= 10000) throw new AppError('app_storage_limit', 409); entries.push({ id: thread.id, path: thread.path }); await this.writeNativeRegistry(entries); }
  }
}

export class DemoManager implements ManagerProvider {
  total = 0;
  constructor(initialTotal = 0) { this.total = initialTotal; }
  async connect(): Promise<Connection> { return { status: 'ready', quota: [], model: 'Demo · no model', error: null }; }
  async chat(threadId: string | null, prompt: string, onThread: (id: string) => void, onTurn: (id: string) => void, onEvent: (event: ProviderEvent) => void) {
    onThread(threadId ?? 'demo-thread'); const turnId = `demo-${Date.now()}`; onTurn(turnId);
    const text = 'This is a demo response, not an AI conversation. Your workspace and messages are saved. Start without --demo to connect your real Codex manager. Demo team tasks produce simulated notes. Team discussion, deliverable reviews and storage controls are available in this demo.';
    for (let index = 1; index <= 6; index++) { await new Promise(resolve => setTimeout(resolve, 70)); onEvent({ kind: 'text', turnId, text: text.slice(0, Math.ceil(text.length * index / 6)) }); }
    this.total += 900; onEvent({ kind: 'usage', turnId, total: this.total });
    return { text, turnId };
  }
  close() {}
}
