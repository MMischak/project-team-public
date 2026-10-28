import { useEffect, useRef, useState } from "react";
import {
  CheckCircle,
  PaperPlaneTilt,
  Paperclip,
  Plus,
  User,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import type { MeetingAction, Snapshot } from "../server/types.ts";
import type { CurrentItem } from "./TeamWorkspace.tsx";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { useDialog } from "./useDialog.ts";
import { RecoveryPanel } from "./RecoveryPanel.tsx";

type Props = {
  state: Snapshot;
  api: (route: string, body?: unknown) => Promise<boolean>;
  requesting: boolean;
  error: string;
  currentItem: CurrentItem;
  active: boolean;
};
const number = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const clock = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

export function MeetingRoom({
  state,
  api,
  requesting,
  error,
  currentItem,
  active,
}: Props) {
  const [roomId, setRoomId] = useState(""),
    [create, setCreate] = useState(false),
    [title, setTitle] = useState("");
  const [participants, setParticipants] = useState<string[]>([]),
    [recipient, setRecipient] = useState("all"),
    [text, setText] = useState("");
  const [attachment, setAttachment] = useState<CurrentItem | null>(null);
  const commands = useRef(new Map<string, string>()),
    dialog = useRef<HTMLElement>(null);
  useDialog(dialog, create && active, () => setCreate(false));
  const rooms = state.meetings.rooms,
    room =
      rooms.find((room) => room.id === roomId) ??
      rooms.find((room) => room.status === "open") ??
      rooms.at(-1);
  const name = (id: string) =>
    id === "user"
      ? "You"
      : id === "manager"
        ? "Manager"
        : (state.team.agents.find((agent) => agent.id === id)?.name ??
          "Former member");
  const role = (id: string) =>
    id === "manager"
      ? "manager"
      : state.team.agents.find((agent) => agent.id === id)?.role;
  const messages = state.meetings.messages.filter(
      (message) => message.meetingId === room?.id,
    ),
    turns = state.meetings.turns.filter((turn) => turn.meetingId === room?.id);
  const pending = turns.filter((turn) =>
      ["queued", "running"].includes(turn.status),
    ),
    proposals = state.meetings.proposals.filter(
      (proposal) => proposal.meetingId === room?.id,
    );
  const running =
      state.project?.mode === "running" && state.connection.status === "ready",
    closed = room?.status === "closed";
  const disabled = requesting || state.stopping,
    summaryDisabled =
      disabled ||
      !running ||
      closed ||
      pending.length > 0 ||
      !messages.some((message) => message.speakerId !== "user");
  const credits = room && state.meetings.credits[room.id];
  const attachmentLabel = (id: string) => {
    if (id === "brief") return "Project brief";
    const output = id.startsWith("output:")
      ? state.team.outputs.find((output) => output.id === id.slice(7))
      : null;
    return output ? `${output.title} · v${output.version}` : "Saved task";
  };
  useEffect(() => {
    if (!active) setCreate(false);
  }, [active]);
  const submit = async (route: string, body: Record<string, unknown>) => {
    const key = JSON.stringify({ route, body });
    if (!commands.current.has(key))
      commands.current.set(key, crypto.randomUUID());
    const id = commands.current.get(key)!;
    if (!(await api(route, { id, ...body }))) return null;
    commands.current.delete(key);
    return id;
  };
  const actionText = (action: MeetingAction) => {
    if (action.kind === "budget")
      return `Set project allowance to ${number(action.credits)} credits (currently ${number(state.project?.credits ?? 0)}).`;
    if (action.kind === "brief")
      return `Replace project brief with: ${action.instruction}`;
    const task = state.team.tasks.find((task) => task.id === action.taskId);
    return action.kind === "assign"
      ? `Assign “${task?.title ?? action.taskId}” to ${name(action.agentId)}, priority ${action.priority}.`
      : `Revise “${task?.title ?? action.taskId}”: ${action.instruction}\nEstimate ${number(action.estimateTokens / 1000)} credits + 20% reserve; dependent tasks will also run again.`;
  };

  return (
    <section className="meeting-workspace">
      <div className="section-title page-heading">
        <div>
          <h1>Meeting room</h1>
          <p className="view-intro">
            Bring your team’s perspectives together. You decide which proposed
            changes go ahead.
          </p>
        </div>
        <button
          className="primary"
          disabled={disabled || !state.project}
          onClick={() => {
            setTitle("");
            setParticipants(state.team.agents.map((agent) => agent.id));
            setCreate(true);
          }}
        >
          <Plus size={18} />
          New meeting
        </button>
      </div>
      {active && (
        <RecoveryPanel state={state} api={api} requesting={requesting} />
      )}
      {!rooms.length ? (
        <div className="empty-room">
          <span className="empty-state-icon">
            <UsersThree size={28} />
          </span>
          <h2>A conversation with your team</h2>
          <p>
            Start a meeting, choose the members you need, and explore the next
            step together. Project changes always need your confirmation.
          </p>
        </div>
      ) : (
        <>
          <label className="meeting-picker">
            Meeting
            <select
              aria-label="Meeting"
              value={room?.id ?? ""}
              onChange={(event) => {
                setRoomId(event.target.value);
                setText("");
                setAttachment(null);
                setRecipient("all");
              }}
            >
              {[...rooms].reverse().map((room) => (
                <option key={room.id} value={room.id}>
                  {room.title}
                  {room.status === "closed" ? " · closed" : ""}
                </option>
              ))}
            </select>
          </label>
          {room && (
            <>
              <div className="meeting-banner">
                <div className="meeting-participant-stack" aria-hidden="true">
                  {room.participantIds.map((id) => (
                    <AgentAvatar
                      key={id}
                      role={role(id)}
                      className="meeting-participant-avatar"
                    />
                  ))}
                </div>
                <div className="meeting-room-info">
                  <h2>{room.title}</h2>
                  <p>{room.participantIds.map(name).join(" · ")}</p>
                  <small>
                    {number(credits?.used ?? 0)} credits used ·{" "}
                    {number(credits?.reserved ?? 0)} reserved
                    {credits?.estimated
                      ? ` · ${number(credits.estimated)} estimated`
                      : ""}
                  </small>
                </div>
                <span className={`count-tag ${room.status}`}>
                  {room.status}
                </span>
              </div>
              <div className="meeting-controls">
                {proposals.some(
                  (proposal) => proposal.status === "proposed",
                ) && (
                  <button
                    className="primary"
                    onClick={() =>
                      document
                        .getElementById(
                          `meeting-proposal-${proposals.find((proposal) => proposal.status === "proposed")!.id}`,
                        )
                        ?.scrollIntoView({ behavior: "smooth" })
                    }
                  >
                    Review proposed actions
                  </button>
                )}
                <button
                  className="secondary"
                  disabled={summaryDisabled}
                  onClick={() =>
                    void submit("meeting-summary", {
                      meetingId: room.id,
                      pauseAfter: true,
                    })
                  }
                >
                  <CheckCircle size={18} />
                  Summarize actions and pause
                </button>
                <button
                  className="secondary"
                  disabled={disabled || closed}
                  onClick={() =>
                    void submit("meeting-close", { meetingId: room.id })
                  }
                >
                  End meeting
                </button>
              </div>
              <p className="meeting-guidance muted">
                Replies use project credits. Discussion alone does not change
                tasks or approvals. {state.demo && "This demo uses no AI."}
              </p>
              {!state.demo && (
                <details className="meeting-credit-details">
                  <summary>Reply allowances</summary>
                  <p>
                    A fresh conversation typically reserves about 28.8 credits;
                    later replies reserve from about 14.4, increasing with
                    context.
                  </p>
                </details>
              )}
              {!closed && !running && (
                <p className="meeting-notice" role="status">
                  {state.connection.status !== "ready"
                    ? "Start the manager connection to continue this meeting."
                    : "Resume the project to request replies. Saved discussion and proposals remain available."}
                </p>
              )}
              <div
                className="meeting-transcript"
                role="log"
                aria-label="Meeting transcript"
                aria-live="polite"
                aria-relevant="additions"
              >
                {!messages.length && (
                  <p className="muted">
                    Open with a question or invite the team’s ideas.
                  </p>
                )}
                {messages.map((message) => (
                  <article
                    className={`meeting-message ${message.speakerId === "user" ? "from-user" : ""}`}
                    key={message.id}
                  >
                    <div className="meeting-speaker">
                      {message.speakerId === "user" ? (
                        <span className="speaker-symbol">
                          <User size={17} />
                        </span>
                      ) : (
                        <AgentAvatar
                          role={role(message.speakerId)}
                          className="meeting-avatar"
                        />
                      )}
                      <b>{name(message.speakerId)}</b>
                      <time dateTime={message.createdAt}>
                        {clock(message.createdAt)}
                      </time>
                    </div>
                    {(message.recipientIds.length > 0 ||
                      message.attachment) && (
                      <div className="meeting-message-context">
                        {message.recipientIds.length > 0 && (
                          <small>
                            To {message.recipientIds.map(name).join(", ")}
                          </small>
                        )}
                        {message.attachment && (
                          <small>
                            <Paperclip size={13} />
                            Attached: {attachmentLabel(message.attachment)}
                          </small>
                        )}
                      </div>
                    )}
                    <p>{message.text}</p>
                  </article>
                ))}
              </div>
              {pending.length > 0 && (
                <div className="meeting-notice" role="status">
                  <b>Requested replies</b>
                  <ul>
                    {pending.map((turn) => (
                      <li key={turn.id}>
                        {name(turn.speakerId)} ·{" "}
                        {turn.kind === "meeting-summary"
                          ? "action summary"
                          : "discussion"}{" "}
                        · {turn.status === "running" ? "responding" : "queued"}
                      </li>
                    ))}
                  </ul>
                  <small>
                    {state.meetings.waitingReason === "credit_limit"
                      ? "Waiting for enough project credits. You can change the allowance in Project brief."
                      : state.meetings.waitingReason === "quota_exhausted"
                        ? "Waiting for your provider quota to reset."
                        : "One participant responds at a time. Pause holds queued replies; ending the meeting cancels them."}
                  </small>
                </div>
              )}
              {turns.length > 0 && (
                <details className="meeting-history">
                  <summary>Requested reply history</summary>
                  <ul>
                    {turns.map((turn) => (
                      <li key={turn.id}>
                        {name(turn.speakerId)} ·{" "}
                        {turn.kind === "meeting-summary"
                          ? "action summary"
                          : "discussion"}{" "}
                        · {turn.status}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {!closed && (
                <form
                  className="meeting-compose"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (!text.trim()) return;
                    if (
                      await submit("meeting-message", {
                        meetingId: room.id,
                        text,
                        recipientIds:
                          recipient === "all"
                            ? room.participantIds
                            : [recipient],
                        attachment: attachment?.id ?? null,
                      })
                    ) {
                      setText("");
                      setAttachment(null);
                    }
                  }}
                >
                  <label>
                    Address
                    <select
                      aria-label="Address meeting message"
                      value={recipient}
                      onChange={(event) => setRecipient(event.target.value)}
                    >
                      <option value="all">Everyone · one reply each</option>
                      {room.participantIds.map((id) => (
                        <option key={id} value={id}>
                          {name(id)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Your contribution
                    <textarea
                      aria-label="Meeting message"
                      value={text}
                      maxLength={8000}
                      onChange={(event) => setText(event.target.value)}
                      placeholder="What would you like the team’s perspective on?"
                      disabled={state.stopping}
                    />
                  </label>
                  <div className="meeting-compose-actions">
                    {attachment ? (
                      <button
                        type="button"
                        className="attachment-chip"
                        onClick={() => setAttachment(null)}
                      >
                        <Paperclip size={16} />
                        {attachment.title} attached · remove <X size={14} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setAttachment(currentItem)}
                      >
                        <Paperclip size={17} />
                        Attach current item to meeting
                      </button>
                    )}
                    <button
                      className="primary"
                      disabled={disabled || !running || !text.trim()}
                    >
                      <PaperPlaneTilt size={18} />
                      Request replies
                    </button>
                  </div>
                </form>
              )}
              {proposals.map((proposal) => (
                <article
                  className="plan-card meeting-proposal"
                  id={`meeting-proposal-${proposal.id}`}
                  key={proposal.id}
                >
                  <div className="section-title">
                    <div className="proposal-heading">
                      <AgentAvatar role="manager" className="proposal-avatar" />
                      <h2>Manager’s proposed actions</h2>
                    </div>
                    <span className={`count-tag ${proposal.status}`}>
                      {proposal.status}
                    </span>
                  </div>
                  <p>{proposal.summary}</p>
                  <ol>
                    {proposal.actions.map((action, i) => (
                      <li key={i}>{actionText(action)}</li>
                    ))}
                  </ol>
                  {!proposal.actions.length && (
                    <p>No project changes are proposed.</p>
                  )}
                  {proposal.status === "stale" && (
                    <p role="status">
                      The discussion or project changed. Ask the manager for a
                      fresh proposal before confirming.
                    </p>
                  )}
                  {proposal.status === "proposed" && (
                    <div className="review-actions">
                      <button
                        className="primary"
                        disabled={
                          disabled ||
                          state.busy ||
                          state.recovery.some(
                            (item) =>
                              !["recovered", "kept", "retry"].includes(
                                item.state,
                              ),
                          )
                        }
                        onClick={() =>
                          void submit("meeting-decision", {
                            proposalId: proposal.id,
                            action: "confirm",
                          })
                        }
                      >
                        Confirm proposed changes
                      </button>
                      <button
                        className="secondary"
                        disabled={disabled || state.busy}
                        onClick={() =>
                          void submit("meeting-decision", {
                            proposalId: proposal.id,
                            action: "dismiss",
                          })
                        }
                      >
                        Dismiss proposal
                      </button>
                      <small>
                        Confirmation applies only these listed changes. Plan and
                        milestone acceptance remain separate.
                      </small>
                    </div>
                  )}
                </article>
              ))}
            </>
          )}
        </>
      )}
      {error && (
        <p className="compose-error" role="alert">
          {error}
        </p>
      )}
      {create && active && (
        <div className="modal-overlay">
          <section
            ref={dialog}
            className="dialog meeting-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="meeting-dialog-title"
          >
            <button
              className="dialog-close"
              aria-label="Close meeting dialog"
              onClick={() => setCreate(false)}
            >
              <X size={22} />
            </button>
            <p className="eyebrow">Meeting room</p>
            <h2 id="meeting-dialog-title">Bring the team together</h2>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                const id = await submit("meeting", {
                  title,
                  participantIds: participants,
                });
                if (id) {
                  setRoomId(id);
                  setRecipient("all");
                  setCreate(false);
                }
              }}
            >
              <label>
                Meeting title
                <input
                  aria-label="Meeting title"
                  required
                  maxLength={120}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <fieldset className="meeting-participants">
                <legend>Participants</legend>
                <div className="meeting-fixed-participant">
                  <AgentAvatar role="manager" className="participant-avatar" />
                  <span>
                    <b>Manager</b>
                    <small>Joins every meeting</small>
                  </span>
                </div>
                {state.team.agents.map((agent) => (
                  <label key={agent.id}>
                    <input
                      type="checkbox"
                      checked={participants.includes(agent.id)}
                      onChange={(event) =>
                        setParticipants((ids) =>
                          event.target.checked
                            ? [...ids, agent.id]
                            : ids.filter((id) => id !== agent.id),
                        )
                      }
                    />
                    <AgentAvatar
                      role={agent.role}
                      className="participant-avatar"
                    />
                    <span>
                      <b>{agent.name}</b>
                      <small>
                        {agent.role} · {agent.model}
                      </small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <p className="muted">
                Creating a meeting sends no AI instruction. You choose when to
                request contributions.
              </p>
              {error && <p role="alert">{error}</p>}
              <button className="primary" disabled={disabled}>
                Create meeting
              </button>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
