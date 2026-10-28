# Data and privacy

## Public source and private runtime data

The repository contains source code, test fixtures and a synthetic demo screenshot. It does not require your project files, credentials, account identifiers or conversation logs to be committed.

Normal state on macOS lives under `~/Library/Application Support/Project Team/live`. Demo mode uses a separate `demo` directory. `--state-dir` or `PROJECT_TEAM_STATE_DIR` can select another location. Keep it outside tracked source and outside the agents' writable project folder.

The coordinator retains conversations, tasks, credits, deliverable versions and recovery records. New Codex services keep their history in app-owned native homes. Existing authentication/configuration paths may be linked for the official client to use; credentials are never placed in model prompts or exported artifacts. File-based sign-in has been exercised; other credential-store arrangements may need additional setup.

## What leaves the computer

Model inference uses the existing ChatGPT subscription connection. Supplied task context, instructions, discussion and selected handoff contents may be sent to the model provider. Local persistence does not imply offline inference. Consult your provider's policies and your organization's requirements before using sensitive material.

GitHub publishing is explicit. Inspect the checkpoint preview and the destination repository's visibility before exporting. The coordinator exports only selected captured versions, a summary and a manifest. Avoid selecting content that should not be disclosed. Publishing credentials are not given to agents.

## Storage controls

Settings show app and project-folder usage. Defaults are 1,024 MiB app data, 2,048 MiB project data, 64 MiB diagnostics and seven-day completed native trace retention. At startup/shutdown, or through manual cleanup, eligible old/excess diagnostics, completed private native traces, redundant completed recovery payloads and orphan snapshots can be removed.

Saved conversations, every recorded deliverable version, credit history, unresolved recovery and pending exports remain protected. If protected material fills the budget, work pauses rather than deleting it. Recent completed traces can be reclaimed under app/free-disk pressure. Project files and unrelated shared caches/chats are never automatically deleted.

A running command can exceed a budget before the next check. Filesystem quotas and storage used by external tools are separate concerns. Closing the browser keeps the coordinator running; Stop shuts it down after active work drains.

## Publication hygiene

Use disposable examples and ignored `.test-artifacts/` for test outputs. Never add runtime homes, database files, authentication caches, local absolute home paths, raw transcripts or real customer/project content. `npm run check:publication` checks tracked content and image metadata; Gitleaks supplements it with a secret-pattern scan. Neither is a proof that arbitrary future content is safe. Review the staged diff and images before publishing.
