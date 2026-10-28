import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { realpathSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Project, Message, Step, Agent, TeamState, Task, RecoveryJournal, RecoveryItem, MeetingState, MeetingConversation, MeetingTurn } from './types.ts';
import { AppError } from './types.ts';

type Table = 'settings' | 'messages' | 'steps' | 'agents' | 'plans' | 'tasks' | 'milestones' | 'outputs' | 'handoffs' | 'reviews' | 'decisions' | 'meetings' | 'meetingMessages' | 'meetingTurns' | 'meetingProposals' | 'conversations' | 'checkpoints';
export class Store {
  guardWork = () => {};
  db: DatabaseSync;
  path: string;
  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.path = realpathSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS steps (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, text TEXT NOT NULL, createdAt TEXT NOT NULL);`);
    for (const table of ['agents', 'plans', 'tasks', 'milestones', 'outputs', 'handoffs', 'reviews', 'decisions', 'meetings', 'meetingMessages', 'meetingTurns', 'meetingProposals', 'conversations', 'checkpoints']) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  read<T>(table: Table, id: string): T | null {
    const row = this.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(String(row.value)) as T : null;
  }
  write(table: Table, id: string, value: unknown) {
    this.db.prepare(`INSERT INTO ${table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(id, JSON.stringify(value));
  }
  all<T>(table: Table): T[] { return this.db.prepare(`SELECT value FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(String(row.value)) as T); }
  team(): TeamState { const agentCredits: Record<string, number> = {}; for (const step of this.steps()) { const id = step.agentId ?? 'manager'; agentCredits[id] = (agentCredits[id] ?? 0) + step.used / 1000; } return { models: [], agents: this.all('agents'), plans: this.all('plans'), tasks: this.all('tasks'), milestones: this.all('milestones'), outputs: this.all('outputs'), handoffs: this.all('handoffs'), reviews: this.all('reviews'), decisions: this.all('decisions'), activeTask: this.all<Task>('tasks').find(task => task.status === 'running')?.id ?? null, agentCredits, waitingReason: null }; }
  once(id: string, fn: () => void) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new AppError('invalid_command');
    return this.transaction(() => { if (this.read('settings', `command:${id}`)) return false; fn(); this.write('settings', `command:${id}`, true); return true; });
  }
  project() { return this.read<Project>('settings', 'project'); }
  saveProject(project: Project) { this.write('settings', 'project', project); }
  messages() { return this.all<Message>('messages'); }
  steps() { return this.all<Step>('steps'); }
  meetings(): MeetingState {
    const turns = this.all<MeetingTurn>('meetingTurns'), credits: MeetingState['credits'] = {}, owners = new Map(turns.map(turn => [turn.id, turn.meetingId]));
    for (const step of this.steps()) if (step.meetingTurnId) { const room = owners.get(step.meetingTurnId)!; const total = credits[room] ??= { used: 0, reserved: 0, estimated: 0 }; total.used += step.used / 1000; if (['reserved', 'dispatched'].includes(step.status)) total.reserved += step.reserved / 1000; if (step.estimated) total.estimated += step.used / 1000; }
    return { rooms: this.all('meetings'), messages: this.all('meetingMessages'), turns, proposals: this.all('meetingProposals'), credits, waitingReason: null };
  }
  journal(id: string): RecoveryJournal { return this.read<RecoveryJournal>('settings', `recovery:${id}`) ?? {}; }
  checkpoint(id: string, update: Partial<RecoveryJournal>) { this.write('settings', `recovery:${id}`, { ...this.journal(id), ...update }); }
  recovery(): RecoveryItem[] {
    return this.steps().filter(step => ['failed', 'interrupted'].includes(step.status) || this.journal(step.id).state === 'recovered').map(step => {
      const journal = this.journal(step.id), task = step.taskId ? this.read<Task>('tasks', step.taskId) : null;
      return { id: step.id, kind: step.kind ?? 'chat', title: task?.title ?? (step.meetingTurnId ? 'Meeting response' : step.kind === 'plan' ? 'Manager plan' : step.kind === 'revision' ? 'Manager revision' : 'Manager conversation'), state: journal.state ?? 'unknown', summary: journal.summary ?? 'Check the saved turn before deciding what to do.', result: journal.result?.text ?? null, outputs: journal.outputs ?? [], afterCrash: journal.afterCrash ?? false, used: step.used / 1000, estimated: step.estimated };
    });
  }
  recoveryPending() { return this.recovery().some(item => !['recovered', 'retry', 'kept'].includes(item.state)); }
  log(text: string) { this.db.prepare('INSERT INTO activity(text,createdAt) VALUES (?,?)').run(text, new Date().toISOString()); }
  activity() { return this.db.prepare('SELECT text,createdAt FROM activity ORDER BY id DESC LIMIT 20').all() as { text: string; createdAt: string }[]; }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  balance() {
    const steps = this.steps();
    const used = steps.reduce((sum, step) => sum + step.used, 0);
    const reserved = steps.reduce((sum, step) => sum + (['reserved', 'dispatched'].includes(step.status) ? step.reserved : 0), 0);
    const estimated = steps.reduce((sum, step) => sum + (step.estimated ? step.used : 0), 0);
    return { used: used / 1000, reserved: reserved / 1000, estimated: estimated / 1000, available: (this.project()?.credits ?? 0) - (used + reserved) / 1000 };
  }
  begin(id: string, text: string, attachment: string | null, estimate: number): Step {
    if (!this.read('steps', id)) this.guardWork();
    return this.transaction(() => {
      const existing = this.read<Step>('steps', id);
      if (existing) return existing;
      const project = this.project();
      if (!project || project.mode !== 'running') throw new AppError('project_paused', 409);
      if (this.steps().some(step => ['reserved', 'dispatched'].includes(step.status))) throw new AppError('manager_busy', 409);
      const reserved = Math.ceil(estimate * 1.2);
      if (reserved / 1000 > this.balance().available) throw new AppError('credit_limit', 409);
      const messageId = randomUUID();
      const step: Step = { id, messageId, turnId: null, threadId: project.threadId, baseline: project.lastTotal, reserved, used: 0, estimated: false, dispatchAttempted: false, status: 'reserved' };
      this.write('messages', messageId, { id: messageId, role: 'user', text, attachment, status: 'pending', createdAt: new Date().toISOString() });
      this.write('steps', id, step);
      return step;
    });
  }
  beginTask(id: string, task: Task, agent: Agent): Step {
    if (!this.read('steps', id)) this.guardWork();
    return this.transaction(() => {
      const existing = this.read<Step>('steps', id); if (existing) return existing;
      if (this.project()?.mode !== 'running') throw new AppError('project_paused', 409);
      if (this.steps().some(step => ['reserved', 'dispatched'].includes(step.status))) throw new AppError('manager_busy', 409);
      const reserved = Math.ceil(task.estimateTokens * 1.2);
      if (reserved / 1000 > this.balance().available) throw new AppError('credit_limit', 409);
      const step: Step = { id, messageId: null, agentId: agent.id, taskId: task.id, kind: 'task', threadId: agent.threadId, turnId: null, baseline: agent.lastTotal, reserved, used: 0, estimated: false, dispatchAttempted: false, status: 'reserved' };
      this.write('steps', id, step); this.write('tasks', task.id, { ...task, status: 'running' }); return step;
    });
  }
  dispatchAttempted(id: string) { const step = this.read<Step>('steps', id)!; this.write('steps', id, { ...step, status: 'dispatched', dispatchAttempted: true }); }
  beginMeeting(turn: MeetingTurn, conversation: MeetingConversation, estimate: number) {
    this.guardWork();
    return this.transaction(() => {
      if (this.project()?.mode !== 'running') throw new AppError('project_paused', 409);
      if (this.steps().some(step => ['reserved', 'dispatched'].includes(step.status))) throw new AppError('manager_busy', 409);
      const reserved = Math.ceil(estimate * 1.2);
      if (reserved / 1000 > this.balance().available) throw new AppError('credit_limit', 409);
      if (this.read('steps', turn.id)) throw new AppError('invalid_command');
      const step: Step = { id: turn.id, messageId: null, meetingTurnId: turn.id, conversationId: conversation.id, ...(turn.speakerId === 'manager' ? {} : { agentId: turn.speakerId }), kind: turn.kind, threadId: conversation.threadId, turnId: null, baseline: conversation.lastTotal, reserved, used: 0, estimated: false, dispatchAttempted: false, status: 'reserved' };
      this.write('steps', step.id, step); this.write('conversations', conversation.id, conversation); this.write('meetingTurns', turn.id, { ...turn, status: 'running' }); return step;
    });
  }
  dispatched(id: string, turnId: string) { const step = this.read<Step>('steps', id)!; this.write('steps', id, { ...step, status: 'dispatched', dispatchAttempted: true, turnId }); }
  thread(id: string, threadId: string) {
    const step = this.read<Step>('steps', id)!;
    if (step.conversationId) {
      const conversation = this.read<MeetingConversation>('conversations', step.conversationId)!;
      const changed = conversation.threadId !== threadId;
      this.write('steps', id, { ...step, threadId, baseline: changed ? 0 : step.baseline });
      this.write('conversations', conversation.id, { ...conversation, threadId, lastTotal: changed ? 0 : conversation.lastTotal }); return;
    }
    if (step.agentId) {
      const agent = this.read<Agent>('agents', step.agentId)!;
      const changed = agent.threadId !== threadId;
      this.write('steps', id, { ...step, threadId, baseline: changed ? 0 : step.baseline });
      this.write('agents', agent.id, { ...agent, threadId, lastTotal: changed ? 0 : agent.lastTotal }); return;
    }
    const project = this.project()!;
    const changed = project.threadId !== threadId;
    this.write('steps', id, { ...step, threadId, baseline: changed ? 0 : step.baseline });
    this.saveProject({ ...project, threadId, lastTotal: changed ? 0 : project.lastTotal });
  }
  usage(id: string, total: number) {
    if (!Number.isSafeInteger(total) || total < 0) return;
    this.transaction(() => {
      const step = this.read<Step>('steps', id);
      if (!step || !step.turnId) return;
      // The same cumulative report is replaced, never summed. Late reports correct estimates.
      if (total < step.baseline) return;
      const priorTotal = this.read<number>('settings', `total:${id}`) ?? 0;
      this.write('settings', `total:${id}`, Math.max(priorTotal, total));
      const siblings = step.threadId ? this.steps().filter(other => other.threadId === step.threadId) : [step];
      let baseline = siblings[0]?.baseline ?? 0;
      for (const sibling of siblings) {
        const reported = this.read<number>('settings', `total:${sibling.id}`);
        const next = reported === null ? null : Math.max(0, reported - baseline);
        if (next !== null) this.write('settings', `usage:${sibling.id}`, next);
        this.write('steps', sibling.id, { ...sibling, baseline, ...(next !== null && !['reserved', 'dispatched'].includes(sibling.status) ? { used: next, estimated: false } : {}) });
        if (reported !== null) baseline = Math.max(baseline, reported);
      }
      const project = this.project()!;
      if (step.conversationId) { const conversation = this.read<MeetingConversation>('conversations', step.conversationId)!; if (conversation.threadId === step.threadId) this.write('conversations', conversation.id, { ...conversation, lastTotal: Math.max(conversation.lastTotal, total) }); }
      else {
        if (step.threadId === project.threadId) this.saveProject({ ...project, lastTotal: Math.max(project.lastTotal, total) });
        if (step.agentId) { const agent = this.read<Agent>('agents', step.agentId); if (agent?.threadId === step.threadId) this.write('agents', agent.id, { ...agent, lastTotal: Math.max(agent.lastTotal, total) }); }
      }
    });
  }
  finish(id: string, status: 'complete' | 'failed' | 'interrupted', reply?: string, commit?: () => void, providerCompleted = false, reconcile = false) {
    this.transaction(() => {
      const step = this.read<Step>('steps', id)!;
      if (!['reserved', 'dispatched'].includes(step.status) && !(reconcile && ['failed', 'interrupted'].includes(step.status))) return;
      const actual = this.read<number>('settings', `usage:${id}`);
      const dispatched = step.status === 'dispatched' || step.dispatchAttempted === true || !!step.turnId;
      const estimated = dispatched && (actual === null || status !== 'complete' && !providerCompleted);
      const used = estimated ? Math.max(actual ?? 0, step.reserved) : actual ?? 0;
      this.write('steps', id, { ...step, status, used, estimated });
      if (step.messageId) {
        const message = this.read<Message>('messages', step.messageId)!;
        this.write('messages', message.id, { ...message, status: status === 'complete' ? 'complete' : status });
        if (reply && !this.read<Message>('messages', `reply:${id}`)) this.write('messages', `reply:${id}`, { id: `reply:${id}`, role: 'assistant', text: reply, status: 'complete', attachment: null, createdAt: new Date().toISOString() });
      }
      commit?.();
    });
  }
  recover() {
    const project = this.project();
    if (!project) return;
    const interrupted = this.steps().filter(step => ['reserved', 'dispatched'].includes(step.status));
    for (const step of interrupted) {
      this.write('steps', step.id, { ...step, dispatchAttempted: step.status === 'dispatched' });
      this.finish(step.id, 'interrupted');
      if (step.taskId && step.kind === 'task') { const task = this.read<Task>('tasks', step.taskId); if (task) this.write('tasks', task.id, { ...task, status: 'interrupted', summary: 'Interrupted work needs reconciliation; it was not retried.' }); }
      if (step.conversationId) { const conversation = this.read<MeetingConversation>('conversations', step.conversationId); if (conversation) this.write('conversations', conversation.id, { ...conversation, threadId: null, lastTotal: 0 }); }
      else if (step.agentId) { const agent = this.read<Agent>('agents', step.agentId); if (agent) this.write('agents', agent.id, { ...agent, threadId: null, lastTotal: 0 }); }
      if (step.meetingTurnId) { const turn = this.read<MeetingTurn>('meetingTurns', step.meetingTurnId); if (turn) this.write('meetingTurns', turn.id, { ...turn, status: 'interrupted' }); }
    }
    if (project.mode === 'running' || interrupted.length) {
      this.saveProject({ ...this.project()!, mode: 'recovery', ...(interrupted.length ? { threadId: null, lastTotal: 0 } : {}) });
      this.log('Saved project restored. Review the interrupted conversation and resume explicitly; no message was retried.');
    }
  }
  pruneRunData() {
    return this.transaction(() => {
      const completed = this.steps().filter(step => step.status === 'complete').slice(0, -20); let removed = 0;
      for (const step of completed) {
        if (this.journal(step.id).state === 'recovered') continue;
        removed += Number(this.db.prepare('DELETE FROM settings WHERE id=?').run(`recovery:${step.id}`).changes);
      }
      removed += Number(this.db.prepare('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 500)').run().changes);
      return removed;
    });
  }
  compact() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const free = Number(this.db.prepare('PRAGMA freelist_count').get()?.freelist_count), pages = Number(this.db.prepare('PRAGMA page_count').get()?.page_count), size = Number(this.db.prepare('PRAGMA page_size').get()?.page_size);
    if (this.path !== ':memory:' && free > pages / 4) { const disk = statfsSync(dirname(this.path)); if (disk.bavail * disk.bsize > pages * size * 2 + 16777216) this.db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)'); }
  }
  close() { this.db.close(); }
}
