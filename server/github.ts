import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import type { CheckpointFile, GitHubCheckpoint } from './types.ts';
import { AppError } from './types.ts';

const exec = promisify(execFile);
const sha = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new AppError('github_invalid_response');
  return value;
};
export function githubRepository(remote: string) {
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(remote.trim());
  if (!match || match[1].split('/').some(part => part === '.' || part === '..')) throw new AppError('github_origin_required');
  return match[1];
}
export async function originRepository(folder: string) {
  // Read only the selected root's local origin; ignore inherited Git environment/config includes.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  try {
    if (await realpath(folder) !== folder) throw new Error();
    const options = { cwd: folder, env, timeout: 5000, maxBuffer: 8192 };
    const root = await exec('git', ['--no-optional-locks', 'rev-parse', '--show-toplevel'], options);
    if (await realpath(root.stdout.trim()) !== folder) throw new Error();
    const remote = await exec('git', ['--no-optional-locks', 'config', '--local', '--no-includes', '--get', 'remote.origin.url'], options);
    return githubRepository(remote.stdout);
  } catch { throw new AppError('github_origin_required', 409); }
}

export type GitHubRequest = (method: 'GET' | 'POST', path: string, input: unknown, signal: AbortSignal) => Promise<any>;
export class GitHubError extends AppError {
  httpStatus: number | null;
  constructor(code: string, httpStatus: number | null = null) { super(code, 409); this.httpStatus = httpStatus; }
}
// This process alone uses the user's existing gh sign-in. Its output is never sent to an agent.
export const githubRequest: GitHubRequest = (method, path, input, signal) => new Promise((resolve, reject) => {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' };
  for (const key of ['GH_DEBUG', 'GH_HOST', 'GH_REPO', 'GH_HTTP_UNIX_SOCKET']) delete env[key as keyof typeof env];
  const args = ['api', '--hostname', 'github.com', '--method', method, '-H', 'Accept: application/vnd.github+json', path];
  if (input !== undefined) args.push('--input', '-');
  const child = spawn('gh', args, { env, cwd: '/', stdio: ['pipe', 'pipe', 'pipe'], signal, timeout: 15000 });
  let stdout = '', stderr = '', finished = false;
  const fail = (code: string, status: number | null = null) => { if (!finished) { finished = true; reject(new GitHubError(code, status)); } };
  child.on('error', () => fail('github_unavailable'));
  child.stdin.on('error', () => {});
  child.stdout.on('data', data => { stdout += data.toString(); if (Buffer.byteLength(stdout) > 2_000_000) { fail('github_invalid_response'); child.kill(); } });
  child.stderr.on('data', data => { if (stderr.length < 16384) stderr += data.toString(); });
  child.on('close', code => {
    if (finished) return;
    if (code !== 0) {
      const status = Number(/HTTP (\d{3})/.exec(stderr)?.[1]) || null;
      fail(status === 401 || status === 403 ? 'github_access_denied' : status === 409 || status === 422 ? 'github_export_rejected' : 'github_unavailable', status); return;
    }
    try { const result = JSON.parse(stdout); finished = true; resolve(result); } catch { fail('github_invalid_response'); }
  });
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
});

export interface CheckpointRemote {
  find(record: GitHubCheckpoint, signal: AbortSignal): Promise<string | null>;
  commit(record: GitHubCheckpoint, files: CheckpointFile[], signal: AbortSignal): Promise<string>;
  publish(record: GitHubCheckpoint, signal: AbortSignal): Promise<void>;
}
export class GitHubRemote implements CheckpointRemote {
  request: GitHubRequest;
  constructor(request = githubRequest) { this.request = request; }
  async find(record: GitHubCheckpoint, signal: AbortSignal) {
    try {
      const result = await this.request('GET', `repos/${record.payload.repository}/git/ref/heads/${record.branch}`, undefined, signal);
      if (result.ref !== `refs/heads/${record.branch}` || result.object?.type !== 'commit') throw new AppError('github_ref_conflict');
      return sha(result.object.sha);
    } catch (error) {
      if (error instanceof GitHubError && error.httpStatus === 404) {
        // A missing/private repository also returns 404; verify access before treating the ref as absent.
        await this.request('GET', `repos/${record.payload.repository}`, undefined, signal); return null;
      }
      throw error;
    }
  }
  async commit(record: GitHubCheckpoint, files: CheckpointFile[], signal: AbortSignal) {
    const tree = await this.request('POST', `repos/${record.payload.repository}/git/trees`, { tree: files.map(file => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })) }, signal);
    // No base tree or parents: this branch is a standalone export, never a patch to a working branch.
    const author = { name: 'Project Team checkpoint', email: 'checkpoint@project-team.invalid', date: record.createdAt };
    const commit = await this.request('POST', `repos/${record.payload.repository}/git/commits`, { message: `Project Team checkpoint ${record.id}`, tree: sha(tree.sha), parents: [], author, committer: author }, signal);
    return sha(commit.sha);
  }
  async publish(record: GitHubCheckpoint, signal: AbortSignal) {
    // Only create a new ref. There is deliberately no update/force/delete operation.
    await this.request('POST', `repos/${record.payload.repository}/git/refs`, { ref: `refs/heads/${record.branch}`, sha: sha(record.commit) }, signal);
  }
}
