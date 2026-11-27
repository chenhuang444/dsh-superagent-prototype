import { describe, expect, it } from 'vitest'
import { key } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { meegoKind, type MeegoConfig } from '../src/sources/meego.ts'
import { addressesAgent, commentTime, commentTrigger, hostWritten, itemTrigger, mentionTokens, offsetOf, readable, recordWritten,
  type MeegoItem, type MeegoState } from '../src/sources/meego-trigger.ts'
import { invisibleMarker, invisibleMarkers, markerBits, withoutMarkers } from '../src/sources/personal-identity.ts'
import { comment, COLLEAGUE, mention, OWNER, page } from './fixtures/meego.ts'

const item: MeegoItem = { projectKey: 'p1', workItemId: '123', name: 'Login fails', type: 'issue', url: page('123') }
const memory = (): MeegoState & { map: Map<string, unknown> } => {
  const map = new Map<string, unknown>()
  return { map, get: <V>(name: string) => map.get(name) as V | undefined, set: (name, value) => { if (value === undefined) map.delete(name); else map.set(name, value) } }
}
const config = (fields: Partial<MeegoConfig> = {}): MeegoConfig => meegoKind.schema.parse({ spaces: [{ projectKey: 'p1' }], ...fields })

describe('mentions and the trigger word', () => {
  it('reads a line that starts with the trigger word after mentions, a reply\'s 回复@ and names with spaces and brackets', () => {
    expect(addressesAgent('agent: 看看', 'agent')).toBe(true)
    expect(addressesAgent(`${mention('Ada Lovelace（AL）')} agent：看看`, 'agent')).toBe(true)
    expect(addressesAgent(`回复${mention('Bob')}：agent: 拆任务`, 'agent')).toBe(true)
    expect(addressesAgent(`${mention('Bob')}${mention('Carol')} AGENT: hi`, 'agent')).toBe(true)
    expect(mentionTokens(`回复${mention('Bob')}x`)).toBe('@m x')
  })
  it('does not read the word mid-line, in quotes or code, or after plain text', () => {
    expect(addressesAgent('please agent: look', 'agent')).toBe(false)
    expect(addressesAgent('> agent: quoted\n\n```\nagent: code\n```', 'agent')).toBe(false)
    expect(addressesAgent(`${mention('Ada')} can you look`, 'agent')).toBe(false)
    expect(addressesAgent('agent: hi', '')).toBe(false)
  })
  it('shows mentions as @name without markers', () => {
    expect(readable(`回复${mention('Bob')} ok${invisibleMarker('01'.repeat(32))}`)).toBe('回复@Bob ok')
  })
})

describe('invisible markers', () => {
  it('round-trips bits through zero-width characters a person does not see', () => {
    const bits = markerBits(key('meego-send', 'm1'))
    expect(bits).toHaveLength(64)
    const text = `done\n\n— signed${invisibleMarker(bits)}`
    expect(invisibleMarkers(text)).toEqual([bits])
    expect(withoutMarkers(text)).toBe('done\n\n— signed')
    expect(() => markerBits('abc')).toThrow()
  })
  it('tells host-written comments by the written log or a stored marker, and records one found by its marker', () => {
    const state = memory()
    const bits = markerBits(key('meego-send', 'm1'))
    const marked = comment('77', OWNER, `hi${invisibleMarker(bits)}`)
    expect(hostWritten(state, marked)).toBe(false)
    state.set(KV.meego.marker(bits), { message: 'm1' })
    expect(hostWritten(state, marked)).toBe(true)
    recordWritten(state, marked)
    expect(state.get(KV.meego.written('77'))).toBe('m1')
    expect(state.get(KV.meego.marker(bits))).toEqual({ message: 'm1', comment: '77' })
    // The id alone names it once recorded, so an edit that strips the marker changes nothing.
    expect(hostWritten(state, comment('77', OWNER, 'edited'))).toBe(true)
    // A person who copies a marker the host never stored writes their own comment.
    expect(hostWritten(state, comment('78', OWNER, `copy${invisibleMarker('1'.repeat(64))}`))).toBe(false)
  })
})

describe('times', () => {
  it('reads a zoneless created_at in the server\'s zone, learned from an ISO time', () => {
    expect(offsetOf('2026-11-25T17:26:41+08:00')).toBe(480)
    expect(offsetOf('2026-11-25T17:26:41-05:30')).toBe(-330)
    expect(offsetOf('2026-11-26 16:35:13')).toBeUndefined()
    expect(commentTime('2026-11-26 16:35:13', 480)).toBe('2026-11-26T08:35:13.000Z')
    expect(commentTime('2026-11-26 16:35:13', -60)).toBe('2026-11-26T17:35:13.000Z')
  })
})

