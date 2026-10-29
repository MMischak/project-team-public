import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { Store } from './store.ts';
import { MeetingCoordinator } from './meeting-coordinator.ts';
import { CatalogStorageBudget } from './catalog-storage.ts';
import { AppError } from './types.ts';
import type { Agent, ManagerProvider, Project, Snapshot, WorkspaceProject } from './types.ts';

type ProjectRecord = WorkspaceProject & { legacy?: boolean };
type Member = Pick<Agent, 'id' | 'avatarId' | 'name' | 'role' | 'responsibility' | 'model' | 'effort' | 'createdAt'>;
type ProviderFactory = (store: Store, stateDir: string) => ManagerProvider;
type ConfigureInput = Parameters<MeetingCoordinator['configure']>[0];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const commandId = /^[a-zA-Z0-9-]{8,80}$/;
const now = () => new Date().toISOString();
const contains = (root: string, path: string) => {
  const part = relative(root, path);
  return !part || part !== '..' && !part.startsWith('../') && !part.startsWith('/');
};

/** One shared team and one live coordinator; project history never crosses this seam. */
export class WorkspaceHub extends EventEmitter {
  root: string;
  registry: Store;
  budget: CatalogStorageBudget;
  current!: MeetingCoordinator;
  activeProjectId: string | null;
  switching = false;
  stopping = false;
  instanceId = randomUUID();
  sequence = 0;
  records: ProjectRecord[];
  private createProvider: ProviderFactory;
  private demo: boolean;
  private leases = new Set<Promise<unknown>>();
  private transition: Promise<void> | null = null;
  private shutdown: Promise<void> | null = null;
  private closed = false;
  private notifyCurrent = () => {
    this.captureCurrent();
    this.publish();
  };

  constructor(stateDir: string, createProvider: ProviderFactory, demo = false) {
    super();
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.root = realpathSync(stateDir);
    this.safeDirectory(join(this.root, 'projects'));
    this.safeDatabase(join(this.root, 'workspace.sqlite'));
    this.registry = new Store(join(this.root, 'workspace.sqlite'));
    try {
      this.createProvider = createProvider;
      this.demo = demo;
      this.records = this.registry.read<ProjectRecord[]>('settings', 'workspace:projects') ?? [];
      if (!Array.isArray(this.records) || this.records.some(record => !uuid.test(record.id)) || new Set(this.records.map(record => record.id)).size !== this.records.length || this.records.filter(record => record.legacy).length > 1) throw new AppError('invalid_workspace');
      this.budget = new CatalogStorageBudget(this.root, this.registry, () => this.storageRoots());
      if (!this.registry.read('settings', 'workspace:initialized')) this.importLegacy();
      const activeId = this.registry.read<string>('settings', 'workspace:active-project');
      this.activeProjectId = this.records.some(record => record.id === activeId) ? activeId : this.records[0]?.id ?? null;
      this.current = this.load(this.records.find(record => record.id === this.activeProjectId));
      this.registry.write('settings', 'workspace:active-project', this.activeProjectId);
      this.captureCurrent();
      this.current.on('state', this.notifyCurrent);
    } catch (error) {
      if (this.current) { clearInterval(this.current.quotaTimer); this.current.provider.close(); this.current.store.close(); }
      this.registry.close();
      throw error;
    }
  }

  get storage() { return this.current.storage; }

  private safeDirectory(path: string) {
    try {
      const info = lstatSync(path);
      if (!info.isDirectory() || realpathSync(path) !== resolve(path)) throw new AppError('storage_path_changed', 409);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      mkdirSync(path, { mode: 0o700 });
    }
    return path;
  }

