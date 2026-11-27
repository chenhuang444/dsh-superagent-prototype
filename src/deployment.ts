/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'
import { FORGE_KINDS, type ForgeAccount, type ForgeKind } from './forge/types.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
  forge: s.union(FORGE_KINDS).default('github')
    .description('The code host of this deployment: github or gitlab. Its Source plugin must be enabled; changing it remounts the plugin.'),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
  /** The deployment's one code host. */
  forge: ForgeKind
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  const forge = config.forge ?? 'github'
  if (!FORGE_KINDS.includes(forge)) throw new Error(`dsh-superagent configuration names forge ${String(forge)}; forge takes only ${FORGE_KINDS.join(' or ')}`)
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, forge }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** The Meego Source's configuration that setup reads: the host's `meegle` and the profile it signs in with. */
export const MeegoCliSchema = z.object({
  cli: z.string().trim().default(''),
  profile: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'letters, digits, _ . and -').default('superagent'),
})
/**
 * The GitLab Source's configuration that setup reads: the server's address (`https://host[:port]`, no path), the project
 * (`group/name`, subgroups allowed) and the agent's `glab`.
 */
export const GitlabAccountsSchema = z.object({
  url: z.string().trim().regex(/^(https:\/\/[A-Za-z0-9.-]+(:\d+)?)?$/, 'https://host[:port], without a path or trailing slash').default(''),
  project: z.string().trim().regex(/^([A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+)?$/, 'group/name').default(''),
  cli: z.string().trim().default(''),
  identity: z.enum(['dedicated', 'personal']).default('dedicated'),
  workerCli: z.string().trim().default(''),
  trigger: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/, 'a word of letters, digits, _ and -').default('agent'),
})
/**
 * Whose GitLab account the agent's glab holds: `dedicated`, an account of the agent's own (a bot, or a user made for it);
 * `personal`, the operator's own account, whose notes the agent tells apart from the operator's by a marker it adds.
 */
export type GitlabIdentityKind = z.infer<typeof GitlabAccountsSchema>['identity']
/** Source configuration keys that setup reads, by Source; a change to one of the forge's or Feishu's restarts dsh-superagent. */
const ACCOUNT_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape),
  gitlab: Object.keys(GitlabAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape), meego: Object.keys(MeegoCliSchema.shape) }
/** The Source configuration keys setup reads under `forge`: the forge's Source's, Feishu's and Meego's; another forge's Source has none. */
export const setupFields = (forge: ForgeKind): Readonly<Record<string, readonly string[]>> =>
  ({ [forge]: ACCOUNT_FIELDS[forge]!, feishu: ACCOUNT_FIELDS.feishu!, meego: ACCOUNT_FIELDS.meego! })
