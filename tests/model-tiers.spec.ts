/** Executor model tiers: settings, the accept that names one, the worker Session it seeds, and where people see it. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { policySection } from '../src/app/prompts.ts'
import { key } from '../src/core/index.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

const UI = { name: 'ui', hint: 'UI-heavy work', model: { provider: 'anthropic', model: 'opus', reasoningEffort: 'high' } }
async function saveTiers(tiers: unknown[]) {
  const executor = h.runtime.store.settings().executor
  await h.runtime.settings.save('executor', { ...executor, tiers }, h.runtime.store.blockRevision('executor'), 'panel')
}
/** The models `sessionId`'s Session was seeded with, which its first request uses. */
const selections = (sessionId: string) => vi.mocked((h.agents.get(sessionId) as unknown as { model: { select: (value: unknown) => void } })
  .model.select).mock.calls.map(([value]) => value)
const accept = (triggerId: string, extra: Record<string, unknown> = {}) => h.route({ kind: 'accept', trigger_id: triggerId, title: 'Redo the page',
  worktree_name: 'redo-page', acknowledgement: '收到，重做页面。', ...extra })

it('rejects duplicate or malformed tier names and defaults to no tiers', () => {
  expect(ExecutorConfigSchema.parse({}).tiers).toEqual([])
  expect(() => ExecutorConfigSchema.parse({ tiers: [UI, UI] })).toThrow('Duplicate tier names')
  expect(() => ExecutorConfigSchema.parse({ tiers: [{ ...UI, name: 'UI Heavy' }] })).toThrow()
  expect(ExecutorConfigSchema.parse({ tiers: [{ name: 'ui', model: UI.model }] }).tiers).toEqual([{ name: 'ui', hint: '', model: UI.model }])
})

it('lists the tiers in the main Session\'s Policy section only when some are configured', async () => {
  expect(policySection(h.runtime.store.settings()).text).not.toContain('Executor model tiers')
  await saveTiers([UI])
  expect(policySection(h.runtime.store.settings()).text).toContain('Executor model tiers.')
  expect(policySection(h.runtime.store.settings()).text).toContain('- ui: anthropic/opus. UI-heavy work')
})

it('refuses a tier model DSH cannot resolve', async () => {
  vi.mocked(h.ctx.llm.resolveCallConfig as never as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('unknown provider nowhere'))
  await expect(saveTiers([{ ...UI, model: { provider: 'nowhere', model: 'x' } }])).rejects.toMatchObject({ code: 'modelUnavailable' })
  expect(h.runtime.store.settings().executor.tiers).toEqual([])
})

it('starts the worker of an accept that names a tier on that tier\'s model, and says so in the acknowledgement and on the ticket', async () => {
  await saveTiers([UI])
  const trigger = feishu('1', '@bot 重做这个页面，用 ui 档')
  h.runtime.receive(trigger); await h.runtime.idle()
  const result = await accept(trigger.id, { executor_tier: 'ui' })
  await h.runtime.idle()
  const ticketId = (result.ticket as { ticket_id: string }).ticket_id
  const ticket = h.runtime.store.tickets.get(ticketId)!
  expect(ticket.execution?.tier).toEqual({ name: 'ui', provider: 'anthropic', model: 'opus', reasoningEffort: 'high' })
  expect(selections(`worker-${ticketId}`)).toEqual([{ provider: 'anthropic', model: 'opus', reasoningEffort: 'high' }])
  expect(h.runtime.store.receipts.get(key('ack', trigger.id))?.text).toBe('收到，重做页面。 [ui · anthropic/opus (high)]')
  expect(result.ticket).toMatchObject({ executor_tier: 'ui · anthropic/opus (high)' })
  // A later edit of the tier leaves the ticket on the model it was accepted with.
  await saveTiers([{ ...UI, model: { provider: 'anthropic', model: 'sonnet' } }])
  expect(h.runtime.store.tickets.get(ticketId)!.execution?.tier?.model).toBe('opus')
})

it('starts the worker of an accept without a tier on the Executor model, and refuses a tier that is not configured', async () => {
  await saveTiers([UI])
  const plain = feishu('1', '@bot 修一下按钮'), unknown = feishu('2', '@bot 用 max 档修')
  h.runtime.receive(plain); h.runtime.receive(unknown); await h.runtime.idle()
  const result = await accept(plain.id)
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
  expect(ticket.execution).not.toHaveProperty('tier')
  expect(selections(`worker-${ticket.id}`)).toEqual([])
  expect(h.runtime.store.receipts.get(key('ack', plain.id))?.text).toBe('收到，重做页面。')
  await expect(accept(unknown.id, { executor_tier: 'max', worktree_name: 'max-fix' })).rejects.toThrow('executor_tier max is not configured; the tiers are ui')
})
