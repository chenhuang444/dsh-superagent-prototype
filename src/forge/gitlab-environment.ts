/**
 * The GitLab forge's worker environment: the `glab` shim bound to the configured server, the hint a blocked command prints,
 * the server's credential lines and the check that a worker's git reads them, and in personal mode the pre-push guard.
 */
import { gitlabOf, type GitlabAccount } from '../deployment.ts'
import { credentialHelper, gitQuote, runAsWorker, shellQuote, workerGitConfig } from '../infra/environment.ts'
import { SetupError } from '../setup.ts'
import type { ForgeEnvironment } from './types.ts'

/** The glab workers run: in personal mode the worker's (read-only API), else the agent's. */
const workerGlab = (gitlab: GitlabAccount): string => gitlab.identity === 'personal' && gitlab.workerCli ? gitlab.workerCli : gitlab.cli
/** What workers' glab can do, for the messages that name it. */
const acts = (gitlab: GitlabAccount): string => gitlab.identity === 'personal'
  ? `use glab, which acts as ${gitlab.login} with read-only API access; post notes, open and update merge requests and resolve discussions through the gitlab_* tools`
  : `use glab, which acts as ${gitlab.login}`
/**
 * The personal mode pre-push guard: the push may not create or update a tag, delete a remote branch, or push to the remote's
 * default branch (`refs/remotes/<remote>/HEAD`, else `main` and `master`). git gives the remote's name as `$1` and one line
 * `<local ref> <local sha> <remote ref> <remote sha>` per ref in `$input`.
 */
const PRE_PUSH = [
  'remote=$1',
  'default=$(git symbolic-ref --quiet --short "refs/remotes/$remote/HEAD" 2>/dev/null); default=${default#"$remote/"}',
  'refuse() { echo "dsh-superagent: push refused: $1. Push only the ticket\'s own branch; a person merges, tags and deletes branches." >&2; exit 1; }',
  'printf \'%s\\n\' "$input" | { while read -r source sha ref old; do',
  '  [ -n "$ref" ] || continue',
  '  case "$ref" in refs/tags/*) refuse "$ref is a tag";; esac',
  '  case "$sha" in *[!0]*) ;; *) refuse "it deletes $ref";; esac',
  '  branch=${ref#refs/heads/}',
  '  if [ -n "$default" ]; then [ "$branch" != "$default" ] || refuse "$branch is the default branch of $remote"',
  '  else case "$branch" in main|master) refuse "$branch is a default branch";; esac; fi',
  'done; } || exit 1',
].join('\n')

/**
 * GitLab: `glab` is the workers' glab, pointed at the configured server through `GITLAB_HOST` so commands outside a clone of
 * it reach the same host; it also answers git's credential requests for the server's address. In personal mode that is the
 * worker's glab, whose token reads the API and pushes but cannot write through the API; the host keeps the agent's glab.
 */
export const gitlabEnvironment: ForgeEnvironment = {
  commands: ['glab'],
  // `gh` fails, so a worker's habit of calling it never reaches the operator's own GitHub account.
  shims: (input, run, fail) => {
    const gitlab = gitlabOf(input)
    return [{ name: 'glab', body: `GITLAB_HOST=${shellQuote(gitlab.host)}\nexport GITLAB_HOST\n${run(workerGlab(gitlab))}` },
      { name: 'gh', body: fail(`gh is unavailable: this installation's code host is GitLab; ${acts(gitlab)}.`) }]
  },
  blockedHint: input => acts(gitlabOf(input)),
  gitConfig: input => {
    const gitlab = gitlabOf(input)
    const { hostname } = new URL(gitlab.url)
    return [
      `[credential "${gitlab.url}"]`, `\thelper = ${gitQuote(credentialHelper(workerGlab(gitlab)))}`,
      `[url "${gitlab.url}/"]`, `\tinsteadOf = git@${hostname}:`, `\tinsteadOf = ssh://git@${hostname}/`,
    ]
  },
  hooks: input => gitlabOf(input).identity === 'personal' ? [{ name: 'pre-push', body: PRE_PUSH }] : [],
  verify: async (input, subprocess, signal) => {
    const { stateDir } = input
    const gitlab = gitlabOf(input)
    // `-z` separates fields with NUL and never quotes paths.
    const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', `credential.${gitlab.url}.helper`], stateDir,
      AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
    if (helpers.join('\0') !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(workerGlab(gitlab)), ''].join('\0')) {
      throw new SetupError('gitlabGitTooOld', { url: gitlab.url })
    }
  },
}
