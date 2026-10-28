import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { Coordinator } from './coordinator.ts';
import { TeamCoordinator } from './team-coordinator.ts';
import { MeetingCoordinator } from './meeting-coordinator.ts';
import { AppError } from './types.ts';

async function body(request: IncomingMessage) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new AppError('json_required', 415);
  let value = ''; for await (const chunk of request) { value += chunk.toString(); if (Buffer.byteLength(value) > 20000) throw new AppError('request_too_large', 413); }
  try { const parsed = JSON.parse(value); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); return parsed; } catch { throw new AppError('invalid_json'); }
}
export function serverFor(coordinator: Coordinator, options: { port: number; root: string; demo: boolean; devHandler?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void; onStop?: () => void }) {
  const json = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    const host = request.headers.host;
    const allowed = [`127.0.0.1:${options.port}`, `localhost:${options.port}`];
    if (!allowed.includes(host ?? '')) { json(response, 403, { error: 'invalid_host' }); return; }
    const origin = request.headers.origin;
    if ((origin && !allowed.map(host => `http://${host}`).includes(origin)) || request.headers['sec-fetch-site'] === 'cross-site') { json(response, 403, { error: 'invalid_origin' }); return; }
    const url = new URL(request.url ?? '/', `http://${host}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (request.method === 'GET' && url.pathname.startsWith('/api/output/') && coordinator instanceof TeamCoordinator) {
          const id = url.pathname.slice('/api/output/'.length);
          json(response, 200, { version: coordinator.store.read('outputs', id), content: await coordinator.artifacts.content(id) }); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/state') { json(response, 200, coordinator.snapshot()); return; }
        if (request.method === 'GET' && url.pathname.startsWith('/api/recovery-output/') && coordinator instanceof TeamCoordinator) {
          const id = url.pathname.slice('/api/recovery-output/'.length), output = coordinator.store.recovery().flatMap(item => item.outputs).find(output => output.id === id);
          if (!output) throw new AppError('output_not_found', 404);
          json(response, 200, { version: output, content: await coordinator.artifacts.verify(output) }); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/events') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
          const send = (state: unknown) => response.write(`data: ${JSON.stringify(state)}\n\n`);
          send(coordinator.snapshot()); coordinator.on('state', send);
          const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
          request.on('close', () => { clearInterval(heartbeat); coordinator.off('state', send); }); return;
        }
        if (request.method !== 'POST' || request.headers['x-project-team'] !== '1') throw new AppError('invalid_request', 403);
        const input = await body(request);
        if (url.pathname === '/api/project') await coordinator.configure(input);
        else if (url.pathname === '/api/storage-refresh') coordinator.checkStorage();
        else if (url.pathname === '/api/storage-policy') coordinator.saveStoragePolicy(input);
        else if (url.pathname === '/api/storage-cleanup') await coordinator.cleanupStorage();
        else if (coordinator instanceof TeamCoordinator && url.pathname === '/api/checkpoint-preview') { json(response, 200, await coordinator.checkpoints.preview(input)); return; }
        else if (coordinator instanceof TeamCoordinator && url.pathname === '/api/checkpoint') await coordinator.checkpoints.create(input);
        else if (coordinator instanceof TeamCoordinator && url.pathname === '/api/checkpoint-retry') coordinator.checkpoints.retry(input);
        else if (coordinator instanceof TeamCoordinator && url.pathname === '/api/checkpoint-check') coordinator.checkpoints.check(input);
        else if (url.pathname === '/api/connect') await coordinator.connect();
        else if (url.pathname === '/api/resume') coordinator.mode('running');
        else if (url.pathname === '/api/pause') coordinator.mode('paused');
        else if (url.pathname === '/api/recovery') await coordinator.recoverStep(input);
        else if (url.pathname === '/api/message') coordinator.send(input.id, input.text, input.attachment ?? null);
        else if (coordinator instanceof MeetingCoordinator && url.pathname === '/api/meeting') coordinator.createMeeting(input);
        else if (coordinator instanceof MeetingCoordinator && url.pathname === '/api/meeting-message') coordinator.postMeeting(input);
        else if (coordinator instanceof MeetingCoordinator && url.pathname === '/api/meeting-summary') coordinator.summarizeMeeting(input);
        else if (coordinator instanceof MeetingCoordinator && url.pathname === '/api/meeting-decision') coordinator.decideMeeting(input);
        else if (coordinator instanceof MeetingCoordinator && url.pathname === '/api/meeting-close') coordinator.closeMeeting(input);
        else if (coordinator instanceof TeamCoordinator && url.pathname === '/api/hire') coordinator.hire(input);
        else if (coordinator instanceof TeamCoordinator && url.pathname === '/api/plan') coordinator.proposePlan(input);
        else if (coordinator instanceof TeamCoordinator && url.pathname === '/api/approve-plan') coordinator.approvePlan(input);
        else if (coordinator instanceof TeamCoordinator && url.pathname === '/api/assign') coordinator.assignTask(input);
        else if (coordinator instanceof TeamCoordinator && url.pathname === '/api/accept-milestone') coordinator.acceptMilestone(input);
        else if (coordinator instanceof TeamCoordinator && url.pathname === '/api/revision') coordinator.requestRevision(input);
        else if (coordinator instanceof TeamCoordinator && url.pathname === '/api/resolve-decision') coordinator.resolveDecision(input);
        else if (url.pathname === '/api/stop') { json(response, 202, { stopping: true }); void coordinator.stop().then(() => options.onStop?.(), () => options.onStop?.()); return; }
        else throw new AppError('not_found', 404);
        json(response, 200, coordinator.snapshot()); return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new AppError('not_found', 404);
      const staticResponse = async () => {
        const root = resolve(options.root, 'dist');
        const path = resolve(root, '.' + decodeURIComponent(url.pathname));
        if (path !== root && !path.startsWith(root + sep)) throw new AppError('invalid_path', 403);
        const file = extname(path) ? path : resolve(root, 'index.html');
        const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
        try { const data = await readFile(file); response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }); response.end(request.method === 'HEAD' ? undefined : data); }
        catch { json(response, 404, { error: 'build_required', hint: 'Run npm run build before npm start.' }); }
      };
      if (options.devHandler) options.devHandler(request, response, () => { void staticResponse().catch(() => json(response, 404, { error: 'not_found' })); });
      else await staticResponse();
    } catch (error) { json(response, error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.code : 'internal_error' }); }
  });
}
