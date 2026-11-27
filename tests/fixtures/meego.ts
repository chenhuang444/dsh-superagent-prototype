/** `meegle` answers of space `p1` (simple name `acme`) on `project.example.com`, and a stand-in for `meegle` answering them. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { sourceContextOf, type SourceContextDeps } from '../../src/app/source-context.ts'
import { Store } from '../../src/app/store.ts'
import { Engine, type Trigger } from '../../src/core/index.ts'
import { Commands, commandError } from '../../src/infra/commands.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../../src/policy.ts'
import { bindMeego } from '../../src/sources/meego-channel.ts'
import { meegoKind } from '../../src/sources/meego.ts'
import { SourceRegistry } from '../../src/sources/registry.ts'
import type { MeegoCli } from '../../src/deployment.ts'
import { testDeployment } from './deployment.ts'

export const HOST = 'project.example.com'
/** The operator, under whose account the agent writes. */
export const OWNER = '1001'
/** A colleague. */
export const COLLEAGUE = '1002'
export const VIEW = `https://${HOST}/acme/issueView/V1`
export const testMeego = (overrides: Partial<MeegoCli> = {}): MeegoCli => ({ cli: '/bin/meegle', profile: 'superagent', host: HOST,
  userKey: OWNER, name: 'Ada', larkUserId: 'lark_ada', ...overrides })
export const page = (id: string, type = 'issue') => `https://${HOST}/acme/${type}/detail/${id}`
/** A work item as `view get` and `workitem get` list it, created by the colleague. */
export const attribute = (id: string, fields: Record<string, unknown> = {}) => ({ work_item_id: id, work_item_name: `Bug ${id}`,
  create_by: { key: COLLEAGUE, name: 'Bob' }, create_time: '2026-11-25T17:26:41+08:00', update_time: '2026-11-25T17:26:41+08:00',
  work_item_type: { key: 'issue' }, owned_project: { key: 'p1', simple_name: 'acme' }, ...fields })
/** A page of `view get`. */
export const viewPage = (items: unknown[], more = false) => ({ pagination: { has_more: more ? 'True' : 'False', page_num: 1, total: String(items.length) },
  work_item_list: items.map(item => ({ work_item_attribute: item })) })
/** A row of `mywork todo`: one per node or subtask. */
export const todoRow = (id: string, projectKey = 'p1') => ({ project_key: projectKey,
  work_item_info: { work_item_id: Number(id), work_item_name: `Task ${id}`, work_item_type_key: 'story' }, node_info: { node_name: 'Dev' } })
export const workItem = (id: string, text = 'details', fields: Record<string, unknown> = {}) =>
  ({ work_item_attribute: attribute(id, fields), work_item_fields: [{ key: 'description', value: text }] })
export const comment = (id: string, creator: string, content: string, createdAt = '2026-11-26 16:35:13') =>
  ({ comment_id: id, content, created_at: createdAt, creator, file_url: '' })
export const comments = (list: unknown[], totalPages = 1, pageNum = 1) =>
  ({ comments: list, pagination: { page_num: pageNum, page_size: 20, total: list.length, total_pages: totalPages } })
/** A mention as Feishu Project writes it. */
export const mention = (name: string, id = 'lark_ada') =>
  `@${name}<!-- mention:{"id":"${id}","cn_name":"${name}","blockType":"AT_USER_BLOCK"} -->`
export const notFound = () => commandError({ stderr: '{"data":null,"error":{"code":"SERVER_CALL_FAILED","message":"error=WorkItemNotFound, work item missing","retryable":true}}', code: 1 })

type Route = unknown | ((args: string[]) => unknown)
/**
 * Answers `meegle --profile superagent <command> <sub> ...` from `routes` by `<command> <sub>` (such as `comment list`), each
 * an answer or a function of the arguments; an Error is thrown as `meegle` fails. Returns the calls' arguments.
 */
export function meegle(commands: Commands, routes: Record<string, Route>) {
  const calls: string[][] = []
  vi.spyOn(commands, 'withSignal').mockReturnValue(commands)
  const run = vi.spyOn(commands, 'run').mockImplementation(async (program, args) => {
    const [profileFlag, profile, command = '', sub = '', ...rest] = args
    if (program !== '/bin/meegle' || profileFlag !== '--profile' || profile !== 'superagent') throw new Error(`Unexpected call ${program} ${args.join(' ')}`)
    calls.push([command, sub, ...rest])
    const route = routes[`${command} ${sub}`]
    const value: unknown = typeof route === 'function' ? (route as (args: string[]) => unknown)(rest) : route
    if (value === undefined) throw new Error(`No answer for meegle ${command} ${sub}`)
    if (value instanceof Error) throw value
    return JSON.stringify(value)
  })
  return { calls, run, named: (name: string) => calls.filter(call => `${call[0]} ${call[1]}` === name).map(call => call.slice(2)) }
}
/** The value after `flag` in `args`. */
export const flag = (args: string[], name: string): string | undefined => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }

/**
 * A Meego Source's context over a real Store in a temporary directory: the Source on with `config` (space `p1` and `VIEW` by
 * default), the operator allowed, and an Engine with stand-in ports. The channel and reader are bound to its state. Close it
 * with `close()`.
 */
export function meegoHost(config: Record<string, unknown> = {}, overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'meego-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' },
    sources: { meego: { enabled: true, config: { cli: 'meegle', spaces: [{ projectKey: 'p1' }], views: [{ url: VIEW }], ...config } } },
    policy: { sources: { meego: { allowed: [{ id: OWNER }] } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(meegoKind)
  const executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn(async () => {}) }, executor, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const deployment = testDeployment({ meego: testMeego() })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const ctx = sourceContextOf(deps, meegoKind)
  const unbind = bindMeego({ state: ctx.state, config: kind => ctx.config(kind) })
  return { ...deps, store, engine, commands, receive, board, ctx,
    context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind),
    taken: (): Trigger[] => receive.mock.calls.map(([trigger]) => trigger),
    close: () => { unbind(); store.close() } }
}
export type MeegoHost = ReturnType<typeof meegoHost>