  private safeFile(path: string) {
    try {
      const info = lstatSync(path);
      // A dangling link still exists. Never let SQLite follow it or share a DB inode.
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || realpathSync(path) !== resolve(path)) throw new AppError('storage_path_changed', 409);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  private safeDatabase(path: string) {
    for (const suffix of ['', '-wal', '-shm']) this.safeFile(path + suffix);
  }

  private recordRoot(record?: ProjectRecord) {
    return !record || record.legacy ? this.root : join(this.root, 'projects', record.id);
  }

  storageRoots() { return [this.root, ...this.records.filter(record => !record.legacy).map(record => this.recordRoot(record))]; }

  private importLegacy() {
    const path = join(this.root, 'project-team.sqlite');
    this.safeDatabase(path);
    const legacy = new Store(path);
    try {
      const project = legacy.project();
      if (project) {
        const record: ProjectRecord = { id: randomUUID(), name: project.name, brief: project.brief, folder: project.folder, credits: project.credits, mode: project.mode, createdAt: now(), updatedAt: now(), legacy: true };
        // Keep the original DB/native home in place: old recovery identities remain valid.
        this.records.push(record);
        this.mergeMembers(legacy.all<Agent>('agents'));
      }
      this.registry.transaction(() => {
        this.registry.write('settings', 'workspace:projects', this.records);
        this.registry.write('settings', 'workspace:initialized', true);
      });
    } finally { legacy.close(); }
  }

  private members() {
    return (this.registry.read<Member[]>('settings', 'workspace:members') ?? []).map(member => ({
      id: member.id, avatarId: member.avatarId, name: member.name, role: member.role,
      responsibility: member.responsibility, model: member.model, effort: member.effort, createdAt: member.createdAt,
    }));
  }

  private mergeMembers(agents: Agent[]) {
    const members = this.members();
    const used = new Set(members.map(member => member.avatarId));
    for (const agent of agents) {
      if (members.some(member => member.id === agent.id)) continue;
      if (members.length >= 8) throw new AppError('team_limit', 409);
      const identity: Member = { id: agent.id, name: agent.name, role: agent.role, responsibility: agent.responsibility, model: agent.model, effort: agent.effort, createdAt: agent.createdAt, avatarId: agent.avatarId };
      let avatarId = identity.avatarId;
      if (!avatarId || !/^0[1-8]$/.test(avatarId) || used.has(avatarId)) avatarId = Array.from({ length: 8 }, (_, index) => String(index + 1).padStart(2, '0')).find(id => !used.has(id));
      used.add(avatarId);
      members.push({ ...identity, avatarId });
    }
    if (JSON.stringify(members) !== JSON.stringify(this.members())) this.registry.write('settings', 'workspace:members', members);
    return members;
  }

  private applyMembers(store: Store) {
    for (const member of this.members()) {
      const existing = store.read<Agent>('agents', member.id);
      store.write('agents', member.id, { ...existing, ...member, threadId: existing?.threadId ?? null, lastTotal: existing?.lastTotal ?? 0 });
    }
  }

  private load(record?: ProjectRecord) {
    const root = this.recordRoot(record);
    this.safeDirectory(join(this.root, 'projects'));
    this.safeDirectory(root);
    const path = join(root, 'project-team.sqlite');
    this.safeDatabase(path);
    const store = new Store(path);
    let provider: ManagerProvider | undefined;
    try {
      this.mergeMembers(store.all<Agent>('agents'));
      this.applyMembers(store);
      provider = this.createProvider(store, root);
      const coordinator = new MeetingCoordinator(store, provider, this.demo);
      coordinator.storage.useCatalogBudget(this.budget);
      coordinator.storage.refresh();
      return coordinator;
    } catch (error) {
      provider?.close();
      store.close();
      throw error;
    }
  }

  private captureCurrent() {
    if (!this.current || this.closed) return;
    this.mergeMembers(this.current.store.all<Agent>('agents'));
    // Also backfill an imported legacy roster's avatar IDs into its local bindings.
    const local = this.current.store.all<Agent>('agents');
    for (const member of this.members()) {
      const actor = local.find(agent => agent.id === member.id);
      if (!actor || actor.avatarId !== member.avatarId) this.current.store.write('agents', member.id, { ...actor, ...member, threadId: actor?.threadId ?? null, lastTotal: actor?.lastTotal ?? 0 });
    }
    const project = this.current.store.project();
    if (!project) return;
    if (!this.activeProjectId) {
      const imported: ProjectRecord = { id: randomUUID(), name: project.name, brief: project.brief, folder: project.folder, credits: project.credits, mode: project.mode, createdAt: now(), updatedAt: now(), legacy: true };
      this.records.push(imported);
      this.activeProjectId = imported.id;
      this.registry.write('settings', 'workspace:active-project', imported.id);
      this.registry.write('settings', 'workspace:projects', this.records);
    }
    const record = this.records.find(record => record.id === this.activeProjectId)!;
    const updated = { ...record, name: project.name, brief: project.brief, folder: project.folder, credits: project.credits, mode: project.mode };
    if (JSON.stringify(record) !== JSON.stringify(updated)) {
      Object.assign(record, updated, { updatedAt: now() });
      this.registry.write('settings', 'workspace:projects', this.records);
    }
  }

  snapshot(): Snapshot & { draft: string } {
    const state = this.current.snapshot();
    return {
      ...state,
      revision: { instanceId: this.instanceId, sequence: ++this.sequence },
      stopping: this.stopping,
      workspace: {
        projects: this.records.map(({ legacy: _legacy, ...record }) => ({ ...record, mode: record.id !== this.activeProjectId && record.mode === 'running' ? 'paused' : record.mode })),
        activeProjectId: this.activeProjectId,
        switching: this.switching,
      },
    };
  }

  publish() { if (!this.closed) this.emit('state', this.snapshot()); }

  assertScope(expected: string | string[] | undefined) {
    if (this.switching) throw new AppError('project_switching', 409);
    if (this.stopping || this.closed) throw new AppError('coordinator_stopping', 409);
    if (typeof expected !== 'string' || expected !== (this.activeProjectId ?? 'none')) throw new AppError('stale_project', 409);
  }

  async scoped<T>(expected: string | string[] | undefined, operation: (coordinator: MeetingCoordinator) => T | Promise<T>): Promise<T> {
    this.assertScope(expected);
    const coordinator = this.current;
    const work = Promise.resolve().then(() => {
      if (this.switching || coordinator !== this.current) throw new AppError('stale_project', 409);
      return operation(coordinator);
    });
    this.leases.add(work);
    try { const result = await work; if (this.switching || coordinator !== this.current) throw new AppError('stale_project', 409); return result; }
    finally { this.leases.delete(work); this.captureCurrent(); }
  }

  async validateFolder(folder: unknown, excludingProjectId?: string | null) {
    if (typeof folder !== 'string') throw new AppError('invalid_project');
    let canonical: string;
    try { canonical = await realpath(folder); if (!(await stat(canonical)).isDirectory()) throw new Error(); }
    catch { throw new AppError('folder_unavailable'); }
    if (contains(canonical, this.root) || contains(this.root, canonical)) throw new AppError('state_inside_project', 409);
    for (const record of this.records) {
      if (record.id === excludingProjectId) continue;
      if (record.folder === canonical) throw new AppError('project_folder_in_use', 409);
      if (contains(record.folder, canonical) || contains(canonical, record.folder)) throw new AppError('project_folder_overlap', 409);
    }
    return canonical;
  }

  async configured(coordinator: MeetingCoordinator, input: ConfigureInput) {
    const folder = await this.validateFolder(input.folder, this.activeProjectId);
    await coordinator.configure({ ...input, folder });
    if (!this.activeProjectId) {
      const project = coordinator.store.project()!;
      const record: ProjectRecord = { id: randomUUID(), name: project.name, brief: project.brief, folder: project.folder, credits: project.credits, mode: project.mode, createdAt: now(), updatedAt: now(), legacy: true };
      this.records.push(record);
      this.activeProjectId = record.id;
      this.registry.write('settings', 'workspace:active-project', record.id);
      this.registry.write('settings', 'workspace:projects', this.records);
    }
    this.captureCurrent();
    this.publish();
  }

  private command(input: { id: string }, kind: string, payload: unknown) {
    if (!input || typeof input.id !== 'string' || !commandId.test(input.id)) throw new AppError('invalid_command');
    const hash = createHash('sha256').update(JSON.stringify({ kind, payload })).digest('hex');
    const previous = this.registry.read<{ hash: string; projectId: string; selected?: boolean }>('settings', `workspace:command:${input.id}`);
    if (previous && previous.hash !== hash) throw new AppError('invalid_command', 409);
    return { previous, hash };
  }

  async createProject(expected: string | string[] | undefined, input: ConfigureInput & { id: string }) {
    this.assertScope(expected);
    const { previous, hash } = this.command(input, 'create', { name: input.name, brief: input.brief, folder: input.folder, credits: input.credits });
    if (previous) {
      if (previous.selected === false) {
        const saved = this.records.find(record => record.id === previous.projectId);
        if (!saved) throw new AppError('project_not_found', 404);
        if (saved.id !== this.activeProjectId) await this.transitionTo(saved);
        this.registry.write('settings', `workspace:command:${input.id}`, { ...previous, selected: true });
      }
      return;
    }
    const folder = await this.validateFolder(input.folder);
    this.assertScope(expected);
    const capacity = this.current.storage.refresh();
    if (capacity.reason && capacity.reason !== 'project_storage_limit') throw new AppError(capacity.reason, 409);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || typeof input.brief !== 'string' || input.brief.length > 8000 || !Number.isFinite(input.credits) || input.credits < 1 || input.credits > 1_000_000) throw new AppError('invalid_project');
    const record: ProjectRecord = { id: randomUUID(), name: input.name.trim(), brief: input.brief.trim(), folder, credits: input.credits, mode: 'paused', createdAt: now(), updatedAt: now() };
    await this.transitionTo(record, async () => {
      const projectRoot = this.safeDirectory(this.recordRoot(record));
      this.safeDatabase(join(projectRoot, 'project-team.sqlite'));
      const store = new Store(join(projectRoot, 'project-team.sqlite'));
      try { store.saveProject({ name: record.name, brief: record.brief, folder, credits: record.credits, mode: 'paused', threadId: null, lastTotal: 0 }); }
      finally { store.close(); }
      this.records.push(record);
      this.registry.write('settings', 'workspace:projects', this.records);
      this.registry.write('settings', `workspace:command:${input.id}`, { hash, projectId: record.id, selected: false });
    });
    this.registry.write('settings', `workspace:command:${input.id}`, { hash, projectId: record.id, selected: true });
  }