/** The keys setup reads of a GitHub deployment; `setupFields` gives them for any forge. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = setupFields('github')

export interface Deployment extends Machine {
  /** The agent's account on the deployment's forge (`Machine.forge`). */
  account: ForgeAccount
  /** The repository or project the forge works on; the same as `account.repository`. */
  repository: string
  /** The GitHub CLI and account, present only when the forge is GitHub. */
  github?: GithubAccount
  /** The GitLab server, project and account, present only when the forge is GitLab. */
  gitlab?: GitlabAccount
  feishu?: FeishuBot
  /** The Feishu Project `meegle` and the profile the host signs in with, present when the Meego Source names one that exists. */
  meego?: MeegoCli
}
/** The host's `meegle` (absolute path) and its profile, kept apart from the profile the operator uses themselves, and the account it is signed in to. */
export interface MeegoCli {
  cli: string; profile: string
  /** The Feishu Project site the profile is signed in to, as `auth status` reports it (a host name, no scheme). */
  host: string
  /** The operator's user_key, under which the agent writes. */
  userKey: string
  /** The operator's display name, which signatures name. */
  name: string
  /** The operator's lark_user_id, which a mention of them in a comment carries. */
  larkUserId: string
}
export interface GithubAccount { cli: string; login: string; noreply: string }
/** The deployment's GitHub account; the GitHub Source and the GitHub forge run only when the forge is GitHub. @throws otherwise */
export function githubOf(deployment: Pick<Deployment, 'github'>): GithubAccount {
  if (!deployment.github) throw new Error('This deployment\'s code host is not GitHub')
  return deployment.github
}
/** The deployment's GitLab account; the GitLab Source and the GitLab forge run only when the forge is GitLab. @throws otherwise */
export function gitlabOf(deployment: Pick<Deployment, 'gitlab'>): GitlabAccount {
  if (!deployment.gitlab) throw new Error('This deployment\'s code host is not GitLab')
  return deployment.gitlab
}
/** The GitLab server, the agent's `glab` and account, and the project's numeric id. */
export interface GitlabAccount {
  /** Absolute path of the agent's glab (usually a wrapper that sets `GLAB_CONFIG_DIR`). */
  cli: string
  /** `https://host[:port]`, as configured. */
  url: string
  /** `new URL(url).host`, which `glab api --hostname` takes. */
  host: string
  /** The agent's username. */
  login: string
  /** The agent's user id. */
  id: number
  /** The agent's commit email. */
  email: string
  /** The project's numeric id, which every API path uses. */
  projectId: number
  /** Whose account `cli` is signed in to; see `GitlabIdentityKind`. */
  identity: GitlabIdentityKind
  /** With `personal`: the glab workers run, signed in to the same account with only `read_api` and `write_repository`. */
  workerCli?: string
  /** With `personal`: the word that, followed by a colon at the start of a line, addresses the agent. */
  trigger: string
  /** The account's role on the project (GitLab access level, the higher of project and group); 40 and above is Maintainer. */
  accessLevel: number
  /** True when the account is a bot user, such as the user of a project or group access token. */
  bot?: boolean
  /** The day `cli`'s token expires (`YYYY-MM-DD`), when GitLab reported it. */
  expiresAt?: string
  /** With `personal`: the day `workerCli`'s token expires (`YYYY-MM-DD`), when GitLab reported it. */
  workerExpiresAt?: string
  /** With `personal`: true when GitLab could not report the tokens (before GitLab 15.5), so their scopes went unchecked. */
  tokenUnchecked?: boolean
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  const noreply = `${agent.id}+${agent.login}@users.noreply.github.com`
  return { ...machine, repository, github: { cli, login: agent.login, noreply },
    account: { kind: 'github', login: agent.login, email: noreply, repository, web: 'https://github.com' } }
}

/** GitLab's Developer role, the lowest that may push branches. */
const DEVELOPER = 30
const GitlabUser = z.object({
  id: z.number().int().positive(), username: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  email: z.string().nullish(), commit_email: z.string().nullish(), public_email: z.string().nullish(), bot: z.boolean().nullish(),
})
const Access = z.object({ access_level: z.number().int() }).nullish()
const GitlabProject = z.object({
  id: z.number().int().positive(), path_with_namespace: z.string().regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/),
  default_branch: z.string().nullish(), permissions: z.object({ project_access: Access, group_access: Access }).nullish(),
})
/**
 * Verify the agent's glab account on the configured GitLab server and its Developer (push) access to the configured project.
 * Every probe is `<cli> api --hostname <host> …`, so glab never falls back to another signed-in host. In personal mode it also
 * checks the worker's glab and both tokens (`resolveWorker`).
 */
