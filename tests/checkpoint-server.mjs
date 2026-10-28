// Browser-only deterministic remote fixture. It cannot contact GitHub or an AI provider.
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { DemoTeam } from '../server/demo-team.ts';
import { MeetingCoordinator } from '../server/meeting-coordinator.ts';
import { GitHubRemote, GitHubError } from '../server/github.ts';
import { AppError } from '../server/types.ts';
import { serverFor } from '../server/http.ts';
const [directory, root] = process.argv.slice(2), store = new Store(join(directory, 'fixture.sqlite'));
const coordinator = new MeetingCoordinator(store, new DemoTeam(store), true);
coordinator.checkpoints.demo = false;
coordinator.checkpoints.destination = async () => 'fixture/checkpoints';
coordinator.checkpoints.remote = new GitHubRemote(async (method, path, input) => {
  const refs = store.read('settings', 'fixture-refs') ?? {};
  if (method === 'GET' && path.includes('/git/ref/')) {
    const branch = path.split('/git/ref/heads/')[1];
    if (!refs[branch]) throw new GitHubError('github_unavailable', 404);
    return { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: refs[branch] } };
  }
  if (path.endsWith('/git/trees')) { store.write('settings', 'fixture-tree', input); return { sha: 'b'.repeat(40) }; }
  if (path.endsWith('/git/commits')) { store.write('settings', 'fixture-commit-count', (store.read('settings', 'fixture-commit-count') ?? 0) + 1); return { sha: 'a'.repeat(40) }; }
  if (path.endsWith('/git/refs')) {
    await new Promise(resolve => setTimeout(resolve, 600));
    refs[input.ref.slice('refs/heads/'.length)] = input.sha; store.write('settings', 'fixture-refs', refs);
    if (!store.read('settings', 'fixture-lost-ack')) { store.write('settings', 'fixture-lost-ack', true); throw new AppError('github_unavailable'); }
    return {};
  }
  return {};
});
const server = serverFor(coordinator, { port: 4181, root, demo: true, onStop: () => void shutdown() });
let stopping = false;
async function shutdown() { if (stopping) return; stopping = true; await coordinator.stop(); server.close(); server.closeAllConnections(); store.close(); }
server.listen(4181, '127.0.0.1', () => console.log('Checkpoint fixture is open'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown());
