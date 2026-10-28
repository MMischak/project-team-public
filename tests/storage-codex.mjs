import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const path = process.argv[2];
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line); if (id === undefined) return;
  appendFileSync(path + '.calls', method + '\n');
  let result = {};
  if (method === 'config/read') result = { config: { features: Object.fromEntries(['shell_tool','multi_agent','apps','plugins','computer_use','code_mode_host','browser_use','in_app_browser','hooks'].map(key => [key, false])) } };
  if (method === 'account/read') result = { account: { type: 'chatgpt' } };
  if (method === 'thread/list') result = { data: JSON.parse(readFileSync(path, 'utf8')), nextCursor: null };
  if (method === 'thread/read') result = { thread: JSON.parse(readFileSync(path, 'utf8')).find(thread => thread.id === params.threadId) };
  if (method === 'thread/delete') { const threads = JSON.parse(readFileSync(path, 'utf8')); writeFileSync(path, JSON.stringify(threads.filter(thread => thread.id !== params.threadId))); }
  process.stdout.write(JSON.stringify({ id, result }) + '\n');
});
