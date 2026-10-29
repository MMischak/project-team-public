import {
  FolderSimple,
  Plus,
  CaretDown,
  CircleNotch,
} from "@phosphor-icons/react";
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
      <label className="project-list-label" htmlFor="active-project">
        <span>Active project</span>
        <span>{workspace.projects.length}</span>
      </label>
      <div className="project-select">
        <FolderSimple size={17} weight="fill" aria-hidden="true" />
        <select
          id="active-project"
          aria-label="Active project"
          aria-describedby="project-selection-state"
          value={workspace.activeProjectId ?? ""}
          disabled={disabled || !workspace.projects.length}
          onChange={(event) => {
            if (event.target.value !== workspace.activeProjectId)
              select(event.target.value);
          }}
        >
          {!workspace.activeProjectId && (
            <option value="">No projects yet</option>
          )}
          {workspace.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        {workspace.switching ? (
          <CircleNotch size={15} className="spin" aria-hidden="true" />
        ) : (
          <CaretDown size={14} aria-hidden="true" />
        )}
      </div>
      <small className="shared-team-note" id="project-selection-state">
        <span className="local-dot" />{" "}
        {workspace.switching
          ? "Saving before switching…"
          : "One project at a time"}
      </small>
      <button className="new-project" onClick={create} disabled={disabled}>
        <Plus size={17} /> New project
      </button>
    </section>
  );
}
