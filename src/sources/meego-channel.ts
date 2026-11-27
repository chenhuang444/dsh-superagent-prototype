/** Feishu Project (Meego) outbound channel: posts signed comments on work items under the operator's account, once each. */
import { key, type OutboundMessage } from '../core/index.ts'
import { MeegoError, validItems, type Commands, type Tally } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'
import { CommentPageSchema, CommentSchema, recordWritten, type MeegoComment, type MeegoState } from './meego-trigger.ts'
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
/**
 * The visible line under every comment the host writes: who wrote it on whose behalf, and how to address the agent rather
 * than the person. It names the person without `@`, so quoting it mentions nobody.
 */
export const meegoSignature = (name: string, trigger: string, text: string): string => chinese(text)
  ? `—— 由 DSH superagent 代 ${name} 发出。找 agent 请在评论开头写 ${trigger}:`
  : `— Posted by DSH superagent on behalf of ${name}. To address the agent, start a comment with ${trigger}:`
/** The content the host posts: the text, a blank line, the signature and the invisible marker of `bits`. */
export const signedComment = (text: string, name: string, trigger: string, bits: string): string =>
  `${text.trimEnd()}\n\n${meegoSignature(name, trigger, text)}${invisibleMarker(bits)}`

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
    const trigger = binding.config<{ trigger: string }>('meego')?.trigger ?? 'agent'
    await commands.meegle(['comment', 'add', '--project-key', projectKey, '--work-item-id', workItemId,
      '--content', signedComment(message.text, meego.name, trigger, bits)])
    // A comment the list does not show yet is recorded when a poll finds its marker.
    await find().catch(() => false)
    return 'sent'
  } catch (error) {
    if (error instanceof MeegoError && error.reason === 'WorkItemNotFound') return 'gone'
    throw error
  }
}
/** The work item's page, which the address carries. */
export const meegoLink = (address: Record<string, string>): ChannelLink =>
  ({ url: address.url ?? '', label: { zh: '飞书项目工作项', en: 'Feishu Project work item' } })
