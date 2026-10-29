import { existsSync, lstatSync, opendirSync, realpathSync, statfsSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Store } from './store.ts';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from './types.ts';
import type { CatalogStorageBudget } from './catalog-storage.ts';
import type { Agent, GitHubCheckpoint, MeetingConversation, OutputVersion, StoragePolicy, StorageUsage } from './types.ts';

export const MiB = 1024 * 1024;
export const DEFAULT_STORAGE: StoragePolicy = { appMiB: 1024, projectMiB: 2048, logsMiB: 64, retentionDays: 7 };
const within = (root: string, path: string) => { const part = relative(root, path); return !part || part !== '..' && !part.startsWith('../') && !part.startsWith('/'); };
export type StorageFile = { path: string; bytes: number; mtime: number };
export type StorageScan = { files: StorageFile[]; bytes: number; complete: boolean };

export const ownedStorageRoots = (path: string) => [path, `${path}-wal`, `${path}-shm`, ...['snapshots', 'codex', 'codex-logs', 'native-home', 'manager-service', 'manager'].map(name => join(dirname(path), name))];
export function isDiagnosticPath(part: string) {
  return (part.startsWith('codex-logs/') || part.startsWith('manager-service/codex-logs/') || /^(?:manager-service\/)?native-home\/(?:log|tmp)\//.test(part)) && !/\.(?:sqlite|db)(?:-wal|-shm)?$/.test(part) || /^(?:manager-service\/)?(?:codex|native-home)\/logs_\d+\.sqlite(?:-wal|-shm)?$/.test(part);
}

// Share one entry ceiling across the whole inventory. Overlapping roots and hard links count once.
// Directory iteration is bounded too; a very large directory cannot allocate an unbounded name list.
export function scanStorageRoots(roots: readonly string[], maxEntries = 150000): StorageScan {
  const result: StorageScan = { files: [], bytes: 0, complete: true }, pending: string[] = [];
  if (roots.length > maxEntries) return { ...result, complete: false };
  const normalized = [...new Set(roots.map(root => resolve(root)))];
  const selected = normalized.filter(root => !normalized.some(other => other !== root && within(other, root)));
  const selectedSet = new Set(selected), files = new Set<string>();
  let entries = 0;
  const enqueue = (path: string) => { if (++entries > maxEntries) { result.complete = false; return false; } pending.push(path); return true; };
  for (const root of selected) if (!enqueue(root)) return result;
  try {
    while (pending.length && result.complete) {
      const path = pending.pop()!;
      const parent = dirname(path);
      if (existsSync(parent) && realpathSync(parent) !== resolve(parent)) throw new Error();
      let info; try { info = lstatSync(path); } catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
      if (info.isSymbolicLink()) { if (selectedSet.has(path)) result.complete = false; continue; }
      if (info.isDirectory()) {
        if (realpathSync(path) !== path) throw new Error();
        const directory = opendirSync(path);
        try { let entry; while ((entry = directory.readSync())) if (!enqueue(join(path, entry.name))) break; }
        finally { directory.closeSync(); }
      } else if (info.isFile()) {
        const identity = `${info.dev}:${info.ino}`;
        if (files.has(identity)) continue;
        files.add(identity);
        const bytes = Math.max(info.size, Number.isFinite(info.blocks) ? info.blocks * 512 : 0);
        result.bytes += bytes; result.files.push({ path, bytes, mtime: info.mtimeMs });
      }
    }
  } catch { result.complete = false; }
  return result;
}
const scan = (root: string) => scanStorageRoots([root]);

export class Storage {
  store: Store; root: string; current: StorageUsage; cleaning = false;
  catalogBudget: CatalogStorageBudget | null = null;
  constructor(store: Store) {
    this.store = store; this.root = resolve(dirname(store.path));
    this.current = { policy: this.policy(), appBytes: 0, projectBytes: 0, databaseBytes: 0, snapshotBytes: 0, runtimeBytes: 0, reclaimableBytes: 0, status: 'ok', reason: null, checkedAt: null, cleaning: false, lastCleanup: store.read('settings', 'storage:last-cleanup') };
  }
  policy() { return { ...DEFAULT_STORAGE, ...(this.store.read<StoragePolicy>('settings', 'storage:policy') ?? {}), ...(this.catalogBudget?.policy() ?? {}) }; }
  useCatalogBudget(budget: CatalogStorageBudget) {
    const existing = this.policy();
    if (!budget.policy()) budget.savePolicy(existing);
    this.catalogBudget = budget; this.refresh();
  }
  ownedRoots() { return ownedStorageRoots(this.store.path); }
  ownedFiles() { return scanStorageRoots(this.ownedRoots()); }
  refresh() {
    if (this.store.path === ':memory:') return this.current;
    const inventory = this.catalogBudget ? this.catalogBudget.usage() : null;
    const local = inventory ? null : this.ownedFiles(), files = local?.files ?? [];
    const complete = inventory?.complete ?? local!.complete, policy = this.policy(), folder = this.store.project()?.folder;
    const project = folder ? scan(folder) : { bytes: 0, complete: true };
    if (folder) { try { if (!lstatSync(folder).isDirectory() || realpathSync(folder) !== folder) project.complete = false; } catch { project.complete = false; } }
    const databaseBytes = inventory?.databaseBytes ?? files.filter(f => f.path === this.store.path || f.path.startsWith(this.store.path + '-')).reduce((n, f) => n + f.bytes, 0);
    const snapshotBytes = inventory?.snapshotBytes ?? files.filter(f => within(join(this.root, 'snapshots'), f.path)).reduce((n, f) => n + f.bytes, 0);
    const appBytes = inventory?.appBytes ?? files.reduce((n, f) => n + f.bytes, 0), runtimeBytes = appBytes - databaseBytes - snapshotBytes;
    const appLimit = policy.appMiB * MiB, projectLimit = policy.projectMiB * MiB;
    let reason: StorageUsage['reason'] = !complete || !project.complete ? 'storage_scan_incomplete' : appBytes + 16 * MiB >= appLimit ? 'app_storage_limit' : project.bytes >= projectLimit ? 'project_storage_limit' : inventory && inventory.diagnosticBytes > policy.logsMiB * MiB ? 'diagnostic_storage_limit' : null;
    try { for (const path of [this.root, ...(folder && project.complete ? [folder] : [])]) { const disk = statfsSync(path); if (disk.bavail * disk.bsize < 64 * MiB) reason = 'disk_space_low'; } } catch { reason = 'storage_scan_incomplete'; }
    const diagnosticBytes = inventory?.diagnosticBytes ?? files.filter(f => this.isDiagnostic(f.path)).reduce((n, f) => n + f.bytes, 0);
    this.current = { ...this.current, policy, appBytes, projectBytes: project.bytes, databaseBytes, snapshotBytes, runtimeBytes, reclaimableBytes: diagnosticBytes, status: reason ? reason === 'storage_scan_incomplete' ? 'unavailable' : 'blocked' : appBytes >= appLimit * .8 || project.bytes >= projectLimit * .8 || !!inventory && diagnosticBytes >= policy.logsMiB * MiB * .8 ? 'warning' : 'ok', reason, checkedAt: new Date().toISOString(), cleaning: this.cleaning };
    return this.current;
  }
  assertCapacity() {
    if (this.cleaning) throw new AppError('storage_busy', 409);
    const usage = this.refresh();
    if (usage.status === 'blocked' || usage.status === 'unavailable') throw new AppError(usage.reason ?? 'app_storage_limit', 409);
  }
  savePolicy(input: StoragePolicy) {
    if (!input || Object.keys(input).some(key => !['appMiB', 'projectMiB', 'logsMiB', 'retentionDays'].includes(key)) || !Number.isInteger(input.appMiB) || input.appMiB < 64 || input.appMiB > 8192 || !Number.isInteger(input.projectMiB) || input.projectMiB < 64 || input.projectMiB > 65536 || !Number.isInteger(input.logsMiB) || input.logsMiB < 1 || input.logsMiB > 256 || input.logsMiB > input.appMiB / 2 || !Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 30) throw new AppError('invalid_storage_policy');
    this.catalogBudget?.savePolicy(input);
    this.store.write('settings', 'storage:policy', input); this.refresh();
  }
  protectedThreads() {
    return new Set(this.store.steps().filter(step => ['reserved', 'dispatched', 'failed', 'interrupted'].includes(step.status)).map(step => step.threadId).filter((id): id is string => !!id));
  }
  forgetThread(id: string) {
    if (this.protectedThreads().has(id)) throw new AppError('storage_protected_thread');
    this.store.transaction(() => {
      const project = this.store.project(); if (project?.threadId === id) this.store.saveProject({ ...project, threadId: null, lastTotal: 0 });
      for (const agent of this.store.all<Agent>('agents')) if (agent.threadId === id) this.store.write('agents', agent.id, { ...agent, threadId: null, lastTotal: 0 });
      for (const conversation of this.store.all<MeetingConversation>('conversations')) if (conversation.threadId === id) this.store.write('conversations', conversation.id, { ...conversation, threadId: null, lastTotal: 0 });
    });
  }
  isDiagnostic(path: string) { return isDiagnosticPath(relative(this.root, path)); }
  remove(path: string) {
    // Recheck every ancestor immediately before unlinking. Never recursively remove a directory.
    if (!within(this.root, path) || realpathSync(dirname(path)) !== dirname(path) || lstatSync(path).isSymbolicLink()) throw new AppError('storage_path_changed');
    unlinkSync(path);
  }
  cleanupFiles(now = Date.now(), pressure = false) {
    const inventory = this.ownedFiles(); if (!inventory.complete) throw new AppError('storage_scan_incomplete');
    const policy = this.policy(), cutoff = now - policy.retentionDays * 86400000;
    const catalog = this.catalogBudget?.usage(); if (catalog && !catalog.complete) throw new AppError('storage_scan_incomplete');
    let removed = 0, logsBytes = catalog?.diagnosticBytes ?? inventory.files.filter(f => this.isDiagnostic(f.path)).reduce((n, f) => n + f.bytes, 0);
    const logs = inventory.files.filter(f => this.isDiagnostic(f.path)).sort((a, b) => a.mtime - b.mtime);
    for (const file of logs) if (pressure || file.mtime < cutoff || logsBytes > policy.logsMiB * MiB) { this.remove(file.path); logsBytes -= file.bytes; removed++; }
    const protectedOutputs = new Set(this.store.all<OutputVersion>('outputs').map(o => o.id));
    for (const step of this.store.steps()) for (const o of this.store.journal(step.id).outputs ?? []) protectedOutputs.add(o.id);
    for (const record of this.store.all<GitHubCheckpoint>('checkpoints')) for (const o of record.payload.outputs) protectedOutputs.add(o.version.id);
    for (const file of inventory.files) {
      const match = /^([a-f0-9-]{36})\.txt$/.exec(relative(join(this.root, 'snapshots'), file.path));
      if (match && !protectedOutputs.has(match[1]) && (pressure || file.mtime < now - 86400000)) { this.remove(file.path); removed++; }
      if (/^(?:manager-service\/)?native-home\/project-team-threads\.json\.[a-f0-9-]{36}\.tmp$/.test(relative(this.root, file.path)) && file.mtime < now - 86400000) { this.remove(file.path); removed++; }
    }
    const records = this.store.pruneRunData(); this.store.compact();
    for (const file of inventory.files) if (file.path !== this.store.path && file.path.endsWith('.sqlite') && existsSync(file.path) && realpathSync(file.path) === file.path) {
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(file.path); db.exec('PRAGMA busy_timeout=500; PRAGMA wal_checkpoint(TRUNCATE)');
        const free = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count), pages = Number(db.prepare('PRAGMA page_count').get()?.page_count), size = Number(db.prepare('PRAGMA page_size').get()?.page_size), disk = statfsSync(this.root);
        if (free > pages / 4 && disk.bavail * disk.bsize > pages * size * 2 + 16 * MiB) db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
      } catch { /* A busy or unsupported native database is kept intact and remains counted. */ }
      finally { db?.close(); }
    }
    const result = { at: new Date(now).toISOString(), files: removed, records, nativeThreads: 0 };
    this.store.write('settings', 'storage:last-cleanup', result); this.current.lastCleanup = result; this.refresh(); return result;
  }
  migrateLegacyThreads() {
    let ids = this.store.read<string[]>('settings', 'storage:legacy-threads');
    if (ids) return ids;
    ids = [...new Set([this.store.project()?.threadId, ...this.store.steps().map(s => s.threadId), ...this.store.all<Agent>('agents').map(a => a.threadId), ...this.store.all<MeetingConversation>('conversations').map(c => c.threadId)].filter((id): id is string => !!id))];
    // Keep saved turn IDs for read-only recovery, but future turns start in the private runtime home.
    this.store.transaction(() => {
      this.store.write('settings', 'storage:legacy-threads', ids);
      const project = this.store.project(); if (project) this.store.saveProject({ ...project, threadId: null, lastTotal: 0 });
      for (const agent of this.store.all<Agent>('agents')) this.store.write('agents', agent.id, { ...agent, threadId: null, lastTotal: 0 });
      for (const conversation of this.store.all<MeetingConversation>('conversations')) this.store.write('conversations', conversation.id, { ...conversation, threadId: null, lastTotal: 0 });
    });
    return ids;
  }
}
