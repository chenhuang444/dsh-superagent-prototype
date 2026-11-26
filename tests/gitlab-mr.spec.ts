import { AGENT } from './fixtures/gitlab-identity.ts'
import { expect, it } from 'vitest'
import { feishuTrigger } from '../src/sources/feishu.ts'
import { claimMr, mrEndNotices, mrOf, MrSchema, observeMr, type Mr } from '../src/sources/gitlab-mr.ts'
import { itemTrigger } from '../src/sources/gitlab-trigger.ts'
import { agentMr, execution, gitlabHost, mr, ticket, WEB } from './fixtures/gitlab.ts'

const parsed = (value: unknown): Mr => MrSchema.parse(value)
const ended = (iid: number, at: string, merged = true) => parsed(agentMr(iid, 'agent/x', merged ? { state: 'merged', merged_at: at } : { state: 'closed', closed_at: at }))

it('lets a ticket follow its source MR or the agent\'s MR of the project from its branch, and refuses others', () => {
  const h = gitlabHost()
  const source = itemTrigger(parsed(mr(30)), true, AGENT)
  h.store.triggers.save(source)
  h.store.tickets.save(ticket('t1', { execution: execution('fix-1'), origin: { triggerId: source.id, triggerIds: [source.id] } }))
  h.store.tickets.save(ticket('t2', { execution: execution('other-2'), follows: [{ thread: 'gitlab:mr:41', own: true }] }))
  expect(claimMr(h.ctx, 't1', parsed(agentMr(40, 'agent/fix-1', { source_project_id: 99 })))).toContain('MR does not belong to this ticket')
  expect(claimMr(h.ctx, 't1', parsed(mr(31, { source_branch: 'agent/fix-1' })))).toContain('MR does not belong to this ticket')
  // An Issue with the source MR's iid is no MR.
  h.store.tickets.save(ticket('t3', { origin: { triggerId: 'x', triggerIds: [] } }))
  expect(claimMr(h.ctx, 't3', parsed(mr(30)))).toContain('omit mr_number')
  expect(claimMr(h.ctx, 't1', parsed(agentMr(41, 'agent/fix-1')))).toBe('MR already belongs to another active ticket')
  // An MR that is not open is not bound, and that is no refusal.
  expect(claimMr(h.ctx, 't1', parsed(agentMr(42, 'agent/fix-1', { state: 'merged' })))).toBeUndefined()
  expect(mrOf(h.store.tickets.get('t1')!)).toBeUndefined()
  expect(claimMr(h.ctx, 't1', parsed(mr(30)))).toBeUndefined()
  expect(claimMr(h.ctx, 't1', parsed(agentMr(43, 'agent/fix-1')))).toBeUndefined()
  expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'gitlab:mr:30', own: false }, { thread: 'gitlab:mr:43', own: true }])
  expect(mrOf(h.store.tickets.get('t1')!)).toBe(43)
  expect(h.store.threads.get('gitlab:mr:43')).toMatchObject({ subscriptions: ['t1'], meta: { iid: 43, isMr: true, mrAuthor: 'agent-bot' } })
  h.store.close()
})

it('binds the agent\'s open MR to the unique live ticket on its branch, notes auto-merge, and ends the ticket when it merges', async () => {
  const h = gitlabHost()
  const request = feishuTrigger({ message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', sender_id: 'ou_alice', sender_type: 'user',
    content: '@bot 修一下标题', create_time: '1', mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
  h.store.triggers.save(request)
  h.store.tickets.save(ticket('t1', { execution: execution('one'), origin: { triggerId: request.id, triggerIds: [request.id] },
    channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } },
      { source: 'gitlab', thread: 'gitlab:issue:3', address: { kind: 'issue', iid: '3' } }] }))
  expect(await observeMr(h.ctx, parsed(agentMr(9, 'agent/one', { merge_when_pipeline_succeeds: true })))).toBe(false)
  expect(mrOf(h.store.tickets.get('t1')!)).toBe(9)
  expect(h.store.threads.get('gitlab:mr:9')!.meta.facts).toMatchObject({ autoMerge: { value: { en: 'on' } } })
  // A ticket that follows an MR moves to another only by its Executor's report.
  await observeMr(h.ctx, parsed(agentMr(10, 'agent/one')))
  expect(mrOf(h.store.tickets.get('t1')!)).toBe(9)
  expect(await observeMr(h.ctx, ended(9, '2026-09-02T00:00:00Z'))).toBe(true)
  expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged', at: '2026-09-02T00:00:00.000Z' } })
  expect(h.store.threads.get('gitlab:mr:9')!.meta.facts).not.toHaveProperty('autoMerge')
  const deployment = h.deployment
  // The notice goes to the other conversations, in the request's language; GitLab shows the merge itself.
  const notices = mrEndNotices(h.store.tickets.get('t1')!, request.text, deployment)
  expect(notices).toEqual([expect.objectContaining({ kind: 'notice', channel: expect.objectContaining({ source: 'feishu' }),
    text: `[MR !9](${WEB}/-/merge_requests/9) 已合并。` })])
  expect(mrEndNotices(h.store.tickets.get('t1')!, request.text, deployment).map(notice => notice.id)).toEqual(notices.map(notice => notice.id))
  h.store.close()
})

it('keeps a ticket on its other open MR when one closes, and writes an English notice for a request without Han characters', async () => {
  const h = gitlabHost()
  h.store.tickets.save(ticket('t3', { execution: execution('fix-3'), channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1' } }] }))
  expect(claimMr(h.ctx, 't3', parsed(agentMr(21, 'agent/fix-3')))).toBeUndefined()
  expect(claimMr(h.ctx, 't3', parsed(agentMr(22, 'agent/fix-3')))).toBeUndefined()
  expect(await observeMr(h.ctx, ended(22, '2026-09-02T00:00:00Z', false))).toBe(true)
  expect(h.store.tickets.get('t3')).not.toHaveProperty('ended')
  expect(mrOf(h.store.tickets.get('t3')!)).toBe(21)
  expect(h.executor.stop).not.toHaveBeenCalled()
  expect(await observeMr(h.ctx, ended(21, '2026-09-03T00:00:00Z', false))).toBe(true)
  expect(h.store.tickets.get('t3')).toMatchObject({ ended: { outcome: 'closed' } })
  expect(mrEndNotices(h.store.tickets.get('t3')!, 'fix the title', h.deployment))
    .toEqual([expect.objectContaining({ text: `[MR !21](${WEB}/-/merge_requests/21) was closed without merging.` })])
  // An MR's end is kept on the tickets that follow it, so binding and closing write no key-value record.
  expect(h.store.keys('gitlab-')).toEqual([])
  expect(mrEndNotices(h.store.tickets.get('t3')!, 'x', { repository: 'acme/widgets' })).toEqual([])
  h.store.close()
})

it('follows an MR it opened again when it reopens', async () => {
  const h = gitlabHost()
  h.store.tickets.save(ticket('t5', { execution: execution('fix-5'),
    follows: [{ thread: 'gitlab:mr:21', own: true }, { thread: 'gitlab:mr:22', own: true, closed: { at: '2026-09-02T00:00:00.000Z', outcome: 'closed' } }] }))
  await observeMr(h.ctx, parsed(agentMr(22, 'agent/fix-5')))
  expect(h.store.tickets.get('t5')!.follows).toEqual([{ thread: 'gitlab:mr:21', own: true }, { thread: 'gitlab:mr:22', own: true }])
  h.store.close()
})
