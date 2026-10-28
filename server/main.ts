import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store } from './store.ts';
import { CodexTeam } from './codex-team.ts';
import { DemoTeam } from './demo-team.ts';
import { MeetingCoordinator } from './meeting-coordinator.ts';
import { serverFor } from './http.ts';

const flags = process.argv.slice(2);
const value = (flag: string) => { const index = flags.indexOf(flag); return index < 0 ? undefined : flags[index + 1]; };
const demo = flags.includes('--demo');
const port = Number(value('--port') ?? process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535.');
if (value('--host') && !['127.0.0.1', 'localhost'].includes(value('--host')!)) throw new Error('Project Team binds only to loopback.');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultState = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Project Team') : join(homedir(), '.local', 'share', 'project-team');
const stateDir = resolve(value('--state-dir') ?? process.env.PROJECT_TEAM_STATE_DIR ?? join(defaultState, demo ? 'demo' : 'live'));
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const lockPath = join(stateDir, 'coordinator.lock');
try {
  const previous = Number(await readFile(lockPath, 'utf8'));
  try { process.kill(previous, 0); console.error('Project Team is already running for this saved workspace.'); process.exit(1); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
  await unlink(lockPath);
} catch (error: any) { if (error.code !== 'ENOENT') throw error; }
const lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.close();
const store = new Store(join(stateDir, 'project-team.sqlite'));
const coordinator = new MeetingCoordinator(store, demo ? new DemoTeam(store) : new CodexTeam(stateDir), demo);
await coordinator.cleanupStorage(true);
const storageTimer = setInterval(() => { if (!coordinator.stopping && !coordinator.storage.cleaning) coordinator.checkStorage(); }, 10000); storageTimer.unref();
const vite = flags.includes('--dev') ? await (await import('vite')).createServer({ root, server: { middlewareMode: true }, appType: 'spa' }) : null;
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return; shuttingDown = true;
  clearInterval(storageTimer);
  try { await coordinator.stop(); await coordinator.cleanupStorage(true); } catch { console.error('Services stopped, but saved state needs attention. Check available disk space.'); }
  server.close(); server.closeAllConnections(); await vite?.close();
  try { store.close(); } catch { console.error('The saved database could not close cleanly. Reopen after resolving the storage error.'); }
  await unlink(lockPath).catch(() => {});
};
const server = serverFor(coordinator, { port, root, demo, devHandler: vite?.middlewares, onStop: () => { void shutdown(); } });
server.on('error', async () => { console.error('Could not start Project Team. Check whether the port is already in use.'); await shutdown(); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Project Team${demo ? ' · DEMO, no AI provider' : ''} is open at ${url}\nStop in the interface or press Ctrl+C. Closing the browser keeps it running.`);
  if (flags.includes('--open') && process.platform === 'darwin') {
    const opener = spawn('open', [url], { stdio: 'ignore' }); opener.on('error', () => {});
  }
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown(); });
