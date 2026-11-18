# Design: GitLab forge

This file is the contract between the three implementers (core, source, docs). Names and signatures here are fixed; change them only after telling the lead.

## D1. Configuration and deployment (owner: core, `src/deployment.ts`)

- `FORGE_KINDS = ['github', 'gitlab']` in `src/forge/types.ts`. Remove every Gerrit placeholder the cherry-pick brought (`GerritAccountsSchema`, `GerritAccount`, `gerritOf`, `gerrit` on `Deployment`, `skill/gerrit`, `gerrit` in `PROTECTED_COMMANDS`, REVIEW_KEYS, resources, locales, test fixtures `testGerrit*`, `skills/dsh-superagent-gerrit`).
- GitLab Source setup fields:

```ts
export const GitlabAccountsSchema = z.object({
  url: z.string().trim().regex(/^(https:\/\/[A-Za-z0-9.-]+(:\d+)?)?$/, 'https://host[:port], without a path or trailing slash').default(''),
  project: z.string().trim().regex(/^([A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+)?$/, 'group/name').default(''),
  cli: z.string().trim().default(''),
})
export interface GitlabAccount {
  cli: string          // absolute path of the agent's glab (wrapper)
  url: string          // https://host[:port], as configured
  host: string         // new URL(url).host, passed to `glab api --hostname`
  login: string        // the agent's username
  id: number           // the agent's user id
  email: string        // commit email: user.commit_email || user.email || `${id}-${login}@users.noreply.${hostname}`
  projectId: number    // numeric project id
}
export function gitlabOf(deployment: Pick<Deployment, 'gitlab'>): GitlabAccount  // throws when not GitLab
```

- `Deployment.gitlab?: GitlabAccount`; `repository` = the project's canonical `path_with_namespace`; `account = { kind: 'gitlab', login, email, repository, web: url }`.
- `resolveGitlab(machine, config, probe, path)` checks, in order: `gitlabUrlUnset`, `gitlabProjectUnset`, `gitlabCliUnset`, `gitlabCliMissing`, `gitlabCliSignedOut` (`[cli, 'api', '--hostname', host, 'user']` fails), `gitlabNoAccount`, `gitlabProjectUnreadable` (`[cli, 'api', '--hostname', host, 'projects/<urlencoded project>']`), `gitlabProjectUnreported`, `gitlabProjectReadOnly` (max of `permissions.project_access.access_level` and `permissions.group_access.access_level` < 30, Developer). Place of all of them: `gitlab`. `gitlabGitTooOld` has place `deployment`.
- Setup fields: `ACCOUNT_FIELDS.gitlab = ['url', 'project', 'cli']`.
- No address, project or version is written in code; tests use `https://gitlab.example.com` and `acme/widgets`.

## D2. Commands (owner: core, `src/infra/commands.ts`)

```ts
glab<T>(args: string[]): Promise<T>                                   // JSON of `<cli> ...args`
gitlab<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
gitlab(path: string, ...flags: string[]): Promise<string>             // raw output
gitlabPages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]>
```

