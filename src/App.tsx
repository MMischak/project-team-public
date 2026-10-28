import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { UsersThree, FolderSimple, ChatCircle, FileText, Pause, Play, PaperPlaneTilt, GearSix, Database, X, Plus, ArrowRight, WarningCircle, CheckCircle, PlugsConnected, Stop, Paperclip, CircleNotch, ArrowSquareOut, } from '@phosphor-icons/react';
import type { Snapshot } from '../server/types.ts';
import { TeamWorkspace } from './TeamWorkspace.tsx';
import type { CurrentItem } from './TeamWorkspace.tsx';
import { useDialog } from './useDialog.ts';
import { MeetingRoom } from './MeetingRoom.tsx';
import { latestSnapshot } from './snapshot.ts';
import { StoragePanel, storageReasons } from './StoragePanel.tsx';

type State = Snapshot & { draft: string };
const restoreState = (saved: State): State => ({ ...saved, checkpoints: saved.checkpoints ?? [], recovery: saved.recovery ?? [], meetings: saved.meetings ?? { rooms: [], messages: [], turns: [], proposals: [], credits: {}, waitingReason: null } });
const errors: Record<string, string> = {
  ...storageReasons,
  storage_busy: 'Wait for active work or exports to finish before changing storage.',
  invalid_storage_policy: 'Check the storage limits. Diagnostic logs may use at most half the run data budget.',
  storage_native_busy: 'The native service has not stopped yet. Cleanup left its files alone; try again when it ends.',
  storage_path_changed: 'A storage directory changed or became a link. Check its location before continuing.',
  github_origin_required: 'Select a Git repository root with a GitHub origin remote to export a checkpoint.',
  invalid_checkpoint: 'Choose one to ten saved versions and enter a milestone summary.',
  checkpoint_too_large: 'Select at most 1 MiB of saved deliverables per checkpoint.',
  stale_checkpoint: 'The selected versions or project changed. Preview the checkpoint again.',
  checkpoint_busy: 'A checkpoint is exporting. Wait for it to finish before exporting or retrying another.',
  checkpoint_retry_unavailable: 'This checkpoint has finished or reached its three-attempt retry limit.',
  invalid_meeting: 'Choose a meeting title and existing team members.',
  invalid_meeting_message: 'Enter a contribution and choose participants from this meeting.',
  invalid_meeting_result: 'The meeting reply could not be validated. Review its saved attempt before retrying.',
  meeting_closed: 'This meeting is closed. Its transcript remains available.',
  meeting_limit: 'End an open meeting before creating another; up to five can stay open.',
  meeting_queue_full: 'Let queued contributions finish before requesting more replies.',
  meeting_full: 'This meeting is full. End it and open a new discussion.',
  meeting_busy: 'Wait for this meeting’s requested replies before asking for an action summary.',
  meeting_discussion_required: 'Invite a participant to contribute before asking for a summary.',
  stale_meeting_proposal: 'The project or discussion changed. Ask the manager for a fresh proposal.',
  recovery_required: 'Review each interrupted attempt before resuming the project.',
  recovery_unverified: 'The previous turn could not be proved to have ended. Check again; retry remains blocked.',
  stale_recovery: 'This recovery decision changed. Check the current saved turn and snapshots.',
  recovery_context_missing: 'The older attempt has no saved recovery context. Keep it stopped, then discuss a fresh instruction with the manager.',
  pause_for_recovery: 'Pause the project before reviewing interrupted work.',
  project_permissions_unverified: 'The project permission check failed. Team execution is blocked until the local configuration is fixed.',
  project_folder_locked: 'The project folder is fixed after tasks are created. You can still update the brief and credit allowance.',
  choose_builder_output: 'Select the builder output you want changed; this review covers several producing tasks.',
  invalid_agent_result: 'The member returned an invalid result. Work is saved for review and was not retried.',
  output_unavailable: 'The declared output could not be read within the project folder.',
  state_inside_project: 'Keep the coordinator state folder outside the selected project folder.',
  stale_review: 'This review changed. Inspect the current versions before accepting or requesting changes.',
  stale_plan: 'This plan has already changed. Use the current proposal.',
  active_plan: 'Finish or review the current plan before proposing another.',
  snapshot_changed: 'The saved output failed its integrity check.',
  invalid_plan: 'The manager proposal was invalid and was not approved or executed.',
  permission_denied: 'Codex could not start inside this session. Run the app from your normal Terminal to use your existing sign-in.',
  codex_unavailable: 'Codex could not be started. Check its installation, then reconnect.',
  tool_configuration_unverified: 'The installed Codex version could not confirm conversation-only permissions. Chat stays disabled.',
  sign_in_required: 'Sign in with ChatGPT in the official Codex client, then reconnect here.',
  wrong_authentication: 'This connection is not using ChatGPT subscription authentication. Check your Codex sign-in.',
  provider_closed: 'The Codex connection closed. Your conversation is saved. Reconnect and resume when ready.',
  provider_request_rejected: 'Codex rejected a request. Check your local version and reconnect.',
  provider_timeout: 'Codex did not respond in time. Your message is saved; it will not be sent again automatically.',
  provider_turn_failed: 'The manager response did not finish. Your message is saved.',
  connect_first: 'Start the manager connection first.', project_paused: 'Resume the project before sending an instruction.',
  credit_limit: 'The next response does not fit your available credits. Adjust your project budget or shorten the conversation.',
  quota_exhausted: 'Your Codex quota is exhausted. Wait for the account window to reset before continuing.',
  manager_busy: 'The manager is finishing the current response.', folder_unavailable: 'Enter the full path of an existing project folder.',
  invalid_project: 'Check the project name, folder and credit allowance.',
  invalid_message: 'Enter an instruction of up to 8,000 characters.',
  tool_activity_blocked: 'A tool action was blocked. This manager connection supports conversation only.',
  tool_request_blocked: 'A tool request was blocked. Reconnect to continue conversation.',
};
const credit = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const stamp = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [view, setView] = useState('Project');
  const [settings, setSettings] = useState(false);
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<CurrentItem | null>(null);
  const [currentItem, setCurrentItem] = useState<CurrentItem>({ id: 'brief', title: 'Project brief' });
  const [error, setError] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const command = useRef<{ id: string; text: string } | null>(null);
  const settingsDialog = useRef<HTMLElement>(null);
  useDialog(settingsDialog, settings, () => setSettings(false));
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.onmessage = event => { setState(previous => latestSnapshot(previous, restoreState(JSON.parse(event.data)))); setReconnecting(false); };
    events.onerror = () => setReconnecting(true);
    return () => events.close();
  }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [state?.messages.length, state?.draft]);
  const api = async (route: string, body: unknown = {}) => {
    setError(''); setRequesting(true);
    try {
      const response = await fetch(`/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Project-Team': '1' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(errors[result.error] ?? 'The action could not be completed. Try again when the connection is ready.');
      if (result.connection) setState(previous => latestSnapshot(previous, restoreState(result)));
      return true;
    } catch (error) { setError(error instanceof Error && !error.message.includes('fetch') ? error.message : 'The local coordinator is unavailable. Your draft is still here.'); return false; }
    finally { setRequesting(false); }
  };
  const send = async (event: FormEvent) => {
    event.preventDefault(); if (!text.trim()) return;
    if (!command.current || command.current.text !== text) command.current = { id: crypto.randomUUID(), text };
    if (await api('message', { ...command.current, attachment: attachment?.id ?? null })) { setText(''); setAttachment(null); command.current = null; }
  };
  if (!state) return <div className="loading"><UsersThree size={48} weight="fill"/><h1>Opening your workspace</h1><p>{reconnecting ? 'Start the local coordinator to connect.' : 'Restoring your saved project…'}</p></div>;
  const project = state.project;
  const ready = state.connection.status === 'ready';
  const active = project?.mode === 'running';
  const storageBlocked = state.storage?.status === 'blocked' || state.storage?.status === 'unavailable';
  const recoveryPending = state.recovery.some(item => !['recovered', 'retry', 'kept'].includes(item.state));
  const needsConnection = !ready;
  const providerError = state.connection.error ? errors[state.connection.error] ?? 'The manager connection needs attention.' : '';
  const heading = !project ? 'YOUR TEAM STARTS HERE' : project.mode === 'recovery' ? 'PICK UP WHERE YOU LEFT OFF' : needsConnection ? 'CONNECT YOUR MANAGER' : active ? 'READY WHEN YOU ARE' : 'TAKE YOUR TIME';
  const managerStatus = state.busy && !state.team.activeTask && !state.meetings.turns.some(turn => turn.status === 'running' && turn.speakerId !== 'manager') ? 'Working' : ready ? 'Ready' : state.connection.status === 'connecting' ? 'Connecting' : 'Offline';
  const chatDisabled = storageBlocked || !project || !ready || !active || state.busy || requesting || state.stopping;
  const discuss = () => { if (window.innerWidth < 1100) document.getElementById('manager-chat')?.scrollIntoView({ behavior: 'smooth' }); input.current?.focus(); };
  return <>
    <header className="topbar">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); setView('Project'); }}><UsersThree size={40} weight="fill"/><span><strong>PROJECT TEAM</strong><small>The right agent for each task</small></span></a>
      <div className="credit-bar"><Database size={27}/><div><b>Project credits{state.credits.estimated > 0 && <small title="Included in used credits while provider usage is unavailable"> · {credit(state.credits.estimated)} estimated</small>}</b><span>Used <strong>{project ? credit(state.credits.used) : '—'}</strong><i/>Reserved <strong>{project ? credit(state.credits.reserved) : '—'}</strong><i/>Available <strong>{project ? credit(state.credits.available) : '—'}</strong></span></div></div>
      <div className="top-actions">{state.demo && <span className="demo-tag">Demo · no AI</span>}<button className="quiet" onClick={() => setSettings(true)} aria-label="Connection and settings"><GearSix size={23}/></button><button className="quiet run-control" disabled={!project || requesting || state.stopping || (!active && (!ready || recoveryPending || state.busy || storageBlocked))} onClick={() => void api(active ? 'pause' : 'resume')}>{active ? <Pause size={20} weight="fill"/> : <Play size={20} weight="fill"/>}{active ? 'Pause' : 'Resume'}</button></div>
    </header>
    {state.storage && state.storage.status !== 'ok' && <div className="storage-banner" role="status"><span>{state.storage.reason ? storageReasons[state.storage.reason] : 'Storage is approaching its budget.'}</span><button className="quiet" onClick={() => setSettings(true)}>Manage storage</button></div>}
    {reconnecting && <div className="connection-banner" role="status">{state.stopping ? 'Coordinator stopped. Start it manually to return to your workspace.' : 'Reconnecting to the local coordinator. Your saved conversation stays here.'}</div>}
    <div className="workspace">
      <nav className="sidebar" aria-label="Workspace"><div className="nav-items">{[{ name: 'Project', icon: FolderSimple }, { name: 'Team', icon: UsersThree }, { name: 'Meeting room', icon: ChatCircle }, { name: 'Outputs', icon: FileText }].map(({ name, icon: Icon }) => <button key={name} className={view === name ? 'nav-item selected' : 'nav-item'} onClick={() => setView(name)} aria-current={view === name ? 'page' : undefined}><Icon size={25} weight={view === name ? 'fill' : 'regular'}/>{name}</button>)}</div><div className="sidebar-foot"><span className="local-dot"/>On your computer<a href="https://github.com/MMischak/project-team-public" target="_blank" rel="noreferrer">Project on GitHub <ArrowSquareOut size={15}/></a></div></nav>
      <main className="main-content">
        <div className="eyebrow">{project?.name ?? 'Your next idea'}<span>·</span>{view === 'Project' ? 'Project workspace' : view}</div>
        {view === 'Project' ? <>
          <h1>{heading}</h1>
          <section className="decision-area"><div className="decision-icon">{project?.mode === 'recovery' ? <WarningCircle size={41}/> : <FileText size={41}/>}</div><div className="decision-copy"><h2>{!project ? 'Give your team a direction' : project.mode === 'recovery' ? 'Your work is saved' : needsConnection ? 'Start a conversation' : 'Shape the plan with your manager'}</h2><p>{!project ? 'Define your outcome, choose teammates and models that fit the work, and set a token allowance. Your manager helps shape the plan.' : project.mode === 'recovery' ? recoveryPending ? 'Interrupted work needs review. Reconnect, check the saved turns and outputs, then choose what to restore or retry. Nothing has been sent again.' : 'Your project and recovery decisions are saved. Resume explicitly when you’re ready to continue.' : needsConnection ? 'Connect your existing Codex sign-in to discuss your project. You control when the work starts and stops.' : 'Discuss your goals, ask questions and refine the brief. Your conversation stays with this project.'}</p></div><div className="decision-actions"><button className="primary" onClick={() => !project ? setEdit(true) : needsConnection ? void api('connect') : recoveryPending ? document.getElementById('recovery-title')?.scrollIntoView({ behavior: 'smooth' }) : project.mode !== 'running' ? void api('resume') : discuss()} disabled={requesting || state.stopping}>{requesting ? <CircleNotch size={20} className="spin"/> : !project ? <Plus size={21}/> : needsConnection ? <PlugsConnected size={21}/> : project.mode !== 'running' ? <Play size={21} weight="fill"/> : <ChatCircle size={21}/>} {!project ? 'Create project' : needsConnection ? 'Start manager' : recoveryPending ? 'Review interrupted work' : project.mode !== 'running' ? 'Resume project' : 'Discuss with manager'}</button><button className="secondary" onClick={() => project ? setEdit(true) : discuss()} disabled={!project}><FileText size={20}/>Project brief</button></div></section>
          {(error || providerError) && <div className="error-note" role="alert"><WarningCircle size={22}/><span>{error || providerError}</span></div>}
          {state.meetings.proposals.some(proposal => proposal.status === 'proposed') && <section className="meeting-notice"><h2>A meeting proposal needs your decision</h2><p>Your manager has summarized proposed changes. Review them before they affect project work.</p><button className="secondary" onClick={() => setView('Meeting room')}>Review meeting proposal</button></section>}
          <section className="team-scene"><div className="section-title"><div><h2>Your team</h2><p>A shared place to turn ideas into something useful.</p></div><span className="count-tag">1 manager · {state.team.agents.length} members</span></div><div className="scene-wrap"><img className="studio" src="/studio.svg" alt="A warm creative studio with three illustrated teammates working together"/><div className="scene-caption">Your creative workspace</div><div className="manager-card"><img src="/manager.svg" alt=""/><div><strong>Manager</strong><span>Project Manager</span><small className={`status ${ready ? 'green' : ''}`}><span/>{managerStatus}</small></div></div></div></section>
          <section className="next-steps"><div className="section-title"><div><h2>From idea to outcome</h2><p>Your starting point is a clear brief and a conversation.</p></div></div><div className="milestones">{[{ title: 'Brief', text: 'Define your goals', done: !!project }, { title: 'Conversation', text: 'Discuss with your manager', done: state.messages.some(message => message.role === 'assistant') }, { title: 'Team work', text: 'Work through an approved plan', done: state.team.tasks.some(task => task.status === 'complete') }, { title: 'Review', text: 'Accept usable results', done: state.team.milestones.some(item => item.status === 'accepted') }].map((item, index) => <div className="milestone" key={item.title}><div className="milestone-track"><span className={item.done ? 'milestone-dot done' : 'milestone-dot'}>{item.done ? <CheckCircle size={22} weight="fill"/> : index + 1}</span><span/></div><b>{item.title}</b><small>{item.text}</small></div>)}</div></section>
          <TeamWorkspace state={state} view="Project" api={api} selected={currentItem} select={setCurrentItem} error={error} requesting={requesting}/>
        </> : view === 'Meeting room' ? null : <TeamWorkspace state={state} view={view === 'Team' ? 'Team' : 'Outputs'} api={api} selected={currentItem} select={setCurrentItem} error={error} requesting={requesting}/>}
        <div hidden={view !== 'Meeting room'}><MeetingRoom state={state} api={api} requesting={requesting} error={error} currentItem={currentItem} active={view === 'Meeting room'}/></div>
        <footer className="project-footer"><span><span className="local-dot"/>{project ? 'Project and conversation saved locally' : 'Create a project to start'}</span><button onClick={() => setSettings(true)}>Connection details <ArrowRight size={14}/></button></footer>
      </main>
      <aside className="manager-panel" id="manager-chat"><div className="manager-heading"><img src="/manager.svg" alt="Manager portrait"/><div><h2>Manager</h2><p>Project manager</p><span className={`status ${ready ? 'green' : ''}`}><span/>{managerStatus}</span></div></div>
        <div className="messages" aria-label="Manager conversation" aria-live="polite">{!state.messages.length && <div className="welcome-message"><p>A good project starts with a conversation.</p><p>Tell your manager what you want to achieve, where you need help and what a good result would look like.</p><small>{state.demo ? 'This session uses a clearly labelled demo response.' : 'Start the manager to use your Codex subscription.'}</small></div>}{state.messages.map(message => <article key={message.id} className={`message ${message.role}`}><div className="message-meta"><b>{message.role === 'user' ? 'You' : 'Manager'}</b><time>{stamp(message.createdAt)}</time></div>{message.attachment && <span className="attached-label"><Paperclip size={13}/>{message.attachment === 'brief' ? 'Project brief attached' : message.attachment.startsWith('output:') ? 'Output version attached' : 'Task attached'}</span>}<p>{message.text}</p>{['failed', 'interrupted'].includes(message.status) && <small className="message-failure">Response interrupted · not retried</small>}</article>)}{state.busy && !state.team.activeTask && <article className="message assistant"><div className="message-meta"><b>Manager</b><span className="thinking"><CircleNotch size={15} className="spin"/>Thinking</span></div><p>{state.storage?.cleaning ? 'Cleaning disposable run data…' : state.draft || 'Working on your reply…'}</p></article>}<div ref={bottom}/></div>
        <div className="current-item"><label>Current item</label><button disabled={!project} onClick={() => currentItem.id === 'brief' ? setEdit(true) : currentItem.id.startsWith('output:') ? setView('Outputs') : setView('Team')}><FileText size={27}/><span><b>{currentItem.title}</b><small>{project?.name ?? 'No project selected'}</small></span><ArrowRight size={19}/></button><button className={`attach-button ${attachment ? 'attached' : ''}`} disabled={!project} onClick={() => setAttachment(attachment ? null : currentItem)}><Paperclip size={19}/>{attachment ? `${attachment.title} attached · remove` : 'Attach current item'}</button>{currentItem.id !== 'brief' && <button className="quiet" onClick={() => setCurrentItem({ id: 'brief', title: 'Project brief' })}>Select project brief</button>}</div>
        <form className="chat-compose" onSubmit={send}>{error && view !== 'Project' && <p className="compose-error" role="alert">{error}</p>}<div className="compose-box"><textarea ref={input} aria-label="Message your project manager" placeholder={!project ? 'Create a project to begin…' : !ready ? 'Start the manager to chat…' : !active ? 'Resume your project to chat…' : 'Message your project manager…'} value={text} maxLength={8000} onChange={event => setText(event.target.value)} disabled={!project || state.stopping} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!chatDisabled) void send(event); } }}/><button type="submit" aria-label="Send instruction" disabled={chatDisabled || !text.trim()}><PaperPlaneTilt size={24} weight="fill"/></button></div><small>Instructions stay with your manager.</small></form>
      </aside>
    </div>
    {edit && <ProjectDialog project={project} onClose={() => setEdit(false)} save={async values => { if (await api('project', values)) setEdit(false); }} error={error} busy={requesting || state.busy}/>}
    {settings && <div className="modal-overlay" onClick={event => { if (event.target === event.currentTarget) setSettings(false); }}><section ref={settingsDialog} className="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><button className="dialog-close" aria-label="Close settings" onClick={() => setSettings(false)}><X size={23}/></button><h2 id="settings-title">Your local connection</h2><p>Your workspace runs on this computer. Codex manages your ChatGPT sign-in.</p><div className="setting-row"><span>Manager</span><b>{state.demo ? 'Demo · no AI provider' : managerStatus}</b></div><div className="setting-row"><span>Model</span><b>{state.connection.model ?? 'Selected by Codex'}</b></div><StoragePanel state={state} api={api} requesting={requesting} error={error}/><h3>Account quota</h3>{state.connection.quota.length ? state.connection.quota.map((window, index) => <div className="quota" key={index}><div><span>{window.windowDurationMins ? `${Math.round(window.windowDurationMins / 60)}-hour window` : 'Account window'}</span><b>{window.usedPercent}% used</b></div><progress value={window.usedPercent} max="100"/>{window.resetsAt && <small>Resets {new Date(window.resetsAt * 1000).toLocaleString()}</small>}</div>) : <p className="muted">{state.demo ? 'Demo mode has no provider quota.' : 'Quota information is not available yet.'}</p>}<p className="muted">Account quota and project credits are separate.</p>{providerError && <p className="compose-error">{providerError}</p>}<button className="primary" disabled={state.busy || requesting || state.stopping} onClick={() => void api('connect')}><PlugsConnected size={20}/>{ready ? 'Refresh connection' : 'Start manager'}</button><button className="stop-button" disabled={state.stopping || requesting} onClick={() => void api('stop')}><Stop size={18} weight="fill"/>{state.stopping ? 'Finishing and stopping…' : 'Stop local coordinator'}</button></section></div>}
  </>;
}

function ProjectDialog({ project, onClose, save, error, busy }: { project: Snapshot['project']; onClose: () => void; save: (values: { name: string; brief: string; folder: string; credits: number }) => Promise<void>; error: string; busy: boolean }) {
  const [name, setName] = useState(project?.name ?? ''); const [brief, setBrief] = useState(project?.brief ?? ''); const [folder, setFolder] = useState(project?.folder ?? ''); const [credits, setCredits] = useState(project?.credits ?? 100);
  const form = useRef<HTMLFormElement>(null);
  const dialog = useRef<HTMLElement>(null);
  useDialog(dialog, true, onClose);
  return <div className="modal-overlay" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialog} className="dialog project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-title"><button className="dialog-close" aria-label="Close project form" onClick={onClose}><X size={23}/></button><h2 id="project-title">{project ? 'Your project brief' : 'Start with an idea'}</h2><p>A little direction gives your manager a good place to start.</p><form ref={form} onSubmit={event => { event.preventDefault(); void save({ name, brief, folder, credits }); }}><label>Project name<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="What are you working on?"/></label><label>What do you want to achieve?<textarea rows={4} maxLength={8000} value={brief} onChange={event => setBrief(event.target.value)} placeholder="Describe the outcome, your priorities and any constraints."/></label><label>Project folder<input required value={folder} onChange={event => setFolder(event.target.value)} placeholder="Full path to an existing folder"/><small>Choose the folder your builders can work in. The folder is fixed once team tasks exist.</small></label><label>Project credit allowance<input required type="number" min="1" max="1000000" step="any" value={credits} onChange={event => setCredits(Number(event.target.value))}/><small>1 credit = 1,000 reported tokens. This is your project allowance, not money.</small></label>{error && <p className="compose-error" role="alert">{error}</p>}<button className="primary" disabled={busy}><CheckCircle size={21}/>{busy ? 'Saving…' : project ? 'Save brief' : 'Create project'}</button></form></section></div>;
}
