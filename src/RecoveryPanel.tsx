import { useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  CheckCircle,
  Database,
  FileText,
} from "@phosphor-icons/react";
import type { Snapshot } from "../server/types.ts";
import { projectHeaders } from "./projectScope.ts";

type Props = {
  state: Snapshot;
  api: (route: string, body: unknown) => Promise<boolean>;
  requesting: boolean;
};

export function RecoveryPanel({ state, api, requesting }: Props) {
  const [preview, setPreview] = useState<{
    id: string;
    content: string;
  } | null>(null);
  const [opened, setOpened] = useState<string[]>([]);
  const [error, setError] = useState("");
  const commands = useRef(new Map<string, string>());
  if (!state.recovery.length) return null;
  const pending = state.recovery.filter(
    (item) => !["recovered", "retry", "kept"].includes(item.state),
  );
  const disabled =
    requesting ||
    state.busy ||
    state.stopping ||
    state.connection.status !== "ready" ||
    state.project?.mode === "running";
  const decide = async (
    stepId: string,
    action: string,
    outputIds: string[],
  ) => {
    const key = JSON.stringify({ stepId, action, outputIds });
    if (!commands.current.has(key))
      commands.current.set(key, crypto.randomUUID());
    if (
      await api("recovery", {
        id: commands.current.get(key),
        stepId,
        action,
        outputIds,
      })
    )
      commands.current.delete(key);
  };
  const inspect = async (id: string) => {
    setError("");
    setPreview(null);
    try {
      const response = await fetch(`/api/recovery-output/${id}`, {
        headers: projectHeaders(state),
      });
      if (!response.ok) throw new Error();
      const result = await response.json();
      setPreview({ id, content: result.content });
      setOpened((items) => [...new Set([...items, id])]);
    } catch {
      setError(
        "This recovery snapshot could not be verified. Check the saved turn again.",
      );
    }
  };

  return (
    <section
      className="work-section recovery-panel"
      aria-labelledby="recovery-title"
    >
      <div className="section-title">
        <div className="panel-heading">
          <ArrowCounterClockwise size={21} />
          <h2 id="recovery-title">Recovery review</h2>
        </div>
        <span
          className={`count-tag ${pending.length ? "needs-review" : "recovered"}`}
        >
          {pending.length ? `${pending.length} to review` : "Decisions saved"}
        </span>
      </div>
      <p>
        {pending.length
          ? "Review each interrupted attempt before resuming. Checking and restoring work sends no new AI instruction."
          : state.project?.mode === "running"
            ? "Your recovery decisions are saved. Approved work has resumed."
            : "Your recovery decisions are saved. Resume explicitly to continue approved work."}
      </p>
      {state.connection.status !== "ready" && (
        <p className="muted">
          Start the manager connection to check saved turns.
        </p>
      )}
      {state.recovery.map((item) => (
        <article className="plan-card recovery-card" key={item.id}>
          <div className="section-title">
            <h3>{item.title}</h3>
            <span className={`count-tag ${item.state}`}>
              {item.state === "ready" ? "Your recovery decision" : item.state}
            </span>
          </div>
          <p>
            {item.state === "recovered"
              ? "Completed work restored. Nothing was sent again."
              : item.summary}
          </p>
          <div className="recovery-usage">
            <Database size={16} />
            <small>
              {item.used.toLocaleString(undefined, {
                maximumFractionDigits: 2,
              })}{" "}
              credits{" "}
              {item.estimated
                ? "estimated; missing usage stays estimated"
                : "recorded"}{" "}
              for this attempt. A retry uses a separate allowance.
            </small>
          </div>
          {item.result &&
            !["recovered", "retry", "kept"].includes(item.state) && (
              <details className="response-details">
                <summary>Completed response</summary>
                <pre className="inline-preview">{item.result}</pre>
              </details>
            )}
          {item.outputs.length > 0 && (
            <div className="recovery-outputs">
              <p className="field-label">Captured outputs</p>
              <div className="output-links">
                {item.outputs.map((output) => (
                  <button
                    className="secondary"
                    key={output.id}
                    onClick={() => void inspect(output.id)}
                  >
                    <FileText size={17} />
                    Inspect {output.path ?? output.title}
                    {opened.includes(output.id) ? " · opened" : ""}
                  </button>
                ))}
              </div>
            </div>
          )}
          {preview &&
            item.outputs.some((output) => output.id === preview.id) && (
              <div className="recovery-preview">
                <p className="preview-caption muted">
                  Saved recovery candidate · SHA-256{" "}
                  {item.outputs
                    .find((output) => output.id === preview.id)!
                    .hash.slice(0, 12)}
                  …{item.afterCrash ? " · captured after interruption" : ""}
                </p>
                <pre className="inline-preview">{preview.content}</pre>
              </div>
            )}
          {!["recovered", "retry", "kept"].includes(item.state) && (
            <div className="review-actions">
              <button
                className="secondary"
                disabled={disabled}
                onClick={() => void decide(item.id, "check", [])}
              >
                Check saved turn
              </button>
              {item.state === "ready" && (
                <button
                  className="primary"
                  disabled={
                    disabled ||
                    item.outputs.some((output) => !opened.includes(output.id))
                  }
                  onClick={() =>
                    void decide(
                      item.id,
                      "restore",
                      item.outputs.map((output) => output.id),
                    )
                  }
                >
                  <CheckCircle size={18} />
                  {item.outputs.length
                    ? "Restore reviewed work"
                    : "Restore completed response"}
                </button>
              )}
              {["ended", "ready"].includes(item.state) && (
                <>
                  <button
                    className="secondary"
                    disabled={disabled}
                    onClick={() => void decide(item.id, "retry", [])}
                  >
                    Queue one retry
                  </button>
                  <button
                    className="secondary"
                    disabled={disabled}
                    onClick={() => void decide(item.id, "keep", [])}
                  >
                    Keep stopped
                  </button>
                </>
              )}
            </div>
          )}
          {item.state === "kept" && (
            <button
              className="secondary"
              disabled={disabled}
              onClick={() => void decide(item.id, "check", [])}
            >
              Review again
            </button>
          )}
          {["ended", "ready"].includes(item.state) && (
            <p className="recovery-note muted">
              Retry retains the earlier attempt and its charge. It may overwrite
              declared files and starts only after Resume. Restored outputs
              still need normal milestone acceptance.
            </p>
          )}
        </article>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
