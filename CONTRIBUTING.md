# Contributing

Start with the README, product brief and domain language. Keep a change small enough to review and explain its effect on the user's workflow.

## Local checks

Use Node.js 24+:

```sh
npm ci
npm test
npm run build
npm run check:publication
```

Unit/integration tests use disposable fixtures and do not make live model calls. Browser workflows use an installed Playwright or `PROJECT_TEAM_PLAYWRIGHT_MODULE`; their output goes to ignored `.test-artifacts/`.

```sh
npm run test:browser
npm run test:storage-browser
```

Native `check:permissions` and `check:storage` commands use the installed Codex runtime and existing authentication. Their default probes do not request inference. Other diagnostics offer explicit live modes that can consume tokens; inspect the script before opting in. Save reports under `.test-artifacts/`, never public docs.

## Review expectations

Preserve user authority, serial execution, immutable outputs, exact usage identities, recovery safety and the project-folder boundary. Distinguish a product direction from implemented behavior. Do not claim model prices or token savings without evidence.

Use synthetic examples in issues, pull requests and screenshots. Remove account data, real prompts, local paths and credentials before sharing diagnostics. Report sensitive problems through the private security channel described in SECURITY.md.
