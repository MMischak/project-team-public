# Tinkrew — design and workflow verification

Verified on 29 October 2026. The approved quiet SaaS layout remains the visual reference; the requested follow-up replaces photographic characters with distinct fictional adults in an animated-film style and adds saved-project navigation. The [current demo capture](docs/assets/workspace.png) is reproducible with `npm run capture:demo`.

## Visual checks

- White/ink work surfaces, blue selection/focus, readable sentence-case typography, fine dividers and a persistent manager conversation retain the approved hierarchy.
- The manager and eight possible hires have nine different original PNG portraits. A member’s appearance follows their identity across projects, including members with the same role. No runtime image generation or image-service request is needed.
- Project names, model/effort, usage and status come from saved state. Team profiles identify usage as belonging to the current project. Demo counters and examples are synthetic.
- The sidebar offers a separate New project action and shows which saved project is selected. Empty, paused, offline, switching and working states preserve their real meanings.
- The full nine-character roster initially overflowed at tablet width. A nonzero wrapping basis fixed it; subsequent checks passed at 320, 390, 768, 1024 and 1440 pixels. Dialogs, credits, project navigation and the full roster fit those widths.
- Desktop and mobile captures were inspected. The README uses 1440 × 1040 pixels and waits for every portrait to decode before capturing. Public images exclude ancillary provenance/personal metadata.

The earlier [visual target](docs/assets/design-target.png) documents the approved layout, including its historical character treatment. It is not a claim that the old photographic faces remain in the application.

## Functional verification

- 121 public unit/integration tests and production/type checks pass.
- All six browser workflows pass: workspace, saved projects/characters, meetings, recovery, GitHub checkpoints and storage. They use isolated demo/fake-provider fixtures and no live inference or external publishing.
- The saved-project workflow verifies separate conversations, tasks, outputs, meetings, ledgers and runtime bindings; shared identities and unique portraits; folder-overlap rejection; stale mutation/read protection; draft separation and attachment reset; reload/restart persistence; and no automatic dispatch.
- Integration regressions cover draining active turns and exports, request races, unsafe database/native paths, failed-close retries and one app allowance across inactive project data.
- Reviewing a plan remains separate from approving it. Switching never authorizes model work, milestone acceptance or a checkpoint export.
- No unexpected page/console error or external request remains in the new browser workflow. Its two deliberate Stop operations explicitly account for their expected event-stream transport closures.

The scoped independent backend review has no unresolved high-priority finding. Publication-content and secret scans are required before pushing.

## Project dropdown follow-up

The Active project control is now a native dropdown. Switching keeps the selected section open while all project-specific controls remain scoped by the keyed session. Meeting room identifies its project, meeting count and paused/offline state; the manager header also names the current project. Keyboard focus returns to the selector after a switch.

Production/type checks and the workspace, meeting and saved-project browser workflows were rerun successfully. The expanded saved-project workflow switches between distinct meetings/transcripts without leaving Meeting room, checks draft/recipient/attachment reset, independent process queues and explicit reconnect/Resume. Project, Team and Meeting room fit 320–1440 pixels with all nine participants. A previously incorrect avatar-stack sizing selector was fixed when this full-participant mobile check exposed it. Success captures wait for images to decode.

## Public README gallery

The README and screenshot tour use five fresh captures from one disposable demo run: Website launch overview, shared team profiles, Launch planning discussion, Customer insights / Customer discovery, and the mobile overview. Desktop images are 1440 × 1040; mobile is 390 × 844. Alex, Sam and Jordan retain their characters across views. The Website launch ledger is 3.6 demo credits throughout; Customer insights has its own 2.7-credit discussion after explicit connect/Resume.

Fonts and portraits finish loading before capture. CSS animations are fast-forwarded and the caret is hidden so transient navigation/hover states do not appear. Meeting views use actual page scrolling to retain project context and expose worker perspectives; no image content is retouched. Each PNG contains only image chunks, with no ancillary metadata. The capture run reports no browser errors, external requests or horizontal overflow and removes its temporary state.

All 121 public unit/integration tests and the production build pass for this publication. The gallery has been visually inspected, local links checked, and screenshot-tool prerequisites documented. Storage documentation and informational UI copy describe cleanup at app startup/shutdown or on manual request, matching the implementation.

final result: passed
