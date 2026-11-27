/** Feishu Project (Meego) polling: the work items of the watched views and the to-do list, and their new comments. */
import { liveTicket, type Thread } from '../core/index.ts'
import { MeegoError, validItems, type Commands, type Tally } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, type Health, type SourceContext } from './host.ts'
import { allComments } from './meego-channel.ts'
import { commentTrigger, description, hostWritten, itemTrigger, meegoPage, meegoThreadKey, offsetOf, ProjectSearchSchema,
  recordWritten, SOURCE, TodoPageSchema, TodoRowSchema, UrlDecodeSchema, ViewPageSchema, WorkItemAttributeSchema, WorkItemSchema,
  type MeegoItem } from './meego-trigger.ts'
import { pause, polled } from './poll.ts'

/** The configuration a poll reads; `meego.ts` defines its schema. */
export interface MeegoPollConfig {
  trigger: string; spaces: { projectKey: string }[]; views: { url: string }[]; todo: boolean
  pollSeconds: number; maxItems: number; failuresBeforeError: number
}
/** Pages a list reads at most, which bounds an answer that never says it ended. */
const MAX_PAGES = 100
/** How far before a work item's cursor its comments are read again, for comments the server listed late. */
const OVERLAP_MS = 5000

const pollFailure = (failures: number, threshold: number, error: unknown): Health | undefined =>
  failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
