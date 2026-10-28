# Design verification — workspace refresh

Verified on 28 October 2026 against the [selected visual target](docs/assets/design-target.png): a quiet white SaaS workspace with generated photographic characters. The [implemented demo capture](docs/assets/workspace.png) is reproducible with the demo capture script.

## Comparison and iteration

The source is 1488 × 1057 pixels. Live desktop captures used a 1488 × 1059 CSS viewport; the two-pixel height difference was accounted for without stretching either image. Full-frame and focused side-by-side composites were inspected. A separate 390 × 844 capture and mobile plan-review dialog were checked. The README capture uses 1440 × 1040.

The first comparison found smaller supporting typography/portraits, a narrow conversation column, weak assignment/outcome hierarchy and a stacked review summary. The next pass enlarged the relevant type and portraits, matched the column proportions, added assignment dividers, refined outcomes, restored a photographic conversation identity and made the review summary responsive. The attachment label was darkened to provide 5.30:1 contrast on its message background. Fresh captures verified these fixes.

## Required surfaces

- **Typography:** sentence-case system sans hierarchy, readable project/section titles, bounded descriptions and smaller supporting metadata. No external font request.
- **Spacing and layout:** compact navigation, project context and roster above the work, a clear next action, fine separators and a persistent conversation. Dialogs scroll within the viewport.
- **Color:** white/ink surfaces, blue focus/selection, actual-state green and strengthened muted/attachment text. Keyboard focus and reduced-motion behavior remain available.
- **Images:** generated fictional photographic portraits load correctly and remain consistent across rosters, profiles, assignments and conversations. Public images exclude ancillary personal/provenance metadata. No user photographs or private source screenshots are included.
- **Content:** names, model/effort, credits, task status and outputs come from saved state. Actual demo tasks/counters replace the concept's illustrative values. Pause/Resume, attachment and final approval controls are retained for the real application.

The plan-review dialog is a read-only step: opening it leaves the proposal, tasks and credits unchanged. **Approve plan** remains the separate final action. Meeting drafts stay mounted; captured outputs, recovery decisions and export previews preserve their existing boundaries.

## Functional verification

- 98 unit/integration checks and the production/type check pass.
- Workspace browser checks pass, including the new plan-review no-dispatch/no-credit assertions, focus handling, hiring, revisions, version review and milestone acceptance.
- Meeting, checkpoint, recovery and storage browser workflows pass with isolated synthetic fixtures.
- Responsive checks cover 320, 390, 768, 1024 and 1440 pixels with visible credits and no horizontal overflow. Live desktop/mobile views were also inspected in the in-app browser.
- Fixtures use no live model inference or external GitHub export.

No actionable P0/P1/P2 finding remains. Optional P3 refinement: small-label sizing can be tuned further, and the assistant portrait sits within bubble metadata rather than beside the entire bubble. These do not block the selected visual direction or the workflow.

final result: passed
