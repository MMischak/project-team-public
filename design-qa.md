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

- 121 public unit/integration tests and production/type checks pass. The synchronized private checkout passes its 120 tests and production build.
- All six browser workflows pass: workspace, saved projects/characters, meetings, recovery, GitHub checkpoints and storage. They use isolated demo/fake-provider fixtures and no live inference or external publishing.
- The saved-project workflow verifies separate conversations, tasks, outputs, meetings, ledgers and runtime bindings; shared identities and unique portraits; folder-overlap rejection; stale mutation/read protection; draft separation and attachment reset; reload/restart persistence; and no automatic dispatch.
- Integration regressions cover draining active turns and exports, request races, unsafe database/native paths, failed-close retries and one app allowance across inactive project data.
- Reviewing a plan remains separate from approving it. Switching never authorizes model work, milestone acceptance or a checkpoint export.
- No unexpected page/console error or external request remains in the new browser workflow. Its two deliberate Stop operations explicitly account for their expected event-stream transport closures.

The scoped independent backend review has no unresolved high-priority finding. Publication-content and secret scans are required before pushing.

final result: passed
