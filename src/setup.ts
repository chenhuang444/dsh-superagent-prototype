/** Structured startup and configuration errors with the settings location where the operator can fix them. */
import { fill } from './infra/text.ts'

export type SetupPlace = 'deployment' | 'github' | 'gitlab' | 'feishu' | 'meego'
export const SETUP_PROBLEMS = {
  foreignFile: ['deployment', '{file} was not written by dsh-superagent; move it, or choose another state directory.'],
  gitTooOld: ['deployment', 'git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later.'],
  environmentFailed: ['deployment', 'Preparing the agent environment failed.'],
  repositoryUnset: ['github', 'The GitHub Source names no repository.'],
  agentCliUnset: ['github', 'The agent GitHub CLI is not set.'],
  agentCliMissing: ['github', 'The agent GitHub CLI was not found.'],
  agentCliSignedOut: ['github', 'The agent GitHub CLI cannot read its account.'],
  agentCliNoAccount: ['github', 'The agent GitHub CLI did not report a GitHub account.'],
  repositoryUnreadable: ['github', '@{account} cannot read {repository}.'],
  repositoryUnreported: ['github', 'The agent GitHub CLI did not return {repository}.'],
  repositoryReadOnly: ['github', '@{account} cannot push to {repository}.'],
  gitlabUrlUnset: ['gitlab', 'The GitLab Source names no GitLab address.'],
  gitlabProjectUnset: ['gitlab', 'The GitLab Source names no project.'],
  gitlabCliUnset: ['gitlab', 'The agent glab is not set.'],
  gitlabCliMissing: ['gitlab', 'The agent glab was not found.'],
  gitlabCliSignedOut: ['gitlab', 'The agent glab cannot read its account on {host}; sign it in with glab auth login --hostname {host}.'],
  gitlabNoAccount: ['gitlab', 'The agent glab did not report a GitLab account on {host}.'],
  gitlabProjectUnreadable: ['gitlab', '@{account} cannot read {project}.'],
  gitlabProjectUnreported: ['gitlab', 'The agent glab did not return {project}.'],
  gitlabProjectReadOnly: ['gitlab', '@{account} cannot push to {project}; it needs the Developer role or higher.'],
  gitlabPersonalBot: ['gitlab', '@{account} is a bot user, such as a project access token\'s; personal mode needs your own account. Set Identity to dedicated to use the token as the agent\'s account.'],
  gitlabWorkerCliUnset: ['gitlab', 'Personal mode needs the worker glab, signed in to the same account with a read_api and write_repository token.'],
  gitlabWorkerCliMissing: ['gitlab', 'The worker glab was not found.'],
  gitlabWorkerCliSignedOut: ['gitlab', 'The worker glab cannot read its account on {host}; sign it in with glab auth login --hostname {host}.'],
  gitlabWorkerOtherAccount: ['gitlab', 'The worker glab is signed in as @{worker}, not @{account}; sign both in to the same account.'],
  gitlabTokenUnreadable: ['gitlab', 'GitLab on {host} did not report the token of a glab.'],
  gitlabHostScopes: ['gitlab', 'The agent glab\'s token has the scopes {scopes}; personal mode needs api.'],
  gitlabWorkerScopes: ['gitlab', 'The worker glab\'s token must have exactly read_api and write_repository (read_repository and read_user allowed); extra: {extra}; missing: {missing}.'],
  gitlabGitTooOld: ['deployment', 'git does not read the {url} credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later.'],
  feishuCliFailed: ['feishu', 'The bot lark-cli does not work.'],
  feishuNoApp: ['feishu', 'auth status of the bot lark-cli did not report the app.'],
  feishuBotNotReady: ['feishu', 'The bot identity of app {app} is {status}; configure the app secret with lark-cli.'],
  feishuUserIdentity: ['feishu', 'The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes.'],
  feishuNoBot: ['feishu', 'The Feishu bot API did not return the bot\'s open_id.'],
  meegoCliMissing: ['meego', 'The meegle of the Feishu Project Source was not found.'],
  meegoSignedOut: ['meego', 'meegle profile {profile} is not signed in; run {login} in a terminal, then check again.'],
  meegoHostUnknown: ['meego', 'meegle profile {profile} did not report its Feishu Project site.'],
} as const satisfies Record<string, readonly [SetupPlace, string]>
export type SetupCode = keyof typeof SETUP_PROBLEMS
export interface SetupProblem { place: SetupPlace; code: SetupCode; values: Record<string, string>; detail: string }

/**
 * Thrown by deployment and account verification checks when a required CLI, account, or repository check fails.
 * `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
 */
export class SetupError extends Error {
  readonly place: SetupPlace
  constructor(readonly code: SetupCode, readonly values: Record<string, string> = {}) {
    const [place, text] = SETUP_PROBLEMS[code]
    const sentence = fill(text, values)
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    this.place = place
  }
  get problem(): SetupProblem { return { place: this.place, code: this.code, values: this.values, detail: this.message } }
}