export async function resolveGitlab(machine: Machine, gitlab: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const accounts = GitlabAccountsSchema.parse(gitlab ?? {})
  const { url, project } = accounts
  if (!url) throw new SetupError('gitlabUrlUnset')
  if (!project) throw new SetupError('gitlabProjectUnset')
  if (!accounts.cli) throw new SetupError('gitlabCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(machine.stateDir)) } catch (error) { throw new SetupError('gitlabCliMissing', { output: reason(error) }) }
  const { host, hostname } = new URL(url)
  const call: Call = (program, endpoint) => probe([program, 'api', '--hostname', host, endpoint])
  const api = (endpoint: string): Promise<string> => call(cli, endpoint)
  const text = await api('user').catch((error: unknown) => { throw new SetupError('gitlabCliSignedOut', { host, output: reason(error) }) })
  const agent = parsed(GitlabUser, text)
  if (!agent) throw new SetupError('gitlabNoAccount', { host })
  const login = agent.username
  // A project or group access token signs glab in as a bot user, which is never a person's own account.
  if (accounts.identity === 'personal' && agent.bot) throw new SetupError('gitlabPersonalBot', { account: login })
  // Use the canonical path returned by GitLab so a renamed or moved project matches what the API reports later.
  const access = parsed(GitlabProject, await api(`projects/${encodeURIComponent(project)}`).catch((error: unknown) => {
    throw new SetupError('gitlabProjectUnreadable', { account: login, project, output: reason(error) })
  }))
  if (!access) throw new SetupError('gitlabProjectUnreported', { project })
  const repository = access.path_with_namespace
  const level = Math.max(access.permissions?.project_access?.access_level ?? 0, access.permissions?.group_access?.access_level ?? 0)
  if (level < DEVELOPER) throw new SetupError('gitlabProjectReadOnly', { account: login, project: repository })
  const email = agent.commit_email || agent.email || `${agent.id}-${login}@users.noreply.${hostname}`
  const common = { cli, url, host, login, id: agent.id, email, projectId: access.id, trigger: accounts.trigger, accessLevel: level,
    ...agent.bot ? { bot: true } : {} }
  const resolved: GitlabAccount = accounts.identity === 'personal'
    ? { ...common, identity: 'personal', ...await resolveWorker(machine, accounts.workerCli, call, cli, { id: agent.id, login }, host, path) }
    : { ...common, identity: 'dedicated', ...await dedicatedExpiry(api) }
  return { ...machine, repository, gitlab: resolved, account: { kind: 'gitlab', login, email, repository, web: url } }
}
/**
 * The day a dedicated account's token expires, which the panel warns about ahead of time; nothing when GitLab cannot report
 * the token (before 15.5) or reports none, since a dedicated account's setup never fails on this read.
 */
async function dedicatedExpiry(api: (endpoint: string) => Promise<string>): Promise<Pick<GitlabAccount, 'expiresAt'>> {
  const answer = await api('personal_access_tokens/self').catch(() => undefined)
  const token = answer === undefined ? undefined : parsed(TokenSelf, answer)
  return token?.expires_at ? { expiresAt: token.expires_at } : {}
}
/** The scopes a personal mode worker token may hold; it must hold `read_api` and `write_repository`, and never `api`. */
const WORKER_SCOPES: readonly string[] = ['read_api', 'read_repository', 'write_repository', 'read_user']
const WORKER_REQUIRED: readonly string[] = ['read_api', 'write_repository']
const TokenSelf = z.object({ scopes: z.array(z.string()), expires_at: z.string().nullish() })
/** True when a probe failed with HTTP 404, which a GitLab before 15.5 answers for `personal_access_tokens/self`. */
const notFound = (error: unknown): boolean =>
  (!!error && typeof error === 'object' && 'code' in error && error.code === 404) || /\bHTTP 404\b|\b404 Not Found\b/.test(reason(error))
const listed = (scopes: readonly string[]): string => scopes.length ? scopes.join(', ') : 'none'
type Call = (program: string, endpoint: string) => Promise<string>
type Tokens = Pick<GitlabAccount, 'workerCli' | 'expiresAt' | 'workerExpiresAt' | 'tokenUnchecked'>
/**
 * Personal mode: the worker's glab must be signed in to the same account as `cli`, with a token that reads the API and
 * pushes but cannot write through the API, and `cli`'s token must hold `api`. A GitLab that cannot report a token (404, as
 * before 15.5, or an answer that does not parse) leaves the scopes unchecked rather than failing.
 */
async function resolveWorker(machine: Machine, name: string, call: Call, cli: string, agent: { id: number; login: string }, host: string,
  path: string): Promise<Tokens> {
  if (!name) throw new SetupError('gitlabWorkerCliUnset')
  let workerCli: string
  try { workerCli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { throw new SetupError('gitlabWorkerCliMissing', { output: reason(error) }) }
  const text = await call(workerCli, 'user').catch((error: unknown) => { throw new SetupError('gitlabWorkerCliSignedOut', { host, output: reason(error) }) })
  const worker = parsed(GitlabUser, text)
  if (!worker) throw new SetupError('gitlabWorkerCliSignedOut', { host })
  if (worker.id !== agent.id) throw new SetupError('gitlabWorkerOtherAccount', { account: agent.login, worker: worker.username })
  /** The token `program` holds, or undefined when GitLab cannot report it. */
  const token = async (program: string) => {
    const answer = await call(program, 'personal_access_tokens/self').catch((error: unknown) => {
      if (notFound(error)) return undefined
      throw new SetupError('gitlabTokenUnreadable', { host, output: reason(error) })
    })
    return answer === undefined ? undefined : parsed(TokenSelf, answer)
  }
  const [main, own] = [await token(cli), await token(workerCli)]
  if (main && !main.scopes.includes('api')) throw new SetupError('gitlabHostScopes', { scopes: listed(main.scopes) })
  if (own) {
    const extra = own.scopes.filter(scope => !WORKER_SCOPES.includes(scope)), missing = WORKER_REQUIRED.filter(scope => !own.scopes.includes(scope))
    if (extra.length || missing.length) throw new SetupError('gitlabWorkerScopes', { extra: listed(extra), missing: listed(missing) })
  }
  return { workerCli, ...main?.expires_at ? { expiresAt: main.expires_at } : {}, ...own?.expires_at ? { workerExpiresAt: own.expires_at } : {},
    ...main && own ? {} : { tokenUnchecked: true } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}

const MeegoAuth = z.object({ authenticated: z.boolean(), host: z.string().nullish() })
const MeegoMe = z.object({ user_key: z.string().regex(/^\d+$/), name_cn: z.string().nullish(), name_en: z.string().nullish() })
/** The first JSON value of a `meegle` answer, which prints nothing but JSON on success. */
const meegoJson = <T>(schema: z.ZodType<T>, text: string): T | undefined => parsed(schema, text.trim())
/**
 * Verify that the Meego Source's `meegle` exists and its profile is signed in, and read the account the agent writes under.
 * A problem here pauses only the Meego Source (`Setup.meegoProblem`), as a Feishu bot problem pauses only Feishu.
 */
export async function resolveMeego(machine: Machine, meego: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<MeegoCli | undefined> {
  const { cli: name, profile } = MeegoCliSchema.parse(meego ?? {})
  if (!name) return undefined
  let cli: string
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { throw new SetupError('meegoCliMissing', { output: reason(error) }) }
  const run = (...args: string[]): Promise<string> => probe([cli, '--profile', profile, ...args])
  const login = `${name} --profile ${profile} auth login --host <host>`
  const signedOut = (output = ''): never => { throw new SetupError('meegoSignedOut', { profile, login, ...output ? { output } : {} }) }
  const auth = meegoJson(MeegoAuth, await run('auth', 'status', '--format', 'json').catch((error: unknown) => signedOut(reason(error))))
  if (!auth?.authenticated) return signedOut()
  if (!auth.host) throw new SetupError('meegoHostUnknown', { profile })
  const me = meegoJson(MeegoMe, await run('user', 'me').catch((error: unknown) => signedOut(reason(error))))
  if (!me) return signedOut()
  // `lark_user_id` is a number wider than JSON numbers keep exactly, so it is read from the text as digits.
  const found = await run('user', 'search', '--user-keys', me.user_key).catch(() => '')
  const larkUserId = /"lark_user_id"\s*:\s*"?(\d+)/.exec(found)?.[1] ?? ''
  return { cli, profile, host: auth.host, userKey: me.user_key, name: me.name_cn || me.name_en || me.user_key, larkUserId }
}
