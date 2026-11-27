/** Feishu Project (Meego) outbound channel: posts signed comments on work items under the operator's account, once each. */
import { key, type OutboundMessage } from '../core/index.ts'
import { MeegoError, validItems, type Commands, type Tally } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'
import { CommentPageSchema, CommentSchema, MEEGO_PREFIX, recordWritten, WorkItemSchema, type MeegoComment, type MeegoState } from './meego-trigger.ts'
import { chinese, invisibleMarker, invisibleMarkers, markerBits } from './personal-identity.ts'

/** What the channel and the context reader need of the running Source beyond `commands`. */
export type MeegoBinding = Pick<SourceContext, 'config'> & { state: MeegoState }
let bound: MeegoBinding | undefined
/**
 * Lends the running Source's state to its channel and context reader, which the registry calls with `commands` only; the
 * plugin binds it while its kind is registered, so a send never runs without it. Returns the unbinder.
 */
export function bindMeego(binding: MeegoBinding): () => void {
  bound = binding
  return () => { if (bound === binding) bound = undefined }
}
/** The bound Source, or undefined outside a running plugin. */
export const meegoBinding = (): MeegoBinding | undefined => bound

/** Every comment of a work item, all pages; `window` is `--start-time`/`--end-time`, and `tally` counts unreadable comments. */
export async function allComments(commands: Commands, projectKey: string, workItemId: string, window: string[] = [], tally?: Tally): Promise<MeegoComment[]> {
  const comments: MeegoComment[] = []
  for (let page = 1; ; page += 1) {
    const answer = CommentPageSchema.parse(await commands.meegle(['comment', 'list', '--project-key', projectKey, '--work-item-id', workItemId,
      ...window, '--page-num', String(page)]))
    comments.push(...validItems(CommentSchema, answer.comments ?? [], tally))
    // A page beyond the last, or an answer without pages, ends the list; 200 pages (4000 comments) bound a runaway answer.
    if (page >= (answer.pagination?.total_pages ?? 1) || !answer.comments?.length || page >= 200) return comments
  }
}
/** `text` in bold red on yellow, as Feishu Project stores the two colours: one span inside the other. */
const highlight = (text: string): string =>
  `<span style="background-color: rgb(255, 236, 179)"><span style="color: rgb(245, 74, 69)">**${text}**</span></span>`
/**
 * The visible line under every comment the host writes: who wrote it on whose behalf, and how to address the agent rather
 * than the person. It names the person without `@`, so quoting it mentions nobody.
 */
export const meegoSignature = (name: string, trigger: string, text: string): string => chinese(text)
  ? `—— 由 DSH superagent 代 ${name} 发出。👉 找 agent 请在评论开头写 ${highlight(`${trigger}:`)}`
  : `— Posted by DSH superagent on behalf of ${name}. 👉 To address the agent, start a comment with ${highlight(`${trigger}:`)}`
/** A mention of a person as Feishu Project writes it, which notifies them; `larkUserId` is their lark_user_id. */
export const meegoMention = (name: string, larkUserId: string): string =>
  `@${name}<!-- mention:${JSON.stringify({ id: `lark_user_id_${larkUserId}`, cn_name: name, blockType: 'AT_USER_BLOCK' })} -->`
/**
 * The content the host posts: the prefix, an optional mention, the text, a blank line, the signature and the invisible marker
 * of `bits`.
 */
export const signedComment = (text: string, name: string, trigger: string, bits: string, mention = ''): string =>
  `${MEEGO_PREFIX} ${mention ? `${mention} ` : ''}${text.trimEnd()}\n\n${meegoSignature(name, trigger, text)}${invisibleMarker(bits)}`
/**
 * Whether a comment of `kind` mentions the operator, under the Source's `notify`: the agent writes with their account, which
 * notifies nobody, so a mention is how they learn of it. `replies` leaves out the acknowledgement of a request they just wrote.
 */
export const mentionsOperator = (notify: 'replies' | 'all' | 'none', kind: OutboundMessage['kind']): boolean =>
  notify === 'all' || (notify === 'replies' && kind !== 'acknowledgement')

/**
 * Adds the operator to a work item's watchers unless they are there. `workitem update` replaces the whole list, so the current
 * watchers are read first and kept.
 * @throws when `meegle` failed.
 */
export async function watchItem(commands: Commands, projectKey: string, workItemId: string, userKey: string): Promise<void> {
  const item = WorkItemSchema.parse(await commands.meegle(['workitem', 'get', '--project-key', projectKey, '--work-item-id', workItemId]))
  const value = item.work_item_fields?.find(field => field.key === 'watchers')?.value
  const watchers = Array.isArray(value) ? value.flatMap(user => typeof user === 'object' && user && 'key' in user && typeof user.key === 'string' ? [user.key] : []) : []
  if (watchers.includes(userKey)) return
  await commands.meegle(['workitem', 'update', '--project-key', projectKey, '--work-item-id', workItemId,
    '--fields', JSON.stringify([{ field_key: 'watchers', field_value: JSON.stringify([...watchers, userKey]) }])])
}
/**
 * Posts a comment once per message id. The host stores the marker before writing, so a retry finds a comment an earlier attempt
 * posted (`comment add` returns no id and takes no idempotency key); once found, the comment id goes into the written log, which
 * tells the agent's comments apart from the operator's. `gone` when the work item no longer exists.
 * @throws while the Source is not running, or when `meegle` failed.
 */
export async function sendMeego(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const binding = bound
  if (!binding) throw new Error('The Feishu Project Source is not running')
  const { state } = binding
  const { commands } = host
  const meego = commands.deployment.meego
  if (!meego) throw new Error('The Feishu Project Source has no signed-in meegle')
  const { projectKey = '', workItemId = '' } = message.channel.address
  if (!/^[A-Za-z0-9_-]+$/.test(projectKey) || !/^\d+$/.test(workItemId)) throw new Error('Missing Feishu Project reply target')
  const bits = markerBits(key('meego-send', message.id))
  const stored = state.get(KV.meego.marker(bits))
  if (stored?.comment) return 'sent'
  if (!stored) state.set(KV.meego.marker(bits), { message: message.id })
  const find = async (): Promise<boolean> => {
    const found = (await allComments(commands, projectKey, workItemId)).find(comment => invisibleMarkers(comment.content ?? '').includes(bits))
    if (found) recordWritten(state, found, bits)
    return !!found
  }
  try {
    if (await find()) return 'sent'
    const config = binding.config<{ trigger: string; notify?: 'replies' | 'all' | 'none'; watch?: boolean }>('meego')
    const mention = meego.larkUserId && mentionsOperator(config?.notify ?? 'replies', message.kind) ? meegoMention(meego.name, meego.larkUserId) : ''
    await commands.meegle(['comment', 'add', '--project-key', projectKey, '--work-item-id', workItemId,
      '--content', signedComment(message.text, meego.name, config?.trigger ?? 'agent', bits, mention)])
    // A comment the list does not show yet is recorded when a poll finds its marker.
    await find().catch(() => false)
    // Watching is a courtesy to the operator: a failure leaves the comment sent and is tried again with the next one.
    if (config?.watch ?? true) await watchItem(commands, projectKey, workItemId, meego.userKey).catch(() => undefined)
    return 'sent'
  } catch (error) {
    if (error instanceof MeegoError && error.reason === 'WorkItemNotFound') return 'gone'
    throw error
  }
}
/** The work item's page, which the address carries. */
export const meegoLink = (address: Record<string, string>): ChannelLink =>
  ({ url: address.url ?? '', label: { zh: '飞书项目工作项', en: 'Feishu Project work item' } })