/** Polls every `pollSeconds` while setup resolved a signed-in `meegle` and the Source is on. */
export async function watchMeego(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the account; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('meego', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<MeegoPollConfig & Record<string, unknown>>(SOURCE)
    try {
      if (!config) ctx.report('meego', health('paused', 'sourceOff'))
      else if (ctx.problem) ctx.report('meego', { state: 'paused', detail: ctx.problem.detail })
      else if (!ctx.deployment.meego) ctx.report('meego', health('paused', 'meegoCliUnset'))
      else await pollRound(ctx, signal)
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('meego', failed)
    }
    await pause((ctx.config<MeegoPollConfig & Record<string, unknown>>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}

interface Round {
  started: number; commands: Commands; signal?: AbortSignal | undefined
  failures: string[]; notes: string[]; gone: string[]; tally: Tally; comments: number
}
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
/** Learns the server's UTC offset from an ISO time it wrote, which reads the zoneless times of its comments. */
function learnOffset(ctx: SourceContext, time: string | null | undefined): void {
  const offset = offsetOf(time)
  if (offset !== undefined && ctx.state.get(KV.meego.offset) !== offset) ctx.state.set(KV.meego.offset, offset)
}
const offsetNow = (ctx: SourceContext): number => ctx.state.get(KV.meego.offset) ?? -new Date().getTimezoneOffset()

/** The configured spaces by simple name, each read once with `project search` and kept. */
async function spaces(ctx: SourceContext, round: Round, config: MeegoPollConfig): Promise<Map<string, string>> {
  const bySimple = new Map<string, string>()
  for (const { projectKey } of config.spaces) {
    let space = ctx.state.get(KV.meego.space(projectKey))
    if (!space) {
      try {
        const answer = ProjectSearchSchema.parse(await round.commands.meegle(['project', 'search', '--project-key', projectKey]))
        const found = answer.projects?.find(project => project.project_key === projectKey)
        if (!found?.simple_name) { round.notes.push(`space ${projectKey} not found`); continue }
        space = { simpleName: found.simple_name, name: (found.name ?? '').trim() }
        ctx.state.set(KV.meego.space(projectKey), space)
      } catch (error) { round.failures.push(`space ${projectKey}: ${String(error)}`); continue }
    }
    bySimple.set(space.simpleName, projectKey)
  }
  return bySimple
}
/** Every work item of a view, all pages. */
async function viewItems(ctx: SourceContext, round: Round, projectKey: string, viewId: string, host: string): Promise<MeegoItem[]> {
  const items: MeegoItem[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const answer = ViewPageSchema.parse(await round.commands.meegle(['view', 'get', '--project-key', projectKey, '--view-id', viewId,
      '--page-num', String(page)]))
    const list = answer.work_item_list ?? []
    for (const item of validItems(WorkItemAttributeSchema, list.map(row => row.work_item_attribute), round.tally)) {
      learnOffset(ctx, item.create_time ?? item.update_time)
      const simple = item.owned_project?.simple_name ?? ''
      items.push({ projectKey: item.owned_project?.key ?? projectKey, workItemId: item.work_item_id, name: item.work_item_name,
        type: item.work_item_type.key, url: simple ? meegoPage(host, simple, item.work_item_type.key, item.work_item_id) : '',
        ...item.create_by?.key ? { creator: item.create_by.key } : {}, ...item.create_time ? { createdAt: item.create_time } : {} })
    }
    if (!answer.pagination?.has_more || !list.length) break
  }
  return items
}
/** The operator's to-do work items in the configured spaces, once each; one row of the list is a node or a subtask. */
async function todoItems(ctx: SourceContext, round: Round, simpleOf: Map<string, string>, host: string): Promise<MeegoItem[]> {
  const items = new Map<string, MeegoItem>()
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const answer = TodoPageSchema.parse(await round.commands.meegle(['mywork', 'todo', '--action', 'todo', '--todo-scope', 'all',
      '--page-num', String(page)]))
    if (!answer.list?.length) break
    for (const row of validItems(TodoRowSchema, answer.list, round.tally)) {
      const simple = simpleOf.get(row.project_key)
      const { work_item_id: id, work_item_name: name, work_item_type_key: type } = row.work_item_info
      if (!simple || items.has(id)) continue
      items.set(id, { projectKey: row.project_key, workItemId: id, name, type, url: meegoPage(host, simple, type, id) })
    }
  }
  return [...items.values()]
}
/**
 * The work items the Source watches, by target (`view:<link>`, `todo`). A link that does not decode to a view of a configured
 * space is named in the health detail; a target whose read failed is left out, so its baseline and new items wait.
 */
async function scopeTargets(ctx: SourceContext, round: Round, config: MeegoPollConfig, host: string): Promise<Map<string, MeegoItem[]>> {
  const bySimple = await spaces(ctx, round, config)
  const simpleOf = new Map([...bySimple].map(([simple, projectKey]) => [projectKey, simple]))
  const targets = new Map<string, MeegoItem[]>()
  for (const { url } of config.views) {
    if (stopped(ctx, round)) return targets
    try {
      const decoded = UrlDecodeSchema.parse(await round.commands.meegle(['url', 'decode', '--url', url]))
      const projectKey = bySimple.get(decoded.simple_name ?? '')
      if (!decoded.url_kind.startsWith('view_') || !decoded.view_id) { round.notes.push(`not a view: ${url}`); continue }
      if (!projectKey) { round.notes.push(`view outside the spaces: ${url}`); continue }
      targets.set(`view:${url}`, await viewItems(ctx, round, projectKey, decoded.view_id, host))
    } catch (error) { if (!stopped(ctx, round)) round.failures.push(`view ${url}: ${String(error)}`) }
  }
  if (config.todo && !stopped(ctx, round)) {
    try { targets.set('todo', await todoItems(ctx, round, simpleOf, host)) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`todo: ${String(error)}`) }
  }
  return targets
}
/** Names a work item's Thread, when one exists, with what its Channel and people need. */
function nameThread(ctx: SourceContext, item: MeegoItem): void {
  const thread = meegoThreadKey(item.workItemId)
  ctx.threads.patch(thread, { projectKey: item.projectKey, workItemId: item.workItemId, type: item.type, url: item.url })
  ctx.threads.describe(thread, { label: item.name, ...item.url ? { url: item.url } : {} })
}
/**
 * Takes in the work items of a target: its first look is the baseline, which marks every item seen and makes no Trigger; later,
 * an item never seen before makes an `item` Trigger unless the operator created it (they ask with a comment). A first-seen item's
 * comment cursor starts at the round, so its older comments are not read.
 */
async function intakeItems(ctx: SourceContext, round: Round, target: string, items: MeegoItem[]): Promise<void> {
  const meego = ctx.deployment.meego!
  const baseline = !ctx.state.get(KV.meego.baseline(target))
  for (const item of items) {
    if (stopped(ctx, round)) return
    if (ctx.state.get(KV.meego.seen(item.workItemId))) continue
    try {
      // An item the operator created makes no Trigger, so a view that names its creator needs no read.
      if (!baseline && item.creator !== meego.userKey) {
        const read = WorkItemSchema.parse(await round.commands.meegle(['workitem', 'get', '--project-key', item.projectKey,
          '--work-item-id', item.workItemId, '--fields', '["description"]']))
        const attribute = read.work_item_attribute
        learnOffset(ctx, attribute.create_time)
        const creator = item.creator ?? attribute.create_by?.key ?? ''
        const createdAt = item.createdAt ?? attribute.create_time ?? new Date(round.started).toISOString()
        if (creator !== meego.userKey) {
          await ctx.receive(itemTrigger({ ...item, creator, createdAt }, description(read), target === 'todo' ? 'todo' : 'view'))
        }
      }
      ctx.state.set(KV.meego.seen(item.workItemId), true)
      if (ctx.state.get(KV.meego.cursor(item.workItemId)) === undefined) ctx.state.set(KV.meego.cursor(item.workItemId), round.started)
    } catch (error) { if (!stopped(ctx, round)) counted(round, item.workItemId, error) }
  }
  if (baseline && !stopped(ctx, round)) ctx.state.set(KV.meego.baseline(target), true)
}
function counted(round: Round, workItemId: string, error: unknown): void {
  if (error instanceof MeegoError && error.reason === 'WorkItemNotFound') round.gone.push(workItemId)
  else round.failures.push(`${workItemId}: ${String(error)}`)
}
const live = (ctx: SourceContext, thread: Thread | undefined): boolean =>
  !!thread?.subscriptions.some(id => { const ticket = ctx.tickets.get(id); return !!ticket && liveTicket(ticket) })
/** A subscribed Thread's work item, from what the Source recorded on it or on its newest Trigger. */
function threadItem(ctx: SourceContext, thread: Thread): MeegoItem | undefined {
  const meta = { ...ctx.triggers.latest(thread.key)?.meta, ...thread.meta }
  const projectKey = typeof meta.projectKey === 'string' ? meta.projectKey : ''
  if (!projectKey || !/^\d+$/.test(thread.ref.id)) return undefined
  return { projectKey, workItemId: thread.ref.id, name: typeof meta.label === 'string' ? meta.label : thread.ref.id,
    type: typeof meta.type === 'string' ? meta.type : '', url: typeof meta.url === 'string' ? meta.url : ctx.triggers.latest(thread.key)?.url ?? '' }
}
/**
 * The work items whose comments a round reads: subscribed Threads with a live Ticket always; the other items in scope and
 * subscribed Threads within the polling horizon by turns, `maxItems` a round, from where the last round stopped.
 * @returns them, and how many rounds a full turn takes.
 */
function commentTargets(ctx: SourceContext, scope: Map<string, MeegoItem>, maxItems: number): { items: MeegoItem[]; rounds: number } {
  const always = new Map<string, MeegoItem>(), rest = new Map(scope)
  for (const thread of ctx.threads.subscribed(SOURCE)) {
    if (!polled(ctx, thread)) continue
    const item = scope.get(thread.ref.id) ?? threadItem(ctx, thread)
    if (!item) continue
    if (live(ctx, thread)) { always.set(item.workItemId, item); rest.delete(item.workItemId) }
    else if (!rest.has(item.workItemId)) rest.set(item.workItemId, item)
  }
  const turn = [...rest.values()].sort((a, b) => a.workItemId.localeCompare(b.workItemId))
  if (turn.length <= maxItems) { ctx.state.set(KV.meego.rotation, 0); return { items: [...always.values(), ...turn], rounds: 1 } }
  const start = (ctx.state.get(KV.meego.rotation) ?? 0) % turn.length
  const taken = Array.from({ length: maxItems }, (_, index) => turn[(start + index) % turn.length]!)
  ctx.state.set(KV.meego.rotation, (start + maxItems) % turn.length)
  return { items: [...always.values(), ...taken], rounds: Math.ceil(turn.length / maxItems) }
}
/**
 * Takes in a work item's comments since its cursor (less `OVERLAP_MS`; Trigger ids drop repeats) and moves the cursor to the
 * round's start. The host's own comments make no Trigger; on a Thread without a live Ticket, only comments that address the
 * agent do, so colleagues' talk does not wake an ended Ticket.
 */
async function intakeComments(ctx: SourceContext, round: Round, item: MeegoItem, config: MeegoPollConfig): Promise<void> {
  const meego = ctx.deployment.meego!
  const cursor = KV.meego.cursor(item.workItemId)
  const thread = ctx.threads.get(meegoThreadKey(item.workItemId))
  const since = ctx.state.get(cursor) ?? (thread ? Date.parse(thread.createdAt) : round.started)
  const window = ['--start-time', String(Math.max(0, since - OVERLAP_MS)), '--end-time', String(Date.now())]
  const comments = await allComments(round.commands, item.projectKey, item.workItemId, window, round.tally)
  const offset = offsetNow(ctx)
  const ordered = comments.sort((a, b) => a.created_at.localeCompare(b.created_at))
  for (const comment of ordered) {
    if (stopped(ctx, round)) throw new Error('The Feishu Project Source stopped during the poll')
    if (hostWritten(ctx.state, comment)) { recordWritten(ctx.state, comment); continue }
    const trigger = commentTrigger(comment, item, meego, config.trigger, offset)
    if (!trigger.addressed && !live(ctx, ctx.threads.get(meegoThreadKey(item.workItemId)))) continue
    round.comments += 1
    await ctx.receive(trigger)
  }
  ctx.state.set(cursor, round.started)
}
/**
 * One polling round: the configured spaces, the work items of the views and the to-do list with the new ones as Triggers, then
 * the new comments of the items in scope and of subscribed Threads. Each view, item and Thread fails on its own; a work item
 * the server no longer has is only named.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const config = ctx.config<MeegoPollConfig & Record<string, unknown>>(SOURCE)
  const meego = ctx.deployment.meego
  if (!config || !meego) return
  const round: Round = { started: Date.now(), commands: ctx.commands.withSignal(signal), signal, failures: [], notes: [], gone: [],
    tally: { skipped: 0 }, comments: 0 }
  const targets = await scopeTargets(ctx, round, config, meego.host)
  const scope = new Map<string, MeegoItem>()
  for (const [target, items] of targets) {
    await intakeItems(ctx, round, target, items)
    for (const item of items) if (!scope.has(item.workItemId)) scope.set(item.workItemId, item)
  }
  const { items, rounds } = commentTargets(ctx, scope, config.maxItems)
  for (const item of items) {
    if (stopped(ctx, round)) return
    const key = meegoThreadKey(item.workItemId)
    try {
      await intakeComments(ctx, round, item, config)
      ctx.threads.patch(key, { pollError: undefined })
    } catch (error) {
      if (stopped(ctx, round)) return
      counted(round, item.workItemId, error)
      ctx.threads.patch(key, { pollError: String(error) })
    }
  }
  if (stopped(ctx, round)) return
  // After the intake, so a Thread a Trigger of this round opened is named too.
  for (const item of scope.values()) nameThread(ctx, item)
  if (round.failures.length) throw new Error(`${round.failures.length} Feishu Project reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const detail = [`${scope.size} work items in scope, ${round.comments} comments taken in`,
    ...rounds > 1 ? [`comments of every work item are read once in ${rounds} rounds`] : [],
    ...round.gone.length ? [`gone from Feishu Project: ${[...new Set(round.gone)].join(', ')}`] : [],
    ...round.notes, ...round.tally.skipped ? [`${round.tally.skipped} unreadable items skipped`] : []]
  ctx.report('meego', { state: 'ready', detail: detail.join('; '), at: new Date(round.started).toISOString() })
}
