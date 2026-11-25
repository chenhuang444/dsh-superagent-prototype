/**
 * Ticket directories under the execution root: a cached scan of their git state and size, the automatic cleanup of ended
 * tickets' directories once the retention period passed, and the cleanups a person starts from the panel.
 */
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { key, liveTicket, type Ticket } from '../core/index.ts'
import { UserError } from '../core/errors.ts'
import type { HealthEntry } from '../infra/health.ts'
import { runAsWorker } from '../infra/environment.ts'
import { KV } from '../kv.ts'
import type { Settings } from '../policy.ts'
import { WORKSPACE_FILTERS, type WorkspaceFilter } from './api.ts'
import { executionRoot } from './execution-environment.ts'
import type { Store } from './store.ts'
import { ticketSummary } from './views/records.ts'

/** How often the automatic pass scans the ticket directories and cleans those due. */
export const CLEANUP_INTERVAL_MS = 60 * 60_000
/** Maximum runtime of a cleanup command, as of a prepare command. */
const CLEANUP_TIMEOUT_MS = 10 * 60_000
/** Maximum runtime of one git or du read of a directory during a scan. */
const READ_TIMEOUT_MS = 60_000
/** How many directories a scan reads at once. */
const SCAN_CONCURRENCY = 4
/** How many changed tracked files a scan keeps per directory. */
const CHANGED_SHOWN = 20
const DAY_MS = 86_400_000

/** The last cleanup of a ticket directory, by its name: when, how it ended, and when the prepare command rebuilt it. */
export interface CleanupRecord {
  at: string
  state: 'cleaned' | 'failed'
  ticketId?: string
  /** The output of a failed cleanup. */
  output?: string
  /** A person forced it: a cleanup command that failed or left the directory was followed by removing the directory. */
  forced?: true
  /** The key of the cleanup command it ran, which tells an automatic pass whether a failed one may run again. */
  command: string
  /** When a launch rebuilt the cleaned directory and told its worker. */
  rebuiltAt?: string
}
/** What a scan read of one directory. */
export interface DirectoryFacts {
  kind: 'worktree' | 'clone' | 'plain'
  branch?: string
  /** Tracked files with uncommitted changes, at most `CHANGED_SHOWN`, and how many there are. */
  changed: string[]
  changedCount: number
  /** Commits of HEAD on no remote branch; undefined outside git or when git could not tell. */
  unpushed?: number
  /** Disk usage in bytes, as `du` counts it. */
  bytes?: number
  /** A read that failed, such as a git command that timed out. */
  error?: string
  at: string
}
/**
 * A ticket directory's state for cleanup: its ticket is open (`active`) or ended within the retention period (`retained`),
 * it is `due`, an automatic cleanup `skipped` it (`changed` tracked files, or messages `waiting` to resume its ticket), its
 * last cleanup `failed`, it was `cleaned`, or no ticket names it (`orphan`).
 */
export type WorkspaceState = 'active' | 'retained' | 'due' | 'skipped' | 'failed' | 'cleaned' | 'orphan'
/** Whether a directory needs a person: an automatic cleanup skipped it, it failed, or no ticket names it. */
export const needsAttention = (state: WorkspaceState): boolean => state === 'skipped' || state === 'failed' || state === 'orphan'

/** Host dependencies used by `Workspaces`. */
export interface WorkspacesHost {
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly subprocess: SubprocessRuntime
  readonly stateDir: string
  readonly lifetime: AbortSignal
  /** The `workspaces` health entry, an error while automatic cleanups failed. */
  readonly health: HealthEntry
  /** Whether processing is paused or waits for setup, which holds automatic cleanups. */
  paused(): boolean
  /** The execution environment of a cleanup command: the ticket's, or for a directory no ticket names, the deployment's with its name and path. */
  environment(target: { ticket?: Ticket; name: string; directory: string }): Record<string, string>
  now?(): number
}

