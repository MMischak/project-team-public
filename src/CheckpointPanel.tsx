import { useRef, useState } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  FileText,
  GitBranch,
  GithubLogo,
  X,
} from "@phosphor-icons/react";
import type { CheckpointPreview, Snapshot } from "../server/types.ts";
import { useDialog } from "./useDialog.ts";
import { projectHeaders } from "./projectScope.ts";

const reasons: Record<string, string> = {
  checkpoint_interrupted:
    "Export was interrupted. Retry checks the saved branch before publishing.",
  checkpoint_not_published:
    "GitHub has no branch for this checkpoint. The status check did not publish anything.",
  github_access_denied:
    "GitHub denied access. Check your existing GitHub CLI sign-in and repository permissions.",
  github_unavailable:
    "GitHub could not be reached. Check your connection and GitHub CLI sign-in before retrying.",
  github_ref_conflict:
    "The checkpoint branch points to different work. It was left untouched.",
  snapshot_changed:
    "A saved version failed its integrity check. Restore the local snapshot before retrying.",
  github_invalid_response:
    "GitHub returned an unexpected response. The export remains unsynced.",
  github_export_rejected:
    "GitHub rejected the export. Check repository rules and that the repository has at least one commit.",
};
const errors: Record<string, string> = {
  github_origin_required:
    "The project folder must be a Git repository root with a GitHub origin remote.",
  invalid_checkpoint: "Choose one to ten versions and enter a summary.",
  checkpoint_too_large: "Choose at most 1 MiB of deliverables per checkpoint.",
  snapshot_changed: "A saved version failed its integrity check.",
  checkpoint_protected_file:
    "Credential files, runtime databases and native session logs cannot be exported.",
};

