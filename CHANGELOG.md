# Changelog

All notable changes to dsh-superagent are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- A Feishu Project (Meego) Source, phase 1. Feishu Project has no bot account, so the Source works under the operator's own account through the `meegle` CLI, with a profile of its own (`superagent` by default). It polls the views you name by link and, when **我的待办** is on, your to-do items in the chosen spaces. A work item that enters this scope for the first time becomes a Trigger; items already there when a view is added do not, and neither do items you created. Comments on watched and subscribed work items become Triggers too. See [006 Deployment](docs/006-deployment.md).
- On Feishu Project, people address the agent with a comment line that starts with the trigger word and a colon, `agent:` by default, optionally after mentions or `回复@…`. Quotes and code do not count, and neither does a work item's description. A comment that does not address the agent reaches it only on a work item with a live Ticket.
- The agent's replies on Feishu Project are comments under your name. Each ends with a signature line saying that DSH superagent posted it for you, followed by an invisible marker; dsh-superagent also records the comments it posts. It tells its own comments from yours by either, and posts a reply once even when a send is retried.
- The Feishu Project Policy part lists user_keys, with the admission rows `items` and `comments`. Setup reports a missing `meegle`, a profile that is not signed in and a profile without a site; these pause only the Feishu Project Source. The `meego` health entry reports the scope and how many rounds a full turn of its comments takes.
- Workers get a read-only `meegle` in `worker-bin`. It runs under the Source's profile, refuses `--profile`, and allows only commands that read; every other command is refused with the note that it writes. Workers have no tool to write to Feishu Project yet.
- GitLab setup names a project or group access token as a way to give the agent an account of its own, with no administrator: [006 Deployment](docs/006-deployment.md) and [SETUP.md](SETUP.md) describe it, and the setup questions skip commit identity and auto-merge in personal access token mode.
- Under `dedicated`, setup reads the token's expiry date, and the GitLab card warns before it expires, as personal mode already did.
- The GitLab card warns when the agent's account is on the allowed list and is no bot user: that is usually your own token with Identity left at `dedicated`, which drops every request you make.

### Changed

- Personal mode refuses a glab signed in as a bot user, such as a project access token's, and says to use `dedicated` for it, instead of reporting that the two glabs are signed in to different accounts.

## 0.2.2-rc.3 - 2026-11-26

This release still targets the DSH 0.2.2-rc.x interfaces and requires DSH 0.2.2-rc.2 or later.

### Added

- Personal access token mode for GitLab. Set **Identity** to `personal` on the GitLab Source when the project cannot have an account of the agent's own. The agent then works under the operator's account with two tokens: `api` for dsh-superagent, and `read_api` with `write_repository` for the **Worker glab**. Setup checks that both belong to one user and have those scopes. The default, `dedicated`, keeps the existing behaviour. See [006 Deployment](docs/006-deployment.md).
- Under `personal`, everything dsh-superagent writes on GitLab carries a signature line above its hidden marker. A note of the account without the marker counts as the person's own words. People address the agent with the **Trigger** word and a colon at the start of a line, `agent:` by default, optionally after mentions. Quotes and code do not count. A note that only mentions the person is not for the agent, unless it answers in a discussion the agent took part in.
- Under `personal`, the worker's git refuses to push tags, delete remote branches or push the default branch. dsh-superagent withdraws auto-merge on a ticket's MR and signs again an MR description that lost its marker. The GitLab Source warns when the account is a Maintainer, when GitLab did not report the tokens' scopes, and when a token expires within 14 days.
- GitLab write tools for workers: `gitlab_reply`, `gitlab_resolve`, `gitlab_mr_create`, `gitlab_mr_update`, `gitlab_mr_close`, `gitlab_upload` and `gitlab_job_retry`. They run with dsh-superagent's glab, act only on the ticket's own Issues and MRs, and find what an earlier attempt of the same call posted.

### Changed

- GitLab workers write to GitLab only through the `gitlab_*` tools, in both identities. The GitLab prompts and the `dsh-superagent-gitlab` skill no longer show `glab api -X POST` or `PUT`; glab stays for reads.

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
