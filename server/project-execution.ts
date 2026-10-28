import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { contained, confinedPath } from './artifacts.ts';
import { AppError } from './types.ts';
import { projectPath } from './team-domain.ts';

type Rpc = (method: string, params: unknown) => Promise<any>;
export function projectPolicy(folder: string) { return { extends: ':workspace', filesystem: { ':root': 'deny', ':minimal': 'read', ':tmpdir': 'deny', ':slash_tmp': 'deny', [folder]: 'write' }, network: { enabled: false } }; }
export function profileToml(folder: string) { const policy = projectPolicy(folder); return `{extends=":workspace",filesystem={${Object.entries(policy.filesystem).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}},network={enabled=false}}`; }
export function verifyPolicy(config: any, id: string, folder: string) {
  const active = config?.permissions?.[id], expected = projectPolicy(folder);
  if (config?.sandbox_mode != null || config?.default_permissions !== id || active?.extends !== ':workspace' || active?.network?.enabled !== false || Object.values(active?.workspace_roots ?? {}).some(Boolean) || Object.keys(active?.filesystem ?? {}).filter(key => key !== 'glob_scan_max_depth').length !== Object.keys(expected.filesystem).length || !Object.entries(expected.filesystem).every(([key, value]) => active.filesystem[key] === value)) throw new AppError('project_permissions_unverified', 503);
}
export class ProjectExecution {
  folder: string; profile: string; stateDir: string; rpc: Rpc; verified = false;
  guardStorage: () => void;
  constructor(folder: string, profile: string, stateDir: string, rpc: Rpc, guardStorage = () => {}) { this.folder = folder; this.profile = profile; this.stateDir = stateDir; this.rpc = rpc; this.guardStorage = guardStorage; }
  async command(command: string[], outputBytesCap = 32768) {
    if (!this.verified) throw new AppError('project_permissions_unverified', 503);
    this.guardStorage();
    if (!Array.isArray(command) || !command.length || command.length > 80 || command.some(value => typeof value !== 'string' || value.includes('\0') || value.length > 65536) || command.reduce((sum, value) => sum + value.length, 0) > 131072) throw new AppError('invalid_tool_arguments');
    if (await realpath(this.folder) !== this.folder) throw new AppError('project_folder_changed', 409);
    const result = await this.rpc('command/exec', { command, cwd: this.folder, permissionProfile: this.profile, timeoutMs: 30000, outputBytesCap, env: Object.fromEntries(['OPENAI_API_KEY', 'CODEX_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN'].map(key => [key, null])) });
    this.guardStorage();
    if (!Number.isInteger(result?.exitCode) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw new AppError('invalid_execution_result', 503);
    return result;
  }
  async verify() {
    if (this.verified) return;
    if (await realpath(this.folder) !== this.folder || contained(this.folder, await realpath(this.stateDir))) throw new AppError('state_inside_project', 409);
    const inside = await mkdtemp(join(this.folder, '.project-team-check-'));
    const outside = await mkdtemp(join(this.stateDir, 'permission-check-'));
    const link = join(inside, 'escape');
    try {
      await writeFile(join(inside, 'inside.txt'), 'inside-fixture'); await writeFile(join(outside, 'outside.txt'), 'outside-fixture'); await symlink(outside, link);
      const script = 'read_probe() { if /bin/cat "$2" >/dev/null 2>&1; then printf "%s=allowed\\n" "$1"; else printf "%s=denied\\n" "$1"; fi; }; write_probe() { if (printf fixture > "$2") 2>/dev/null; then printf "%s=allowed\\n" "$1"; else printf "%s=denied\\n" "$1"; fi; }; read_probe inside_read "$1/inside.txt"; write_probe inside_write "$1/write.txt"; read_probe outside_read "$2/outside.txt"; write_probe outside_write "$2/write.txt"; read_probe symlink_read "$1/escape/outside.txt"; write_probe symlink_write "$1/escape/write-link.txt"; read_probe traversal_read "$4"; write_probe metadata_write "$3"';
      const result = await this.rpc('command/exec', { command: ['/bin/sh', '-c', script, 'permission-check', inside, outside, `.git/.project-team-${randomUUID()}`, relative(this.folder, join(outside, 'outside.txt'))], cwd: this.folder, permissionProfile: this.profile, timeoutMs: 10000, outputBytesCap: 4096 });
      const expected = 'inside_read=allowed\ninside_write=allowed\noutside_read=denied\noutside_write=denied\nsymlink_read=denied\nsymlink_write=denied\ntraversal_read=denied\nmetadata_write=denied\n';
      if (result?.exitCode !== 0 || result?.stdout !== expected) throw new AppError('project_permissions_unverified', 503);
      this.verified = true;
    } finally { await rm(inside, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  }
  async read(path: string) {
    const target = await confinedPath(this.folder, path);
    const result = await this.command(['/bin/cat', target], 262145);
    if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 262144 || result.stdout.includes('\0')) throw new AppError('output_unavailable');
    return result.stdout;
  }
  async write(path: string, content: string, allowedOutputs: string[]) {
    projectPath(path);
    if (!allowedOutputs.includes(path) || typeof content !== 'string' || Buffer.byteLength(content) > 65536 || content.includes('\0')) throw new AppError('invalid_tool_arguments');
    const target = await confinedPath(this.folder, path, true);
    const parent = target.slice(0, target.lastIndexOf('/'));
    return this.command(['/bin/sh', '-c', 'umask 077; /bin/mkdir -p -- "$1" && printf "%s" "$2" > "$3"', 'project-write', parent, content, target]);
  }
}
