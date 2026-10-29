import type { Snapshot } from "../server/types.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";

export function ProjectRoster({
  state,
  managerStatus,
  openTeam,
}: {
  state: Snapshot;
  managerStatus: string;
  openTeam: () => void;
}) {
  const active = state.team.tasks.find(
    (task) => task.id === state.team.activeTask,
  );
  const isWorking = (id: string) =>
    active?.agentId === id ||
    state.meetings.turns.some(
      (turn) => turn.speakerId === id && turn.status === "running",
    );
  return (
    <section className="project-roster" aria-label="Project team">
      <div className="roster-member">
        <AgentAvatar role="manager" />
        <div>
          <strong>Manager</strong>
          <p>Plans and coordinates</p>
          <span
            className={
              "roster-status " +
              (managerStatus === "Working" || managerStatus === "Ready"
                ? "available"
                : "")
            }
          >
            <i />
            {managerStatus}
          </span>
        </div>
      </div>
      {state.team.agents.map((agent) => (
        <button
          className="roster-member"
          key={agent.id}
          onClick={openTeam}
          title={agent.responsibility}
        >
          <AgentAvatar role={agent.role} avatarId={agent.avatarId} />
          <span>
            <strong>{agent.name}</strong>
            <span className="roster-role">
              {agent.role === "builder"
                ? "Creates and iterates"
                : "Checks and reviews"}
            </span>
            <span
              className={
                "roster-status " + (isWorking(agent.id) ? "available" : "")
              }
            >
              <i />
              {isWorking(agent.id)
                ? "Working"
                : state.connection.status !== "ready"
                  ? "Offline"
                  : agent.lastTotal > 0
                    ? "Ready"
                    : "Not started"}
            </span>
          </span>
        </button>
      ))}
      {!state.team.agents.length && (
        <button className="roster-invitation" onClick={openTeam}>
          <span className="roster-portraits">
            <AgentAvatar role="builder" />
            <AgentAvatar role="reviewer" />
          </span>
          <span>
            <strong>Your next teammates</strong>
            <span>Choose a builder and a reviewer</span>
          </span>
        </button>
      )}
    </section>
  );
}