- Every call runs `<cli> api --hostname <host> projects/<projectId>[/<path>] ...flags`. `path` is relative to the project, may carry a query string, and is refused when absolute, a URL or containing `..` (same rule as GitHub's `path`). `''` names the project itself.
- `gitlabPages` adds `--paginate --output ndjson` and parses one JSON value per non-empty line.
- Failures: glab prints `glab: <message> (HTTP <status>)` or `glab: HTTP <status>`; `commandError` already reads the status into `CliError.code`.
- `run` additionally sets `GLAB_CHECK_UPDATE=false` and `NO_PROMPT=1` (or the equivalents glab documents).
- `agentVariables` also clears `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`, `OAUTH_TOKEN`, `CI_JOB_TOKEN`, `GITLAB_HOST`.

## D3. Worker environment (owner: core, `src/forge/gitlab-environment.ts`)

- Shim `glab`: exports `GITLAB_HOST=<host>` and execs the configured cli.
- `commands: ['glab']`; `PROTECTED_COMMANDS = ['gh', 'git', 'lark-cli', 'glab']`.
- Blocked hint: `use glab, which acts as <login>`.
- git config lines (hostname = host without port):

```
[credential "<url>"]
	helper = "!'<cli>' auth git-credential"
[url "<url>/"]
	insteadOf = git@<hostname>:
	insteadOf = ssh://git@<hostname>/
```

- `verify` reads `credential.<url>.helper` like GitHub and throws `SetupError('gitlabGitTooOld')`.

## D4. Source (owner: source, `src/sources/gitlab*.ts`)

- Kind id and Trigger source: `gitlab`. Health entry `gitlab`. Plugin name `dsh-superagent-gitlab`, entry `src/sources/gitlab.ts`, build output `lib/gitlab-watch.js`, export `./gitlab-watch`.
- Issue and MR iids are separate sequences. Thread ids: `issue:<iid>`, `mr:<iid>`, `ci:<branch>`; Thread keys `gitlab:issue:12`, `gitlab:mr:34`.
- Trigger `meta`: `{ iid, isMr, kind: 'issue' | 'mr' | 'note' | 'diff' | 'review', noteId?, discussionId?, path?, line?, mrAuthor?, ci?, branch?, revision? }`.
- Channel address (strings): `{ kind: 'issue' | 'mr', iid, discussion?, url? }`. `discussion` is set for a note in a non-individual discussion, so replies go into that discussion.
- `channel.link(address, links)` uses `links.gitlab?.url` and `links.repository` for `<url>/<repository>/-/issues/<iid>` or `/-/merge_requests/<iid>`.
- Source config: `GitlabAccountsSchema.extend({ pollSeconds (60–3600, default 60), failuresBeforeError (default 3), observeIssues, observeMergeRequests, observeComments, observeCi })`, all switches default false. Admission rows: `issues`, `merge_requests`, `comments`, `ci`.
- Policy part: `allowed: [{ id: <username> }]`, `bots?: [{ id }]`. Username pattern `[A-Za-z0-9_.-]+`.
- Environment variables: `DSH_SUPERAGENT_GITLAB_URL`, `DSH_SUPERAGENT_GITLAB_PROJECT` (path), `DSH_SUPERAGENT_GITLAB_PROJECT_ID`, `DSH_SUPERAGENT_GITLAB_ACCOUNT`, `DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL`, `DSH_SUPERAGENT_GITLAB_ISSUE_IID`, `DSH_SUPERAGENT_GITLAB_MR_IID`, `DSH_SUPERAGENT_GITLAB_MR_HEAD` (`refs/merge-requests/<iid>/head`). Empty when not applicable.
- Polling (no Todos API): each round scans `issues?updated_after=<cursor>&order_by=updated_at&sort=asc&per_page=100` and `merge_requests?…` since the cursor; for each updated item reads its `discussions` and receives notes newer than the item's cursor that mention the agent, or all of them when `observeComments`; receives a new Issue / MR body when it mentions the agent or its observe switch is on. Subscribed Threads are polled with `pollThreads` from `poll.ts`. System notes are skipped, except `approved this merge request`, `unapproved this merge request` and `requested changes`, which become `kind: 'review'` Triggers. The agent's own notes are skipped. Cursors advance only after `receive`, through `cursorAt`.
- CI: an MR's `head_pipeline` jobs (`pipelines/<id>/jobs?per_page=100`), and the newest pipeline of the default branch (`pipelines?ref=<branch>&order_by=id&sort=desc&per_page=1`), mapped onto `CiSnapshot` from `github-read.ts` (job `failed` with `allow_failure: false` → conclusion `failure`; `canceled` → `cancelled`; `success` → `success`; `skipped`/`manual` → `skipped`; other statuses are running). Reuse `ciCounts`, `ciSummary`, `ciFailures`, `ciFact`.
- MR lifecycle mirrors `github-pull.ts`: `readMr`, `claimMr`, `observeMr`, `mrsOf`, `mrOf`, `mrEndNotices`. An agent MR is authored by the agent and has `source_project_id === projectId`; a ticket branch's last path segment is the ticket name. `merge_when_pipeline_succeeds` is the auto-merge fact.
- Idempotent replies: a hidden `<!-- dsh-superagent:<message id> -->` marker; before posting, list the target's notes and skip when one by the agent holds the marker. `'gone'` for 403 with `locked` in the message; a deleted discussion falls back to a top-level note.
- Mentions: `@<login>` not preceded by a word character, `@` or `.`, and not followed by `[A-Za-z0-9_-]` or `.<word char>`; case-insensitive.
- KV: add `gitlab: { … }` to `src/kv.ts` (owner: source); prefixes start with `gitlab-`.

## D5. Forge object (owner: source, `src/forge/gitlab.ts`)

```ts
export const gitlabForge: Forge = {
  kind: 'gitlab', source: 'gitlab', setupFields: ['url', 'project', 'cli'],
  resolve: resolveGitlab, environment: gitlabEnvironment,
  review: { param: { name: 'mr_number', describe: a => `The ticket's MR: its source MR, or one by ${a.login} from a branch named after this ticket (DSH_SUPERAGENT_NAME).` }, read: readMr, claim: claimMr, of: mrOf, endNotices: (t, r, d) => mrEndNotices(t, r, d) },
  readPath: readGitlabPath, resource: { prefix: 'gitlab/', read: readGitlab }, skill: 'gitlab',
}
registerForge(gitlabForge)   // at module load; src/index.ts imports './forge/gitlab.ts'
```

- `src/forge/review.ts` reads card keys per Source: `github:<n>` → `pr_number`, `gitlab:mr:<n>` → `mr_number` (owner: core).
- Resources: `gitlab/issues/<iid>`, `gitlab/merge_requests/<iid>`, with `/notes/<page>`, `/discussion/<discussion id>`, `/pipelines` (MR only); `gitlab/commits/<sha>/pipelines`. Messages are `ContextMessage` (`{ id, from, at, text, reply_to?, path?, line?, url, bot? }`). Pages of 20 with `next_resource`.
- `readGitlabPath` reads `repository/files/<encoded>/raw?ref=<default>` and `repository/tree?path=&ref=&per_page=100`, refusing hidden parts and `node_modules`.

## D6. Texts (owner: docs)

- `prompts/forge/gitlab/<name>.md` for every shared prompt file that names the GitHub workflow (`gh`, PR, GitHub, auto-merge commands, noreply email). Words: GitLab, merge request (MR), `glab`, `$DSH_SUPERAGENT_GITLAB_*`, `mr_number`, `!<iid>` for MRs and `#<iid>` for Issues. The first line rule of messages applies to GitLab notes and MR descriptions.
- Auto-merge: `<merge CLI> mr merge <iid> --auto-merge --sha <sha> --repo $DSH_SUPERAGENT_GITLAB_URL/$DSH_SUPERAGENT_GITLAB_PROJECT`; withdraw with `<merge CLI> api -X POST projects/$DSH_SUPERAGENT_GITLAB_PROJECT_ID/merge_requests/<iid>/cancel_merge_when_pipeline_succeeds`.
- `skills/dsh-superagent-gitlab/SKILL.md`: front matter `name: dsh-superagent-gitlab`, the resources of D5, replying in a discussion with `glab api -X POST projects/$DSH_SUPERAGENT_GITLAB_PROJECT_ID/merge_requests/<iid>/discussions/<id>/notes -f body=…`, resolving with `PUT …/discussions/<id>?resolved=true`, and `orchestrator_report` with `mr_number`.
- SETUP.md, README, docs/006, 007, 008 and `examples/profile.cordis.patch.yml` cover a GitLab deployment: `forge: gitlab`, enabling `dsh-superagent-gitlab` and disabling `dsh-superagent-github`, the glab wrapper with `GLAB_CONFIG_DIR`, `glab auth login --hostname <host>` with a personal access token (scopes `api`, `read_repository`, `write_repository`), and the GitLab address asked from the operator.
