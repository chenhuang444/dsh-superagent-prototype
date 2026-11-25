/** Workspaces on real git worktrees: the scan, the automatic cleanup after the retention period, its skips, and forced cleanups. */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Workspaces, changedPaths } from '../src/app/workspaces.ts'
import type { Ticket } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { gitEnv } from './fixtures/git.ts'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-25T00:00:00Z')
let base: string, repo: string, root: string, store: Store, board: HealthBoard, workspaces: Workspaces, paused: boolean, now: number
const env = () => gitEnv({ GIT_CONFIG_GLOBAL: join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x',
  GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env() as NodeJS.ProcessEnv, encoding: 'utf8' })
/** A SubprocessRuntime on child_process that passes the command's environment, as DSH's does. */
const subprocess = {
  spawn: ({ argv, cwd, env: extra }: { argv: readonly string[]; cwd: string; env?: Record<string, string> }) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...env(), ...extra } as NodeJS.ProcessEnv })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
} as unknown as SubprocessRuntime
const CLEANUP = 'git -C "$REPO" worktree remove --force "$DSH_SUPERAGENT_DIR"'

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'workspaces-')))
  writeFileSync(join(base, 'gitconfig'), '')
  repo = join(base, 'repo'); root = join(base, 'work')
  mkdirSync(repo); mkdirSync(root)
  git(repo, 'init', '-q', '-b', 'main'); writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init')
  store = new Store(join(base, 'state', 'orchestrator.sqlite'))
  const settings = store.settings()
  store.saveSettings({ ...settings, executor: { ...settings.executor, directory: root, cleanup: CLEANUP } })
  board = new HealthBoard(); paused = false; now = NOW
  workspaces = new Workspaces({ store, subprocess, stateDir: join(base, 'state'), lifetime: new AbortController().signal,
    health: board.claim('workspaces'), paused: () => paused, now: () => now,
    environment: ({ ticket, name, directory }) => ({ REPO: repo, DSH_SUPERAGENT_DIR: directory, DSH_SUPERAGENT_NAME: name,
      DSH_SUPERAGENT_TICKET: ticket?.id ?? '' }) })
})
afterEach(() => { workspaces.dispose(); store.close(); rmSync(base, { recursive: true, force: true }) })

