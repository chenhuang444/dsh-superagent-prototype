import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { key, type Ticket } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { apply, meegoKind, pollRound } from '../src/sources/meego.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { invisibleMarker, markerBits } from '../src/sources/personal-identity.ts'
import { attribute, COLLEAGUE, comment, comments, flag, meegle, meegoHost, mention, notFound, OWNER, page, todoRow, VIEW, viewPage, workItem,
  type MeegoHost } from './fixtures/meego.ts'

const NOW = Date.parse('2026-11-27T00:00:00Z')
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: NOW }) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const decoded = { url_kind: 'view_issue', host: 'project.example.com', simple_name: 'acme', view_id: 'V1', work_item_type: 'issue' }
const space = { projects: [{ project_key: 'p1', name: ' Acme ', simple_name: 'acme' }] }
/** Routes of a space whose view lists `items`, with `extra` routes. */
const routes = (items: () => unknown[], extra: Record<string, unknown> = {}) => ({ 'project search': space, 'url decode': decoded,
  'view get': () => viewPage(items()), 'comment list': comments([]), ...extra })
const ticket = (id: string): Ticket => ({ id, title: id, decisionId: `d-${id}`,
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'meego', id: OWNER }, scope: '' },
  channels: [], assignments: [{ id: `a-${id}`, state: 'running', createdAt: '2026-11-26T00:00:00Z' }], inputs: [], undelivered: [],
  createdAt: '2026-11-26T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z', origin: { triggerId: `source-${id}`, triggerIds: [] } })
/** A Thread of work item `id` subscribed by `tickets`, as an earlier Trigger left it. */
const subscribe = (h: MeegoHost, id: string, tickets: string[]) => h.store.threads.save({ key: `meego:${id}`, ref: { source: 'meego', id },
  createdAt: '2026-11-26T00:00:00Z', lastAt: '2026-11-26T12:00:00Z', subscriptions: tickets, correlated: [], pending: [],
  meta: { projectKey: 'p1', workItemId: id, type: 'issue', url: page(id) } })

it('takes the view\'s first look as its baseline, then makes a Trigger of each new item but the operator\'s own', async () => {
  const h = meegoHost()
  let items = [attribute('101')]
  const api = meegle(h.commands, routes(() => items, { 'workitem get': (args: string[]) => workItem(flag(args, '--work-item-id')!, 'it crashes') }))
  await pollRound(h.ctx)
  expect(h.receive).not.toHaveBeenCalled()
  expect(h.store.get(KV.meego.baseline(`view:${VIEW}`))).toBe(true)
  expect(h.store.get(KV.meego.seen('101'))).toBe(true)
  expect(h.store.get(KV.meego.cursor('101'))).toBe(NOW)
  expect(h.store.get(KV.meego.space('p1'))).toEqual({ simpleName: 'acme', name: 'Acme' })
  expect(h.store.get(KV.meego.offset)).toBe(480)
  expect(h.board.all.meego).toMatchObject({ state: 'ready', detail: expect.stringContaining('1 work items in scope') })
  items = [attribute('101'), attribute('102'), attribute('103', { create_by: { key: OWNER, name: 'Ada' } })]
  await pollRound(h.ctx)
  expect(h.taken().map(trigger => [trigger.id, trigger.text, trigger.meta.via])).toEqual([[key('meego-item', '102'), 'Bug 102\n\nit crashes', 'view']])
  expect(api.named('workitem get').map(args => flag(args, '--work-item-id'))).toEqual(['102'])
  // The space is read once and kept.
  expect(api.named('project search')).toHaveLength(1)
  expect(h.store.threads.get('meego:102')!.meta).toMatchObject({ projectKey: 'p1', workItemId: '102', label: 'Bug 102', url: page('102') })
  // An item leaving and coming back is no new item.
  items = [attribute('101')]
  await pollRound(h.ctx)
  items = [attribute('101'), attribute('102')]
  await pollRound(h.ctx)
  expect(h.receive).toHaveBeenCalledTimes(1)
  h.close()
})

it('reads every page of a view', async () => {
  const h = meegoHost()
  const api = meegle(h.commands, routes(() => [], { 'view get': (args: string[]) =>
    flag(args, '--page-num') === '1' ? viewPage([attribute('101')], true) : viewPage([attribute('102')]) }))
  await pollRound(h.ctx)
  expect(api.named('view get').map(args => flag(args, '--page-num'))).toEqual(['1', '2'])
  expect(h.board.all.meego?.detail).toContain('2 work items in scope')
  h.close()
})

