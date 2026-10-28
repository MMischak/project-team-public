import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let turnCount = 0;
let accountReads = 0;
const turns = [];
const testCase = process.env.PROJECT_TEAM_TEST_CASE;
if (testCase === 'publishing-env' && ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'].some(key => process.env[key])) process.exit(2);
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'account/read' && ++accountReads > 1 && testCase === 'disconnect-account') process.exit(0);
  if (method === 'thread/start' && testCase === 'disconnect-thread') process.exit(0);
  if (method === 'turn/start' && testCase === 'disconnect-dispatch') process.exit(0);
  let result = {};
  if (method === 'config/read') result = { config: { features: Object.fromEntries(['shell_tool', 'multi_agent', 'apps', 'plugins', 'computer_use', 'code_mode_host', 'browser_use', 'in_app_browser', 'hooks'].map(name => [name, testCase === 'unsafe-tools' ? true : false])), mcp_servers: { inherited: { token: 'FAKE-PRIVATE-CONFIG' } } } };
  if (method === 'account/read') result = { account: testCase === 'signed-out' ? null : { type: testCase === 'api-auth' ? 'apiKey' : 'chatgpt', email: 'FAKE-PRIVATE-EMAIL' } };
  if (method === 'account/rateLimits/read') result = { rateLimits: { primary: { usedPercent: 71, windowDurationMins: 10080, resetsAt: 1791225900 }, credits: { balance: 'FAKE-PRIVATE-BALANCE' } } };
  if (method === 'thread/start' || method === 'thread/resume') result = { thread: { id: 'fixture-thread' }, modelProvider: 'openai', model: 'fixture-model' };
  if (method === 'thread/read') result = { thread: { id: 'fixture-thread', status: { type: 'idle' } } };
  if (method === 'thread/turns/list') result = { data: params.cursor ? turns : [], nextCursor: params.cursor ? null : 'older', backwardsCursor: null };
  if (method === 'turn/start') {
    const turnId = `fixture-${++turnCount}`;
    turns.push({ id: turnId, status: 'completed', itemsView: 'full', items: [{ type: 'userMessage', content: params.input }, { type: 'agentMessage', phase: 'final_answer', text: `Saved conversation ${turnCount}.` }] });
    if (testCase === 'evicted-event' && turnCount === 35) send({ method: 'thread/tokenUsage/updated', params: { turnId: 'fixture-1', tokenUsage: { total: { totalTokens: 900000 } } } });
    if (testCase === 'tool-activity') send({ method: 'item/started', params: { turnId, item: { type: 'commandExecution' } } });
    else {
      send({ method: 'item/agentMessage/delta', params: { turnId, itemId: 'answer', delta: 'Saved ' } });
      send({ method: 'item/completed', params: { turnId, item: { id: 'answer', type: 'agentMessage', text: `Saved conversation ${turnCount}.` } } });
      send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { total: { totalTokens: turnCount * 1200 } } } });
      // Completion deliberately precedes the turn/start response.
      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed', items: [] } } });
    }
    result = { turn: { id: turnId } };
  }
  send({ id, result });
});
