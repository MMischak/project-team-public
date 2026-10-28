import type { Agent, PlanProposal, TaskResult } from './types.ts';
import { AppError } from './types.ts';

export function projectPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 240 || value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.split('/').some(part => !part || ['.', '..', '.git', '.codex', '.agents', '.aws'].includes(part) || /^\.env(?:\.|$)/.test(part))) throw new AppError('invalid_output_path');
  return value;
}
function record(value: any, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) throw new AppError('invalid_agent_result');
}
function text(value: any, max = 8000) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError('invalid_agent_result'); return value.trim(); }
function list(value: any, max: number) { if (!Array.isArray(value) || value.length > max) throw new AppError('invalid_agent_result'); return value; }
function identifier(value: any) { if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(value)) throw new AppError('invalid_agent_result'); return value; }
export function parsePlan(source: string, agents: Agent[]): PlanProposal {
  let proposal: any; try { proposal = JSON.parse(source); } catch { throw new AppError('invalid_agent_result'); }
  record(proposal, ['summary', 'milestones', 'suggestedHires']); text(proposal.summary, 4000);
  const tasks = new Map<string, any>(), milestones = new Set<string>(), owner = new Map<string, string>();
  for (const milestone of list(proposal.milestones, 5)) {
    record(milestone, ['id', 'title', 'tasks']); identifier(milestone.id); text(milestone.title, 160);
    if (milestones.has(milestone.id) || !milestone.tasks?.length) throw new AppError('invalid_agent_result'); milestones.add(milestone.id);
    for (const task of list(milestone.tasks, 12)) {
      record(task, ['id', 'title', 'instruction', 'role', 'agentId', 'dependencies', 'estimateTokens', 'outputs']);
      identifier(task.id); text(task.title, 160); text(task.instruction);
      if (tasks.has(task.id) || !['builder', 'reviewer'].includes(task.role) || !Number.isSafeInteger(task.estimateTokens) || task.estimateTokens < 1000 || task.estimateTokens > 200000) throw new AppError('invalid_agent_result');
      if (task.agentId !== null && !agents.some(agent => agent.id === task.agentId && agent.role === task.role)) throw new AppError('unhired_agent');
      list(task.dependencies, 12).forEach(identifier); list(task.outputs, 12).forEach(projectPath);
      if (task.role === 'builder' && !task.outputs.length || task.role === 'reviewer' && (!task.dependencies.length || task.outputs.length)) throw new AppError('invalid_agent_result');
      tasks.set(task.id, task); owner.set(task.id, milestone.id);
    }
  }
  if (!tasks.size || tasks.size > 20) throw new AppError('invalid_agent_result');
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id) || !tasks.has(id)) throw new AppError('invalid_dependencies'); if (visited.has(id)) return; visiting.add(id); for (const dependency of tasks.get(id).dependencies) visit(dependency); visiting.delete(id); visited.add(id); };
  for (const id of tasks.keys()) visit(id);
  // Task-level acyclicity alone does not rule out circular acceptance gates.
  const gates = new Map([...milestones].map(id => [id, new Set<string>()]));
  for (const [id, task] of tasks) for (const dependency of task.dependencies) if (owner.get(id) !== owner.get(dependency)) gates.get(owner.get(id)!)!.add(owner.get(dependency)!);
  visiting.clear(); visited.clear();
  const visitGate = (id: string) => { if (visiting.has(id)) throw new AppError('invalid_dependencies'); if (visited.has(id)) return; visiting.add(id); for (const dependency of gates.get(id)!) visitGate(dependency); visiting.delete(id); visited.add(id); };
  for (const id of milestones) visitGate(id);
  for (const hire of list(proposal.suggestedHires, 5)) { record(hire, ['role', 'responsibility', 'reason']); text(hire.role, 100); text(hire.responsibility, 1000); text(hire.reason, 1000); }
  return proposal;
}
export function parseTaskResult(source: string, allowedOutputs: string[], reviewer: boolean): TaskResult {
  let result: any; try { result = JSON.parse(source); } catch { throw new AppError('invalid_agent_result'); }
  record(result, ['summary', 'outputs', 'verdict', 'findings', 'alternatives']); text(result.summary, 4000);
  if (!['ready', 'changes', 'conflict'].includes(result.verdict) || typeof result.findings !== 'string' || result.findings.length > 16000) throw new AppError('invalid_agent_result');
  const submitted = new Set<string>();
  for (const output of list(result.outputs, 12)) {
    record(output, ['path', 'url', 'title']); text(output.title, 160);
    if (reviewer || output.url !== null || !allowedOutputs.includes(projectPath(output.path)) || submitted.has(output.path)) throw new AppError('unexpected_output'); submitted.add(output.path);
  }
  if (!reviewer && result.verdict !== 'conflict' && allowedOutputs.some(path => !submitted.has(path))) throw new AppError('missing_output');
  for (const alternative of list(result.alternatives, 5)) { record(alternative, ['label', 'reasoning', 'instruction']); text(alternative.label, 160); text(alternative.reasoning, 4000); text(alternative.instruction); }
  if (result.verdict === 'conflict' ? result.alternatives.length < 2 : result.alternatives.length !== 0) throw new AppError('invalid_agent_result');
  return result;
}
export function parseRevision(source: string): { summary: string; instruction: string; estimateTokens: number } {
  let result: any; try { result = JSON.parse(source); } catch { throw new AppError('invalid_agent_result'); }
  record(result, ['summary', 'instruction', 'estimateTokens']); text(result.summary, 4000); text(result.instruction);
  if (!Number.isSafeInteger(result.estimateTokens) || result.estimateTokens < 1000 || result.estimateTokens > 200000) throw new AppError('invalid_agent_result'); return result;
}

const str = { type: 'string' }, integer = { type: 'integer' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const array = (items: unknown) => ({ type: 'array', items });
export const planSchema = object({ summary: str, milestones: array(object({ id: str, title: str, tasks: array(object({ id: str, title: str, instruction: str, role: { enum: ['builder', 'reviewer'], type: 'string' }, agentId: { type: ['string', 'null'] }, dependencies: array(str), estimateTokens: integer, outputs: array(str) })) })), suggestedHires: array(object({ role: str, responsibility: str, reason: str })) });
export const taskSchema = object({ summary: str, outputs: array(object({ path: { type: ['string', 'null'] }, url: { type: ['string', 'null'] }, title: str })), verdict: { type: 'string', enum: ['ready', 'changes', 'conflict'] }, findings: str, alternatives: array(object({ label: str, reasoning: str, instruction: str })) });
export const revisionSchema = object({ summary: str, instruction: str, estimateTokens: integer });
