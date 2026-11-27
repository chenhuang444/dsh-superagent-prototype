# SETUP

Instructions for an agent that sets up dsh-superagent with its operator. If you are a person, ask your coding agent to read this file and follow it.

## How to run the setup

The setup follows [docs/000-philosophy.md](docs/000-philosophy.md): it takes as little of the operator's attention as possible.

- **Before the first question,** read only this file and `docs/000-philosophy.md`, and run the probe below once; on GitLab, probe the operator's login once more when the address is known. Read nothing else until every answer is collected.
- **Ask one question per message,** about one thing. Wait for the answer before the next one. Skip a question the probe already answers.
- **Keep each message under 300 words,** unless the operator asks for more. Give each question a recommended answer the operator can accept with one word, and one sentence on why it matters.
- **Do not execute while asking.** Collect every answer, then send one message with the full plan, and execute only after the operator confirms it.
- **Never ask for a secret in the chat.** Steps that need the operator's hands, such as creating an account, signing a CLI in or entering an app secret, go into one message with the exact commands to run in their own terminal.
- **Teach the philosophy through the questions,** one sentence at a time, not as a lecture.

## 1. Probe

Run from this checkout, once, and keep the result to yourself:

```sh
node -v; pnpm -v; git --version; tmux -V; python3 --version; gh --version | head -1; glab --version | head -1; dsh --version
gh api user --jq .login
command -v lark-cli
meegle --version
meegle --profile superagent auth status --format json
grep -l -E 'id: dsh-superagent\b' "${DSH_HOME:-$HOME/.dsh}"/profiles/*/cordis.patch.yml 2>/dev/null
```

- **Prerequisites:** Node.js 22.19+ or 24+, pnpm, git 2.32+, tmux, Python 3.8+, and DSH within the `engines.dsh` range of `package.json`; for GitHub, GitHub CLI 2.48+; for GitLab, a recent GitLab CLI (`glab`), one that has `glab auth git-credential` and `glab api --paginate --output ndjson` (1.40 or later is safe). A missing one becomes an item of the plan, not a question. DSH also needs a model provider; if the operator has never run DSH with a model, configuring one is an operator step.
- **Operator login:** on GitHub, the `gh api user` result is the operator's own GitHub login. On GitLab, once question 2 gave the address, run `glab auth status --hostname <host>`, or `glab api --hostname <host> user | python3 -c 'import json,sys; print(json.load(sys.stdin)["username"])'` (`glab api` has no `--jq`), where `<host>` is the address without `https://`. Either login is the recommendation in question 7; when the operator's glab is not signed in there, ask for their username in that question instead.
- **Feishu Project:** `meegle --version` tells whether `meegle` is installed (1.0.27 is tested). `auth status` on the `superagent` profile tells whether an earlier setup signed it in, and its `host` is the operator's Feishu Project site. A missing `meegle` or a profile that is not signed in becomes an item of the plan, and only if question 12 says yes. The `auth status` command needs a profile of that name; when there is none it reports it as not signed in.
- **Existing profile:** a profile with a `dsh-superagent` entry is an earlier setup: ask whether to continue it, keep its configuration, and read Upgrade in `docs/006-deployment.md`.

## 2. Questions

Ask in this order, one per message, following the flow of work in [docs/001-domain.md](docs/001-domain.md): first where Triggers come from, then who may ask for work there, then what the Executor does with a Ticket. Recommendations are in brackets.

**Sources: where requests come from.**

