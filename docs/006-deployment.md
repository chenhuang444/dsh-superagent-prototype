# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **An agent account on the code host,** GitHub or GitLab; a deployment works on one. The agent comments, pushes branches and opens pull requests (GitLab: merge requests) as this account, through a CLI signed in only as that account: `gh` for GitHub, `glab` for GitLab.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories and commands.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm, git 2.32+, Python 3.8+ and tmux
- For GitHub: GitHub CLI (`gh`) 2.48 or later. For GitLab: a recent GitLab CLI (`glab`), one that has `glab auth git-credential` and `glab api --paginate --output ndjson`; 1.40 or later is safe. Source CLI fields must point to `gh`, `glab` or `lark-cli` wrappers; the host relies on their subcommands and output formats.
- The code host: a repository on github.com, or a project on a GitLab instance served at `https://host[:port]` (see [GitLab deployments](#gitlab-deployments)). GitHub Enterprise Server and a GitLab served under a path, such as `https://host/gitlab`, are not supported. To create a checkout per Ticket, keep a local clone from which the prepare command can add worktrees. Install `git-lfs` if that repository uses Git LFS.
- A model provider configured for DeepSeek Harness. dsh-superagent uses the profile's default model unless the Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because dsh-superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. dsh-superagent reads the login the same way.

### Agent GitLab account

On GitLab, the agent is a user on the operator's own GitLab instance; `https://gitlab.example.com` stands for its address below.

1. Create a GitLab user for the agent, and add it to the project as Developer or higher. The agent pushes its branches and opens merge requests, so Reporter is not enough.
2. As that user, create a personal access token with the scopes `api`, `read_repository` and `write_repository`, and an expiry date you will remember to renew.
3. Give it a glab that uses only its own configuration:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/glab-agent <<'EOF'
   #!/bin/sh
   export GLAB_CONFIG_DIR="$HOME/.config/glab-agent"
   exec glab "$@"
   EOF
   chmod +x ~/.local/bin/glab-agent
   glab-agent auth login --hostname gitlab.example.com --stdin < token.txt && rm token.txt
   glab-agent auth status --hostname gitlab.example.com
   ```

   For an address with a port, pass `--hostname gitlab.example.com:8443`. The last command names the account it is signed in as. dsh-superagent reads it with `glab-agent api --hostname gitlab.example.com user`.

   By default glab keeps the token in the operating system's keyring when one is available. glab keys keyring entries by host and does not separate them by `GLAB_CONFIG_DIR`, so a token the operator's own glab keeps there for the same host would collide with the agent's. Add `--insecure-storage` to the login when the operator's own glab uses the same host, or when the keyring is not available to the service, for example in a tmux session started over SSH on Linux: the token is then kept in plain text in `~/.config/glab-agent/config.yml`, which glab writes readable only by the operator's user. Prefer the keyring when neither applies.

### Personal access token mode (GitLab)

Use this mode only when the project cannot have an account of the agent's own: creating a user needs an administrator, and a project or group access token needs the Maintainer role. In personal mode the agent works under the operator's own GitLab account. Set **Identity** to `personal` on the GitLab Source; the default, `dedicated`, keeps the account above.

1. As yourself, create two legacy personal access tokens, each with an expiry date about 90 days ahead:
   - `superagent-host` with the scope `api`. Only dsh-superagent itself uses it: polling, and every note, merge request and discussion change the agent makes.
   - `superagent-worker` with exactly `read_api` and `write_repository` (`read_repository` and `read_user` are allowed too). Workers use it: they read the API and push branches, and GitLab refuses their API writes, so everything they post goes through dsh-superagent's tools.
2. Give each token a glab with its own configuration, as in step 3 above:

   ```sh
   for name in glab-agent glab-agent-worker; do
     printf '#!/bin/sh\nexport GLAB_CONFIG_DIR="$HOME/.config/%s"\nexec glab "$@"\n' "$name" > ~/.local/bin/$name
     chmod +x ~/.local/bin/$name
   done
   glab-agent auth login --hostname gitlab.example.com --stdin < host-token.txt && rm host-token.txt
   glab-agent-worker auth login --hostname gitlab.example.com --stdin < worker-token.txt && rm worker-token.txt
   ```

   The keyring note above applies to both, and more so here: your own glab, `glab-agent` and `glab-agent-worker` all sign in to the same host, so add `--insecure-storage` to both logins unless your own glab keeps its token in a file.
3. On the GitLab Source, set **Identity** to `personal`, **glab** to `/home/me/.local/bin/glab-agent`, **Worker glab** to `/home/me/.local/bin/glab-agent-worker`, and **Trigger** to the word that addresses the agent (`agent` by default). Put your own username on the GitLab allowed list.

Setup checks that both glabs are signed in to the same account, that the host token has `api`, and that the worker token has `read_api` and `write_repository` and nothing broader. It reads both tokens' expiry dates; the panel warns before they expire. GitLab before 15.5 cannot report a token, so setup then skips these checks and says so. The worker glab is required: personal mode has no single-token form, because a worker posting with the host token would write notes the agent cannot tell from yours.

**Using it.** People address the agent with a line that starts with the trigger word and a colon, after any mentions: `agent: fix the spacing`, or `@lisi agent: fix the spacing`. `@<your username>` alone addresses you, not the agent. Everything the agent posts ends with a small line saying that DSH superagent posted it for you and how to address the agent, followed by a hidden marker by which dsh-superagent recognizes its own notes.

**Limits.**

- The host token reaches every project you can reach; only dsh-superagent's own process holds it. The worker token can read every project you can read.
- `write_repository` accepts git push options, which can change a merge request's title, description, labels and auto-merge. Workers are told not to use them, and dsh-superagent turns auto-merge back off when a push enabled it.
- GitLab's audit log, push events and pipelines show you, and pipelines run with your role. If you are a Maintainer, the panel warns: protect the default branch so that nobody pushes to it directly.
- GitLab does not notify you of your own actions, so you get no notification of the agent's notes; follow its progress in the panel or Feishu. Each discussion the agent posts in makes you a participant, so you get notified of later replies there, and a person the agent mentions sees the mention as yours.
- GitLab CE has no approval rules, so nothing stops you from approving and merging the agent's merge requests yourself: agree in the team that someone else approves them.
- Workers' git runs a pre-push guard from `<stateDir>/worker-hooks`, which refuses tags, deleting remote branches and pushing to the remote's default branch. It is a guardrail, not a boundary: a repository whose own configuration sets `core.hooksPath`, or `git push --no-verify`, skips it.

**Rotation.** Before a token expires, create a new one with the same scopes, sign the matching glab in again with it, and check setup again from the panel.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

## Install

Run this block once, on a machine that has no `superagent` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.2-rc.2
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, also enable the `dsh-superagent-feishu` entry there. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration and, by default, the Ticket directories in `work`. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |
| `forge` | no | The code host: `github` (the default) or `gitlab`. Its Source plugin must be enabled: `dsh-superagent-github` or `dsh-superagent-gitlab` |

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

## Start and stop

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` runs `dsh --profile superagent` in tmux session `dsh-superagent`, or `dsh-<profile>` for another profile. It waits up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing setup information. It refuses duplicate instances, including ones started outside this script.

`stop` and `restart` request graceful shutdown and wait up to five minutes for Executors. They never force-kill the process or touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each profile stores logs and control files under `.artifacts/`:

- Startup logs: `dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** Set the GitHub repository (`owner/name`) and agent CLI, for example `/home/me/.local/bin/gh-agent`; on GitLab, the address, the project and the agent's glab, as [GitLab deployments](#gitlab-deployments) describes. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts or GitLab usernames, and Feishu users, who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** The directory root and a prepare command. To give each Ticket a checkout of the repository:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   To remove the directories of ended Tickets, set a cleanup command, such as `git -C /home/me/src/widgets worktree remove --force "$DSH_SUPERAGENT_DIR"`, and the retention days, seven by default. [003 Execution](003-execution.md#cleaning-up-ticket-directories) describes the rules and a prepare command that rebuilds a cleaned directory from its branch.

   List personal CLIs, such as one signed in to your own account, as blocked commands.
4. **Prompts.** Set the team sections: the disclosure line of messages on the code host, review bots, the commit author and the auto-merge condition.

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET settings` | `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent: `restarting: true`. Refused when setup has nothing to fix |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the prompt configuration: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, and `skillPrefix`, which Sessions load a skill's name under. Or saves it: the new `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |
| `GET workspaces?filter=<attention, due, failed, orphan or all>` | The Ticket directories: `root`, `scannedAt`, `retentionDays`, `cleanupCommand`, `counts` per filter, and `items`, each with `name`, `directory`, `exists`, `state` (`active`, `retained`, `due`, `skipped`, `failed`, `cleaned` or `orphan`), `reason`, its last scan's `facts`, its `ticket` and its last `cleanup` |
| `POST workspaces/<name>/clean` with `{"force": false}` | Cleans a directory now: its cleanup record, with `state` `cleaned` or `failed` and the command's `output`. `force: true` also discards uncommitted changes and removes what the command leaves |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `workspaces` | Ticket directory cleanup: an error while a directory's last cleanup failed |
| `github`, `gitlab`, `feishu`, `history` | Source polling, events and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:github`, `source:gitlab`, `source:feishu`: `{"enabled": true, "config": {…}}`. GitLab's config has `url`, `project` and `cli`, `pollSeconds` (60 by default) and the switches `observeIssues`, `observeMergeRequests`, `observeComments` and `observeCi`, off by default. GitHub's config has `repository` and `cli`, and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI; Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`.
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, by `issues`, `pulls`, `comments` or `ci` for GitHub, and by `issues`, `merge_requests`, `comments` or `ci` for GitLab, whose part is `{"allowed": [{"id": "<username>"}], "bots": [{"id": "<username>"}]}`; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `tiers`, `maxWorkers`, `directory`, `prepare`, `cleanup`, `retentionDays` and `blockedCommands`. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing a repository or CLI runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## GitLab deployments

A deployment works on one code host. With `forge: gitlab` on the `dsh-superagent` entry, the GitLab Source takes the GitHub Source's place: it polls the project's Issues and merge requests and replies on them, and the agent delivers its work as merge requests. The GitHub Source, if it stays enabled, reports *Off: not this deployment's code host* and polls nothing. GitLab has no notifications the agent can read, so the Source reads the Issues and merge requests updated since its last poll, every minute by default, with their discussions. Issues are `#<iid>` and merge requests `!<iid>`; the two are numbered separately.

1. **Account.** Create the agent user, its token and its glab wrapper, as in Agent GitLab account above, or, without one, your own two tokens as in Personal access token mode.
2. **Profile.** Set `forge: gitlab` on the `dsh-superagent` entry, enable `dsh-superagent-gitlab` (`disabled: false`) and disable `dsh-superagent-github` (`disabled: true`), as the comments in [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) show.
3. **GitLab Source.** In **Settings → Sources → GitLab**, set the address (`https://gitlab.example.com`, or with a port, without a path or a trailing slash), the project as `group/name` with every subgroup, and the agent's glab, for example `/home/me/.local/bin/glab-agent`. Saving checks the account, the project and the agent's role, then restarts dsh-superagent.
4. **Policy.** Under **On each Source → GitLab**, list the GitLab usernames that may ask for work, and the bots whose messages may become candidates. GitLab's bots are bot users, such as the users of project and group access tokens; a CI or review bot that runs under an ordinary user counts as a person unless it is on the bot list.
5. **Execution.** Each Ticket's checkout comes from a local clone of the project. The prepare command adds a worktree from the default branch, or from the merge request that started the Ticket:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "$DSH_SUPERAGENT_GITLAB_URL/$DSH_SUPERAGENT_GITLAB_PROJECT.git" "${DSH_SUPERAGENT_GITLAB_MR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

A person asks for work by writing `@<agent username>` (in personal mode, a line that starts with `agent:`) in a new Issue, a merge request description or a note, including a note on a diff. A note in a discussion is answered in that discussion. A merge request the agent opens from its project, on a branch whose last path segment is the Ticket's short name, binds to the Ticket, as does the merge request that started it; its notes, approvals, requests for changes and pipeline changes then reach the worker. The Ticket ends when the merge request merges or closes.

Auto-merge uses `glab mr merge <iid> --auto-merge --sha <sha>` of the account that the Delivery requirements name, never the agent's: GitLab merges once the pipeline succeeds, and only if the source branch's head is still `<sha>`. Withdrawing it cancels *merge when pipeline succeeds* through the API.

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the code host's repository or project and the agent's push access, writes the worker environment, and checks that git uses only the agent's credentials for the code host. A Feishu setup failure disables only the Feishu Source.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` runs the agent's CLI; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the github.com credential helper, rewrites GitHub SSH addresses to HTTPS and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed.

On a GitLab deployment, `glab` runs the agent's glab (in personal mode the worker glab) with `GITLAB_HOST` set to the configured host; `gh` fails, saying to use `glab`, so a worker never reaches the operator's own `gh`; and the git configuration selects `glab auth git-credential` of the same glab as the credential helper of the GitLab address alone, rewrites `git@<host>:` and `ssh://git@<host>/` addresses to HTTPS, and holds nothing for github.com. `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`, `OAUTH_TOKEN`, `CI_JOB_TOKEN` and `GITLAB_HOST` are removed from the agent's environment, so glab uses only the wrapper's login. dsh-superagent's own glab calls pass `--hostname` and turn off glab's update check and prompts. In personal mode the git configuration also sets `core.hooksPath` to `<stateDir>/worker-hooks`, which holds the pre-push guard; each hook there runs the repository's own hook of the same name after it, so hooks such as Git LFS's keep working.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. On GitLab, mention the agent's username in a new Issue or note in the project. For Feishu, mention the bot in a configured chat.

## Upgrade

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`.
4. Run `scripts/dsh-superagent restart` and inspect its status.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

GitHub deployments need no change for the GitLab support: `forge` defaults to `github`, and the GitLab plugin is inserted disabled. To move a deployment from GitHub to GitLab, stop it, change `forge` and the plugin toggles as in GitLab deployments, start it and set the GitLab Source; Tickets and Threads from GitHub stay in the database but no longer receive anything. A team that overrode a built-in part or a team section on GitHub keeps its text, which names GitHub's commands: rewrite it for GitLab. An overridden built-in part may instead drop its override to follow the GitLab default; a team section's GitLab default is in `prompts/forge/gitlab/team/`.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `The GitHub Source names no repository.` | Set the repository, `owner/name`, on the GitHub card |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| `git does not read the github.com credential configuration dsh-superagent writes` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The GitLab Source names no GitLab address.` | Set the address, `https://host[:port]` without a path, on the GitLab card |
| `The GitLab Source names no project.` | Set the project, `group/name` with every subgroup, on the GitLab card |
| `The agent glab is not set.` | Set the agent's glab wrapper on the GitLab card |
| `The agent glab was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent glab cannot read its account on …` | Sign the wrapper in with `glab auth login --hostname <host> --stdin`, as in Agent GitLab account; check that the token has not expired or been revoked and has the `api` scope. If the operator's glab is signed in to the same host through the keyring, sign the wrapper in again with `--insecure-storage` |
| `The agent glab did not report a GitLab account on …` | The address is not a GitLab API, or a proxy answers in its place; check the address with `curl <address>/api/v4/version` |
| `@… cannot read …` (GitLab) or `The agent glab did not return …` | Add the agent user to the project, check the project's path, including subgroups, and that the token has the `api` and `read_repository` scopes |
| `@… cannot push to …; it needs the Developer role or higher.` | Give the agent user the Developer role or higher on the project or its group |
| `git does not read the https://… credential configuration dsh-superagent writes` | Install git 2.32 or later |
| `Personal mode needs the worker glab, …` or `The worker glab was not found.` | Set the worker glab on the GitLab card, as in Personal access token mode |
| `The worker glab cannot read its account on …` | Sign the worker glab in with its own token, `glab-agent-worker auth login --hostname <host> --stdin`; with the keyring, add `--insecure-storage` |
| `The worker glab is signed in as @…, not @…` | Sign both glabs in to your own account, each with its own token |
| `The agent glab's token has the scopes …` | Sign the agent glab in with a token that has `api` |
| `The worker glab's token must have exactly read_api and write_repository …` | Create the worker token again with only `read_api` and `write_repository`, and sign the worker glab in with it |
| `GitLab on … did not report the token of a glab.` | GitLab answered `personal_access_tokens/self` with an error other than 404; the output says which, often an expired or revoked token |
| `dsh-superagent: push refused: …` (worker) | The pre-push guard of personal mode refused a tag, a deletion or the default branch; a person does those |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment. On GitLab, check the `gitlab` health entry, and that the mention is the agent's exact username |
