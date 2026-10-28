import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Store } from './store.ts';
import type { ManagerProvider, Snapshot, Step, RecoveryJournal, Message } from './types.ts';
import { AppError } from './types.ts';
import { Storage } from './storage.ts';

export class Coordinator extends EventEmitter {
  store: Store;
  provider: ManagerProvider;
  demo: boolean;
  busy = false;
  stopping = false;
  draft = '';
  connection: Snapshot['connection'] = { status: 'offline', quota: [], model: null, error: null };
  active: Promise<void> | null = null;
  connecting: Promise<void> | null = null;
  instanceId = randomUUID();
  snapshotSequence = 0;
  storage: Storage;
  constructor(store: Store, provider: ManagerProvider, demo = false) { super(); this.store = store; this.provider = provider; this.demo = demo; store.recover(); this.storage = new Storage(store); store.guardWork = () => this.guardStorage(); provider.setStorageGuard?.(() => this.guardStorage(), this.storage.migrateLegacyThreads()); this.storage.refresh(); }
  snapshot(): Snapshot & { draft: string } { return { revision: { instanceId: this.instanceId, sequence: ++this.snapshotSequence }, storage: { ...this.storage.current, cleaning: this.storage.cleaning }, project: this.store.project(), messages: this.store.messages(), credits: this.store.balance(), connection: this.connection, busy: this.busy, stopping: this.stopping, demo: this.demo, activity: this.store.activity(), draft: this.draft, team: this.store.team(), recovery: this.store.recovery(), meetings: this.store.meetings(), checkpoints: this.store.all('checkpoints') }; }
  guardStorage() {
    try { this.storage.assertCapacity(); }
    catch (error) { this.pauseForStorage(); throw error; }
  }
  pauseForStorage() { const project = this.store.project(); if (project?.mode === 'running') { this.store.saveProject({ ...project, mode: 'paused' }); this.store.log('Storage needs attention. New work is paused; saved work remains protected.'); this.publish(); } }
  checkStorage() { const usage = this.storage.refresh(); if (usage.status === 'blocked' || usage.status === 'unavailable') this.pauseForStorage(); this.publish(); }
  storageWorkActive() { return false; }
  saveStoragePolicy(input: Parameters<Storage['savePolicy']>[0]) { if (this.busy || this.connecting || this.stopping || this.storageWorkActive()) throw new AppError('storage_busy', 409); this.storage.savePolicy(input); this.checkStorage(); }
  async cleanupStorage(automatic = false) {
    if (this.busy || this.connecting || this.storageWorkActive() || this.stopping && !automatic) throw new AppError('storage_busy', 409);
    const usage = this.storage.refresh(), pressure = usage.reason === 'app_storage_limit' || usage.reason === 'disk_space_low';
    const project = this.store.project(); if (project?.mode === 'running') this.store.saveProject({ ...project, mode: 'paused' });
    this.busy = true; this.storage.cleaning = true; this.publish();
    this.active = (async () => {
      try {
        if (this.provider.closeForStorage) await this.provider.closeForStorage(); else this.provider.close();
        this.connection = { status: 'offline', quota: [], model: null, error: null };
        const before = pressure ? Date.now() + 1 : Date.now() - usage.policy.retentionDays * 86400000;
        let removed: string[] = [], warning: string | undefined;
        try { removed = await this.provider.cleanupStorage?.(this.storage.protectedThreads(), before, id => this.storage.forgetThread(id)) ?? []; }
        catch { warning = 'storage_native_unavailable'; }
        const result = { ...this.storage.cleanupFiles(Date.now(), pressure), nativeThreads: removed.length, ...(warning ? { warning } : {}) };
        this.store.write('settings', 'storage:last-cleanup', result); this.storage.current.lastCleanup = result;
      } finally { this.storage.cleaning = false; this.busy = false; this.active = null; this.storage.refresh(); this.publish(); }
    })();
    await this.active;
  }
  afterIdle() { queueMicrotask(() => this.retryPending()); }
  retryPending() {
    if (this.busy || this.stopping || this.connection.status !== 'ready' || this.store.project()?.mode !== 'running' || this.store.recoveryPending()) return false;
    const step = this.store.steps().find(step => step.kind !== 'task' && !step.meetingTurnId && this.store.journal(step.id).state === 'retry' && !this.store.read('steps', this.store.journal(step.id).retryId!));
    if (!step) return false;
    try { this.runRetry(step, this.store.journal(step.id).retryId!); }
    catch (error) { this.store.saveProject({ ...this.store.project()!, mode: 'recovery' }); this.store.log(`Queued retry needs attention (${error instanceof AppError ? error.code : 'retry_failed'}).`); this.publish(); }
    return true;
  }
  runRetry(step: Step, id: string) {
    const message = this.store.read<Message>('messages', step.messageId!)!;
    this.send(id, message.text, message.attachment);
  }
  async prepareRecovery(_step: Step, journal: RecoveryJournal): Promise<Partial<RecoveryJournal>> {
    if (!journal.result?.text.trim()) throw new AppError('empty_reply');
    return { outputs: [], captured: true, summary: 'The manager finished. Restore the saved response without sending it again.' };
  }
  recoveryCommit(_step: Step, journal: RecoveryJournal) { return { reply: journal.result!.text, apply: () => {} }; }
  async validateRecovery(_journal: RecoveryJournal) {}
  retryWork(_step: Step, _retryId: string) {}
  async inspectRecovery(step: Step) {
    const journal = this.store.journal(step.id);
    if (step.dispatchAttempted === false) { this.store.checkpoint(step.id, { state: 'ended', summary: 'This attempt was reserved but never dispatched. You can queue a retry or keep it stopped.' }); return; }
    if (!step.threadId || !this.provider.inspect) { this.store.checkpoint(step.id, { state: 'unknown', summary: 'The saved turn cannot be verified. A missing response does not prove failed work. Retry is blocked.' }); return; }
    const inspection = await this.provider.inspect(step.threadId, step.turnId, journal.prompt ?? null, step.kind === 'task');
    if (inspection.state === 'unknown' || inspection.state === 'active') {
      this.store.checkpoint(step.id, { state: inspection.state, summary: inspection.state === 'active' ? 'The saved turn is still active or has no terminal record. Check again after it ends; retry is blocked.' : 'No unique terminal turn could be verified. Check again; retry is blocked.' }); return;
    }
    if (inspection.turnId && !step.turnId) this.store.write('steps', step.id, { ...step, turnId: inspection.turnId });
    if (inspection.state === 'ended') { this.store.checkpoint(step.id, { state: 'ended', summary: 'Codex recorded this attempt as ended without a completed result. Existing files may contain partial work. A retry is your choice.' }); return; }
    this.store.checkpoint(step.id, { result: journal.result ?? { text: inspection.text ?? '', turnId: inspection.turnId! } });
    try {
      const prepared = await this.prepareRecovery(step, this.store.journal(step.id));
      this.store.checkpoint(step.id, { ...prepared, state: 'ready' });
    } catch (error) {
      this.store.checkpoint(step.id, { state: 'ended', summary: `Codex completed the turn, but its result or outputs could not be restored (${error instanceof AppError ? error.code : 'recovery_unavailable'}). Review partial files before choosing a retry.` });
    }
  }
  async recoverStep(input: { id: string; stepId: string; action: 'check' | 'restore' | 'retry' | 'keep'; outputIds?: string[] }) {
    if (typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(input.id) || !['check', 'restore', 'retry', 'keep'].includes(input.action)) throw new AppError('invalid_command');
    if (this.store.read('settings', `command:${input.id}`)) return;
    if (this.busy || this.stopping) throw new AppError('manager_busy', 409);
    const step = this.store.read<Step>('steps', input.stepId);
    if (!step || !['failed', 'interrupted'].includes(step.status)) throw new AppError('stale_recovery', 409);
    const priorState = this.store.journal(step.id).state;
    if (priorState === 'retry' || priorState === 'recovered' || priorState === 'kept' && input.action !== 'check') throw new AppError('stale_recovery', 409);
    if (this.connection.status !== 'ready') throw new AppError('connect_first', 409);
    if (this.store.project()?.mode === 'running') throw new AppError('pause_for_recovery', 409);
    this.busy = true; this.publish();
    this.active = (async () => {
      try {
        if (input.action === 'check' || input.action === 'retry' || input.action === 'keep') await this.inspectRecovery(step);
        const journal = this.store.journal(step.id);
        if (input.action === 'restore') {
          if (journal.state !== 'ready' || !journal.captured || !Array.isArray(input.outputIds) || [...input.outputIds].sort().join('|') !== (journal.outputs ?? []).map(output => output.id).sort().join('|')) throw new AppError('stale_recovery', 409);
          await this.validateRecovery(journal);
          const changes = this.recoveryCommit(step, journal);
          this.store.finish(step.id, 'complete', changes.reply, () => { changes.apply(); this.store.checkpoint(step.id, { state: 'recovered', summary: 'Completed work restored. Nothing was sent again. Resume explicitly when ready.' }); this.store.write('settings', `command:${input.id}`, true); }, true, true);
        } else {
          if (input.action !== 'check' && !['ended', 'ready'].includes(journal.state ?? '')) throw new AppError('recovery_unverified', 409);
          this.store.once(input.id, () => {
            if (input.action === 'retry') {
              const retryId = randomUUID();
              this.retryWork(step, retryId);
              this.store.checkpoint(step.id, { state: 'retry', retryId, summary: 'You queued one retry. It will start only after Resume and available credits/quota.' });
            } else if (input.action === 'keep') this.store.checkpoint(step.id, { state: 'kept', summary: 'You kept this attempt stopped. Dependent tasks remain blocked; other approved work can resume.' });
          });
        }
        this.store.log(`Recovery decision saved: ${input.action}. No automatic replay.`);
      } finally { this.busy = false; this.active = null; this.publish(); }
    })();
    await this.active;
  }
  validAttachment(attachment: string | null): boolean { return attachment === null || attachment === 'brief'; }
  async attachmentContext(_attachment: string | null) { return ''; }
  publish() { this.emit('state', this.snapshot()); }
  async configure(input: { name: string; brief: string; folder: string; credits: number }) {
    if (this.busy || this.stopping) throw new AppError('manager_busy', 409);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || typeof input.brief !== 'string' || input.brief.length > 8000 || typeof input.folder !== 'string' || !Number.isFinite(input.credits) || input.credits < 1 || input.credits > 1_000_000) throw new AppError('invalid_project');
    let folder: string;
    try { folder = await realpath(input.folder); if (!(await stat(folder)).isDirectory()) throw new Error(); } catch { throw new AppError('folder_unavailable'); }
    const existing = this.store.project();
    if (existing && folder !== existing.folder && this.store.recoveryPending()) throw new AppError('project_folder_locked', 409);
    this.store.saveProject({ name: input.name.trim(), brief: input.brief.trim(), folder, credits: input.credits, mode: existing?.mode ?? 'paused', threadId: existing?.threadId ?? null, lastTotal: existing?.lastTotal ?? 0 });
    this.storage.refresh();
    this.store.log(existing ? 'Project settings saved.' : 'Project created. Start the manager connection to discuss your plan.'); this.publish();
  }
  async connect() {
    if (this.stopping || this.busy) throw new AppError('manager_busy', 409);
    if (this.connecting) return this.connecting;
    this.connection = { ...this.connection, status: 'connecting', error: null }; this.publish();
    this.connecting = (async () => {
      try {
        if (this.store.project() && this.provider.configureProject) await this.provider.configureProject(this.store.project()!.folder);
        this.connection = await this.provider.connect();
        this.store.log(this.connection.status === 'ready' ? this.demo ? 'Demo connection started. No AI provider is used.' : 'Codex subscription connection started.' : 'Connection needs attention.');
      } catch (error) { this.connection = { ...this.connection, status: 'unavailable', error: error instanceof AppError ? error.code : 'codex_unavailable' }; }
      finally { this.connecting = null; this.publish(); }
    })();
    return this.connecting;
  }
  mode(mode: 'running' | 'paused') {
    const project = this.store.project(); if (!project) throw new AppError('project_required');
    if (this.stopping) throw new AppError('coordinator_stopping', 409);
    if (mode === 'running' && this.connection.status !== 'ready') throw new AppError('connect_first', 409);
    if (mode === 'running') this.guardStorage();
    if (mode === 'running' && (this.busy && project.mode !== 'running' || this.store.recoveryPending())) throw new AppError('recovery_required', 409);
    this.store.saveProject({ ...project, mode });
    this.store.log(mode === 'running' ? 'Project resumed. Manager conversation enabled.' : 'Project paused. Any current response will finish and save.'); this.publish();
    this.afterIdle();
  }
  send(id: string, text: string, attachment: string | null) {
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(id) || typeof text !== 'string' || !text.trim() || text.length > 8000 || !this.validAttachment(attachment)) throw new AppError('invalid_message');
    if (this.store.read<Step>('steps', id)) return; // client retry: no second inference
    if (this.busy || this.stopping) throw new AppError('manager_busy', 409);
    if (this.connection.status !== 'ready') throw new AppError('connect_first', 409);
    if (this.connection.quota.some(window => window.usedPercent >= 100)) throw new AppError('quota_exhausted', 409);
    const project = this.store.project(); if (!project) throw new AppError('project_required');
    const history = this.store.messages().filter(message => message.status === 'complete');
    // The estimate is approximate and includes a response allowance; it is not a provider limit.
    const context = history.map(message => `${message.role}: ${message.text}`).join('\n');
    const estimate = Math.max(1200, Math.ceil((context.length + text.length + project.brief.length) / 4) + 800);
    this.store.begin(id, text.trim(), attachment, estimate);
    this.busy = true; this.draft = ''; this.publish();
    const historyPrefix = !project.threadId && context ? `Previous saved conversation:\n${context}\n\n` : '';
    const prompt = `${historyPrefix}Project: ${project.name}\nProject brief: ${project.brief || 'Not provided yet.'}\n${attachment === 'brief' ? 'The user explicitly attached the current project brief.\n' : ''}User instruction: ${text.trim()}`;
    this.active = (async () => {
      try {
        const fullPrompt = `${prompt}${await this.attachmentContext(attachment)}\nCoordinator attempt: ${id}`;
        this.store.checkpoint(id, { prompt: fullPrompt });
        const result = await this.provider.chat(project.threadId, fullPrompt,
          threadId => this.store.thread(id, threadId),
          turnId => this.store.dispatched(id, turnId),
          event => {
            if (this.store.read<Step>('steps', id)?.turnId !== event.turnId) return;
            if (event.kind === 'text') this.draft = event.text;
            else this.store.usage(id, event.total);
            this.publish();
          }, () => this.store.dispatchAttempted(id));
        if (result.connection) this.connection = result.connection;
        this.store.checkpoint(id, { result: { text: result.text, turnId: result.turnId } });
        this.store.finish(id, 'complete', result.text);
        this.store.log('Manager response saved.');
        const step = this.store.read<Step>('steps', id)!;
        // With no cumulative baseline, start a fresh thread next time and pass saved context.
        if (step.estimated) this.store.saveProject({ ...this.store.project()!, threadId: null, lastTotal: 0 });
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'conversation_failed';
        this.store.finish(id, 'failed');
        const current = this.store.project()!;
        this.store.saveProject({ ...current, mode: 'recovery', threadId: null, lastTotal: 0 });
        this.connection = { ...this.connection, status: 'unavailable', error: code };
        this.store.log('Manager response was interrupted. Your message is saved and will not be retried automatically.');
      } finally { this.busy = false; this.draft = ''; this.active = null; this.publish(); this.afterIdle(); }
    })();
  }
  async stop() {
    this.stopping = true; this.publish();
    try {
      await this.active; await this.connecting;
      const project = this.store.project(); if (project) this.store.saveProject({ ...project, mode: 'stopped' });
    } finally {
      this.provider.close(); this.connection = { status: 'offline', quota: [], model: null, error: null }; this.publish();
    }
  }
}
