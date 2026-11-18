/**
 * The GitLab forge's worker environment: the `glab` shim bound to the configured server, the hint a blocked command prints,
 * the server's credential lines and the check that a worker's git reads them.
 */
import { gitlabOf } from '../deployment.ts'
import { credentialHelper, gitQuote, runAsWorker, shellQuote, workerGitConfig } from '../infra/environment.ts'
import { SetupError } from '../setup.ts'
import type { ForgeEnvironment } from './types.ts'

/**
 * GitLab: `glab` is the agent's glab, pointed at the configured server through `GITLAB_HOST` so commands outside a clone of
 * it reach the same host; it also answers git's credential requests for the server's address.
 */
export const gitlabEnvironment: ForgeEnvironment = {
  commands: ['glab'],
  // `gh` fails, so a worker's habit of calling it never reaches the operator's own GitHub account.
  shims: (input, run, fail) => {
    const { cli, host, login } = gitlabOf(input)
    return [{ name: 'glab', body: `GITLAB_HOST=${shellQuote(host)}\nexport GITLAB_HOST\n${run(cli)}` },
      { name: 'gh', body: fail(`gh is unavailable: this installation's code host is GitLab; use glab, which acts as ${login}.`) }]
  },
  blockedHint: input => `use glab, which acts as ${gitlabOf(input).login}`,
  gitConfig: input => {
    const { cli, url } = gitlabOf(input)
    const { hostname } = new URL(url)
    return [
      `[credential "${url}"]`, `\thelper = ${gitQuote(credentialHelper(cli))}`,
      `[url "${url}/"]`, `\tinsteadOf = git@${hostname}:`, `\tinsteadOf = ssh://git@${hostname}/`,
    ]
  },
  verify: async (input, subprocess, signal) => {
    const { stateDir } = input
    const { cli, url } = gitlabOf(input)
    // `-z` separates fields with NUL and never quotes paths.
    const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', `credential.${url}.helper`], stateDir,
      AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
    if (helpers.join('\0') !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(cli), ''].join('\0')) throw new SetupError('gitlabGitTooOld', { url })
  },
}
