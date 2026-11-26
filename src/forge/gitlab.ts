/**
 * The GitLab forge: the agent's `glab` account, merge requests as reviews, the `gitlab/` originals and repository reads through
 * the GitLab REST API. It registers itself when this module loads; the main plugin entry imports it.
 */
import type { Ticket } from '../core/index.ts'
import { resolveGitlab, type GitlabAccountsSchema } from '../deployment.ts'
import { claimMr, mrEndNotices, mrOf, readMr, type Mr } from '../sources/gitlab-mr.ts'
import { readGitlab, readGitlabPath } from '../sources/gitlab-read.ts'
import { gitlabEnvironment } from './gitlab-environment.ts'
import { registerForge } from './index.ts'
import type { Forge, ForgeReview } from './types.ts'

const review: ForgeReview<Mr> = {
  param: {
    name: 'mr_number',
    describe: account => `The ticket's MR: its source MR, or one by ${account.login} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`,
  },
  read: (ctx, iid, signal) => readMr(ctx, iid, signal),
  claim: (ctx, ticketId, mr) => claimMr(ctx, ticketId, mr),
  of: (ticket: Pick<Ticket, 'follows'>) => mrOf(ticket),
  endNotices: (ticket, request, deployment) => mrEndNotices(ticket, request, deployment),
}
export const gitlabForge: Forge = {
  kind: 'gitlab',
  source: 'gitlab',
  setupFields: ['url', 'project', 'cli', 'identity', 'workerCli', 'trigger'] satisfies (keyof typeof GitlabAccountsSchema.shape)[],
  resolve: (machine, config, probe, path) => resolveGitlab(machine, config, probe, path),
  environment: gitlabEnvironment,
  review: review as ForgeReview<never>,
  readPath: readGitlabPath,
  resource: { prefix: 'gitlab/', read: readGitlab },
  skill: 'gitlab',
}
registerForge(gitlabForge)