describe('Triggers', () => {
  it('makes an item Trigger once per work item, never addressed, from its creator', () => {
    const trigger = itemTrigger({ ...item, creator: COLLEAGUE, createdAt: '2026-11-25T17:26:41+08:00' }, 'agent: details', 'view')
    expect(trigger).toMatchObject({ id: key('meego-item', '123'), source: 'meego', threads: [{ source: 'meego', id: '123' }],
      actor: { source: 'meego', id: COLLEAGUE }, human: true, at: '2026-11-25T09:26:41.000Z', text: 'Login fails\n\nagent: details',
      channel: { source: 'meego', thread: 'meego:123', address: { projectKey: 'p1', workItemId: '123', url: page('123') } },
      meta: { kind: 'item', projectKey: 'p1', workItemId: '123', type: 'issue', via: 'view' } })
    expect(trigger.addressed).toBeUndefined()
  })
  it('makes a comment Trigger, addressed when it summons, with owner on the operator\'s own', () => {
    const own = commentTrigger(comment('9', OWNER, `${mention('Bob')} agent: 看看`), item, { userKey: OWNER }, 'agent', 480)
    expect(own).toMatchObject({ id: key('meego-comment', '123', '9'), addressed: 'mention', text: '@Bob agent: 看看', at: '2026-11-26T08:35:13.000Z',
      meta: { kind: 'comment', projectKey: 'p1', workItemId: '123', commentId: '9', owner: true } })
    const other = commentTrigger(comment('10', COLLEAGUE, 'looks fine'), item, { userKey: OWNER }, 'agent', 480)
    expect(other.addressed).toBeUndefined()
    expect(other.meta).not.toHaveProperty('owner')
    expect(other.human).toBe(true)
  })
})

describe('the kind', () => {
  it('listens only to the configured spaces, observing new items, with a row per Trigger kind', () => {
    expect(meegoKind.scope!({ meta: { kind: 'item', projectKey: 'p1' } }, config())).toEqual({ listened: true, observed: true, row: 'items' })
    expect(meegoKind.scope!({ meta: { kind: 'comment', projectKey: 'p1' } }, config())).toEqual({ listened: true, observed: false, row: 'comments' })
    expect(meegoKind.scope!({ meta: { kind: 'comment', projectKey: 'p2' } }, config())).toEqual({ listened: false, reason: 'space_not_listened' })
  })
  it('has admission rows for new work items and comments', () => {
    expect(meegoKind.policy!.rows!({}).map(row => [row.id, row.cells])).toEqual([
      ['items', { listedUnaddressed: true, unlistedAddressed: false, unlistedUnaddressed: true }],
      ['comments', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }]])
    expect(meegoKind.policy!.schema.parse({ allowed: [{ id: OWNER, name: 'Ada' }] })).toEqual({ allowed: [{ id: OWNER, name: 'Ada' }] })
    expect(() => meegoKind.policy!.schema.parse({ allowed: [{ id: 'ou_x' }] })).toThrow()
  })
  it('names a work item\'s Thread from its page on any host', () => {
    expect(meegoKind.find!(`see ${page('7001', 'story')}`)).toEqual({ threads: ['meego:7001'], terms: [] })
    expect(meegoKind.find!('https://other.example.com/x/issue/detail/42?tab=1')).toEqual({ threads: ['meego:42'], terms: [] })
    expect(meegoKind.find!('#12')).toEqual({ threads: [], terms: [] })
  })
  it('validates its configuration: unique spaces and views, bounded tunables', () => {
    expect(config()).toMatchObject({ cli: '', profile: 'superagent', trigger: 'agent', views: [], todo: false, notify: 'replies', pollSeconds: 60, maxItems: 40, failuresBeforeError: 3 })
    expect(() => config({ spaces: [{ projectKey: 'p1' }, { projectKey: 'p1' }] })).toThrow()
    expect(() => config({ views: [{ url: 'not a link' }] })).toThrow()
    expect(() => config({ maxItems: 0 })).toThrow()
    expect(() => meegoKind.schema.parse({ extra: 1 })).toThrow()
  })
  it('sets the work item link and the trigger word for a ticket\'s Executor', () => {
    const trigger = itemTrigger({ ...item, creator: COLLEAGUE, createdAt: '2026-11-25T17:26:41+08:00' }, '', 'todo')
    const values = meegoKind.environment!.values
    expect(values({ deployment: {} as never, config: config({ trigger: 'bot' }), trigger }))
      .toEqual({ DSH_SUPERAGENT_MEEGO_ITEM: page('123'), DSH_SUPERAGENT_MEEGO_TRIGGER: 'bot' })
    expect(values({ deployment: {} as never, config: config() })).toEqual({ DSH_SUPERAGENT_MEEGO_ITEM: '', DSH_SUPERAGENT_MEEGO_TRIGGER: 'agent' })
  })
})