1. **Code host.** Is the repository on GitHub or on GitLab? [The one the team's code is on; a deployment works on one.] The answers below say "the code host" for it.
2. With GitLab: **which GitLab address,** as `https://host[:port]`, without a path? It is the operator's own instance: never assume one, and do not suggest gitlab.com unless the operator names it.
3. **Sources.** Should the agent take requests from the code host only, or also from Feishu chats? [The code host only, unless the team works in Feishu.]
4. **Repository.** On GitHub: which github.com repository should the agent work on, as `owner/name`? On GitLab: which project, as `group/name`, with every subgroup in the path?
5. **Agent account.** Which account on the code host will the agent act as? [An account of its own, never the operator's: everything the agent writes appears under this name.] It may not exist yet; creating it is an operator step. On GitHub, it is a user account. On GitLab, offer three choices, as in the Agent GitLab account section of `docs/006-deployment.md`, and recommend the first the operator can do:
   - **a user for the agent,** which needs an administrator of the instance;
   - **a project access token** (or a group access token), which needs the Maintainer role on the project and no administrator: its bot user is the agent, and people mention it by the token's name;
   - **personal access token mode,** when the operator has neither: the agent works under the operator's own account with two tokens of theirs, and people address it with a line starting `agent:` rather than a mention.

   The first two set **Identity** to `dedicated`, the third to `personal`. Never sign the dedicated glab in with the operator's own token: under `dedicated` the operator's own requests would then count as the agent's and be dropped.
6. With Feishu: **which chats,** by name? The agent looks up their ids after the bot is configured.

**Policy: who may ask for work.**

7. **On the code host.** Which GitHub logins, or GitLab usernames, may ask the agent for work? [Only `<operator login>`: the agent acts only for people on this list, and a short list keeps the team's noise low while the operator learns how the agent behaves.]
8. With Feishu: **who may ask in Feishu?** [Everyone in the first chat, kept in sync with its members.]

**Execution: what the agent does with a Ticket.**

9. **Checkout.** Which local clone of the repository should each Ticket check out from? [A new clone under `~/src/<name>`.]
10. **Commit identity.** Who should the agent's commits name as author? [The agent account, so its work is visibly its own.] Another identity, such as the operator's, goes into the Delivery requirements prompt section. Skip it in personal access token mode: the agent account is the operator's own, so commits name the operator; say so in the plan.
11. **Auto-merge.** Skip it in personal access token mode, where a person always merges: the agent never enables auto-merge under a person's account, whatever Delivery requirements say. Otherwise: should the agent enable auto-merge on its own pull requests (GitLab: merge requests) once they are ready and approved? [No: people merge until the agent's work has been right for a while.] The agent never enables it as the agent account, so with yes it needs the CLI (`gh` or `glab`) of another account that may merge: ask the operator to sign one in among the operator steps, and name it in Delivery requirements. With no, remove the auto-merge paragraph from Delivery requirements.

**Feishu Project: work items and their comments.** Feishu Project has no bot account, so the agent works there under the operator's own account and signs what it writes; ask these only when question 12 says yes.

12. **Feishu Project.** Should the agent also read work items and comments from Feishu Project? [No, unless the team tracks its work there.] Everything it posts there appears under the operator's name, with a signature line, as in the Feishu Project section of `docs/006-deployment.md`.
13. **Site.** Which Feishu Project site does the operator sign in to, as a host name such as `project.example.com`? Take it from the probe's `host` when the profile is signed in; otherwise ask, and never assume one.
14. **Spaces.** Which spaces should the agent watch, by name or by a link into each? [One space to start; more can be added on the card later.] Look up their project keys with `meegle --profile superagent project search --project-key <name>` once the profile is signed in.
15. **Views.** Which views should it watch? Ask for their links. [A view of the operator's own stories in progress, and a view of bugs: only work items in these views reach the agent unasked.]
16. **我的待办.** Should it also watch the operator's to-do list? [No: a to-do list holds every node and subtask assigned to the operator, which is more than the agent needs to see.]
17. **Assigned bugs.** Should a new bug that enters the bug view be looked into without anyone asking? [Yes, in `observe` mode: the agent records what it would do without doing it, until the operator trusts its judgement.]
18. **Who may ask in Feishu Project.** [Only the operator: on Feishu Project the agent writes as them.] The list holds user_keys; `meegle --profile superagent user me` prints the operator's.

Do not ask about values with a good default; list them in the plan instead:

- profile `superagent`, a copy of DSH's Web profile kept apart from the profile the operator works in, so it restarts without closing their Sessions; port `3082`; state directory `<home>/.dsh/state/superagent` as an absolute path;
- an hourly check from the operator's own profile, which repairs dsh-superagent when it is not running;
- branch prefix `agent/`;
- accept mode `observe`, which records proactive work without doing it, and the default rules and prompt sections;
- with Feishu: the bot reads only mentions, and direct messages are on;
- with Feishu Project: `meegle` profile `superagent`, trigger word `agent`, a poll every minute, and the comments of at most 40 work items per round.

## 3. Plan

Send one message, under 300 words: what will be installed, the accounts and CLIs, the settings to save, the operator steps, and the defaults. Ask for one confirmation.

## 4. Execute

1. **Operator steps first.** Read the Accounts section of `docs/006-deployment.md`, write the CLI wrappers yourself, then send one message with what only the operator can do: create the agent account and, with auto-merge, sign a CLI in as the account that enables it, accept the repository invitation as the agent account, run `auth login` for each wrapper, and for Feishu create and publish the bot app and run the `config init` command with its secret. On GitLab, the operator steps depend on question 5. For a user of the agent's own: create the agent user on their GitLab instance; add it to the project as Developer or higher; create a personal access token for it with the scopes `api`, `read_repository` and `write_repository`; and sign the wrapper in with `<wrapper> auth login --hostname <host> --stdin < <token file>`, then delete the token file. For a project access token: in the project's **Settings → Access tokens**, add a token named as people should see the agent (such as `superagent`), with the role Developer, the scopes `api`, `read_repository` and `write_repository` and an expiry date; then sign the wrapper in with it the same way. In personal access token mode, the operator instead creates two tokens of their own, one with `api` and one with exactly `read_api` and `write_repository`, and signs one wrapper in with each (`glab-agent`, `glab-agent-worker`). Wait until the operator says it is done, then check each login: `<wrapper> api user --jq .login` for `gh`, and `<wrapper> auth status --hostname <host>` or `<wrapper> api --hostname <host> user` (its `username`) for `glab`. With a project access token, that `username` is the bot user's (`project_<id>_bot_<hash>`, with `bot: true`): use it wherever this guide says the agent login, and never put it on the allowed list. With a user of the agent's own, check that the login is not the operator's. With Feishu Project, the operator steps are: install `meegle` if the probe found none (`npm install -g @lark-project/meegle`); run `meegle config profile create superagent`; and run `meegle --profile superagent auth login --host <host>` with the site of question 13, which opens a browser to sign in as themselves. Tell them never to run `meegle config profile use`, which would switch the profile their own `meegle` uses. Then check the login with `meegle --profile superagent auth status --format json`: `authenticated` is `true` and `host` is the site.
2. **Install and start.** Follow the Install, Machine configuration, and Start and stop sections of `docs/006-deployment.md`. Skip the `git clone` of this repository: you are in its checkout. Clone the repository of question 4 if question 9 asked for a new clone. On GitLab, the profile's `cordis.patch.yml` sets `forge: gitlab` on the `dsh-superagent` entry, enables `dsh-superagent-gitlab` and disables `dsh-superagent-github`, as in `examples/profile.cordis.patch.yml`. With Feishu Project, it also enables `dsh-superagent-meego`. With an existing profile, skip the `dsh superagent --from-default-profile` command, which would replace the profile and delete its `cordis.patch.yml`, and edit that file instead of replacing it.
3. **Settings.** Save them through the Management API of `docs/006-deployment.md`, in this order: the code host's Source (`github` with `repository` and `cli`, or `gitlab` with `url`, `project` and `cli`, and in personal access token mode also `identity: personal`, `workerCli` and `trigger`), the `feishu` Source if used, the `meego` Source if used (`cli` `meegle` or its absolute path, `profile` `superagent`, `spaces` with the project keys of question 14, `views` with the links of question 15, and `todo` from question 16), the `policy` block with the allowed lists under `sources.github` or `sources.gitlab` (for Feishu, look up the chat ids with the bot's CLI first; for Feishu Project, `sources.meego.allowed` with the operator's user_key, and with yes to question 17 `sources.meego.admission.items.unlistedUnaddressed` set to `inferred` with a rule that new bugs in the bug view are looked into), and the `executor` block with a prepare command from the answer to question 9. Then save the prompts with the commit identity of question 10 and the auto-merge answer of question 11 in Delivery requirements. A save that returns `restarting: true` restarts dsh-superagent: wait until `scripts/dsh-superagent status` no longer exits 1 before the next request, and read the revisions again from `GET settings`.
4. **Failures.** A refused save names the setup problem in its response body. Find it in the Troubleshooting table of `docs/006-deployment.md`, fix it, and continue. Ask the operator only for what you cannot fix yourself.

## 5. Verify and hand over

`scripts/dsh-superagent status` exits 0 with no setup problem. If you run in the operator's own DSH profile, create the hourly check of the Hourly check section of `docs/006-deployment.md` with your schedule tool; otherwise give the operator its prompt to schedule there. Then send one message, under 300 words:

- The panel URL, and that the **Superagent** entry in the sidebar is where to look.
- How to try it: from an account on the allowed list, comment `@<agent login> <request>` on an Issue in the repository (on GitLab, in the project; with a project access token, type `@` and the token's name and pick the bot GitLab suggests; in personal access token mode, a line `agent: <request>`). A Ticket appears on the overview within about a minute.
- With a project access token: it works only in its own project, and the token needs renewing before it expires; the panel warns ahead of time.
- With Feishu Project: a comment on a watched work item whose line starts with `agent:` asks the agent; what it posts appears under the operator's name with a signature line. The limits are in the Feishu Project section of `docs/006-deployment.md`.
- In personal access token mode, the limits of the Personal access token mode section of `docs/006-deployment.md`: what the agent posts appears under the operator's name with a signature line, someone else should approve its merge requests, and the tokens need renewing before they expire.
- Three rules for the operator, from the Responsibility section of `docs/000-philosophy.md`: start narrow, tune for less noise, own what the agent says.
- Where to read more: the numbered documents in `docs/`, in order.
