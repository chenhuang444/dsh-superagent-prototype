/**
 * The GitHub forge's worker environment: the `gh` shim, the hint a blocked command prints, the github.com credential lines
 * and the check that a worker's git reads them.
 */
import { githubOf } from '../deployment.ts'
import { credentialHelper, gitQuote, runAsWorker, workerGitConfig } from '../infra/environment.ts'
import { SetupError } from '../setup.ts'
import type { ForgeEnvironment } from './types.ts'

/** GitHub: `gh` is the agent's GitHub CLI, which also answers git's credential requests for github.com. */
export const githubEnvironment: ForgeEnvironment = {
  commands: ['gh'],
  shims: (input, run) => [{ name: 'gh', body: run(githubOf(input).cli) }],
  blockedHint: input => `use gh, which acts as ${githubOf(input).login}`,
  gitConfig: input => [
    '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(githubOf(input).cli))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
  ],
  verify: async (input, subprocess, signal) => {
    const { stateDir } = input
    // `-z` separates fields with NUL and never quotes paths.
    const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], stateDir,
      AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
    if (helpers.join('\0') !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(githubOf(input).cli), ''].join('\0')) throw new SetupError('gitTooOld')
  },
}