  async switchProject(expected: string | string[] | undefined, input: { id: string; projectId: string }) {
    this.assertScope(expected);
    const { previous, hash } = this.command(input, 'switch', { projectId: input.projectId });
    if (previous) return;
    if (typeof input.projectId !== 'string' || !uuid.test(input.projectId)) throw new AppError('invalid_project');
    const record = this.records.find(record => record.id === input.projectId);
    if (!record) throw new AppError('project_not_found', 404);
    if (record.id !== this.activeProjectId) await this.transitionTo(record);
    this.registry.write('settings', `workspace:command:${input.id}`, { hash, projectId: record.id });
  }

  private async transitionTo(record: ProjectRecord, prepare?: () => Promise<void>) {
    if (this.transition) throw new AppError('project_switching', 409);
    this.switching = true;
    const old = this.current;
    const oldRecord = this.records.find(record => record.id === this.activeProjectId);
    const project = old.store.project();
    if (project?.mode === 'running') old.mode('paused');
    old.stopping = true; // Prevent already queued pumps/leases from starting another turn while draining.
    this.publish();
    this.transition = (async () => {
      let oldClosed = false;
      let activated = false;
      let next: MeetingCoordinator | undefined;
      try {
        // Leases include async filesystem/preview/configuration requests, not only model turns.
        await Promise.allSettled([...this.leases]);
        await old.stop();
        await old.provider.closeForStorage?.();
        oldClosed = true;
        const saved = old.store.project();
        if (saved) old.store.saveProject({ ...saved, mode: old.store.recoveryPending() ? 'recovery' : 'paused' });
        this.captureCurrent();
        // Recheck after leases finish: a configure accepted earlier may have changed the catalog.
        if (await this.validateFolder(record.folder, record.id) !== record.folder) throw new AppError('project_folder_changed', 409);
        await prepare?.();
        next = this.load(record);
        this.registry.write('settings', 'workspace:active-project', record.id);
        old.off('state', this.notifyCurrent);
        old.store.close();
        this.current = next;
        this.activeProjectId = record.id;
        activated = true;
        next.on('state', this.notifyCurrent);
        this.captureCurrent();
      } catch (error) {
        // A failed target open leaves the old project paused and available for explicit reconnect.
        if (oldClosed && !activated) {
          if (next) { await next.stop(); await next.provider.closeForStorage?.(); next.store.close(); }
          old.off('state', this.notifyCurrent);
          old.store.close();
          this.current = this.load(oldRecord);
          this.current.on('state', this.notifyCurrent);
        }
        if (!oldClosed) old.connection = { status: 'unavailable', quota: [], model: null, error: error instanceof AppError ? error.code : 'coordinator_stopping' };
        throw error;
      } finally {
        this.switching = false;
        this.transition = null;
        this.publish();
      }
    })();
    await this.transition;
  }

