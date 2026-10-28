import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { Store } from './store.ts';
import type { OutputVersion, Task } from './types.ts';
import { AppError } from './types.ts';
import { projectPath } from './team-domain.ts';

export const contained = (root: string, path: string) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('../') && !part.startsWith('/'); };
export async function confinedPath(folder: string, path: string, allowMissing = false) {
  projectPath(path);
  if (await realpath(folder) !== folder) throw new AppError('project_folder_changed', 409);
  const target = resolve(folder, path); let candidate = target;
  while (true) {
    try { if (!contained(folder, await realpath(candidate))) throw new AppError('path_outside_project', 403); break; }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; if (!allowMissing || candidate === folder) throw new AppError('output_unavailable', 404); candidate = dirname(candidate); }
  }
  if (!allowMissing && !(await stat(target)).isFile()) throw new AppError('invalid_output_path');
  return target;
}
export class Artifacts {
  store: Store; directory: string;
  constructor(store: Store) { this.store = store; this.directory = join(dirname(store.path), 'snapshots'); }
  async ensureOutside(folder: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (contained(folder, await realpath(this.directory))) throw new AppError('state_inside_project', 409);
  }
  async capture(task: Task, authorId: string, title: string, path: string | null, content: string): Promise<OutputVersion> {
    await this.ensureOutside(this.store.project()!.folder);
    if (Buffer.byteLength(content) > 262144 || content.includes('\0')) throw new AppError('output_too_large');
    const id = randomUUID(), hash = createHash('sha256').update(content).digest('hex');
    const prior = this.store.all<OutputVersion>('outputs').filter(output => path ? output.path === path : output.path === null && output.title === title && output.milestoneId === task.milestoneId);
    const output: OutputVersion = { id, path, url: null, title, version: Math.max(0, ...prior.map(output => output.version)) + 1, hash, authorId, taskId: task.id, milestoneId: task.milestoneId, status: 'draft', bytes: Buffer.byteLength(content), createdAt: new Date().toISOString() };
    await writeFile(join(this.directory, `${id}.txt`), content, { flag: 'wx', mode: 0o600 }); return output;
  }
  async content(id: string) {
    const output = this.store.read<OutputVersion>('outputs', id);
    if (!output) throw new AppError('output_not_found', 404);
    return this.verify(output);
  }
  async verify(output: OutputVersion) {
    if (!/^[a-f0-9-]{36}$/.test(output.id)) throw new AppError('output_not_found', 404);
    const content = await readFile(join(this.directory, `${output.id}.txt`), 'utf8');
    if (createHash('sha256').update(content).digest('hex') !== output.hash) throw new AppError('snapshot_changed', 409);
    return content;
  }
}
