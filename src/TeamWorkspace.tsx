import { useEffect, useRef, useState } from "react";
import {
  Plus,
  X,
  FileText,
  CheckCircle,
  CircleNotch,
  UsersThree,
} from "@phosphor-icons/react";
import type { Plan, Snapshot, Task } from "../server/types.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { projectHeaders } from "./projectScope.ts";
import { useDialog } from "./useDialog.ts";
import { RecoveryPanel } from "./RecoveryPanel.tsx";
import { CheckpointPanel } from "./CheckpointPanel.tsx";

export type CurrentItem = { id: string; title: string };
type Props = {
  state: Snapshot;
  view: "Project" | "Team" | "Outputs";
  api: (route: string, body: unknown) => Promise<boolean>;
  selected: CurrentItem;
  select: (item: CurrentItem) => void;
  error: string;
  requesting: boolean;
};
type Modal = "hire" | "plan" | "revision" | "review-plan";
const command = () => ({ id: crypto.randomUUID() });
const number = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const waiting: Record<string, string> = {
  hire_required:
    "An unassigned task needs a hire. You can assign it in the task queue.",
  credit_limit: "Eligible work exceeds the remaining credit allowance.",
  waiting_for_acceptance:
    "Dependent work waits for milestone acceptance or a user decision.",
  quota_exhausted: "Work waits for your account quota to reset.",
};
const statusLabel: Record<Task["status"], string> = {
  queued: "Queued",
  running: "Working",
  complete: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  decision: "Needs a decision",
};

function producingTasks(tasks: Task[], id: string) {
  const found: Task[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const task = tasks.find((task) => task.id === id);
    if (!task) return;
    if (task.role === "builder") found.push(task);
    else task.dependencies.forEach(visit);
  };
  visit(id);
  return found;
}

function modelName(state: Snapshot, model: string) {
  return (
    state.team.models.find((choice) => choice.model === model)?.name ?? model
  );
}

