# Project Team contributor instructions

Read README.md, docs/product-brief.md and CONTEXT.md before changing product behavior.

The product goal is to fit agent responsibilities, model capability and reasoning effort to the task, with visible token usage and usable shared deliverables. Keep implemented behavior distinct from roadmap ideas. Do not claim automatic model routing or proven token savings without an implementation and evidence.

Preserve user authority over hiring, plan approval, milestone acceptance and publishing. Keep one active turn, immutable handoffs, usage identities, explicit recovery and the verified project-folder boundary.

Use disposable fixtures for tests. Never commit credentials, account data, raw model transcripts, personal project data, local home paths or runtime databases. Generated diagnostics belong under ignored .test-artifacts/, not in public documentation. Run npm test, npm run build and npm run check:publication before a release.
