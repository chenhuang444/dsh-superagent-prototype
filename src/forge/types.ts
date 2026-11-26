/**
 * The code host (forge) protocol: what a deployment's one code host provides to the parts of dsh-superagent that are not a
 * Source, such as setup, the worker environment, an Executor's report of its review, the end notice and repository reads.
 * A deployment selects exactly one forge (`Machine.forge`); generic code reaches it through `forgeOf` and never names a host.
 */
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { OutboundMessage, Ticket } from '../core/index.ts'
import type { Deployment, Machine, Probe } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import type { SourceContext } from '../sources/host.ts'

export const FORGE_KINDS = ['github', 'gitlab'] as const
export type ForgeKind = typeof FORGE_KINDS[number]

/** The agent's account on the deployment's forge, as setup resolved it. */
export interface ForgeAccount {
  kind: ForgeKind
  /** The agent's login or username on the forge. */
  login: string
  /** The commit email the agent's commits use. */
  email: string
  /** The repository (GitHub `owner/name`) or project (GitLab `group/name`) the deployment works on, in the forge's canonical form. */
  repository: string
  /** The forge's web address, such as `https://github.com` or a GitLab server's URL. */
  web: string
}
/** What setup resolves for a forge: its account, the repository, and the forge-specific details (`github` or `gitlab`). */
export type ForgeDeployment = Pick<Deployment, 'account' | 'repository' | 'github' | 'gitlab'>
/** The parts of a deployment a forge's worker environment reads. */
export type ForgeEnvironmentInput = Pick<Deployment, 'stateDir' | 'account' | 'github' | 'gitlab'>
/** One worker command shim: its name under the shim directory, and the shell body the shim runs. */
export interface Shim { name: string; body: string }

/** What a forge contributes to the worker environment: its command shims, its git configuration and the check of it. */
export interface ForgeEnvironment {
  /** The commands the forge's shims provide, which the blocked commands may not block. */
  commands: readonly string[]
  /**
   * The shell commands workers call for this forge, such as `gh`, with the body each shim runs; `run` execs a program past the
   * shim directory and `fail` prints a message and exits 1.
   */
  shims(input: ForgeEnvironmentInput, run: (program: string) => string, fail: (message: string) => string): Shim[]
  /** What a blocked command tells a worker to use instead, such as `use gh, which acts as agent-bot`. */
  blockedHint(input: ForgeEnvironmentInput): string
  /** Lines of the agent's git configuration that give this forge's credentials and URL rewrites; nothing else. */
  gitConfig(input: ForgeEnvironmentInput): string[]
  /**
   * The git hooks every worker's git runs, such as `pre-push`, with the shell body of each; when there are any, the agent's git
   * configuration points `core.hooksPath` at the directory that holds them. A guardrail: a repository's own `core.hooksPath`
   * or `--no-verify` skips them.
   */
  hooks?(input: ForgeEnvironmentInput): Shim[]
  /** Verifies that a worker's git resolves this forge's credential configuration. */
  verify(input: ForgeEnvironmentInput, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void>
}

/** A forge's review unit (GitHub PR, GitLab MR) as Executor tools, cards and notices see it. */
export interface ForgeReview<R = unknown> {
  /** The `orchestrator_report` parameter that names the ticket's review, and its description for the tool schema. */
  param: { name: string; describe(account: ForgeAccount): string }
  /** Reads review `number` before the report's transaction. */
  read(ctx: SourceContext, number: number, signal: AbortSignal): Promise<R>
  /** Claims a review `read` returned for `ticketId` under the forge's binding rules; returns the refusal, or undefined. */
  claim(ctx: SourceContext, ticketId: string, review: R): string | undefined
  /** The number of the review a ticket card names, if any. */
  of(ticket: Pick<Ticket, 'follows'>): number | undefined
  /** The notices to the ticket's other conversations once it ended with its review merged or closed. */
  endNotices(ticket: Ticket, request: string, deployment: ForgeDeployment): OutboundMessage[]
}

/** A code host: its identity, how setup resolves its account, and what it gives generic code. */
export interface Forge {
  kind: ForgeKind
  /** The Source kind id that receives this forge's events; also where its setup problems are fixed. */
  source: ForgeKind
  /** The fields of its Source's configuration that setup reads; a change to one of them restarts dsh-superagent. */
  setupFields: readonly string[]
  /** Resolves the agent's account and the repository from the Source's configuration. @throws SetupError */
  resolve(machine: Machine, config: unknown, probe: Probe, path: string): Promise<Deployment>
  environment: ForgeEnvironment
  review: ForgeReview<never>
  /** Reads a non-hidden file, or a directory listing, from the repository's default branch. */
  readPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string>
  /** The original records `orchestrator_read` serves under `prefix`, such as `github/`. */
  resource: { prefix: string; read(commands: Commands, resource: string): Promise<unknown> }
  /** The built-in skill this forge registers in every Session, by its name (`skill/<name>` keys its override). */
  skill: ForgeKind
}
