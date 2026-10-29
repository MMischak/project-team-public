import { FolderSimple, Plus, Check, CircleNotch } from "@phosphor-icons/react";
import type { Snapshot } from "../server/types.ts";

export function ProjectList({
  workspace,
  disabled,
  create,
  select,
}: {
  workspace: NonNullable<Snapshot["workspace"]>;
  disabled: boolean;
  create: () => void;
  select: (id: string) => void;
}) {
  return (
    <section className="project-list" aria-label="Saved projects">
      <button className="new-project" onClick={create} disabled={disabled}>
        <Plus size={17} /> New project
      </button>
      <div className="project-list-label">
        <span>Projects</span>
        <span>{workspace.projects.length}</span>
      </div>
      <div className="project-list-items">
        {workspace.projects.map((project) => {
          const active = project.id === workspace.activeProjectId;
          return (
            <button
              key={project.id}
              className={"saved-project" + (active ? " active" : "")}
              aria-current={active ? "true" : undefined}
              aria-label={"Open project: " + project.name}
              title={project.name}
              disabled={disabled || active}
              onClick={() => select(project.id)}
            >
              <FolderSimple size={17} weight={active ? "fill" : "regular"} />
              <span>{project.name}</span>
              {active &&
                (workspace.switching ? (
                  <CircleNotch size={13} className="spin" />
                ) : (
                  <Check size={13} />
                ))}
            </button>
          );
        })}
        {!workspace.projects.length && <p>Your next idea starts here.</p>}
      </div>
      <small className="shared-team-note">
        <span className="local-dot" /> One team. One active project.
      </small>
    </section>
  );
}
