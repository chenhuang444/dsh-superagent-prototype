# Changelog

All notable changes to dsh-superagent are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## 0.2.2-rc.2 - 2026-11-25

This release still targets the DSH 0.2.2-rc.x interfaces and requires DSH 0.2.2-rc.2 or later.

### Added

- Cleanup of Ticket directories. A cleanup command in the Execution settings removes an ended Ticket's directory once the retention period passed, seven days by default. It is skipped while tracked files have uncommitted changes or a person's message waits to resume the Ticket; untracked files do not stop it. An automatic pass runs at start, every hour and when a Ticket is accepted. Without a cleanup command nothing is cleaned, so existing deployments are unchanged. See [003 Execution](docs/003-execution.md#cleaning-up-ticket-directories).
- A Workspaces view under Execution lists every Ticket directory with its Ticket and Executor, git state, size and cleanup state, and the directories no Ticket names. A person can clean one now or force a cleanup, which also discards uncommitted changes. `GET workspaces` and `POST workspaces/<name>/clean` serve it.
- A Ticket whose cleaned directory is rebuilt by the prepare command tells its worker that local changes and installed dependencies are gone.

### Fixed

- A main Session archived in the DSH Web UI no longer stops dsh-superagent. DSH refused each of its steps, so candidates timed out without a Decision while every health entry stayed ready. The next delivery now creates a new main Session in its place.

## 0.2.2-rc.1 - 2026-11-20

This release targets the DSH 0.2.2-rc.x interfaces. It requires DSH 0.2.2-rc.2 or later, as `engines.dsh` and the peer dependencies state.

### Added

- GitLab support. A deployment sets `forge: github` (the default) or `forge: gitlab`. The GitLab Source receives Issues, merge requests, comments, diff discussions, approvals and pipelines from one project, and the agent answers in the original discussion. The agent account signs in through its own `glab` wrapper, and git uses `glab` as its credential helper for the configured instance only. The GitLab address is given at setup; nothing is preset. See [006 Deployment](docs/006-deployment.md).
- `SETUP.md` asks whether the code host is GitHub or GitLab and guides a GitLab setup: the agent account, its token, the `glab` wrapper and the profile.
- GitLab prompts under `prompts/forge/gitlab/` and the `dsh-superagent-gitlab` skill.
- A Forge layer (`src/forge/`) that routes code-host behaviour: setup checks, the worker environment, review reports, ticket cards, repository reads, skills and prompt texts. [008 Cookbook](docs/008-cookbook.md) describes how to add a forge.
- Model tiers in the Execution settings. Each tier has a name, a hint and a model. When the requester asks for one, an accept may name it in `executor_tier`, and the worker Session starts on that tier's model.
- The Assessor, Executor and tier model fields offer every configured provider in a dropdown, then that provider's models and the chosen model's reasoning efforts. A provider whose model list failed to load is named with its error.

### Changed

- Built against DSH 0.2.2-rc.2 (cordis 4.1.0, schemastery 3.19.0). The Executor uses `waitForTreeWork`, `listDescendants` and `interrupt` in place of the removed child-session methods, reads worker transcripts from session persistence, and records role models with `agent.model.select`.

### Fixed

- A worker turn or hand-off no longer fails with `subagents.waitForChildren is not a function` on DSH 0.2.2.
- `scripts/dsh-superagent` no longer fails when `ps` prints bytes that are not valid UTF-8.

### Unchanged

- GitHub deployments behave as before. The GitHub baseline snapshot tests pass without updates.

## 0.1.0 - 2026-10-31

- First published research prototype.
