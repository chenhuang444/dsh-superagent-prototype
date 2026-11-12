/**
 * The GitHub forge: the agent's `gh` account, pull requests as reviews, the `github/` originals and repository reads through
 * the GitHub API. Its behaviour is the one dsh-superagent had before forges were pluggable.
 */
import type { Ticket } from '../core/index.ts'
import { resolveDeployment, type GithubAccountsSchema } from '../deployment.ts'
import { githubEnvironment } from './github-environment.ts'
import { claimPull, pullEndNotices, pullOf, readPull, type Pull } from '../sources/github-pull.ts'
import { readGithub, readRepositoryPath } from '../sources/github-read.ts'
import type { Forge, ForgeReview } from './types.ts'

const review: ForgeReview<Pull> = {
  param: {
    name: 'pr_number',
    describe: account => `The ticket's PR: its source PR, or one by ${account.login} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`,
  },
  read: (ctx, number, signal) => readPull(ctx, number, signal),
  claim: (ctx, ticketId, pull) => claimPull(ctx, ticketId, pull),
  of: (ticket: Pick<Ticket, 'follows'>) => pullOf(ticket),
  endNotices: (ticket, request, deployment) => pullEndNotices(ticket, request, deployment.repository),
}
export const githubForge: Forge = {
  kind: 'github',
  source: 'github',
  setupFields: ['repository', 'cli'] satisfies (keyof typeof GithubAccountsSchema.shape)[],
  resolve: (machine, config, probe, path) => resolveDeployment(machine, config, probe, path),
  environment: githubEnvironment,
  review: review as ForgeReview<never>,
  readPath: readRepositoryPath,
  resource: { prefix: 'github/', read: readGithub },
  skill: 'github',
}
