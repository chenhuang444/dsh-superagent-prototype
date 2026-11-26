/**
 * Process environment and CLI shims that bind git, gh or glab, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import type { ForgeEnvironment, Shim } from '../forge/types.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands every worker needs, which `blockedCommands` cannot block: git and the Feishu shim; each forge adds its own. */
const BASE_COMMANDS: readonly string[] = ['git', 'lark-cli']
/** Commands workers need under a forge, which `blockedCommands` cannot block: the forge's shims, git and `lark-cli`. */
export const workerCommands = (forge: Pick<ForgeEnvironment, 'commands'>): readonly string[] => [...forge.commands, ...BASE_COMMANDS]
/**
 * The command names the blocked commands may never name, under any forge: GitHub's `gh` first, then git and `lark-cli`, then
 * GitLab's `glab`. The settings schema does not know the deployment's forge, so it refuses all of them.
 */
export const PROTECTED_COMMANDS: readonly string[] = ['gh', ...BASE_COMMANDS, 'glab']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
/** The directory of the git hooks a forge gives every worker's git (`ForgeEnvironment.hooks`). */
export const workerHooks = (stateDir: string): string => join(stateDir, 'worker-hooks')
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
export const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
/** The git credential helper that answers with the forge CLI's account (`gh` and `glab` both provide `auth git-credential`). */
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub and GitLab tokens and hosts, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // glab reads these before its own configuration; the agent's glab must act only with the account its configuration holds.
    GITLAB_TOKEN: undefined, GITLAB_ACCESS_TOKEN: undefined, OAUTH_TOKEN: undefined, CI_JOB_TOKEN: undefined, GITLAB_HOST: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2)
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.includes(marker))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh`, `glab` or `lark-cli` by name reach the real binary.
 * The deployment's forge (`account.kind`) contributes its own shims, its git credential lines, the hint a blocked command prints
 * and any git hooks (`ForgeEnvironment.hooks`), which the agent's git configuration then names in `core.hooksPath`.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'account' | 'github' | 'gitlab' | 'feishu'>, blockedCommands: readonly string[],
  forge?: ForgeEnvironment): Promise<void> {
  forge ??= (await import('../forge/index.ts')).forgeOf(deployment.account.kind).environment
  const { stateDir, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const shim = async (name: string, body: string): Promise<void> => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o755 })
    await rename(temporary, join(dir, name))
    kept.add(name)
  }
  const withoutShims = [
    `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
  const shims = forge.shims(deployment, run, fail)
  for (const { name, body } of shims.slice(0, 1)) await shim(name, body)
  await shim('lark-cli', feishu ? run(feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
  for (const { name, body } of shims.slice(1)) await shim(name, body)
  const needed = workerCommands(forge)
  for (const name of new Set(blockedCommands.filter(name => !needed.includes(name)))) {
    await shim(name, fail(`${name} is blocked in this installation; ${forge.blockedHint(deployment)}.`))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  const hooks = await writeHooks(workerHooks(stateDir), forge.hooks?.(deployment) ?? [])
  await own(workerGitConfig(stateDir), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    ...forge.gitConfig(deployment),
    ...hooks ? ['[core]', `\thooksPath = ${gitQuote(hooks)}`] : [],
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/**
 * The client-side hooks git runs, but `reference-transaction`, which runs on every ref update. With
 * `core.hooksPath` set, git no longer runs the repository's own `.git/hooks`, so each one written passes on to it.
 */
const CLIENT_HOOKS: readonly string[] = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'post-rewrite', 'pre-auto-gc']
/** The hooks git gives input on stdin; the others inherit git's stdin, which reading could wait on forever. */
const READS_INPUT: readonly string[] = ['pre-push', 'post-rewrite']
/** Runs the repository's own hook of the same name, such as Git LFS's `pre-push`, with the hook's arguments and input. */
const chain = (name: string): string => [
  `hook="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/${name}"`,
  READS_INPUT.includes(name)
    ? 'if [ -x "$hook" ]; then printf \'%s\' "$input" | "$hook" "$@"; exit $?; fi'
    : 'if [ -x "$hook" ]; then exec "$hook" "$@"; fi',
].join('\n')
/**
 * Writes the forge's git hooks into `dir` the way shims are written, refusing foreign files there; returns `dir` when the forge
 * gives any, else removes what was written before and returns undefined. Every client hook is written then: the forge's body
 * for that hook, if any, runs first (a pre-push or post-rewrite body reads the hook's input from `$input`), then the
 * repository's own hook.
 */
async function writeHooks(dir: string, hooks: readonly Shim[]): Promise<string | undefined> {
  let before: string[] = []
  try { before = await readdir(dir) } catch { /* No hooks were written before. */ }
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  const names = hooks.length ? CLIENT_HOOKS : []
  if (names.length) await mkdir(dir, { recursive: true })
  for (const name of names) {
    const body = hooks.filter(hook => hook.name === name).map(hook => hook.body)
    // `$(cat)` drops trailing newlines; the sentinel keeps the input byte for byte.
    const input = READS_INPUT.includes(name) ? ['input=$(cat; printf x)', 'input=${input%x}'] : []
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, ['#!/bin/sh', MARKER, ...input, ...body, chain(name), 'exit 0', ''].join('\n'), { mode: 0o755 })
    await rename(temporary, join(dir, name))
  }
  for (const name of before) if (!names.includes(name)) await unlink(join(dir, name))
  return names.length ? dir : undefined
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/** Verifies that worker git invocations resolve the deployment's forge credential helper. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'stateDir' | 'account' | 'github' | 'gitlab'>, subprocess: SubprocessRuntime, signal: AbortSignal,
  forge?: ForgeEnvironment): Promise<void> {
  forge ??= (await import('../forge/index.ts')).forgeOf(deployment.account.kind).environment
  await forge.verify(deployment, subprocess, signal)
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