/** A ticket with a worktree on `agent/<name>`, ended `endedDaysAgo` days ago, or open without it. */
function ticket(id: string, endedDaysAgo?: number, fields: Partial<Ticket> = {}): Ticket {
  const name = `fix-${id}`, directory = join(root, name)
  git(repo, 'worktree', 'add', '-q', '-b', `agent/${name}`, directory)
  const value: Ticket = { id, title: `Fix ${id}`, decisionId: '', channels: [], assignments: [], inputs: [], undelivered: [],
    mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'x', id: '' }, scope: '' },
    createdAt: '', updatedAt: '', origin: { triggerId: '', triggerIds: [] }, execution: { name, directory, assignment: '' },
    ...endedDaysAgo === undefined ? {} : { ended: { at: new Date(NOW - endedDaysAgo * DAY).toISOString(), by: 'executor', outcome: 'merged' } },
    ...fields }
  store.tickets.save(value)
  return value
}
const state = async (name: string) => (await workspaces.view('all')).items.find(item => item.name === name)
const branches = () => git(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort()

it('cleans an ended ticket\'s worktree once the retention period passed, keeping its branch, and leaves open and recent ones', async () => {
  ticket('old', 8); ticket('recent', 2); ticket('open')
  workspaces.request(); await workspaces.idle()
  expect(existsSync(join(root, 'fix-old'))).toBe(false)
  expect(existsSync(join(root, 'fix-recent'))).toBe(true)
  expect(existsSync(join(root, 'fix-open'))).toBe(true)
  // The branch stays, so the prepare command can rebuild the directory from it.
  expect(branches()).toEqual(['agent/fix-old', 'agent/fix-open', 'agent/fix-recent', 'main'])
  expect(store.get(KV.workspaces.cleanup('fix-old'))).toMatchObject({ state: 'cleaned', ticketId: 'old' })
  expect(await state('fix-old')).toMatchObject({ exists: false, state: 'cleaned' })
  expect(await state('fix-recent')).toMatchObject({ state: 'retained', dueAt: new Date(NOW + 5 * DAY).toISOString(),
    facts: { kind: 'worktree', branch: 'agent/fix-recent', changedCount: 0 } })
  expect(await state('fix-open')).toMatchObject({ state: 'active', actions: { clean: false } })
  expect(board.all.workspaces).toMatchObject({ state: 'ready' })
  // A shorter retention period makes the recent one due.
  const settings = store.settings()
  store.saveSettings({ ...settings, executor: { ...settings.executor, retentionDays: 1 } })
  workspaces.request(); await workspaces.idle()
  expect(existsSync(join(root, 'fix-recent'))).toBe(false)
})

it('skips a directory with uncommitted tracked changes, but not one with only untracked files, and holds every cleanup while paused', async () => {
  ticket('changed', 8); ticket('untracked', 8)
  writeFileSync(join(root, 'fix-changed', 'a.txt'), 'changed\n')
  writeFileSync(join(root, 'fix-untracked', 'tmp.log'), 'scratch\n')
  paused = true
  workspaces.request(); await workspaces.idle()
  expect(existsSync(join(root, 'fix-untracked'))).toBe(true)
  paused = false
  workspaces.request(); await workspaces.idle()
  expect(existsSync(join(root, 'fix-untracked'))).toBe(false)
  expect(await state('fix-changed')).toMatchObject({ state: 'skipped', reason: 'changed', facts: { changed: ['a.txt'], changedCount: 1 } })
  expect((await workspaces.view('attention')).items.map(item => item.name)).toEqual(['fix-changed'])
  await expect(workspaces.clean('fix-changed', false)).rejects.toMatchObject({ code: 'workspaceChanged' })
  // A forced cleanup discards the changes.
  expect(await workspaces.clean('fix-changed', true)).toMatchObject({ state: 'cleaned', forced: true })
  expect(existsSync(join(root, 'fix-changed'))).toBe(false)
})

it('skips the directory of an ended ticket a person\'s message waits to resume, and refuses to clean an open ticket\'s', async () => {
  const waiting = ticket('waiting', 8, { inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'tr1', human: true, at: '' }], undelivered: ['i1'] })
  ticket('open')
  workspaces.request(); await workspaces.idle()
  expect(existsSync(waiting.execution!.directory)).toBe(true)
  expect(await state('fix-waiting')).toMatchObject({ state: 'skipped', reason: 'waiting' })
  await expect(workspaces.clean('fix-open', true)).rejects.toMatchObject({ code: 'workspaceOpen' })
  await expect(workspaces.clean('missing', true)).rejects.toMatchObject({ code: 'unknownWorkspace' })
})

it('records a failed cleanup with its output, runs the same command again only once it changes, and a forced cleanup removes what is left', async () => {
  ticket('stuck', 8)
  const settings = store.settings()
  const command = (cleanup: string) => store.saveSettings({ ...store.settings(), executor: { ...settings.executor, cleanup } })
  command('echo no such repository >&2; exit 2')
  workspaces.request(); await workspaces.idle()
  const failed = store.get(KV.workspaces.cleanup('fix-stuck'))!
  expect(failed).toMatchObject({ state: 'failed', output: expect.stringContaining('no such repository') })
  expect(await state('fix-stuck')).toMatchObject({ state: 'failed', reason: 'retried', cleanup: { state: 'failed' } })
  expect(board.all.workspaces).toMatchObject({ state: 'error' })
  workspaces.request(); await workspaces.idle()
  expect(store.get(KV.workspaces.cleanup('fix-stuck'))!.at).toBe(failed.at)
  // A command that finishes without removing the directory fails too; a forced cleanup removes the directory itself.
  command('true')
  now += 1000
  workspaces.request(); await workspaces.idle()
  expect(store.get(KV.workspaces.cleanup('fix-stuck'))).toMatchObject({ state: 'failed', output: expect.stringContaining('left the directory') })
  expect(await workspaces.clean('fix-stuck', true)).toMatchObject({ state: 'cleaned', forced: true })
  expect(existsSync(join(root, 'fix-stuck'))).toBe(false)
  expect(board.all.workspaces).toMatchObject({ state: 'ready' })
})