  checkStorage() { this.current.checkStorage(); }
  async cleanupStorage(automatic = false) { await this.current.cleanupStorage(automatic); }
  async startupMaintenance() {
    try { await this.cleanupStorage(true); }
    catch (error) {
      if (!(error instanceof AppError) || !['storage_scan_incomplete', 'storage_path_changed', 'storage_native_busy'].includes(error.code)) throw error;
      // Keep the paused inspection/settings surface available; execution still fails closed.
      this.checkStorage();
    }
  }
  async stop() {
    if (this.shutdown) return this.shutdown;
    this.stopping = true;
    this.publish();
    this.shutdown = (async () => {
      try { await this.transition; } catch { /* A failed switch keeps its prior project for shutdown. */ }
      await Promise.allSettled([...this.leases]);
      try {
        await this.current.stop();
        await this.current.provider.closeForStorage?.();
        this.captureCurrent();
      } catch (error) {
        this.stopping = false;
        this.shutdown = null;
        this.current.connection = { status: 'unavailable', quota: [], model: null, error: error instanceof AppError ? error.code : 'coordinator_stopping' };
        this.publish();
        throw error;
      }
    })();
    await this.shutdown;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.current.off('state', this.notifyCurrent);
    this.current.store.close();
    this.registry.close();
  }
}
