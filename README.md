<p align="center">
  <img src="docs/assets/hero.svg" alt="Tinkrew — give every task the right teammate" width="100%" />
</p>

<p align="center">
  <strong>Build an AI crew around the work.</strong><br/>
  Choose responsibilities, models and reasoning effort. Keep token usage visible. Review what your team produces.
</p>

<p align="center">
  <a href="#try-the-demo">Try the demo</a> · <a href="#inside-tinkrew">See it in action</a> · <a href="docs/showcase.md">Screenshot tour</a> · <a href="docs/privacy.md">Data &amp; privacy</a>
</p>

<p align="center"><sub>Early alpha · Local workspace · One active project at a time</sub></p>

<p align="center">
  <a href="docs/assets/workspace.png"><img src="docs/assets/workspace.png" alt="Website launch in Tinkrew: project dropdown, illustrated crew, proposed tasks, credit allowance and manager conversation" width="100%" /></a>
  <br/><sub>The real application with a disposable demo project. All examples, conversations and usage figures are synthetic.</sub>
</p>

## The right attention for the task

A small edit, a difficult implementation and an independent review need different kinds of attention. Tinkrew gives each responsibility a teammate: choose an available model and reasoning effort, give the work a clear brief, and steer the team through reviewable milestones.

| The work | A fitting responsibility |
| --- | --- |
| Clarify the outcome and propose a plan | A manager who brings the next decision to you |
| Make a focused change | A builder configured for the task’s needs |
| Work through a demanding problem | A builder with suitable capability and reasoning effort |
| Check the result independently | A reviewer reading the exact captured version |

**You choose the models and reasoning settings.** Automatic model routing and measured token savings are future work. Compare actual reported usage and output quality rather than assuming a model label guarantees savings.

## Inside Tinkrew

### Choose your crew

Members have clear responsibilities and distinct illustrated identities. Their profiles keep model, reasoning effort and usage for the current project visible. Your shared crew stays with you as you move between projects.

<p align="center">
  <a href="docs/assets/team.png"><img src="docs/assets/team.png" alt="Tinkrew team profiles showing distinct fictional characters, responsibilities, demo model settings and project usage" width="100%" /></a>
  <br/><sub>One shared crew. Different responsibilities. Fictional characters, with clearly labelled demo model settings.</sub>
</p>

### Discuss before changing the work

Open a project meeting, choose who contributes and compare perspectives. Discussion stays with that project. The manager’s proposed changes wait for your confirmation; plan approval and milestone acceptance remain separate decisions.

<p align="center">
  <a href="docs/assets/meetings.png"><img src="docs/assets/meetings.png" alt="Launch planning meeting with project context, named participants and a synthetic discussion" width="100%" /></a>
  <br/><sub>A saved discussion in Website launch. Creating a meeting alone does not send an AI instruction.</sub>
</p>

### Several projects. One shared crew. One focus.

Use the project dropdown to move between saved projects. Each keeps its own conversations, meetings, tasks, deliverables and credit allowance. The open section stays in place, so switching from a meeting shows the selected project’s discussion. Existing work drains before the next project opens paused and disconnected.

[See the project-switching example and mobile view →](docs/showcase.md#switch-projects)

## From an idea to a reviewed result

1. **Define the outcome.** Choose an existing project folder and a token allowance.
2. **Select the team.** Hire builders and reviewers with appropriate responsibilities, models and reasoning settings.
3. **Review the plan.** Inspect proposed tasks, assignments and expected outputs before approving work.
4. **Build and review.** One agent works at a time. Captured versions make handoffs and independent reviews traceable.
5. **Decide at milestones.** Accept results, request revisions, pause or resume. Preview selected versions before exporting a GitHub checkpoint.

Recovery checks saved attempts before retrying them. Project credits record attributable usage and reservations; account-wide provider quota is shown separately.

## Try the demo

Requires **Node.js 24 or newer**. The demo simulates replies and outputs without calling an AI provider.

```sh
git clone https://github.com/MMischak/project-team-public.git
cd project-team-public
npm ci
npm run demo
```

Open [localhost:4173](http://127.0.0.1:4173), then create a demo project using an existing disposable folder.

## Run with Codex

Live use currently targets a personal macOS workspace with a compatible Codex installation and an existing ChatGPT sign-in. For checkpoint exports, configure Git and the GitHub CLI for your own repository. Execution stays disabled if the required permission boundary cannot be verified.

```sh
npm run build
npm start -- --open
```

On macOS, **StartProjectTeam.command** also starts the app. Choose your folder, connect the manager, select members and approve a plan. Closing the browser keeps the coordinator running; **Stop local coordinator** in settings shuts it down.

One project credit represents **1,000 reported tokens**. It is a usage allowance, not money or a guaranteed billing cap.

## Your data and storage

This repository contains source and synthetic examples. Project files, credentials, runtime databases and session histories belong outside it. State stays on your computer; supplied task context still goes to the model provider during live inference. GitHub checkpoint publishing is a separate, explicit action.

The default app storage budget is **1 GiB shared across saved projects**, with **2 GiB for the selected project folder**, **64 MiB for diagnostics** and **seven-day completed trace retention**. Cleanup protects conversations, deliverables, credits, recovery and exports. These are execution guards; a running command can exceed a budget before the next check. Unrelated shared caches and other Codex chats are excluded from automatic deletion.

Read the [data guide](docs/privacy.md) for retention, inactive-project cleanup and publication boundaries.

## Develop and contribute

```sh
npm test
npm run build
npm run check:publication
```

The automated tests use isolated fixtures. With the optional browser tools installed, `npm run capture:demo` reproduces the [screenshot tour](docs/showcase.md#reproduce-the-images) using fresh demo data and cleans up its temporary workspace.

[Architecture](docs/architecture.md) · [Design language](docs/design.md) · [Design verification](design-qa.md) · [Contributing](CONTRIBUTING.md) · [Roadmap](docs/roadmap.md)
