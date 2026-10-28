import type { MeetingAction } from './types.ts';
import { AppError } from './types.ts';

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' }, integer = { type: 'integer' };
export const meetingReplySchema = object({ reply: string });
export const meetingSummarySchema = object({ summary: string, actions: { type: 'array', items: { anyOf: [
  object({ kind: { type: 'string', enum: ['assign'] }, taskId: string, agentId: string, priority: integer }),
  object({ kind: { type: 'string', enum: ['revise'] }, taskId: string, instruction: string, estimateTokens: integer }),
  object({ kind: { type: 'string', enum: ['brief'] }, instruction: string }),
  object({ kind: { type: 'string', enum: ['budget'] }, credits: { type: 'number' } }),
] } } });

function record(value: any, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new AppError('invalid_meeting_result');
}
function text(value: unknown, max: number) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError('invalid_meeting_result'); }
export function parseMeetingResult(source: string, summary: boolean): { text: string; actions: MeetingAction[] } {
  let value: any; try { value = JSON.parse(source); } catch { throw new AppError('invalid_meeting_result'); }
  if (!summary) { record(value, ['reply']); text(value.reply, 8000); return { text: value.reply.trim(), actions: [] }; }
  record(value, ['summary', 'actions']); text(value.summary, 4000);
  if (!Array.isArray(value.actions) || value.actions.length > 5) throw new AppError('invalid_meeting_result');
  const targets = new Set<string>();
  for (const action of value.actions) {
    switch (action?.kind) {
      case 'assign': record(action, ['kind', 'taskId', 'agentId', 'priority']); text(action.taskId, 160); text(action.agentId, 80); if (!Number.isInteger(action.priority) || action.priority < 0 || action.priority > 100) throw new AppError('invalid_meeting_result'); break;
      case 'revise': record(action, ['kind', 'taskId', 'instruction', 'estimateTokens']); text(action.taskId, 160); text(action.instruction, 8000); if (!Number.isSafeInteger(action.estimateTokens) || action.estimateTokens < 1000 || action.estimateTokens > 200000) throw new AppError('invalid_meeting_result'); break;
      case 'brief': record(action, ['kind', 'instruction']); text(action.instruction, 8000); break;
      case 'budget': record(action, ['kind', 'credits']); if (!Number.isFinite(action.credits) || action.credits < 1 || action.credits > 1000000) throw new AppError('invalid_meeting_result'); break;
      default: throw new AppError('invalid_meeting_result');
    }
    const key = 'taskId' in action ? action.taskId : action.kind;
    if (targets.has(key)) throw new AppError('invalid_meeting_result'); targets.add(key);
  }
  return { text: value.summary.trim(), actions: value.actions };
}