export function CheckpointPanel({
  state,
  api,
  requesting,
  apiError,
}: {
  state: Snapshot;
  api: (route: string, body: unknown) => Promise<boolean>;
  requesting: boolean;
  apiError: string;
}) {
  const [open, setOpen] = useState(false),
    [ids, setIds] = useState<string[]>([]),
    [summary, setSummary] = useState("");
  const [preview, setPreview] = useState<CheckpointPreview | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const dialog = useRef<HTMLElement>(null),
    command = useRef<string | null>(null),
    retryCommands = useRef<Record<string, string>>({});
  const close = () => {
    if (!pending && !requesting) setOpen(false);
  };
  useDialog(dialog, open, close);
  const syncing = state.checkpoints.some((item) => item.status === "syncing");
  const disabled = requesting || pending || state.stopping || syncing;
  const edit = () => {
    setPreview(null);
    command.current = null;
    setError("");
  };
  async function inspect() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/checkpoint-preview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Project-Team": "1",
          ...projectHeaders(state),
        },
        body: JSON.stringify({ outputIds: ids, summary }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(
          errors[result.error] ??
            "These saved versions could not be opened. Check the selection and try again.",
        );
        return;
      }
      setPreview(result);
      command.current = crypto.randomUUID();
    } catch {
      setError(
        "The coordinator could not be reached. Your selection is still here.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="work-section checkpoints"
      aria-label="GitHub checkpoints"
    >
      <div className="section-title">
        <div>
          <h2>GitHub checkpoints</h2>
          <p>
            Share chosen versions with a clear record of what was delivered.
          </p>
        </div>
        <button
          className="secondary"
          disabled={disabled || !state.team.outputs.length}
          onClick={() => {
            setOpen(true);
            edit();
          }}
        >
          <GithubLogo size={18} />
          Create checkpoint
        </button>
      </div>
      {!state.checkpoints.length && (
        <div className="empty-checkpoints">
          <GitBranch size={20} />
          <p className="muted">
            Choose saved versions, review the export, then send a checkpoint to
            your project’s GitHub repository.
          </p>
        </div>
      )}
      {state.checkpoints.map((item) => (
        <article className="checkpoint-card" key={item.id}>
          <div className="section-title">
            <h3>{item.payload.summary}</h3>
            <span className={`count-tag ${item.status}`}>
              {item.demo ? "Demo · " : ""}
              {item.status === "synced"
                ? item.demo
                  ? "saved locally"
                  : "Synced"
                : item.status === "syncing"
                  ? "Exporting…"
                  : "Unsynced"}
            </span>
          </div>
          <div className="checkpoint-meta">
            <span>
              <GithubLogo size={16} />
              {item.payload.repository}
            </span>
            <span>{item.payload.outputs.length} selected versions</span>
          </div>
          <p className="checkpoint-branch">
            <GitBranch size={15} />
            <code>{item.branch}</code>
          </p>
          <small className="checkpoint-timestamp">
            Attempt {item.attempts} of 3 ·{" "}
            {new Date(item.createdAt).toLocaleString()}
          </small>
          <details>
            <summary>Exported versions and milestones</summary>
            <ul className="checkpoint-version-list">
              {item.payload.outputs.map((output) => (
                <li key={output.version.id}>
                  <FileText size={18} />
                  <div>
                    <b>
                      {output.version.title} · v{output.version.version}
                    </b>
                    <p>
                      {output.version.status} · {output.author}
                    </p>
                    <code>{output.exportPath}</code>
                    <small>SHA-256 {output.version.hash}</small>
                  </div>
                </li>
              ))}
            </ul>
            {item.payload.milestones.map((milestone) => (
              <p className="checkpoint-milestone" key={milestone.id}>
                {milestone.title} · {milestone.status} at selection
              </p>
            ))}
            {item.commit && (
              <p>
                <small>Commit {item.commit}</small>
              </p>
            )}
          </details>
          {item.error && (
            <p className="checkpoint-error" role="status">
              {reasons[item.error] ??
                "This checkpoint needs attention before retrying."}
            </p>
          )}
          {(item.status === "unsynced" || item.url) && (
            <div className="checkpoint-actions">
              {item.status === "unsynced" &&
                (item.attempts < 3 ? (
                  <button
                    className="secondary"
                    disabled={disabled}
                    onClick={async () => {
                      const key = `${item.id}:${item.attempts}`;
                      retryCommands.current[key] ??= crypto.randomUUID();
                      await api("checkpoint-retry", {
                        id: retryCommands.current[key],
                        checkpointId: item.id,
                      });
                    }}
                  >
                    Retry saved checkpoint
                  </button>
                ) : (
                  <p className="muted">
                    Retry limit reached. Local deliverables are saved. Check
                    GitHub status before reviewing a new checkpoint.
                  </p>
                ))}
              {item.status === "unsynced" && item.commit && (
                <button
                  className="secondary"
                  disabled={disabled}
                  onClick={() =>
                    void api("checkpoint-check", {
                      id: crypto.randomUUID(),
                      checkpointId: item.id,
                    })
                  }
                >
                  Check GitHub status
                </button>
              )}
              {item.url && (
                <a
                  className="secondary"
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open on GitHub <ArrowSquareOut size={16} />
                </a>
              )}
            </div>
          )}
          {item.demo && (
            <p className="muted">
              Simulation only. Nothing was sent to GitHub.
            </p>
          )}
        </article>
      ))}
      {open && (
        <div
          className="modal-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            ref={dialog}
            className="dialog checkpoint-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="checkpoint-title"
          >
            <button
              className="dialog-close"
              aria-label="Close checkpoint dialog"
              disabled={pending || requesting}
              onClick={close}
            >
              <X size={23} />
            </button>
            <p className="eyebrow">GitHub checkpoint</p>
            <h2 id="checkpoint-title">Review a GitHub checkpoint</h2>
            <p>
              Choose the exact versions you want to share. Nothing is exported
              until you review the preview.
            </p>
            <div className="checkpoint-steps" aria-label="Checkpoint steps">
              <span className={!preview ? "active" : ""}>
                1. Select versions
              </span>
              <span className={preview ? "active" : ""}>2. Review export</span>
            </div>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (!preview) {
                  await inspect();
                  return;
                }
                if (
                  await api("checkpoint", {
                    id: command.current,
                    outputIds: ids,
                    summary,
                    previewHash: preview.hash,
                  })
                ) {
                  setOpen(false);
                  setIds([]);
                  setSummary("");
                  setPreview(null);
                  command.current = null;
                }
              }}
            >
              <fieldset disabled={pending || requesting}>
                <legend>Saved versions · choose up to ten</legend>
                {state.team.outputs.map((output) => (
                  <label className="checkpoint-choice" key={output.id}>
                    <input
                      type="checkbox"
                      checked={ids.includes(output.id)}
                      onChange={() => {
                        edit();
                        setIds(
                          ids.includes(output.id)
                            ? ids.filter((id) => id !== output.id)
                            : [...ids, output.id],
                        );
                      }}
                    />
                    <span>
                      <b>
                        {output.title} · v{output.version}
                      </b>
                      <span className="checkpoint-version-status">
                        {output.status}
                      </span>
                      <small>
                        {output.path ?? "Review report"} ·{" "}
                        {output.bytes.toLocaleString()} bytes
                      </small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <p className="selection-hint muted">
                {ids.length} of 10 versions selected
              </p>
              <label>
                Milestone summary
                <textarea
                  required
                  maxLength={4000}
                  value={summary}
                  disabled={pending || requesting}
                  onChange={(event) => {
                    edit();
                    setSummary(event.target.value);
                  }}
                />
              </label>
              {preview && (
                <div className="checkpoint-review">
                  <div className="checkpoint-destination">
                    <GithubLogo size={21} />
                    <div>
                      <b>Destination: {preview.payload.repository}</b>
                      <p>
                        {state.demo
                          ? "Demo: this export stays local."
                          : "This uses your existing GitHub CLI sign-in. The repository’s visibility and access rules apply."}
                      </p>
                    </div>
                  </div>
                  <p>
                    A new codex/checkpoint branch will contain these files as a
                    standalone snapshot.
                  </p>
                  {preview.files.map((file) => (
                    <details
                      className="checkpoint-file-preview"
                      key={file.path}
                    >
                      <summary>{file.path}</summary>
                      <pre>{file.content}</pre>
                    </details>
                  ))}
                  <p className="muted">
                    Project files, staged changes and existing branches stay as
                    they are. Selected text is exported exactly as previewed.
                  </p>
                </div>
              )}
              {(error || apiError) && <p role="alert">{error || apiError}</p>}
              <div className="dialog-actions">
                <button
                  className="primary"
                  disabled={
                    disabled ||
                    !ids.length ||
                    ids.length > 10 ||
                    !summary.trim()
                  }
                >
                  {pending || requesting ? (
                    <CircleNotch className="spin" size={18} />
                  ) : (
                    <CheckCircle size={18} />
                  )}{" "}
                  {preview
                    ? state.demo
                      ? "Save demo checkpoint"
                      : "Export checkpoint to GitHub"
                    : "Preview checkpoint"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
