import { createHash } from 'node:crypto';
import { Store } from './store.ts';
import { Artifacts } from './artifacts.ts';
import { AppError } from './types.ts';
import type { Agent, CheckpointFile, CheckpointPayload, CheckpointPreview, GitHubCheckpoint, Milestone, OutputVersion } from './types.ts';
import { projectPath } from './team-domain.ts';
import { GitHubRemote, originRepository } from './github.ts';
import type { CheckpointRemote } from './github.ts';

export const CHECKPOINT_ATTEMPTS = 3;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const commandId = (id: unknown) => { if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new AppError('invalid_command'); };
const failure = (error: unknown) => error instanceof AppError ? error.code : 'github_unavailable';
export type CheckpointSelection = { outputIds: string[]; summary: string };
function exportPath(value: string) {
  projectPath(value);
  if (value.toLowerCase().split('/').some(part => ['.git', '.codex', '.agents', '.aws', '.ssh', '.gnupg', '.npmrc', '.netrc', 'auth.json', 'credentials', 'credentials.json'].includes(part) || /^\.env(?:\.|$)/.test(part) || /^(?:id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|rollout-.*\.jsonl)$/.test(part) || /\.(?:pem|key|p12|pfx|sqlite(?:3)?(?:-wal|-shm)?|db(?:-wal|-shm)?)$/.test(part))) throw new AppError('checkpoint_protected_file');
  return value;
}