it('lists a directory no ticket names as orphaned, and a forced cleanup without a ticket runs the command with an empty ticket id', async () => {
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/stray', join(root, 'stray'))
  mkdirSync(join(root, 'plain')); writeFileSync(join(root, 'plain', 'x'), 'x')
  await workspaces.scan()
  expect((await workspaces.view('orphan')).items.map(item => [item.name, item.facts?.kind])).toEqual([['plain', 'plain'], ['stray', 'worktree']])
  workspaces.request(); await workspaces.idle()
  expect(existsSync(join(root, 'stray'))).toBe(true)
  expect(await workspaces.clean('stray', false)).toMatchObject({ state: 'cleaned' })
  expect(existsSync(join(root, 'stray'))).toBe(false)
  // A plain directory is not a worktree, so the command fails; forcing removes it.
  expect(await workspaces.clean('plain', false)).toMatchObject({ state: 'failed' })
  expect(await workspaces.clean('plain', true)).toMatchObject({ state: 'cleaned' })
  expect(existsSync(join(root, 'plain'))).toBe(false)
})

it('says when a cleaned directory is rebuilt, once, and a launch waits for a cleanup that runs', async () => {
  const old = ticket('old', 8)
  const settings = store.settings()
  store.saveSettings({ ...settings, executor: { ...settings.executor, cleanup: `sleep 0.3; ${CLEANUP}` } })
  const cleaning = workspaces.clean('fix-old', false)
  let settled = false
  const waited = workspaces.settled(old.execution!.directory).then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(settled).toBe(false)
  expect((await state('fix-old'))?.cleaning).toBe(true)
  await expect(workspaces.clean('fix-old', true)).rejects.toMatchObject({ code: 'workspaceCleaning' })
  await cleaning; await waited
  const cleanedAt = store.get(KV.workspaces.cleanup('fix-old'))!.at
  expect(workspaces.rebuilt(old)).toBe(cleanedAt)
  workspaces.rebuiltDone(old)
  expect(workspaces.rebuilt(old)).toBeUndefined()
  expect(store.get(KV.workspaces.cleanup('fix-old'))).toMatchObject({ state: 'cleaned', rebuiltAt: expect.any(String) })
})

it('refuses a directory that is a link out of the execution root', async () => {
  const outside = join(base, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'x')
  execFileSync('ln', ['-s', outside, join(root, 'link')])
  // A link is not listed as a directory, so nothing names it.
  await expect(workspaces.clean('link', true)).rejects.toMatchObject({ code: 'unknownWorkspace' })
  expect(existsSync(join(outside, 'keep'))).toBe(true)
})

it('reads the paths of git status -z, a rename taking two entries', () => {
  expect(changedPaths(' M a.txt\0R  new.txt\0old.txt\0D  gone.txt\0')).toEqual(['a.txt', 'new.txt', 'gone.txt'])
})

it('forgets a failed cleanup once its ticket resumed and ended again, which starts its retention period anew', async () => {
  const stuck = ticket('stuck', 8)
  store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, cleanup: 'exit 1' } })
  workspaces.request(); await workspaces.idle()
  expect(await state('fix-stuck')).toMatchObject({ state: 'failed' })
  // It resumed a day later, and ended again then.
  now = NOW + DAY
  store.tickets.save({ ...stuck, ended: { ...stuck.ended!, at: new Date(now).toISOString() } })
  expect(await state('fix-stuck')).toMatchObject({ state: 'retained', dueAt: new Date(now + 7 * DAY).toISOString() })
})