export function TeamWorkspace({
  state,
  view,
  api,
  selected,
  select,
  error,
  requesting,
}: Props) {
  const [decisionTargets, setDecisionTargets] = useState<
    Record<string, string>
  >({});
  const [modal, setModal] = useState<Modal | null>(null);
  const [role, setRole] = useState<"builder" | "reviewer">("builder");
  const [name, setName] = useState("");
  const [responsibility, setResponsibility] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("");
  const [instruction, setInstruction] = useState("");
  const [feedback, setFeedback] = useState("");
  const [revisionId, setRevisionId] = useState("");
  const [reviewPlanId, setReviewPlanId] = useState("");
  const [preview, setPreview] = useState<{
    id: string;
    content: string;
  } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const formCommand = useRef<{ key: string; id: string } | null>(null);
  const approvalCommand = useRef<{ planId: string; id: string } | null>(null);
  const dialog = useRef<HTMLElement>(null);
  useDialog(dialog, !!modal, () => setModal(null));

  const team = state.team;
  const project = state.project;
  const model =
    team.models.find((item) => item.model === modelId) ??
    team.models.find((item) => item.isDefault) ??
    team.models[0];
  const selectedEffort = model?.efforts.includes(effort)
    ? effort
    : model?.defaultEffort;
  const disabled = requesting || state.busy || state.stopping;
  const running =
    project?.mode === "running" && state.connection.status === "ready";
  const selectedOutput = selected.id.startsWith("output:")
    ? team.outputs.find((output) => output.id === selected.id.slice(7))
    : null;
  const tasks = team.tasks.filter((task) => !task.supersededBy);
  const proposed = team.plans.find((plan) => plan.status === "proposed");
  const reviewedPlan = team.plans.find(
    (plan) => plan.id === reviewPlanId && plan.status === "proposed",
  );
  const activeTask = tasks.find((task) => task.id === team.activeTask);
  const agentName = (id: string | null) =>
    team.agents.find((agent) => agent.id === id)?.name ?? "Needs a hire";

  useEffect(() => {
    if (!selectedOutput) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    setPreviewError("");
    fetch(`/api/output/${selectedOutput.id}`, {
      headers: projectHeaders(state),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((result) => {
        if (!cancelled)
          setPreview({ id: selectedOutput.id, content: result.content });
      })
      .catch(() => {
        if (!cancelled)
          setPreviewError("The saved version could not be verified or opened.");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedOutput?.id, state.workspace?.activeProjectId]);

  const inspect = (id: string) => {
    const output = team.outputs.find((item) => item.id === id)!;
    select({
      id: `output:${id}`,
      title: `${output.title} · v${output.version}`,
    });
  };
  const revision = (id: string) => {
    setRevisionId(id);
    setFeedback("");
    setModal("revision");
  };
  const reviewPlan = (plan: Plan) => {
    setReviewPlanId(plan.id);
    setModal("review-plan");
  };
  const approvePlan = async () => {
    if (!reviewedPlan) return;
    if (approvalCommand.current?.planId !== reviewedPlan.id) {
      approvalCommand.current = {
        planId: reviewedPlan.id,
        id: crypto.randomUUID(),
      };
    }
    if (await api("approve-plan", approvalCommand.current)) {
      approvalCommand.current = null;
      setModal(null);
    }
  };
  const submitForm = async () => {
    const route =
      modal === "hire" ? "hire" : modal === "plan" ? "plan" : "revision";
    const body =
      modal === "hire"
        ? {
            name,
            role,
            responsibility,
            model: model?.model,
            effort: selectedEffort,
          }
        : modal === "plan"
          ? { instruction }
          : { outputId: revisionId, feedback };
    const key = JSON.stringify({ route, body });
    if (formCommand.current?.key !== key)
      formCommand.current = { key, id: crypto.randomUUID() };
    if (await api(route, { id: formCommand.current.id, ...body })) {
      formCommand.current = null;
      setModal(null);
      setName("");
    }
  };

  return (
    <div className="team-workspace">
      <RecoveryPanel state={state} api={api} requesting={requesting} />
      {view === "Outputs" && (
        <CheckpointPanel
          state={state}
          api={api}
          requesting={requesting}
          apiError={error}
        />
      )}

      {view === "Team" && (
        <>
          <div className="section-title">
            <div>
              <h1>Your team</h1>
              <p>
                One crew across your projects. Match each role to a model and
                reasoning effort that fits its tasks.
              </p>
            </div>
            <button
              className="primary"
              disabled={
                disabled ||
                !project ||
                !team.models.length ||
                team.agents.length >= 8
              }
              onClick={() => setModal("hire")}
            >
              <Plus size={20} />
              Hire member
            </button>
          </div>
          {!team.models.length && (
            <p className="empty-note">
              Start the manager connection to discover available models.
            </p>
          )}
          <div className="member-grid">
            <article className="member-card">
              <div className="member-profile-heading">
                <AgentAvatar role="manager" />
                <div className="member-identity">
                  <span className="member-role">Project manager</span>
                  <h2>Manager</h2>
                  <span
                    className={`member-status ${state.connection.status === "ready" ? "ready" : "offline"}`}
                  >
                    {state.busy &&
                    !team.activeTask &&
                    !state.meetings.turns.some(
                      (turn) =>
                        turn.status === "running" &&
                        turn.speakerId !== "manager",
                    )
                      ? "Working"
                      : state.connection.status === "ready"
                        ? "Ready"
                        : "Offline"}
                  </span>
                </div>
              </div>
              <p>
                Plans the work, coordinates the team and brings decisions to
                you.
              </p>
              <dl className="member-details">
                <div>
                  <dt>Model</dt>
                  <dd>{state.connection.model ?? "Selected by Codex"}</dd>
                </div>
                <div>
                  <dt>Usage in this project</dt>
                  <dd>{number(team.agentCredits.manager ?? 0)} credits used</dd>
                </div>
              </dl>
            </article>
            {team.agents.map((agent) => {
              const working =
                activeTask?.agentId === agent.id ||
                state.meetings.turns.some(
                  (turn) =>
                    turn.speakerId === agent.id && turn.status === "running",
                );
              return (
                <article className="member-card" key={agent.id}>
                  <div className="member-profile-heading">
                    <AgentAvatar role={agent.role} avatarId={agent.avatarId} />
                    <div className="member-identity">
                      <span className="member-role">
                        {agent.role === "builder" ? "Builder" : "Reviewer"}
                      </span>
                      <h2>{agent.name}</h2>
                      <span
                        className={`member-status ${working ? "working" : state.connection.status === "ready" ? "ready" : "offline"}`}
                      >
                        {working
                          ? "Working"
                          : state.connection.status === "ready"
                            ? "Ready"
                            : "Offline"}
                      </span>
                    </div>
                  </div>
                  <p>
                    {agent.responsibility || "Works on the tasks you approve."}
                  </p>
                  <dl className="member-details">
                    <div>
                      <dt>Model</dt>
                      <dd>{modelName(state, agent.model)}</dd>
                    </div>
                    <div>
                      <dt>Reasoning effort</dt>
                      <dd>{agent.effort}</dd>
                    </div>
                    <div>
                      <dt>Usage in this project</dt>
                      <dd>
                        {number(team.agentCredits[agent.id] ?? 0)} credits used
                      </dd>
                    </div>
                  </dl>
                </article>
              );
            })}
          </div>
          {!team.agents.length && (
            <div className="empty-note">
              <UsersThree size={30} />
              <div>
                <b>Build your team, your way</b>
                <p>
                  Hire a builder to produce files and a reviewer to inspect
                  captured versions. Each member keeps a separate Codex
                  conversation.
                </p>
              </div>
            </div>
          )}
        </>
      )}

      {view === "Project" && project && (
        <>
          <section
            className={`work-section ${proposed ? "plan-document" : ""}`}
          >
            <div className="section-title plan-heading">
              <div>
                <h2>{proposed ? "Proposed plan" : "Plan and milestones"}</h2>
                <p>
                  {proposed
                    ? proposed.summary
                    : "You approve the plan before any team task starts."}
                </p>
              </div>
              {proposed ? (
                <button
                  className="primary"
                  disabled={requesting || state.stopping}
                  onClick={() => reviewPlan(proposed)}
                >
                  <CheckCircle size={20} />
                  Review plan
                </button>
              ) : (
                <button
                  className="secondary"
                  disabled={
                    disabled ||
                    !running ||
                    team.milestones.some((item) => item.status !== "accepted")
                  }
                  onClick={() => {
                    setInstruction("");
                    setModal("plan");
                  }}
                >
                  Ask for a plan
                </button>
              )}
            </div>
            {proposed && (
              <>
                <PlanTasks plan={proposed} state={state} />
                {proposed.suggestedHires.length > 0 && (
                  <div className="suggested-hires">
                    <h3>Suggested team additions</h3>
                    {proposed.suggestedHires.map((hire, index) => (
                      <p key={index}>
                        <b>
                          {hire.role}: {hire.responsibility}.
                        </b>{" "}
                        {hire.reason}
                      </p>
                    ))}
                    <p className="muted">
                      You choose and hire members. Unassigned tasks wait for a
                      suitable member.
                    </p>
                  </div>
                )}
                <PlanOutcomes plan={proposed} />
              </>
            )}
            {team.milestones.map((milestone) => (
              <article className="plan-card" key={milestone.id}>
                <div className="section-title">
                  <h3>{milestone.title}</h3>
                  <span className={`count-tag ${milestone.status}`}>
                    {milestone.status === "review"
                      ? "Your review"
                      : milestone.status === "accepted"
                        ? "Accepted"
                        : milestone.status === "decision"
                          ? "Needs a decision"
                          : "Working"}
                  </span>
                </div>
                <div className="output-links">
                  {milestone.outputIds.map((id) => {
                    const output = team.outputs.find((item) => item.id === id)!;
                    return (
                      <button
                        className="secondary"
                        key={id}
                        onClick={() => inspect(id)}
                      >
                        <FileText size={18} />
                        {output.title} · v{output.version}
                      </button>
                    );
                  })}
                </div>
                {milestone.status === "review" && (
                  <div className="review-actions">
                    <button
                      className="primary"
                      disabled={disabled}
                      onClick={() =>
                        void api("accept-milestone", {
                          ...command(),
                          milestoneId: milestone.id,
                          outputIds: milestone.outputIds,
                        })
                      }
                    >
                      <CheckCircle size={20} />
                      Accept milestone
                    </button>
                    <button
                      className="secondary"
                      disabled={disabled}
                      onClick={() => revision(milestone.outputIds[0])}
                    >
                      Request changes
                    </button>
                    <small>Acceptance applies to these exact versions.</small>
                  </div>
                )}
              </article>
            ))}
            {!proposed && !team.milestones.length && (
              <p className="muted">
                Discuss the brief with your manager, hire your team, then ask
                for a plan.
              </p>
            )}
          </section>

          {team.decisions
            .filter((decision) => decision.status === "open")
            .map((decision) => (
              <article className="plan-card decision-card" key={decision.id}>
                <h3>{decision.title}</h3>
                <p>
                  This conflict needs your decision. Independent tasks can
                  continue.
                </p>
                <label>
                  Responsible builder
                  <select
                    aria-label={`Responsible builder for ${decision.title}`}
                    value={decisionTargets[decision.id] ?? ""}
                    onChange={(event) =>
                      setDecisionTargets({
                        ...decisionTargets,
                        [decision.id]: event.target.value,
                      })
                    }
                  >
                    <option value="">
                      Use the sole producing task, or choose one
                    </option>
                    {producingTasks(tasks, decision.taskId).map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.title}
                      </option>
                    ))}
                  </select>
                </label>
                {decision.alternatives.map((option) => (
                  <div key={option.label}>
                    <b>{option.label}</b>
                    <p>{option.reasoning}</p>
                    <button
                      className="secondary"
                      disabled={disabled || !running}
                      onClick={() =>
                        void api("resolve-decision", {
                          ...command(),
                          decisionId: decision.id,
                          instruction: option.instruction,
                          taskId: decisionTargets[decision.id] || undefined,
                        })
                      }
                    >
                      Choose {option.label}
                    </button>
                  </div>
                ))}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const instruction = new FormData(event.currentTarget).get(
                      "instruction",
                    );
                    void api("resolve-decision", {
                      ...command(),
                      decisionId: decision.id,
                      instruction,
                      taskId: decisionTargets[decision.id] || undefined,
                    });
                  }}
                >
                  <label>
                    Your own direction
                    <textarea name="instruction" required maxLength={8000} />
                  </label>
                  <button className="secondary" disabled={disabled || !running}>
                    Send decision to manager
                  </button>
                </form>
              </article>
            ))}
        </>
      )}

      {view !== "Outputs" && tasks.length > 0 && (
        <section className="work-section">
          <div className="section-title">
            <div>
              <h2>Shared task queue</h2>
              <p>
                {activeTask
                  ? `${agentName(activeTask.agentId)} is working on ${activeTask.title}.`
                  : team.waitingReason
                    ? (waiting[team.waitingReason] ??
                      `Work needs attention: ${team.waitingReason}.`)
                    : "One member works at a time. Pause lets the current step finish."}
              </p>
            </div>
          </div>
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              state={state}
              disabled={requesting || state.stopping}
              select={() =>
                select({ id: `task:${task.id}`, title: task.title })
              }
              save={(agentId, priority) =>
                void api("assign", {
                  ...command(),
                  taskId: task.id,
                  agentId,
                  priority,
                })
              }
            />
          ))}
        </section>
      )}

      {view === "Outputs" && (
        <>
          <h1>Project outputs</h1>
          <p className="view-intro">
            Inspect captured drafts and reviews. Send changes through your
            manager.
          </p>
          {!team.outputs.length ? (
            <div className="empty-room">
              <FileText size={54} />
              <h2>Your outputs will live here</h2>
              <p>Approve a plan to start producing versioned work.</p>
            </div>
          ) : (
            <div className="output-layout">
              <div className="output-list">
                {[...team.outputs].reverse().map((output) => (
                  <button
                    key={output.id}
                    className={
                      selected.id === `output:${output.id}`
                        ? "output-row selected"
                        : "output-row"
                    }
                    onClick={() => inspect(output.id)}
                  >
                    <FileText size={23} />
                    <span>
                      <b>
                        {output.title} · v{output.version}
                      </b>
                      <small>
                        {output.status} · {agentName(output.authorId)}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              <section className="output-preview">
                {selectedOutput ? (
                  <>
                    <h2>
                      {selectedOutput.title} · v{selectedOutput.version}
                    </h2>
                    <p className="muted">
                      {selectedOutput.path ?? "Captured review"} ·{" "}
                      {selectedOutput.status}
                      {selectedOutput.recovery?.capturedAfterInterruption &&
                        " · recovered from current files after interruption"}
                      <br />
                      {selectedOutput.bytes.toLocaleString()} bytes · SHA-256{" "}
                      {selectedOutput.hash.slice(0, 12)}…
                    </p>
                    {previewError ? (
                      <p role="alert">{previewError}</p>
                    ) : preview?.id === selectedOutput.id ? (
                      <pre>{preview.content}</pre>
                    ) : (
                      <p>Opening saved version…</p>
                    )}
                    <button
                      className="secondary"
                      disabled={
                        disabled ||
                        !running ||
                        !team.milestones.some(
                          (item) =>
                            item.id === selectedOutput.milestoneId &&
                            item.status !== "accepted" &&
                            item.outputIds.includes(selectedOutput.id),
                        )
                      }
                      onClick={() => revision(selectedOutput.id)}
                    >
                      Request changes
                    </button>
                    <p className="muted">
                      Handoffs:{" "}
                      {team.handoffs
                        .filter((item) => item.outputId === selectedOutput.id)
                        .map(
                          (item) =>
                            `${agentName(item.agentId)} (${item.draft ? "draft" : "accepted"})`,
                        )
                        .join(", ") || "No handoffs yet"}
                    </p>
                  </>
                ) : (
                  <p>Select a version to inspect its saved contents.</p>
                )}
              </section>
            </div>
          )}
        </>
      )}
      {selectedOutput && view === "Project" && (
        <article className="plan-card">
          <h3>Selected: {selected.title}</h3>
          {preview?.id === selectedOutput.id && (
            <pre className="inline-preview">{preview.content}</pre>
          )}
          <p className="muted">
            This exact version is your current item. Use “Attach current item”
            to discuss it.
          </p>
        </article>
      )}
      {error && (
        <p className="compose-error" role="alert">
          {error}
        </p>
      )}

      {modal && (
        <div
          className="modal-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) setModal(null);
          }}
        >
          <section
            ref={dialog}
            className={`dialog${modal === "review-plan" ? " plan-review-dialog" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="team-dialog-title"
          >
            <button
              className="dialog-close"
              aria-label="Close team dialog"
              onClick={() => setModal(null)}
            >
              <X size={23} />
            </button>
            <h2 id="team-dialog-title">
              {modal === "hire"
                ? "Choose a team member"
                : modal === "plan"
                  ? "Ask your manager for a plan"
                  : modal === "review-plan"
                    ? "Review plan"
                    : "Send feedback to your manager"}
            </h2>
            {modal === "review-plan" ? (
              reviewedPlan ? (
                <>
                  <p>{reviewedPlan.summary}</p>
                  <p className="muted">
                    Check the assignments, reasoning settings and expected
                    outputs. Opening this review does not approve or start any
                    work.
                  </p>
                  <dl className="plan-review-summary">
                    <div>
                      <dt>Tasks</dt>
                      <dd>
                        {reviewedPlan.milestones.reduce(
                          (sum, milestone) => sum + milestone.tasks.length,
                          0,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Milestones</dt>
                      <dd>{reviewedPlan.milestones.length}</dd>
                    </div>
                    <div>
                      <dt>Estimated usage</dt>
                      <dd>
                        {number(
                          reviewedPlan.milestones
                            .flatMap((milestone) => milestone.tasks)
                            .reduce(
                              (sum, task) => sum + task.estimateTokens,
                              0,
                            ) / 1000,
                        )}{" "}
                        credits + 20% reserve
                      </dd>
                    </div>
                  </dl>
                  <PlanTasks plan={reviewedPlan} state={state} detailed />
                  {reviewedPlan.suggestedHires.length > 0 && (
                    <div className="suggested-hires">
                      <h3>Suggested team additions</h3>
                      {reviewedPlan.suggestedHires.map((hire, index) => (
                        <p key={index}>
                          <b>
                            {hire.role}: {hire.responsibility}.
                          </b>{" "}
                          {hire.reason}
                        </p>
                      ))}
                      <p className="muted">
                        Approval does not hire members. Unassigned tasks wait
                        until you hire and assign a suitable member.
                      </p>
                    </div>
                  )}
                  {error && (
                    <p className="compose-error" role="alert">
                      {error}
                    </p>
                  )}
                  <div className="plan-review-actions">
                    <button
                      className="secondary"
                      onClick={() => setModal(null)}
                    >
                      Close review
                    </button>
                    <button
                      className="primary"
                      disabled={disabled}
                      onClick={() => void approvePlan()}
                    >
                      {requesting ? (
                        <CircleNotch className="spin" size={20} />
                      ) : (
                        <CheckCircle size={20} />
                      )}
                      Approve plan
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p role="status">
                    This proposal has changed. Close this review to see the
                    current plan.
                  </p>
                  <button className="secondary" onClick={() => setModal(null)}>
                    Close review
                  </button>
                </>
              )
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitForm();
                }}
              >
                {modal === "hire" ? (
                  <>
                    <label>
                      Name
                      <input
                        required
                        maxLength={80}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </label>
                    <label>
                      Role
                      <select
                        aria-label="Role"
                        value={role}
                        onChange={(event) =>
                          setRole(event.target.value as "builder" | "reviewer")
                        }
                      >
                        <option value="builder">
                          Builder · produces project files
                        </option>
                        <option value="reviewer">
                          Reviewer · checks captured versions
                        </option>
                      </select>
                    </label>
                    <label>
                      Responsibility
                      <textarea
                        aria-label="Responsibility"
                        maxLength={2000}
                        value={responsibility}
                        onChange={(event) =>
                          setResponsibility(event.target.value)
                        }
                      />
                      <small>
                        This role description travels with your member across
                        projects. Keep project instructions in the brief.
                      </small>
                    </label>
                    <label>
                      Model
                      <select
                        aria-label="Model"
                        value={model?.model ?? ""}
                        onChange={(event) => {
                          setModelId(event.target.value);
                          setEffort("");
                        }}
                      >
                        {team.models.map((item) => (
                          <option key={item.model} value={item.model}>
                            {item.name} · {item.model}
                          </option>
                        ))}
                      </select>
                      <small>{model?.description}</small>
                    </label>
                    <label>
                      Reasoning effort
                      <select
                        aria-label="Reasoning effort"
                        value={selectedEffort ?? ""}
                        onChange={(event) => setEffort(event.target.value)}
                      >
                        {model?.efforts.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="muted">
                      Models come from your Codex catalog. Availability is
                      confirmed when work starts. Tasks reserve their estimated
                      usage plus 20%. Reasoning effort affects capability and
                      usage; credits count tokens, not money.
                    </p>
                  </>
                ) : modal === "plan" ? (
                  <>
                    <p>
                      Your manager will propose tasks for the current brief and
                      team. You approve before work begins.
                    </p>
                    <label>
                      Additional direction
                      <textarea
                        aria-label="Additional direction"
                        maxLength={8000}
                        value={instruction}
                        onChange={(event) => setInstruction(event.target.value)}
                        placeholder="Priorities, constraints, or a first milestone…"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <p>
                      The manager translates your feedback for the responsible
                      member. A revision creates a new version and a fresh
                      review.
                    </p>
                    <label>
                      What should change?
                      <textarea
                        aria-label="What should change?"
                        required
                        maxLength={8000}
                        value={feedback}
                        onChange={(event) => setFeedback(event.target.value)}
                      />
                    </label>
                  </>
                )}
                {error && (
                  <p className="compose-error" role="alert">
                    {error}
                  </p>
                )}
                <button
                  className="primary"
                  disabled={disabled || (modal !== "hire" && !running)}
                >
                  {requesting ? (
                    <CircleNotch className="spin" size={20} />
                  ) : (
                    <CheckCircle size={20} />
                  )}
                  {modal === "hire"
                    ? "Hire member"
                    : modal === "plan"
                      ? "Propose plan"
                      : "Send feedback"}
                </button>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function PlanTasks({
  plan,
  state,
  detailed = false,
}: {
  plan: Plan;
  state: Snapshot;
  detailed?: boolean;
}) {
  const allTasks = plan.milestones.flatMap((milestone) => milestone.tasks);
  let offset = 0;
  return (
    <div className="plan-milestones">
      {plan.milestones.map((milestone) => {
        const firstIndex = offset;
        offset += milestone.tasks.length;
        return (
          <section className="plan-milestone" key={milestone.id}>
            {(detailed || plan.milestones.length > 1) && (
              <h3>{milestone.title}</h3>
            )}
            <ol className="plan-task-list">
              {milestone.tasks.map((task, index) => {
                const agent = state.team.agents.find(
                  (agent) => agent.id === task.agentId,
                );
                return (
                  <li className="plan-task-row" key={task.id}>
                    <span className="task-index" aria-hidden="true">
                      {firstIndex + index + 1}
                    </span>
                    <div className="plan-task-body">
                      <h3>{task.title}</h3>
                      <p>{task.instruction}</p>
                      <div className="task-deliverables">
                        {task.outputs.map((path) => (
                          <span className="deliverable-chip" key={path}>
                            <FileText size={16} />
                            {path}
                          </span>
                        ))}
                        {!task.outputs.length && task.role === "reviewer" && (
                          <span className="deliverable-chip">
                            <FileText size={16} />
                            Captured review
                          </span>
                        )}
                      </div>
                      {detailed && (
                        <>
                          <p className="plan-task-estimate">
                            Estimate {number(task.estimateTokens / 1000)}{" "}
                            credits + 20% reserve
                          </p>
                          <p className="plan-task-dependencies">
                            {task.dependencies.length
                              ? `After: ${task.dependencies.map((id) => allTasks.find((item) => item.id === id)?.title ?? id).join(", ")}`
                              : "No task dependencies"}
                          </p>
                        </>
                      )}
                    </div>
                    <div className="plan-task-assignee">
                      {agent ? (
                        <AgentAvatar
                          role={agent.role}
                          avatarId={agent.avatarId}
                        />
                      ) : (
                        <UsersThree className="unassigned-avatar" size={28} />
                      )}
                      <div className="assignee-info">
                        <b>{agent?.name ?? "Needs a hire"}</b>
                        <span>
                          {agent
                            ? `${modelName(state, agent.model)} · ${agent.effort} effort`
                            : `${task.role === "builder" ? "Builder" : "Reviewer"} required`}
                        </span>
                        {agent && <small>User selected</small>}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

function PlanOutcomes({ plan }: { plan: Plan }) {
  const tasks = plan.milestones.flatMap((milestone) => milestone.tasks);
  const files = [...new Set(tasks.flatMap((task) => task.outputs))];
  return (
    <section className="plan-outcomes">
      <h3>Expected outcome</h3>
      <div className="outcome-list">
        <div>
          <FileText size={26} />
          <div>
            <b>
              {files.length === 1
                ? files[0]
                : `${files.length} declared project files`}
            </b>
            <p>Captured as versioned deliverables.</p>
          </div>
        </div>
        {tasks.some((task) => task.role === "reviewer") && (
          <div>
            <UsersThree size={26} />
            <div>
              <b>Independent review</b>
              <p>Feedback on the captured versions.</p>
            </div>
          </div>
        )}
        <div>
          <CheckCircle size={26} />
          <div>
            <b>Your milestone decision</b>
            <p>Inspect the results before accepting.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function TaskRow({
  task,
  state,
  disabled,
  select,
  save,
}: {
  task: Task;
  state: Snapshot;
  disabled: boolean;
  select: () => void;
  save: (agentId: string, priority: number) => void;
}) {
  const [agentId, setAgentId] = useState(task.agentId ?? "");
  const [priority, setPriority] = useState(task.priority);
  useEffect(() => {
    setAgentId(task.agentId ?? "");
    setPriority(task.priority);
  }, [task.agentId, task.priority]);
  const assigned = state.team.agents.find((agent) => agent.id === task.agentId);
  return (
    <article className="task-row">
      <div className="task-row-body">
        <button className="task-title" onClick={select}>
          {task.title}
        </button>
        <small>
          <span className={`task-status ${task.status}`}>
            {statusLabel[task.status]}
          </span>{" "}
          · {task.role} · {number(task.estimateTokens / 1000)} credits estimated
        </small>
        {task.summary && <p>{task.summary}</p>}
      </div>
      <div className="task-assignee">
        {assigned && (
          <AgentAvatar role={assigned.role} avatarId={assigned.avatarId} />
        )}
        <div className="assignee-info">
          <b>{assigned?.name ?? "Needs a hire"}</b>
          {assigned && (
            <span>
              {modelName(state, assigned.model)} · {assigned.effort} effort
            </span>
          )}
        </div>
      </div>
      {task.status === "queued" && (
        <details className="assignment-editor">
          <summary>Edit assignment</summary>
          <form
            className="assignment-form"
            onSubmit={(event) => {
              event.preventDefault();
              save(agentId, priority);
            }}
          >
            <label>
              Assigned member
              <select
                aria-label={`Member for ${task.title}`}
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
              >
                <option value="">Choose a {task.role}</option>
                {state.team.agents
                  .filter((agent) => agent.role === task.role)
                  .map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Priority
              <input
                aria-label={`Priority for ${task.title}`}
                type="number"
                min={0}
                max={100}
                value={priority}
                onChange={(event) => setPriority(Number(event.target.value))}
              />
            </label>
            <button className="secondary" disabled={disabled || !agentId}>
              Save assignment
            </button>
          </form>
        </details>
      )}
    </article>
  );
}
