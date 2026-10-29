import { constants } from 'node:fs';
import { access, lstat, mkdir, readlink, realpath, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppError } from './types.ts';

// Only authentication and configuration are shared. Sessions, logs, databases and scratch files stay app-owned.
export async function prepareNativeHome(stateDir: string, bridge = true, source = process.env.CODEX_HOME ?? join(homedir(), '.codex')) {
  // Service state directories may not redirect into another project or a shared client home.
  // Canonical OS ancestor aliases remain supported; the directory/service leaf itself must be real.
  let state;
  try { state = await lstat(stateDir); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(stateDir, { recursive: true, mode: 0o700 }); state = await lstat(stateDir);
  }
  if (!state.isDirectory() || state.isSymbolicLink()) throw new AppError('storage_path_changed', 409);
  const root = await realpath(stateDir), canonical = await lstat(root);
  if (!canonical.isDirectory() || canonical.isSymbolicLink() || canonical.dev !== state.dev || canonical.ino !== state.ino || (await lstat(stateDir)).isSymbolicLink()) throw new AppError('storage_path_changed', 409);
  const home = join(root, 'native-home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (await realpath(home) !== home) throw new AppError('storage_path_changed', 409);
  for (const name of ['sessions', 'archived_sessions']) {
    const path = join(home, name); await mkdir(path, { recursive: true, mode: 0o700 });
    if (await realpath(path) !== path) throw new AppError('storage_path_changed', 409);
  }
  for (const name of ['codex', 'codex-logs', 'manager']) {
    const path = join(root, name); await mkdir(path, { recursive: true, mode: 0o700 });
    if (await realpath(path) !== path) throw new AppError('storage_path_changed', 409);
  }
  if (bridge) for (const name of ['auth.json', 'config.toml']) {
    const original = join(resolve(source), name), target = join(home, name);
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink() && await readlink(target) !== original) throw new AppError('storage_path_changed', 409);
      if (!existing.isSymbolicLink() && !existing.isFile()) throw new AppError('storage_path_changed', 409);
      // Codex may replace an auth symlink atomically during refresh. Keep that private refreshed cache.
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      try { await access(original, constants.R_OK); await symlink(original, target); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return home;
}