it('watches the to-do list once switched on: items of the spaces, each once, the creator read from the item', async () => {
  const h = meegoHost({ views: [], todo: true })
  let rows = [todoRow('201'), todoRow('201'), todoRow('301', 'p9')]
  meegle(h.commands, { 'project search': space, 'comment list': comments([]),
    'mywork todo': (args: string[]) => flag(args, '--page-num') === '1' ? { list: rows } : { list: null },
    'workitem get': (args: string[]) => workItem(flag(args, '--work-item-id')!, 'todo details') })
  await pollRound(h.ctx)
  expect(h.receive).not.toHaveBeenCalled()
  expect(h.store.get(KV.meego.seen('301'))).toBeUndefined()
  rows = [todoRow('201'), todoRow('202'), todoRow('202'), todoRow('203')]
  await pollRound(h.ctx)
  expect(h.taken().map(trigger => [trigger.id, trigger.actor.id, trigger.meta.via, trigger.url])).toEqual([
    [key('meego-item', '202'), COLLEAGUE, 'todo', page('202', 'story')], [key('meego-item', '203'), COLLEAGUE, 'todo', page('203', 'story')]])
  h.close()
})

it('names a view link it cannot read in the health detail, and a work item the server no longer has', async () => {
  const h = meegoHost({ views: [{ url: VIEW }, { url: 'https://project.example.com/other/issueView/V2' }, { url: 'https://project.example.com/acme/foo' }] })
  h.store.set(KV.meego.baseline(`view:${VIEW}`), true)
  h.store.set(KV.meego.seen('101'), true)
  meegle(h.commands, routes(() => [attribute('101')], {
    'url decode': (args: string[]) => /other/.test(flag(args, '--url')!) ? { ...decoded, simple_name: 'other' }
      : /foo/.test(flag(args, '--url')!) ? { url_kind: 'unknown' } : decoded,
    'comment list': notFound() }))
  await pollRound(h.ctx)
  expect(h.board.all.meego).toMatchObject({ state: 'ready' })
  expect(h.board.all.meego!.detail).toContain('view outside the spaces: https://project.example.com/other/issueView/V2')
  expect(h.board.all.meego!.detail).toContain('not a view: https://project.example.com/acme/foo')
  expect(h.board.all.meego!.detail).toContain('gone from Feishu Project: 101')
  h.close()
})

it('drops the agent\'s comments, takes in only addressed ones without a live Ticket, and every one with it', async () => {
  const h = meegoHost()
  h.store.set(KV.meego.baseline(`view:${VIEW}`), true)
  for (const id of ['101', '102']) { h.store.set(KV.meego.seen(id), true); h.store.set(KV.meego.cursor(id), NOW - 60_000) }
  h.store.set(KV.meego.offset, 480)
  const bits = markerBits(key('meego-send', 'm1'))
  h.store.set(KV.meego.marker(bits), { message: 'm1' })
  h.store.set(KV.meego.written('902'), 'm0')
  h.store.tickets.save(ticket('t1'))
  subscribe(h, '102', ['t1'])
  const list = [comment('901', OWNER, `done${invisibleMarker(bits)}`), comment('902', OWNER, 'edited by the agent'),
    comment('903', COLLEAGUE, 'just chatting'), comment('904', OWNER, `${mention('Bob')} agent: 看看`), comment('905', OWNER, 'my own note')]
  const api = meegle(h.commands, routes(() => [attribute('101'), attribute('102')], { 'comment list': comments(list) }))
  await pollRound(h.ctx)
  const taken = h.taken().map(trigger => [trigger.meta.workItemId, trigger.meta.commentId, trigger.addressed ?? null, trigger.meta.owner ?? null])
  // The live Ticket's work item is read first.
  expect(taken).toEqual([['102', '903', null, null], ['102', '904', 'mention', true], ['102', '905', null, true], ['101', '904', 'mention', true]])
  // A comment found by its marker goes into the written log.
  expect(h.store.get(KV.meego.written('901'))).toBe('m1')
  // The window starts five seconds before each cursor, and the cursor moves to the round's start.
  expect(api.named('comment list').map(args => [flag(args, '--start-time'), flag(args, '--end-time')]))
    .toEqual([[String(NOW - 65_000), String(NOW)], [String(NOW - 65_000), String(NOW)]])
  expect(h.store.get(KV.meego.cursor('101'))).toBe(NOW)
  expect(h.taken()[1]!.at).toBe('2026-11-26T08:35:13.000Z')
  h.close()
})

