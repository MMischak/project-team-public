// Isolated browser fixture. The abrupt exit lives here, never in the production server.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.ts';
import { TeamCoordinator } from '../server/team-coordinator.ts';
import { DemoTeam } from '../server/demo-team.ts';
import { serverFor } from '../server/http.ts';

const [stateDir, folder, portValue] = process.argv.slice(2), port = Number(portValue), root = fileURLToPath(new URL('..', import.meta.url));
const store = new Store(join(stateDir, 'project-team.sqlite')), provider = new DemoTeam(store), coordinator = new TeamCoordinator(store, provider, true);
await coordinator.configure({ name: 'Browser recovery', brief: 'Completed work must survive an abrupt coordinator exit.', folder, credits: 500 }); await coordinator.connect();
for (const role of ['builder', 'reviewer']) coordinator.hire({ id: randomUUID(), name: `Demo ${role}`, role, responsibility: role, model: 'demo', effort: 'demo' });
coordinator.mode('running'); coordinator.proposePlan({ id: randomUUID(), instruction: '' }); await coordinator.active; coordinator.mode('paused'); coordinator.approvePlan({ id: randomUUID(), planId: store.all('plans')[0].id });
const finish = store.finish.bind(store);
store.finish = (...args) => { if (args[0].startsWith('task:') && args[1] === 'complete') process.exit(75); return finish(...args); };
const server = serverFor(coordinator, { port, root, demo: true });
server.listen(port, '127.0.0.1', () => console.log('Recovery fixture is open'));
