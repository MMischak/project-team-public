# Data and privacy

## Public source and private runtime data

The repository contains source code, test fixtures, synthetic demo/design images and generated fictional portraits. The portraits are not user or employee photographs. It does not require your project files, credentials, account identifiers or conversation logs to be committed.

Normal state on macOS lives under `~/Library/Application Support/Project Team/live`. Demo mode uses a separate `demo` directory. `--state-dir` or `PROJECT_TEAM_STATE_DIR` can select another location. Keep it outside tracked source and outside the agents' writable project folder.

Each project retains its own conversations, tasks, credits, deliverable versions, meetings and recovery records. Shared member profiles contain identity, role description, model, reasoning effort and character; native conversation identifiers and usage bindings stay inside the project. Switching projects drains existing work and closes its native connection before opening another. Stale project requests are rejected.

Existing state and native recovery paths remain in place after the Tinkrew rename. The catalog is stored alongside the original data; newly created projects have their own subdirectories. New Codex services keep their history in app-owned native homes. Existing authentication/configuration paths may be linked for the official client to use; credentials are never placed in model prompts or exported artifacts. File-based sign-in has been exercised; other credential-store arrangements may need additional setup.

## What leaves the computer

Model inference uses the existing ChatGPT subscription connection. Supplied task context, instructions, discussion and selected handoff contents may be sent to the model provider. Local persistence does not imply offline inference. Consult your provider's policies and your organization's requirements before using sensitive material.

GitHub publishing is explicit. Inspect the checkpoint preview and the destination repository's visibility before exporting. The coordinator exports only selected captured versions, a summary and a manifest. Avoid selecting content that should not be disclosed. Publishing credentials are not given to agents.

## Storage controls

Settings show app usage across all saved projects and the selected project-folder usage. The app allowance and diagnostic limit are shared once across the catalog; adding a project does not add another allowance. Defaults are 1,024 MiB app data, 2,048 MiB project data, 64 MiB diagnostics and seven-day completed native trace retention. At app startup/shutdown for the selected project, or through manual cleanup, eligible old/excess diagnostics, completed private native traces, redundant completed recovery payloads and orphan snapshots can be removed.

Cleanup stays within the selected project’s owned data. Select an inactive project and use manual cleanup to reclaim its eligible native traces and diagnostics; its files still count toward the shared limit while inactive. No inactive project is opened or given a model instruction just for maintenance.

Saved conversations, every recorded deliverable version, credit history, unresolved recovery and pending exports remain protected. If protected material fills the budget, work pauses rather than deleting it. Recent completed traces can be reclaimed under app/free-disk pressure. Project files and unrelated shared caches/chats are never automatically deleted.

A running command can exceed a budget before the next check. Filesystem quotas and storage used by external tools are separate concerns. Closing the browser keeps the coordinator running; Stop shuts it down after active work drains.

## Publication hygiene

Use disposable examples and ignored `.test-artifacts/` for test outputs. Never add runtime homes, database files, authentication caches, local absolute home paths, raw transcripts or real customer/project content. `npm run check:publication` checks tracked content and image metadata; Gitleaks supplements it with a secret-pattern scan. Neither is a proof that arbitrary future content is safe. Review the staged diff and images before publishing.