/** A directory under the execution root with what decides its cleanup. */
interface Entry { name: string; directory: string; exists: boolean; ticket?: Ticket; record?: CleanupRecord }
/** The key of a cleanup command, which tells whether a failed cleanup ran the command as it reads now. */
const commandKey = (command: string): string => key('cleanup', command.trim())
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 4000)
/** Whether a person's message waits to resume an ended ticket, which would prepare its directory again at once. */
const resumeWaits = (ticket: Ticket): boolean => ticket.undelivered.some(id => {
  const input = ticket.inputs.find(item => item.id === id)
  return input?.kind === 'trigger' && !!input.human && !input.context
})
/** Parses `git status --porcelain=v1 -z` into paths; a rename or copy names its source in the entry after it. */
export function changedPaths(output: string): string[] {
  const entries = output.split('\0').filter(Boolean)
  const paths: string[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    paths.push(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C') index++
  }
  return paths
}

/**
 * Lists, scans and cleans the ticket directories under the execution root. An automatic pass runs at start, every hour and
 * when a ticket is accepted: it cleans each ended ticket's directory once `retentionDays` passed since the ticket ended,
 * unless tracked files have uncommitted changes or a person's message waits to resume the ticket, by running the
 * `cleanup` command with the ticket's execution environment. A cleanup holds the directory: a launch of its ticket waits for
 * it (`settled`), then prepares the directory again and tells the worker (`rebuilt`).
 * Runtime starts it, the DshExecutor waits on it, and the management routes read and drive it.
 */
export class Workspaces {
  /** What the last scan read of each directory, by name. */
  private readonly facts = new Map<string, DirectoryFacts>()
  /** The cleanups that run, by directory name. */
  private readonly cleaning = new Map<string, Promise<CleanupRecord>>()
  private scannedAt?: string
  private scanning?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private passing?: Promise<void>
  private again = false
  constructor(private readonly host: WorkspacesHost) {}
  private now(): number { return this.host.now?.() ?? Date.now() }
  private settings(): Settings['executor'] { return this.host.store.settings().executor }
  root(): string { return executionRoot(this.host.store.settings(), this.host.stateDir) }
  /** Runs a pass now and then every `CLEANUP_INTERVAL_MS`. */
  start(): void {
    if (this.timer) return
    this.request()
    this.timer = setInterval(() => { this.request() }, CLEANUP_INTERVAL_MS)
  }
  dispose(): void { clearInterval(this.timer); this.timer = undefined }
  /** Asks for an automatic pass, such as when a ticket is accepted; one that runs runs once more after it. */
  request(): void {
    if (this.passing) { this.again = true; return }
    this.passing = this.pass().finally(() => {
      this.passing = undefined
      if (this.again && !this.host.lifetime.aborted) { this.again = false; this.request() }
    })
  }
  /** Resolves once the requested passes finished, for tests and shutdown. */
  async idle(): Promise<void> { while (this.passing) await this.passing }
  /** Waits for a cleanup of `directory` that runs, which a launch of its ticket must not race. */
  async settled(directory: string): Promise<void> {
    const name = this.nameOf(directory)
    if (name) await this.cleaning.get(name)?.catch(() => {})
  }
  /**
   * When a launch is about to prepare a ticket's missing directory: the time its last cleanup removed it, unless its worker
   * was told already, which `rebuiltDone` records once the message is delivered.
   */
  rebuilt(ticket: Ticket): string | undefined {
    const name = ticket.execution?.name
    const record = name ? this.host.store.get(KV.workspaces.cleanup(name)) : undefined
    return record?.state === 'cleaned' && !record.rebuiltAt ? record.at : undefined
  }
  rebuiltDone(ticket: Ticket): void {
    const name = ticket.execution?.name
    const record = name ? this.host.store.get(KV.workspaces.cleanup(name)) : undefined
    if (name && record?.state === 'cleaned' && !record.rebuiltAt)
      this.host.store.set(KV.workspaces.cleanup(name), { ...record, rebuiltAt: new Date(this.now()).toISOString() })
  }
  /** The name of a directory right under the execution root, or undefined for any other path. */
  private nameOf(directory: string): string | undefined {
    const root = this.root()
    const name = directory.startsWith(`${root}/`) ? directory.slice(root.length + 1) : ''
    return name && !name.includes('/') && name !== '.' && name !== '..' ? name : undefined
  }
  /** The directories under the execution root, and the directories of tickets there that a cleanup removed. */
  private async entries(): Promise<Entry[]> {
    const root = this.root()
    const names = await readdir(root, { withFileTypes: true }).then(items => items.filter(item => item.isDirectory()).map(item => item.name),
      (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return [] as string[]; throw error })
    const tickets = new Map<string, Ticket>()
    // Newest first, so the newest ticket of a reused name wins.
    for (const ticket of this.host.store.tickets.list()) {
      const name = ticket.execution ? this.nameOf(ticket.execution.directory) : undefined
      if (name && !tickets.has(name)) tickets.set(name, ticket)
    }
    const cleaned = this.host.store.keys(KV.workspaces.cleanup).map(item => item.slice(KV.workspaces.cleanup.prefix.length))
    const all = [...new Set([...names, ...cleaned])].sort()
    const present = new Set(names)
    return all.map(name => {
      const ticket = tickets.get(name), record = this.host.store.get(KV.workspaces.cleanup(name))
      return { name, directory: join(root, name), exists: present.has(name), ...ticket ? { ticket } : {}, ...record ? { record } : {} }
    }).filter(entry => entry.exists || entry.record)
  }
  /** When an ended ticket's directory becomes due, `retentionDays` after the ticket last ended. */
  private dueAt(ticket: Ticket): number | undefined {
    return ticket.ended ? Date.parse(ticket.ended.at) + this.settings().retentionDays * DAY_MS : undefined
  }
  /** The cleanup state of a directory, and why an automatic cleanup skips it. */
  private stateOf(entry: Entry): { state: WorkspaceState; reason?: 'changed' | 'waiting' | 'retried' } {
    const { ticket, record, exists } = entry
    if (!exists) return { state: 'cleaned' }
    if (this.cleaning.has(entry.name)) return { state: ticket && liveTicket(ticket) ? 'active' : 'due' }
    if (!ticket) return { state: 'orphan' }
    if (liveTicket(ticket)) return { state: 'active' }
    // A failure from before the ticket last ended is history: the ticket resumed since, and its retention period starts again.
    if (record?.state === 'failed' && record.at >= (ticket.ended?.at ?? ''))
      return { state: 'failed', ...record.command === commandKey(this.settings().cleanup) ? { reason: 'retried' } : {} }
    if ((this.dueAt(ticket) ?? Infinity) > this.now()) return { state: 'retained' }
    if (resumeWaits(ticket)) return { state: 'skipped', reason: 'waiting' }
    if (this.facts.get(entry.name)?.changedCount) return { state: 'skipped', reason: 'changed' }
    return { state: 'due' }
  }
  /** Reads a directory's git state and size; a failed read is kept as its `error`. */
  private async read(directory: string): Promise<DirectoryFacts> {
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(READ_TIMEOUT_MS)])
    const run = (argv: string[]) => runAsWorker(this.host.subprocess, argv, directory, signal)
    const at = new Date(this.now()).toISOString()
    const git = await lstat(join(directory, '.git')).then(stat => stat.isDirectory() ? 'clone' as const : 'worktree' as const, () => undefined)
    const bytes = await run(['du', '-sk', '.']).then(output => Number.parseInt(output, 10) * 1024, () => undefined)
    const size = bytes !== undefined && Number.isFinite(bytes) ? { bytes } : {}
    if (!git) return { kind: 'plain', changed: [], changedCount: 0, ...size, at }
    try {
      // Without optional locks, a scan never takes the index lock a worker's git may need.
      const changed = changedPaths(await run(['git', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=no']))
      const branch = (await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      const unpushed = await run(['git', 'rev-list', '--count', 'HEAD', '--not', '--remotes']).then(output => Number.parseInt(output, 10), () => undefined)
      return { kind: git, ...branch ? { branch } : {}, changed: changed.slice(0, CHANGED_SHOWN), changedCount: changed.length,
        ...unpushed !== undefined && Number.isFinite(unpushed) ? { unpushed } : {}, ...size, at }
    } catch (error) {
      return { kind: git, changed: [], changedCount: 0, ...size, error: errorText(error), at }
    }
  }
  /** Scans every directory under the execution root; a scan that runs is shared. */
  scan(): Promise<void> {
    return this.scanning ??= (async () => {
      const entries = (await this.entries()).filter(entry => entry.exists && !this.cleaning.has(entry.name))
      const queue = [...entries]
      const worker = async () => {
        for (let entry = queue.shift(); entry && !this.host.lifetime.aborted; entry = queue.shift()) {
          this.facts.set(entry.name, await this.read(entry.directory))
        }
      }
      await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker))
      const kept = new Set(entries.map(entry => entry.name))
      for (const name of this.facts.keys()) if (!kept.has(name)) this.facts.delete(name)
      this.scannedAt = new Date(this.now()).toISOString()
    })().finally(() => { this.scanning = undefined })
  }
  /** Scans, then cleans each due directory, unless processing is paused or no cleanup command is set. */
  private async pass(): Promise<void> {
    try {
      await this.scan()
      const command = this.settings().cleanup.trim()
      if (command && !this.host.paused()) {
        for (const entry of await this.entries()) {
          if (this.host.lifetime.aborted) return
          const { state, reason } = this.stateOf(entry)
          // A failed cleanup runs again on its own only once the command changed.
          if (state === 'due' || (state === 'failed' && reason !== 'retried'))
            await this.cleanEntry(entry.name, false, entry).catch(() => { /* A refusal leaves the directory, as the next scan shows. */ })
        }
      }
      await this.report()
    } catch (error) {
      if (!this.host.lifetime.aborted) this.host.health.set({ state: 'error', detail: errorText(error), at: new Date(this.now()).toISOString() })
    }
  }
  /**
   * Cleans a directory now, as a person asks from the panel: before its retention period ends too, and with `force`, also
   * when tracked files have uncommitted changes or messages wait to resume its ticket, removing what a failed cleanup command left.
   * @throws UserError when the directory is unknown, being cleaned, its ticket is open, or the cleanup is refused without `force`.
   */
  async clean(name: string, force: boolean): Promise<CleanupRecord> {
    const record = await this.cleanEntry(name, force)
    await this.report()
    return record
  }
  /**
   * Holds the directory for one cleanup from the call on, before any await, so a launch of its ticket that asks `settled`
   * meanwhile waits for it; `entry` is the directory a pass found, or undefined to look it up.
   */
  private cleanEntry(name: string, force: boolean, entry?: Entry): Promise<CleanupRecord> {
    if (this.cleaning.has(name)) return Promise.reject(new UserError('workspaceCleaning', { name }))
    const running = (async () => {
      const found = entry ?? (await this.entries()).find(item => item.name === name && item.exists)
      if (!found) throw new UserError('unknownWorkspace', { name })
      const ticket = found.ticket && this.host.store.tickets.get(found.ticket.id)
      if (ticket && liveTicket(ticket)) throw new UserError('workspaceOpen', { name })
      return this.run({ ...found, ...ticket ? { ticket } : {} }, force)
    })()
    this.cleaning.set(name, running)
    return running.finally(() => { this.cleaning.delete(name) })
  }
  /** Sets the `workspaces` health entry: an error while a directory's last cleanup failed. */
  private async report(): Promise<void> {
    const failed = (await this.entries()).filter(entry => this.stateOf(entry).state === 'failed').length
    const at = new Date(this.now()).toISOString()
    this.host.health.set(failed ? { state: 'error', detail: `${failed} ticket director${failed === 1 ? 'y' : 'ies'} failed to clean`, at }
      : { state: 'ready', detail: 'No failed cleanup', at })
  }
  /** Runs one cleanup and records how it ended; a refusal records nothing. */
  private async run(entry: Entry, force: boolean): Promise<CleanupRecord> {
    const { name, directory, ticket } = entry
    const fresh = await this.read(directory)
    this.facts.set(name, fresh)
    if (!force && fresh.changedCount) throw new UserError('workspaceChanged', { name })
    if (!force && ticket && resumeWaits(ticket)) throw new UserError('workspaceWaiting', { name })
    const command = this.settings().cleanup.trim()
    if (!command && !force) throw new UserError('noCleanupCommand')
    await this.inside(directory)
    const base = { command: commandKey(command), ...ticket ? { ticketId: ticket.id } : {}, ...force ? { forced: true as const } : {} }
    let output: string | undefined
    if (command) {
      const env = this.host.environment({ ...ticket ? { ticket } : {}, name, directory })
      const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)])
      await runAsWorker(this.host.subprocess, ['sh', '-c', command], this.root(), signal, env)
        .catch((error: unknown) => { output = `The cleanup command failed: ${errorText(error)}` })
    }
    let left = await lstat(directory).then(() => true, () => false)
    if (left && !output && command) output = 'The cleanup command finished but left the directory'
    // A forced cleanup removes what is left; the directory is the root's own child, which `inside` verified.
    if (left && force) {
      await rm(directory, { recursive: true, force: true }).catch((error: unknown) => { output = `${output ? `${output}\n` : ''}${errorText(error)}` })
      left = await lstat(directory).then(() => true, () => false)
    }
    const at = new Date(this.now()).toISOString()
    const record: CleanupRecord = left ? { ...base, at, state: 'failed', output: output ?? 'The directory is still there' }
      : { ...base, at, state: 'cleaned', ...output ? { output } : {} }
    this.host.store.set(KV.workspaces.cleanup(name), record)
    if (!left) this.facts.delete(name)
    return record
  }
  /** Verifies that a directory is a real child of the execution root, not the root itself or a link that leads elsewhere. */
  private async inside(directory: string): Promise<void> {
    const root = await realpath(this.root())
    const stat = await lstat(directory)
    const real = stat.isSymbolicLink() ? undefined : await realpath(directory)
    if (!real || real === root || !real.startsWith(`${root}/`) || real.slice(root.length + 1).includes('/'))
      throw new Error(`${directory} is not a directory right under the execution root ${root}`)
  }
  /** The directories for the panel, those `filter` selects, with counts per filter and the time of the last scan. */
  async view(filter: WorkspaceFilter) {
    const entries = await this.entries()
    const rows = entries.map(entry => {
      const { state, reason } = this.stateOf(entry)
      const facts = this.facts.get(entry.name)
      const due = entry.ticket ? this.dueAt(entry.ticket) : undefined
      const ticket = entry.ticket && ticketSummary(entry.ticket)
      return { name: entry.name, directory: entry.directory, exists: entry.exists, state, ...reason ? { reason } : {},
        cleaning: this.cleaning.has(entry.name), ...facts ? { facts } : {},
        ...due !== undefined && state === 'retained' ? { dueAt: new Date(due).toISOString() } : {},
        ...ticket ? { ticket: { id: ticket.id, title: ticket.title, state: ticket.state, stage: ticket.stage, ...'action' in ticket && ticket.action ? { action: ticket.action } : {},
          ended: ticket.ended, sessionId: ticket.sessionId, ...ticket.tier ? { tier: ticket.tier } : {} } } : {},
        ...entry.record ? { cleanup: entry.record } : {},
        actions: { clean: entry.exists && state !== 'active' && !this.cleaning.has(entry.name) } }
    })
    const ORDER: readonly WorkspaceState[] = ['failed', 'skipped', 'orphan', 'due', 'active', 'retained', 'cleaned']
    rows.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.name.localeCompare(b.name))
    const selects = (row: typeof rows[number], value: WorkspaceFilter) => value === 'all' || (value === 'attention' ? needsAttention(row.state)
      : row.state === value)
    const counts = Object.fromEntries(WORKSPACE_FILTERS.map(value => [value, rows.filter(row => selects(row, value)).length])) as Record<WorkspaceFilter, number>
    const executor = this.settings()
    return { root: this.root(), scannedAt: this.scannedAt ?? null, scanning: !!this.scanning, retentionDays: executor.retentionDays,
      cleanupCommand: !!executor.cleanup.trim(), counts, items: rows.filter(row => selects(row, filter)) }
  }
}
export type WorkspacesView = Awaited<ReturnType<Workspaces['view']>>
export type WorkspaceRow = WorkspacesView['items'][number]
