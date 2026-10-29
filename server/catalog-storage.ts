import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { DEFAULT_STORAGE, isDiagnosticPath, ownedStorageRoots, scanStorageRoots } from './storage.ts';
import type { Store } from './store.ts';
import type { StoragePolicy } from './types.ts';
import { AppError } from './types.ts';

export type SharedStoragePolicy = Pick<StoragePolicy, 'appMiB' | 'logsMiB' | 'retentionDays'>;
export type CatalogStorageUsage = { appBytes: number; databaseBytes: number; snapshotBytes: number; runtimeBytes: number; diagnosticBytes: number; complete: boolean };
const shared = (value: StoragePolicy | SharedStoragePolicy): SharedStoragePolicy => ({ appMiB: value.appMiB, logsMiB: value.logsMiB, retentionDays: value.retentionDays });
const valid = (value: unknown): value is SharedStoragePolicy => {
  if (!value || typeof value !== 'object') return false;
  const policy = value as SharedStoragePolicy;
  return Number.isInteger(policy.appMiB) && policy.appMiB >= 64 && policy.appMiB <= 8192 && Number.isInteger(policy.logsMiB) && policy.logsMiB >= 1 && policy.logsMiB <= 256 && policy.logsMiB <= policy.appMiB / 2 && Number.isInteger(policy.retentionDays) && policy.retentionDays >= 1 && policy.retentionDays <= 30;
};

// Inventory and shared policy only. Cleanup never receives this catalog-wide file list.
export class CatalogStorageBudget {
  root: string;
  registry: Store;
  private projectRoots: () => readonly string[];
  private maxEntries: number;
  constructor(root: string, registry: Store, projectRoots: () => readonly string[], maxEntries = 150000) {
    this.root = resolve(root); this.registry = registry; this.projectRoots = projectRoots; this.maxEntries = maxEntries;
  }
  roots() {
    const projectRoots = this.projectRoots();
    if (projectRoots.length > this.maxEntries) throw new AppError('storage_scan_incomplete');
    const roots = [...new Set([this.root, ...projectRoots.map(path => resolve(path))])];
    for (const root of roots) {
      const part = relative(this.root, root);
      if (part && (!/^projects\/[^/]+$/.test(part) || !existsSync(root)) || realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new AppError('storage_path_changed');
    }
    return roots;
  }
  policy(): SharedStoragePolicy | null {
    try {
      const value = this.registry.read<unknown>('settings', 'storage:policy');
      if (value === null) return null;
      return valid(value) ? shared(value) : shared(DEFAULT_STORAGE);
    } catch { return shared(DEFAULT_STORAGE); }
  }
  savePolicy(policy: StoragePolicy | SharedStoragePolicy) {
    if (!valid(policy)) throw new AppError('invalid_storage_policy');
    this.registry.write('settings', 'storage:policy', shared(policy));
  }
  usage(): CatalogStorageUsage {
    const result: CatalogStorageUsage = { appBytes: 0, databaseBytes: 0, snapshotBytes: 0, runtimeBytes: 0, diagnosticBytes: 0, complete: true };
    try {
      const policy = this.registry.read<unknown>('settings', 'storage:policy');
      if (policy !== null && !valid(policy)) throw new Error();
      if (this.registry.path !== join(this.root, 'workspace.sqlite')) throw new Error();
      const roots = this.roots(), projects = join(this.root, 'projects');
      // One projects traversal counts every child and abandoned creation data without rescanning child inventories.
      const inventory = scanStorageRoots([
        this.registry.path, `${this.registry.path}-wal`, `${this.registry.path}-shm`, join(this.root, 'coordinator.lock'),
        ...ownedStorageRoots(join(this.root, 'project-team.sqlite')), projects,
      ], this.maxEntries);
      result.complete = inventory.complete;
      const databases = new Set([this.registry.path, ...roots.map(root => join(root, 'project-team.sqlite'))]);
      for (const file of inventory.files) {
        const part = relative(this.root, file.path), scoped = part.replace(/^projects\/[^/]+\//, '');
        result.appBytes += file.bytes;
        const base = file.path.replace(/-(?:wal|shm)$/, '');
        if (databases.has(base)) result.databaseBytes += file.bytes;
        else if (scoped.startsWith('snapshots/')) result.snapshotBytes += file.bytes;
        if (isDiagnosticPath(scoped)) result.diagnosticBytes += file.bytes;
      }
      result.runtimeBytes = result.appBytes - result.databaseBytes - result.snapshotBytes;
      // A registered project path was checked above; unregistered symlink roots are not adopted or followed.
      if (existsSync(projects) && (realpathSync(projects) !== projects || !lstatSync(projects).isDirectory())) result.complete = false;
    } catch { result.complete = false; }
    return result;
  }
}
