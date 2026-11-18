/** GitLab REST v4 payloads of project `acme/widgets` on `https://gitlab.example.com`, and a stand-in for `glab api` answering them. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { sourceContextOf, type SourceContextDeps } from '../../src/app/source-context.ts'
import { Store } from '../../src/app/store.ts'
import { Engine, type Ticket, type Trigger } from '../../src/core/index.ts'
import { Commands, commandError } from '../../src/infra/commands.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../../src/policy.ts'
import { gitlabKind } from '../../src/sources/gitlab.ts'
import { SourceRegistry } from '../../src/sources/registry.ts'
import { testGitlabDeployment } from './deployment.ts'

export const WEB = 'https://gitlab.example.com/acme/widgets'
const user = (username: string, bot = false) => ({ id: 100, username, name: username, state: 'active', avatar_url: 'x',
  web_url: `https://gitlab.example.com/${username}`, ...bot ? { bot: true } : {} })
/** An Issue opened by alice. */
export const issue = (iid: number, fields: Record<string, unknown> = {}) => ({ id: 1000 + iid, iid, project_id: 42, title: 'Login fails',
  description: 'details', state: 'opened', created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z', labels: [],
  author: user('alice'), web_url: `${WEB}/-/issues/${iid}`, ...fields })
/** An open MR by carol from branch `fix` of the project. */
export const mr = (iid: number, fields: Record<string, unknown> = {}) => ({ ...issue(iid), id: 2000 + iid, title: 'Fix the margin',
  author: user('carol'), web_url: `${WEB}/-/merge_requests/${iid}`, source_branch: 'fix', target_branch: 'main',
  source_project_id: 42, target_project_id: 42, sha: 'abc1234def', merged_at: null, closed_at: null,
  merge_when_pipeline_succeeds: false, draft: false, ...fields })
/** The agent's open MR from `branch`. */
export const agentMr = (iid: number, branch: string, fields: Record<string, unknown> = {}) =>
  mr(iid, { author: user('agent-bot'), source_branch: branch, ...fields })
/** A note by `username`; `fields` may make it a diff note or a system note. */
export const note = (id: number, username: string, body: string, fields: Record<string, unknown> = {}) => ({ id, body,
  author: user(username, /_bot/.test(username)), created_at: `2026-09-09T00:00:${String(id % 60).padStart(2, '0')}Z`,
  updated_at: `2026-09-09T00:00:${String(id % 60).padStart(2, '0')}Z`, system: false, type: null, noteable_type: 'Issue',
  resolvable: false, ...fields })
export const diffNote = (id: number, username: string, body: string) => note(id, username, body, { type: 'DiffNote', resolvable: true,
  resolved: false, position: { base_sha: 'a', head_sha: 'b', new_path: 'src/render.ts', new_line: 43, old_path: 'src/render.ts', old_line: null } })
/** A discussion of `notes`; one note alone is an individual note unless `threaded`. */
export const discussion = (id: string, notes: unknown[], threaded = notes.length > 1) => ({ id, individual_note: !threaded, notes })

export const refused = (status: number, text: string) => commandError({ stderr: `glab: ${text} (HTTP ${status})`, code: 1 })
type Route = unknown | ((flags: string[]) => unknown)
/**
 * Answers `glab api --hostname gitlab.example.com projects/42/<path>` from `routes` by path without its query (`''` for the
 * project), as ndjson for `--paginate`; a missing list is empty and a missing item is 404. Returns the paths read with their
 * queries, and the flags of each call.
 */
export function glab(commands: Commands, routes: Record<string, Route>) {
  const reads: string[] = [], calls: { path: string; flags: string[] }[] = []
  vi.spyOn(commands, 'withSignal').mockReturnValue(commands)
  const run = vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => {
    const [api, hostname, host, resource = '', ...flags] = args
    if (api !== 'api' || hostname !== '--hostname' || host !== 'gitlab.example.com') throw new Error(`Unexpected glab call ${args.join(' ')}`)
    const path = resource.replace(/^projects\/42\/?/, '')
    reads.push(path); calls.push({ path, flags })
    const bare = path.split('?')[0]!
    const route = routes[bare]
    const paginated = flags.includes('--paginate')
    const value: unknown = typeof route === 'function' ? (route as (flags: string[]) => unknown)(flags)
      : route ?? (paginated || /(notes|discussions|jobs|pipelines|tree)$/.test(bare) ? [] : refused(404, '404 Not Found'))
    if (value instanceof Error) throw value
    if (typeof value === 'string') return value
    return paginated ? (value as unknown[]).map(item => JSON.stringify(item)).join('\n') + '\n' : JSON.stringify(value)
  })
  return { reads, calls, run, bare: () => reads.map(path => path.split('?')[0]) }
}

/**
 * A GitLab Source's context over a real Store in a temporary directory, as tests/sources.spec.ts builds it: the GitLab
 * Source on with `config`, allowed alice, and an Engine with stand-in ports. Close it with `store.close()`.
 */
export function gitlabHost(config: Record<string, unknown> = {}, overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' }, sources: { gitlab: { enabled: true, config } },
    policy: { sources: { gitlab: { allowed: [{ id: 'alice' }] } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(gitlabKind)
  const executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn(async () => {}) }, executor, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const deployment = testGitlabDeployment()
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, executor, commands, receive, board, ctx: sourceContextOf(deps, gitlabKind),
    context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind) }
}
export type GitlabHost = ReturnType<typeof gitlabHost>
/** A Ticket of alice's explicit request, open and working on `name`. */
export const ticket = (id: string, fields: Partial<Ticket> = {}): Ticket => ({ id, title: id, decisionId: `d-${id}`,
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'gitlab', id: 'alice' }, scope: '' },
  channels: [], assignments: [{ id: `a-${id}`, state: 'running', createdAt: '2026-09-01T00:00:00Z' }], inputs: [], undelivered: [],
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', origin: { triggerId: `source-${id}`, triggerIds: [] }, ...fields })
export const execution = (name: string) => ({ name, directory: `/w/${name}`, assignment: '' })
