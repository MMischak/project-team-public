import { useEffect, useState } from "react";
import type { Snapshot, StoragePolicy } from "../server/types.ts";
export const storageReasons: Record<string, string> = {
  app_storage_limit:
    "Saved run data has reached its limit. Clean disposable data or adjust the budget.",
  diagnostic_storage_limit:
    "Diagnostic logs across saved projects have reached the limit. Open a project and clean its run data, or adjust the log budget.",
  project_storage_limit:
    "The project folder has reached its limit. Review its build files or adjust the budget.",
  storage_scan_incomplete:
    "Disk usage could not be fully measured. New work waits for a complete check.",
  disk_space_low:
    "Less than 64 MiB is free on this disk. Free space before starting more work.",
};
const size = (bytes: number) =>
  bytes < 1048576
    ? `${Math.ceil(bytes / 1024)} KiB`
    : bytes < 1073741824
      ? `${(bytes / 1048576).toFixed(1)} MiB`
      : `${(bytes / 1073741824).toFixed(2)} GiB`;
export function StoragePanel({
  state,
  api,
  requesting,
  error,
}: {
  state: Snapshot;
  api: (route: string, body?: unknown) => Promise<boolean>;
  requesting: boolean;
  error: string;
}) {
  const usage = state.storage;
  const [policy, setPolicy] = useState<StoragePolicy | null>(
    usage?.policy ?? null,
  );
  useEffect(() => {
    if (usage) setPolicy(usage.policy);
  }, [
    usage?.policy.appMiB,
    usage?.policy.projectMiB,
    usage?.policy.logsMiB,
    usage?.policy.retentionDays,
  ]);
  if (!usage || !policy) return null;
  const disabled =
    requesting ||
    state.busy ||
    state.stopping ||
    state.checkpoints.some((c) => c.status === "syncing");
  return (
    <section className="storage-panel" aria-label="Disk usage and cleanup">
      <h3>Storage on this computer</h3>
      <div className="storage-meter">
        <div>
          <span>All projects · run data</span>
          <b>
            {size(usage.appBytes)} / {usage.policy.appMiB} MiB
          </b>
        </div>
        <progress
          aria-label="App storage used"
          max={usage.policy.appMiB * 1048576}
          value={usage.appBytes}
        />
      </div>
      <div className="storage-meter">
        <div>
          <span>Selected project folder</span>
          <b>
            {size(usage.projectBytes)} / {usage.policy.projectMiB} MiB
          </b>
        </div>
        <progress
          aria-label="Project storage used"
          max={usage.policy.projectMiB * 1048576}
          value={usage.projectBytes}
        />
      </div>
      <p className="muted">
        Saved records {size(usage.databaseBytes)} · deliverable versions{" "}
        {size(usage.snapshotBytes)} · runtime files {size(usage.runtimeBytes)}.
        Diagnostic files: {size(usage.reclaimableBytes)}.
      </p>
      {usage.reason && (
        <p role="status">
          {storageReasons[usage.reason] ??
            "Storage needs attention before new work starts."}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void api("storage-policy", policy);
        }}
      >
        <div className="storage-fields">
          <label>
            All projects: run data budget (MiB)
            <input
              type="number"
              min={64}
              max={8192}
              required
              value={policy.appMiB}
              onChange={(e) =>
                setPolicy({ ...policy, appMiB: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Project folder budget (MiB)
            <input
              type="number"
              min={64}
              max={65536}
              required
              value={policy.projectMiB}
              onChange={(e) =>
                setPolicy({ ...policy, projectMiB: Number(e.target.value) })
              }
            />
          </label>
          <label>
            All projects: diagnostic logs (MiB)
            <input
              type="number"
              min={1}
              max={256}
              required
              value={policy.logsMiB}
              onChange={(e) =>
                setPolicy({ ...policy, logsMiB: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Keep completed run traces (days)
            <input
              type="number"
              min={1}
              max={30}
              required
              value={policy.retentionDays}
              onChange={(e) =>
                setPolicy({ ...policy, retentionDays: Number(e.target.value) })
              }
            />
          </label>
        </div>
        {error && <p role="alert">{error}</p>}
        <button className="secondary" disabled={disabled}>
          Save storage limits
        </button>
      </form>
      <div className="storage-actions">
        <button
          className="secondary"
          disabled={disabled}
          onClick={() => void api("storage-refresh")}
        >
          Refresh disk usage
        </button>
        <button
          className="secondary"
          disabled={disabled}
          onClick={() => void api("storage-cleanup")}
        >
          {usage.cleaning ? "Cleaning…" : "Clean disposable data"}
        </button>
      </div>
      <p className="muted">
        Cleanup keeps saved conversations, deliverables, credits, recovery and
        exports. It pauses work and closes the connection; reconnect and Resume
        when ready. Cleanup applies to this project. Old completed run traces
        and excess diagnostics are cleaned at app startup and shutdown for the
        selected project.
        Open an older project to clean its traces. The app limit includes all
        saved projects. At that limit, cleanup can remove recent completed
        traces too.
      </p>
      <p className="muted">
        Budgets pause new work and keep 16 MiB for saving results. A running
        command can exceed a budget before it finishes. Project files and your
        other Codex chats are never deleted. Existing shared Codex/npm
        installations and caches are outside these limits.
      </p>
      {usage.lastCleanup && (
        <p className="muted">
          Last cleanup: {usage.lastCleanup.files} files,{" "}
          {usage.lastCleanup.records} redundant records,{" "}
          {usage.lastCleanup.nativeThreads} completed run traces.{" "}
          {usage.lastCleanup.warning &&
            "Native trace cleanup was unavailable; those files remain counted."}
        </p>
      )}
    </section>
  );
}
