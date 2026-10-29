export type Project = { name: string; brief: string; folder: string; credits: number; mode: 'paused' | 'running' | 'recovery' | 'stopped'; threadId: string | null; lastTotal: number };
export type Message = { id: string; role: 'user' | 'assistant'; text: string; status: 'complete' | 'pending' | 'failed' | 'interrupted'; createdAt: string; attachment: string | null };
export type Step = { id: string; messageId: string | null; agentId?: string; taskId?: string; conversationId?: string; meetingTurnId?: string; kind?: 'plan' | 'revision' | 'task' | 'meeting' | 'meeting-summary'; turnId: string | null; threadId: string | null; baseline: number; reserved: number; used: number; estimated: boolean; dispatchAttempted?: boolean; status: 'reserved' | 'dispatched' | 'complete' | 'failed' | 'interrupted' };
export type Meeting = { id: string; title: string; participantIds: string[]; status: 'open' | 'closed'; version: number; createdAt: string };
export type MeetingMessage = { id: string; meetingId: string; speakerId: string; text: string; recipientIds: string[]; attachment: string | null; createdAt: string };
export type MeetingTurn = { id: string; meetingId: string; userMessageId: string; speakerId: string; kind: 'meeting' | 'meeting-summary'; status: 'queued' | 'running' | 'complete' | 'failed' | 'interrupted' | 'cancelled'; createdAt: string; baseHash?: string; retryOf?: string; pauseAfter?: boolean };
export type MeetingConversation = { id: string; meetingId: string; speakerId: string; threadId: string | null; lastTotal: number };
export type MeetingAction = { kind: 'assign'; taskId: string; agentId: string; priority: number } | { kind: 'revise'; taskId: string; instruction: string; estimateTokens: number } | { kind: 'brief'; instruction: string } | { kind: 'budget'; credits: number };
export type MeetingProposal = { id: string; meetingId: string; summary: string; actions: MeetingAction[]; baseHash: string; transcriptVersion: number; status: 'proposed' | 'confirmed' | 'dismissed' | 'superseded' | 'stale'; createdAt: string };
export type MeetingState = { rooms: Meeting[]; messages: MeetingMessage[]; turns: MeetingTurn[]; proposals: MeetingProposal[]; credits: Record<string, { used: number; reserved: number; estimated: number }>; waitingReason: string | null };
export type TurnInspection = { state: 'unknown' | 'active' | 'completed' | 'ended'; turnId?: string; text?: string };
export type RecoveryJournal = { prompt?: string; payload?: unknown; revision?: { taskId: string; milestoneId: string; feedback: string; decisionId?: string }; result?: { text: string; turnId: string }; outputs?: OutputVersion[]; captured?: boolean; afterCrash?: boolean; state?: 'unknown' | 'active' | 'ended' | 'ready' | 'recovered' | 'retry' | 'kept'; summary?: string; retryId?: string };
export type RecoveryItem = { id: string; kind: string; title: string; state: NonNullable<RecoveryJournal['state']>; summary: string; result: string | null; outputs: OutputVersion[]; afterCrash: boolean; used: number; estimated: boolean };
export type ModelChoice = { model: string; name: string; description: string; efforts: string[]; defaultEffort: string; isDefault: boolean };
export type Agent = { avatarId?: string; id: string; name: string; role: 'builder' | 'reviewer'; responsibility: string; model: string; effort: string; threadId: string | null; lastTotal: number; createdAt: string };
export type PlanTask = { id: string; title: string; instruction: string; role: Agent['role']; agentId: string | null; dependencies: string[]; estimateTokens: number; outputs: string[] };
export type PlanMilestone = { id: string; title: string; tasks: PlanTask[] };
export type PlanProposal = { summary: string; milestones: PlanMilestone[]; suggestedHires: { role: string; responsibility: string; reason: string }[] };
export type Plan = PlanProposal & { id: string; status: 'proposed' | 'approved' | 'superseded'; createdAt: string };
export type Task = PlanTask & { planId: string; milestoneId: string; status: 'queued' | 'running' | 'complete' | 'failed' | 'interrupted' | 'decision'; priority: number; attempt: number; outputIds: string[]; inputIds: string[]; summary: string; feedback: string | null; createdAt: string; supersededBy?: string };
export type Milestone = { id: string; planId: string; title: string; status: 'working' | 'review' | 'accepted' | 'decision'; taskIds: string[]; outputIds: string[]; acceptedIds: string[] };
export type OutputVersion = { id: string; path: string | null; url: string | null; title: string; version: number; hash: string; authorId: string; taskId: string; milestoneId: string; status: 'draft' | 'accepted'; bytes: number; createdAt: string; recovery?: { stepId: string; capturedAfterInterruption: boolean } };
export type Handoff = { id: string; taskId: string; agentId: string; outputId: string; draft: boolean; createdAt: string };
export type Review = { id: string; taskId: string; agentId: string; outputIds: string[]; verdict: 'ready' | 'changes' | 'conflict'; findings: string; createdAt: string };
export type Decision = { id: string; taskId: string; title: string; alternatives: { label: string; reasoning: string; instruction: string }[]; status: 'open' | 'resolved'; resolution: string | null };
export type TeamState = { models: ModelChoice[]; agents: Agent[]; plans: Plan[]; tasks: Task[]; milestones: Milestone[]; outputs: OutputVersion[]; handoffs: Handoff[]; reviews: Review[]; decisions: Decision[]; activeTask: string | null; agentCredits: Record<string, number>; waitingReason: string | null };
export type QuotaWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
export type Connection = { status: 'offline' | 'connecting' | 'ready' | 'sign_in_required' | 'wrong_authentication' | 'unavailable'; quota: QuotaWindow[]; model: string | null; error: string | null };
export type StoragePolicy = { appMiB: number; projectMiB: number; logsMiB: number; retentionDays: number };
export type StorageUsage = { policy: StoragePolicy; appBytes: number; projectBytes: number; databaseBytes: number; snapshotBytes: number; runtimeBytes: number; reclaimableBytes: number; status: 'ok' | 'warning' | 'blocked' | 'unavailable'; reason: string | null; checkedAt: string | null; cleaning: boolean; lastCleanup: { at: string; files: number; records: number; nativeThreads: number; warning?: string } | null };
export type WorkspaceProject = { id: string; name: string; brief: string; folder: string; credits: number; mode: Project['mode']; createdAt: string; updatedAt: string };
export type WorkspaceState = { projects: WorkspaceProject[]; activeProjectId: string | null; switching: boolean };
export type Snapshot = { workspace?: WorkspaceState; revision?: { instanceId: string; sequence: number }; project: Project | null; messages: Message[]; credits: { used: number; reserved: number; available: number; estimated: number }; connection: Connection; busy: boolean; stopping: boolean; demo: boolean; activity: { text: string; createdAt: string }[]; team: TeamState; recovery: RecoveryItem[]; meetings: MeetingState; checkpoints: GitHubCheckpoint[]; storage?: StorageUsage };

