import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DemoManager, inspectTurns } from './codex.ts';
import { confinedPath } from './artifacts.ts';
import type { Agent, TeamTurn, TurnCallbacks, MeetingConversation } from './types.ts';
import { Store } from './store.ts';

// Deliberately deterministic, opt-in simulation. Never a fallback for a real turn.
export class DemoTeam extends DemoManager {
  totals = new Map<string, number>();
  delay = 150;
  store: Store;
  constructor(store: Store) {
    super(store.project()?.lastTotal);
    this.store = store;
    if (store.project()?.threadId) this.totals.set(store.project()!.threadId!, this.total);
    for (const agent of store.all<Agent>('agents')) if (agent.threadId) this.totals.set(agent.threadId, agent.lastTotal);
    for (const conversation of store.all<MeetingConversation>('conversations')) if (conversation.threadId) this.totals.set(conversation.threadId, conversation.lastTotal);
  }
  async models() { return [{ model: 'demo', name: 'Demo member · no AI', description: 'Simulated note writer and reviewer for trying the workflow.', efforts: ['demo'], defaultEffort: 'demo', isDefault: true }]; }
  saveTurn(thread: string, turn: unknown) { const turns = this.store.read<any[]>('settings', `demo-history:${thread}`) ?? []; this.store.write('settings', `demo-history:${thread}`, [...turns.filter(saved => saved.id !== (turn as any).id), turn]); }
  async inspect(thread: string, turn: string | null, prompt: string | null) { return inspectTurns(this.store.read<any[]>('settings', `demo-history:${thread}`) ?? [], turn, prompt); }
  async chat(...args: Parameters<DemoManager['chat']>) {
    const [threadId, prompt, onThread, onTurn, onEvent] = args; let thread = threadId ?? 'demo-thread';
    const result = await super.chat(threadId, prompt, id => { thread = id; onThread(id); }, id => { this.saveTurn(thread, { id, status: 'inProgress', items: [{ type: 'userMessage', content: [{ type: 'text', text: prompt }] }] }); onTurn(id); }, onEvent);
    this.saveTurn(thread, { id: result.turnId, status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: prompt }] }, { type: 'agentMessage', phase: 'final_answer', text: result.text }] }); return result;
  }
  async perform(input: TeamTurn, callbacks: TurnCallbacks) {
    const thread = input.threadId ?? `demo-${randomUUID()}`, turnId = randomUUID();
    callbacks.onThread(thread); callbacks.onDispatchAttempt(); callbacks.onTurn(turnId);
    this.saveTurn(thread, { id: turnId, status: 'inProgress', items: [{ type: 'userMessage', content: [{ type: 'text', text: input.prompt }] }] });
    await new Promise(resolve => setTimeout(resolve, this.delay));
    const data = JSON.parse(input.prompt); let result: unknown;
    if (input.kind === 'meeting') result = { reply: `Demo ${data.speaker.name}: ${data.speaker.role === 'reviewer' ? 'I would check clarity and the exact saved output before acceptance.' : data.speaker.role === 'builder' ? 'I would keep the next deliverable small and make its next step clear.' : 'Let’s compare the team’s views. Ask me to summarize proposed actions when you are ready.'} This is discussion; no work or approvals changed. No AI is used.` };
    else if (input.kind === 'meeting-summary') {
      const source = data.state.tasks.find((task: any) => task.role === 'builder' && !data.state.milestones.some((milestone: any) => milestone.id === task.milestoneId && milestone.status === 'accepted'));
      result = { summary: source ? 'Demo proposal: add a clear next step to the note and repeat its dependent review. Your confirmation is required.' : 'Demo summary: keep the next deliverable small. No project changes are proposed.', actions: source ? [{ kind: 'revise', taskId: source.id, instruction: `${source.instruction}\nAdd a clear next step discussed in the meeting.`, estimateTokens: 2000 }] : [] };
    } else if (input.kind === 'plan') {
      const agents = data.agents as Agent[];
      result = { summary: 'Demo plan: write a short project note, then review its captured version. No AI is used.', suggestedHires: ['builder', 'reviewer'].filter(role => !agents.some(agent => agent.role === role)).map(role => ({ role, responsibility: `${role} for the demo note`, reason: 'This demo task needs a user-selected member.' })), milestones: [{ id: 'note', title: 'A usable project note', tasks: [
        { id: 'write-note', title: 'Write the note', instruction: 'Write a short note about the project goal. This is a demo.', role: 'builder', agentId: agents.find(agent => agent.role === 'builder')?.id ?? null, dependencies: [], estimateTokens: 2000, outputs: ['team-note.md'] },
        { id: 'review-note', title: 'Review the note', instruction: 'Check the exact captured note for clarity.', role: 'reviewer', agentId: agents.find(agent => agent.role === 'reviewer')?.id ?? null, dependencies: ['write-note'], estimateTokens: 2000, outputs: [] },
      ] }] };
    } else if (input.kind === 'revision') result = { summary: 'Demo: the responsible builder will make your requested change, then the reviewer will check the new version.', instruction: `Revise the declared note. User feedback: ${data.feedback}`, estimateTokens: 2000 };
    else {
      if (input.kind === 'builder') for (const path of input.allowedOutputs) {
        const target = await confinedPath(input.folder, path, true);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, `# ${data.project.name}\n\n${data.project.brief}\n\nDemo output · no AI\n\n${data.task.instruction}\n${data.task.feedback ? `\nUser feedback: ${data.task.feedback}\n` : ''}`);
      }
      result = { summary: input.kind === 'builder' ? 'Demo note saved.' : 'Demo review saved for the exact handed-off versions.', outputs: input.allowedOutputs.map(path => ({ path, url: null, title: 'Project note' })), verdict: 'ready', findings: input.kind === 'reviewer' ? `Demo check: ${input.inputs.map(item => `${item.version.title} v${item.version.version}`).join(', ')}. The note describes the project goal.` : '', alternatives: [] };
    }
    const total = (this.totals.get(thread) ?? (thread === 'demo-thread' ? this.total : 0)) + 900;
    this.totals.set(thread, total); if (['plan', 'revision'].includes(input.kind)) this.total = total;
    const text = JSON.stringify(result);
    this.saveTurn(thread, { id: turnId, status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: input.prompt }] }, { type: 'agentMessage', phase: 'final_answer', text }] });
    callbacks.onEvent({ kind: 'usage', turnId, total }); return { text, turnId };
  }
  async readFile(folder: string, path: string) { return readFile(await confinedPath(folder, path), 'utf8'); }
}