export class Checkpoints {
  guardStorage = () => {};
  storageBusy = () => false;
  store: Store; artifacts: Artifacts; notify: () => void; stopping: () => boolean; demo: boolean;
  remote: CheckpointRemote; destination: (folder: string) => Promise<string>;
  active: Promise<void> | null = null;
  constructor(store: Store, artifacts: Artifacts, notify: () => void, stopping: () => boolean, demo = false, remote: CheckpointRemote = new GitHubRemote(), destination = originRepository) {
    this.store = store; this.artifacts = artifacts; this.notify = notify; this.stopping = stopping; this.demo = demo; this.remote = remote; this.destination = destination;
    for (const record of store.all<GitHubCheckpoint>('checkpoints')) if (record.status === 'syncing') store.write('checkpoints', record.id, { ...record, status: 'unsynced', error: 'checkpoint_interrupted' });
    // A restart never replays network work. The same frozen record can be retried explicitly.
  }
  async files(payload: CheckpointPayload): Promise<CheckpointFile[]> {
    const files: CheckpointFile[] = [];
    let bytes = 0;
    for (const output of payload.outputs) {
      const content = await this.artifacts.verify(output.version); bytes += Buffer.byteLength(content);
      if (bytes > 1_048_576) throw new AppError('checkpoint_too_large');
      files.push({ path: output.exportPath, content });
    }
    files.push({ path: 'CHECKPOINT.md', content: `# ${payload.projectName}\n\n${payload.summary}\n\n${payload.milestones.map(m => `## ${m.title}\n\nStatus at export selection: ${m.status}\n`).join('\n')}\n## Selected versions\n\n${payload.outputs.map(o => `- ${o.exportPath} · v${o.version.version} · ${o.version.status} · SHA-256 ${o.version.hash}`).join('\n')}\n` });
    files.push({ path: 'manifest.json', content: JSON.stringify({ format: 'project-team-checkpoint-v1', ...payload }, null, 2) + '\n' });
    return files;
  }
  async preview(input: CheckpointSelection): Promise<CheckpointPreview> {
    const project = this.store.project(); if (!project) throw new AppError('project_required');
    if (!Array.isArray(input.outputIds) || !input.outputIds.length || input.outputIds.length > 10 || new Set(input.outputIds).size !== input.outputIds.length || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 4000) throw new AppError('invalid_checkpoint');
    const repository = this.demo ? 'demo/project-team' : await this.destination(project.folder);
    const outputs = input.outputIds.map(id => {
      const version = typeof id === 'string' ? this.store.read<OutputVersion>('outputs', id) : null;
      if (!version) throw new AppError('output_not_found', 404);
      // Validate even historical metadata; never export a protected path from an older snapshot.
      const path = version.path === null ? 'review.md' : exportPath(version.path);
      return { version, author: this.store.read<Agent>('agents', version.authorId)?.name ?? 'Manager', exportPath: `outputs/${version.id}/${path}` };
    }).sort((a, b) => a.version.id.localeCompare(b.version.id));
    if (outputs.reduce((size, o) => size + o.version.bytes, 0) > 1_048_576) throw new AppError('checkpoint_too_large');
    const ids = new Set(outputs.map(o => o.version.milestoneId));
    const milestones = this.store.all<Milestone>('milestones').filter(m => ids.has(m.id)).map(({ id, title, status, outputIds, acceptedIds }) => ({ id, title, status, outputIds, acceptedIds }));
    const payload = { repository, projectName: project.name, summary: input.summary.trim(), outputs, milestones };
    return { payload, hash: digest(payload), files: await this.files(payload) };
  }
  async create(input: CheckpointSelection & { id: string; previewHash: string }) {
    commandId(input.id);
    if (this.store.read('checkpoints', input.id)) return;
    if (this.stopping()) throw new AppError('coordinator_stopping', 409);
    const preview = await this.preview(input);
    if (this.store.read('checkpoints', input.id)) return;
    if (this.stopping()) throw new AppError('coordinator_stopping', 409);
    if (this.active) throw new AppError('checkpoint_busy', 409);
    if (input.previewHash !== preview.hash) throw new AppError('stale_checkpoint', 409);
    this.guardStorage();
    this.store.once(input.id, () => {
      this.store.write('checkpoints', input.id, { id: input.id, payload: preview.payload, hash: preview.hash, branch: `codex/checkpoint-${input.id}`, createdAt: new Date().toISOString(), status: 'unsynced', attempts: 0, error: null, commit: null, url: null, demo: this.demo } satisfies GitHubCheckpoint);
    });
    if (this.store.read('checkpoints', input.id)) this.start(input.id);
  }
  retry(input: { id: string; checkpointId: string }) {
    commandId(input.id);
    if (this.store.read('settings', `command:${input.id}`)) return;
    if (this.storageBusy()) throw new AppError('storage_busy', 409);
    if (this.stopping()) throw new AppError('coordinator_stopping', 409);
    if (this.active) throw new AppError('checkpoint_busy', 409);
    const record = this.store.read<GitHubCheckpoint>('checkpoints', input.checkpointId);
    if (!record || record.status !== 'unsynced' || record.attempts >= CHECKPOINT_ATTEMPTS || record.demo !== this.demo) throw new AppError('checkpoint_retry_unavailable', 409);
    this.store.once(input.id, () => {}); this.start(record.id);
  }
  check(input: { id: string; checkpointId: string }) {
    commandId(input.id);
    if (this.store.read('settings', `command:${input.id}`)) return;
    if (this.storageBusy()) throw new AppError('storage_busy', 409);
    if (this.stopping()) throw new AppError('coordinator_stopping', 409);
    if (this.active) throw new AppError('checkpoint_busy', 409);
    const record = this.store.read<GitHubCheckpoint>('checkpoints', input.checkpointId);
    if (!record || record.status !== 'unsynced' || !record.commit || record.demo !== this.demo) throw new AppError('checkpoint_retry_unavailable', 409);
    this.store.once(input.id, () => {}); this.start(record.id, true);
  }
  start(id: string, checkOnly = false) {
    let record = this.store.read<GitHubCheckpoint>('checkpoints', id)!;
    record = { ...record, status: 'syncing', attempts: record.attempts + (checkOnly ? 0 : 1), error: null };
    this.store.write('checkpoints', id, record);
    this.active = (async () => {
      try {
        if (digest(record.payload) !== record.hash) throw new AppError('snapshot_changed');
        const files = await this.files(record.payload);
        if (this.demo) {
          await new Promise(resolve => setTimeout(resolve, 250));
          record = { ...record, commit: digest(files).slice(0, 40) };
        } else {
          const signal = AbortSignal.timeout(60000);
          const existing = await this.remote.find(record, signal);
          if (existing) {
            if (!record.commit || existing !== record.commit) throw new AppError('github_ref_conflict');
          } else {
            if (checkOnly) throw new AppError('checkpoint_not_published');
            if (!record.commit) {
              record = { ...record, commit: await this.remote.commit(record, files, signal) };
              // Journal the commit before creating a visible reference. Lost acknowledgements are safe to reconcile.
              this.store.write('checkpoints', id, record);
            }
            await this.remote.publish(record, signal);
            if (await this.remote.find(record, signal) !== record.commit) throw new AppError('github_ref_conflict');
          }
        }
        this.store.write('checkpoints', id, { ...record, status: 'synced', error: null, url: this.demo ? null : `https://github.com/${record.payload.repository}/tree/${record.branch}` });
        this.store.log(this.demo ? 'Demo checkpoint saved. Nothing was sent to GitHub.' : 'Selected deliverable versions recorded in a GitHub checkpoint.');
      } catch (error) {
        this.store.write('checkpoints', id, { ...record, status: 'unsynced', error: failure(error) });
        this.store.log('Checkpoint is unsynced. Local versions remain saved; review it before retrying.');
      } finally { this.active = null; this.notify(); }
    })();
    this.notify();
  }
  async drain() { await this.active; }
}