export type CheckpointPayload = {
  repository: string; projectName: string; summary: string;
  outputs: { version: OutputVersion; author: string; exportPath: string }[];
  milestones: Pick<Milestone, 'id' | 'title' | 'status' | 'outputIds' | 'acceptedIds'>[];
};
export type CheckpointFile = { path: string; content: string };
export type CheckpointPreview = { payload: CheckpointPayload; hash: string; files: CheckpointFile[] };
export type GitHubCheckpoint = {
  id: string; payload: CheckpointPayload; hash: string; branch: string; createdAt: string;
  status: 'syncing' | 'unsynced' | 'synced'; attempts: number; error: string | null;
  commit: string | null; url: string | null; demo: boolean;
};
export type ProviderEvent = { kind: 'text'; turnId: string; text: string } | { kind: 'usage'; turnId: string; total: number };
export type TaskResult = { summary: string; outputs: { path: string | null; url: string | null; title: string }[]; verdict: 'ready' | 'changes' | 'conflict'; findings: string; alternatives: Decision['alternatives'] };
export type TurnCallbacks = { onThread: (id: string) => void; onTurn: (id: string) => void; onEvent: (event: ProviderEvent) => void; onDispatchAttempt: () => void };
export type TeamTurn = { kind: 'plan' | 'revision' | 'builder' | 'reviewer' | 'meeting' | 'meeting-summary'; threadId: string | null; model: string | null; effort: string | null; prompt: string; outputSchema: unknown; folder: string; inputs: { version: OutputVersion; content: string }[]; allowedOutputs: string[] };
export interface ManagerProvider {
  setStorageGuard?(guard: () => void, legacyThreads: string[]): void;
  cleanupStorage?(protectedThreads: Set<string>, before: number, forget: (id: string) => void): Promise<string[]>;
  closeForStorage?(): Promise<void>;
  connect(): Promise<Connection>;
  chat(threadId: string | null, prompt: string, onThread: (id: string) => void, onTurn: (id: string) => void, onEvent: (event: ProviderEvent) => void, onDispatchAttempt?: () => void): Promise<{ text: string; turnId: string; connection?: Connection }>;
  close(): void;
  configureProject?(folder: string): Promise<void>;
  models?(): Promise<ModelChoice[]>;
  perform?(input: TeamTurn, callbacks: TurnCallbacks): Promise<{ text: string; turnId: string; connection?: Connection }>;
  readFile?(folder: string, path: string): Promise<string>;
  inspect?(threadId: string, turnId: string | null, prompt: string | null, worker: boolean): Promise<TurnInspection>;
}
export class AppError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}