it('reads the comments of a subscribed Thread outside the views, within the polling horizon', async () => {
  const h = meegoHost({ views: [] })
  subscribe(h, '500', ['gone'])
  const api = meegle(h.commands, { 'project search': space, 'comment list': comments([comment('909', COLLEAGUE, 'agent: again')]) })
  await pollRound(h.ctx)
  expect(api.named('comment list').map(args => flag(args, '--work-item-id'))).toEqual(['500'])
  // Without a cursor, the Thread's creation starts the window.
  expect(flag(api.named('comment list')[0]!, '--start-time')).toBe(String(Date.parse('2026-11-26T00:00:00Z') - 5000))
  expect(h.taken().map(trigger => trigger.meta.commentId)).toEqual(['909'])
  h.close()
})

it('reads the comments of a scope larger than maxItems by turns, and a live Ticket\'s every round', async () => {
  const h = meegoHost({ maxItems: 1 })
  h.store.set(KV.meego.baseline(`view:${VIEW}`), true)
  for (const id of ['101', '102', '103']) h.store.set(KV.meego.seen(id), true)
  h.store.tickets.save(ticket('t1'))
  subscribe(h, '103', ['t1'])
  const api = meegle(h.commands, routes(() => [attribute('101'), attribute('102'), attribute('103')]))
  const read = () => api.named('comment list').splice(0).map(args => flag(args, '--work-item-id'))
  await pollRound(h.ctx)
  expect(read()).toEqual(['103', '101'])
  expect(h.board.all.meego!.detail).toContain('read once in 2 rounds')
  api.calls.length = 0
  await pollRound(h.ctx)
  expect(api.named('comment list').map(args => flag(args, '--work-item-id'))).toEqual(['103', '102'])
  api.calls.length = 0
  await pollRound(h.ctx)
  expect(api.named('comment list').map(args => flag(args, '--work-item-id'))).toEqual(['103', '101'])
  h.close()
})

it('fails the round when a read fails, and still reads the other items', async () => {
  const h = meegoHost()
  h.store.set(KV.meego.baseline(`view:${VIEW}`), true)
  for (const id of ['101', '102']) h.store.set(KV.meego.seen(id), true)
  meegle(h.commands, routes(() => [attribute('101'), attribute('102')], { 'comment list': (args: string[]) =>
    flag(args, '--work-item-id') === '101' ? new Error('network down') : comments([comment('901', COLLEAGUE, 'agent: hi')]) }))
  await expect(pollRound(h.ctx)).rejects.toThrow('1 Feishu Project reads failed: 101: Error: network down')
  expect(h.taken().map(trigger => trigger.meta.commentId)).toEqual(['901'])
  expect(h.store.get(KV.meego.cursor('101'))).toBeUndefined()
  h.close()
})

it('waits for setup, pauses while off, without meegle and on a setup problem', async () => {
  const start = async (overrides: Parameters<typeof meegoHost>[1], enabled = true) => {
    const board = new HealthBoard()
    const settings = SettingsSchema.parse({ sources: { meego: { enabled, config: {} } } })
    const sources = new SourceRegistry(() => settings, board)
    const h = meegoHost({}, { sources, ...overrides })
    const disposers: (() => unknown)[] = []
    apply({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(board.all.meego?.state).not.toBe('starting'))
    const health = { ...board.all.meego }
    expect(sources.kind('meego')).toBe(meegoKind)
    for (const dispose of disposers) await dispose()
    expect(sources.kind('meego')).toBeUndefined()
    h.close()
    return health
  }
  expect(await start({ configured: () => false })).toMatchObject({ state: 'paused', code: 'setupPending' })
  expect(await start({}, false)).toMatchObject({ state: 'paused', code: 'sourceOff' })
  expect(await start({ deployment: testDeployment() })).toMatchObject({ state: 'paused', code: 'meegoCliUnset' })
  const problem = { place: 'meego' as const, code: 'meegoSignedOut' as const, values: {}, detail: 'meegle profile superagent is not signed in' }
  expect(await start({ meegoProblem: problem })).toMatchObject({ state: 'paused', detail: 'meegle profile superagent is not signed in' })
  expect(await start({ ready: Promise.reject(new Error('lock held')) })).toMatchObject({ state: 'error', detail: expect.stringContaining('lock held') })
})
