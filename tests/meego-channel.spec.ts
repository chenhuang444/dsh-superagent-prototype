import { afterEach, expect, it, vi } from 'vitest'
import { key, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { meegoLink, meegoMention, meegoSignature, sendMeego } from '../src/sources/meego-channel.ts'
import { meegoThreadContext } from '../src/sources/meego-read.ts'
import { meegoKind } from '../src/sources/meego.ts'
import { commentTrigger, itemTrigger, MEEGO_PREFIX, meegoChannel, readable } from '../src/sources/meego-trigger.ts'
import { invisibleMarker, markerBits } from '../src/sources/personal-identity.ts'
import { COLLEAGUE, comment, comments, flag, meegle, meegoHost, mention, notFound, OWNER, page, workItem } from './fixtures/meego.ts'

afterEach(() => { vi.restoreAllMocks() })
const address = { projectKey: 'p1', workItemId: '123', url: page('123') }
const message = (id: string, text = '已看过，是缓存问题。', kind: OutboundMessage['kind'] = 'reply'): OutboundMessage =>
  ({ id, channel: meegoChannel(address), text, kind })
const HIGHLIGHT = (text: string) => `<span style="background-color: rgb(255, 236, 179)"><span style="color: rgb(245, 74, 69)">**${text}**</span></span>`
const ADA = '@Ada<!-- mention:{"id":"lark_user_id_lark_ada","cn_name":"Ada","blockType":"AT_USER_BLOCK"} -->'

it('posts a signed comment with its marker once, and finds it again on a retry', async () => {
  const h = meegoHost({ trigger: 'bot' })
  const posted: string[] = []
  const api = meegle(h.commands, {
    'comment list': () => comments(posted.map((content, index) => comment(String(800 + index), OWNER, content))),
    'comment add': (args: string[]) => { posted.push(flag(args, '--content')!); return { action: 'create', success: true } },
  })
  expect(await sendMeego(h, message('m1'))).toBe('sent')
  const bits = markerBits(key('meego-send', 'm1'))
  expect(posted).toEqual([`${MEEGO_PREFIX} ${ADA} 已看过，是缓存问题。\n\n—— 由 DSH superagent 代 Ada 发出。👉 找 agent 请在评论开头写 ${HIGHLIGHT('bot:')}${invisibleMarker(bits)}`])
  expect(h.store.get(KV.meego.marker(bits))).toEqual({ message: 'm1', comment: '800' })
  expect(h.store.get(KV.meego.written('800'))).toBe('m1')
  // A retry after the comment went out writes nothing.
  expect(await sendMeego(h, message('m1'))).toBe('sent')
  expect(api.named('comment add')).toHaveLength(1)
  // A retry after a crash between the write and the read-back finds the comment by its marker.
  h.store.set(KV.meego.marker(bits), { message: 'm1' })
  h.ctx.state.set(KV.meego.written('800'), undefined)
  expect(await sendMeego(h, message('m1'))).toBe('sent')
  expect(api.named('comment add')).toHaveLength(1)
  expect(h.store.get(KV.meego.written('800'))).toBe('m1')
  h.close()
})

it('mentions the operator, who is not notified of their own account\'s comments, as the notify setting says', async () => {
  expect(meegoMention('Ada', 'lark_ada')).toBe(ADA)
  const posted = async (notify: string | undefined, kind: OutboundMessage['kind'], id: string) => {
    const h = meegoHost(notify ? { notify } : {})
    let content = ''
    meegle(h.commands, { 'comment list': comments([]), 'comment add': (args: string[]) => { content = flag(args, '--content')!; return { success: true } } })
    await sendMeego(h, message(id, '收到', kind))
    h.close()
    return content.startsWith(`${MEEGO_PREFIX} ${ADA} 收到`)
  }
  expect(await posted(undefined, 'reply', 'n1')).toBe(true)
  expect(await posted(undefined, 'notice', 'n2')).toBe(true)
  expect(await posted(undefined, 'acknowledgement', 'n3')).toBe(false)
  expect(await posted('all', 'acknowledgement', 'n4')).toBe(true)
  expect(await posted('none', 'reply', 'n5')).toBe(false)
})

it('adds the operator to the watchers after a comment, keeping the others, unless they watch or the switch is off', async () => {
  const watched = async (watchers: string[], config: Record<string, unknown> = {}, get: unknown = undefined) => {
    const h = meegoHost(config)
    const api = meegle(h.commands, { 'comment list': comments([]), 'comment add': { success: true },
      'workitem get': get ?? { ...workItem('123'), work_item_fields: [{ key: 'watchers', value: watchers.map(key => ({ key, name: key })) }] },
      'workitem update': { mcp_result: '' } })
    expect(await sendMeego(h, message('w1'))).toBe('sent')
    h.close()
    return api.named('workitem update').map(args => JSON.parse(flag(args, '--fields')!))
  }
  expect(await watched([COLLEAGUE])).toEqual([[{ field_key: 'watchers', field_value: JSON.stringify([COLLEAGUE, OWNER]) }]])
  expect(await watched([])).toEqual([[{ field_key: 'watchers', field_value: JSON.stringify([OWNER]) }]])
  expect(await watched([COLLEAGUE, OWNER])).toEqual([])
  expect(await watched([], { watch: false })).toEqual([])
  // A failure to read the work item leaves the comment sent.
  expect(await watched([], {}, new Error('busy'))).toEqual([])
})

it('starts with [superagent] in bold, a colour per character, which reads back as plain text', () => {
  expect(MEEGO_PREFIX.startsWith('<span style="color: rgb(245, 74, 69)">**[**</span><span style="color: rgb(255, 125, 0)">**s**</span>')).toBe(true)
  expect(MEEGO_PREFIX.match(/<span /g)).toHaveLength(12)
  expect(readable(`${MEEGO_PREFIX} ${ADA} 修好了\n\n写 ${HIGHLIGHT('agent:')}`)).toBe('[superagent] @Ada 修好了\n\n写 **agent:**')
})

it('signs in the language of the text, without mentioning the person', () => {
  expect(meegoSignature('Ada', 'agent', 'Fixed in the latest build.'))
    .toBe(`— Posted by DSH superagent on behalf of Ada. 👉 To address the agent, start a comment with ${HIGHLIGHT('agent:')}`)
  expect(meegoSignature('Ada', 'agent', '修好了')).not.toContain('@')
})

it('answers gone for a work item the server no longer has, and throws on other failures or outside a running Source', async () => {
  const h = meegoHost()
  meegle(h.commands, { 'comment list': notFound() })
  expect(await sendMeego(h, message('m2'))).toBe('gone')
  vi.restoreAllMocks()
  meegle(h.commands, { 'comment list': comments([]), 'comment add': new Error('busy') })
  await expect(sendMeego(h, message('m3'))).rejects.toThrow('busy')
  await expect(sendMeego(h, { ...message('m4'), channel: { ...meegoChannel(address), address: { projectKey: 'p1' } } })).rejects.toThrow('reply target')
  h.close()
  await expect(sendMeego(h, message('m5'))).rejects.toThrow('not running')
})

it('links to the work item', () => {
  expect(meegoLink(address)).toEqual({ url: page('123'), label: { zh: '飞书项目工作项', en: 'Feishu Project work item' } })
  expect(meegoKind.channel!.link({}, {}).url).toBe('')
})

it('reads the work item and its comments by page, marking the agent\'s and the operator\'s own', async () => {
  const h = meegoHost()
  h.store.set(KV.meego.offset, 480)
  const bits = markerBits(key('meego-send', 'm1'))
  h.store.set(KV.meego.marker(bits), { message: 'm1' })
  meegle(h.commands, {
    'workitem get': workItem('123', `see ${mention('Ada')}`),
    'comment list': (args: string[]) => flag(args, '--page-num') === '1'
      ? comments([comment('901', OWNER, `done${invisibleMarker(bits)}`), comment('902', OWNER, 'agent: look'), comment('903', COLLEAGUE, 'hm')], 2)
      : comments([comment('904', COLLEAGUE, 'later')], 2, 2),
  })
  const trigger: Trigger = commentTrigger(comment('902', OWNER, 'agent: look'), { ...address, name: 'Bug', type: 'issue' }, { userKey: OWNER }, 'agent', 480)
  expect(meegoThreadContext.messageId(trigger)).toBe('902')
  const first = await meegoThreadContext.read(h.commands, trigger, 'thread', undefined, {})
  expect(first.messages.map(item => [item.id, item.from, item.text, item.agent ?? null, item.owner ?? null])).toEqual([
    ['item', COLLEAGUE, 'Bug 123\n\nsee @Ada', null, null], ['901', OWNER, 'done', true, null], ['902', OWNER, 'agent: look', null, true],
    ['903', COLLEAGUE, 'hm', null, null]])
  expect(first.messages[1]!.at).toBe('2026-11-26T08:35:13.000Z')
  expect(first.next).toBe('2')
  const second = await meegoThreadContext.read(h.commands, trigger, 'thread', '2', {})
  expect(second.messages.map(item => item.id)).toEqual(['904'])
  expect(second.next).toBeUndefined()
  expect((await meegoThreadContext.read(h.commands, trigger, 'root', undefined, {})).messages.map(item => item.id)).toEqual(['item'])
  expect((await meegoThreadContext.read(h.commands, trigger, 'parent', undefined, {})).messages).toEqual([])
  const item = itemTrigger({ ...address, name: 'Bug', type: 'issue', creator: COLLEAGUE, createdAt: '2026-11-25T17:26:41+08:00' }, '', 'view')
  expect(meegoThreadContext.messageId(item)).toBe('item')
  h.close()
})
