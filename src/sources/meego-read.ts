/** Read-only Feishu Project (Meego) work item and comment inspection for assessments. */
import type { Commands } from '../infra/commands.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { CommentPageSchema, CommentSchema, commentTime, description, hostWritten, readable, WorkItemSchema, type MeegoComment }
  from './meego-trigger.ts'
import { meegoBinding } from './meego-channel.ts'
import { KV } from '../kv.ts'
import { validItems } from '../infra/commands.ts'
import { invisibleMarkers } from './personal-identity.ts'

/** The server's UTC offset in minutes, as the polls learned it; the host's own until then. */
export const serverOffset = (): number => meegoBinding()?.state.get(KV.meego.offset) ?? -new Date().getTimezoneOffset()
/**
 * `agent` for a comment the host wrote, `owner` for the operator's own. Without the running Source's state (the plugin binds
 * it), only a comment that carries an invisible marker reads as the agent's.
 */
function whose(comment: MeegoComment, userKey: string): Pick<ContextMessage, 'agent' | 'owner'> {
  const state = meegoBinding()?.state
  const agent = state ? hostWritten(state, comment) : invisibleMarkers(comment.content ?? '').length > 0
  return agent ? { agent: true } : comment.creator === userKey ? { owner: true } : {}
}
const commentMessage = (comment: MeegoComment, userKey: string, url: string): ContextMessage =>
  ({ id: comment.comment_id, from: comment.creator, at: commentTime(comment.created_at, serverOffset()), text: readable(comment.content ?? ''),
    ...whose(comment, userKey), ...url ? { url } : {} })

async function itemMessage(commands: Commands, projectKey: string, workItemId: string, url: string): Promise<ContextMessage> {
  const item = WorkItemSchema.parse(await commands.meegle(['workitem', 'get', '--project-key', projectKey, '--work-item-id', workItemId,
    '--fields', '["description"]']))
  const attribute = item.work_item_attribute
  const creator = attribute.create_by?.key ?? ''
  return { id: 'item', from: creator, at: attribute.create_time ? new Date(Date.parse(attribute.create_time)).toISOString() : '',
    text: `${attribute.work_item_name}\n\n${readable(description(item))}`.trimEnd(),
    ...creator && creator === commands.deployment.meego?.userKey ? { owner: true } : {}, ...url ? { url } : {} }
}
/**
 * Context reader for a Meego Trigger: the work item's comments by page, the item itself (its name and description, as message
 * `item`) first on page 1. The item is the root; a comment replies to nothing `meegle` names.
 */
export const meegoThreadContext: ThreadContext<unknown> = {
  messageId: trigger => typeof trigger.meta.commentId === 'string' ? trigger.meta.commentId : 'item',
  read: async (commands, trigger, part, cursor) => {
    const projectKey = String(trigger.meta.projectKey ?? '')
    const workItemId = String(trigger.meta.workItemId ?? '')
    const url = trigger.url ?? ''
    if (part === 'parent') return { messages: [], body: { messages: [] } }
    if (part === 'root') {
      const messages = [await itemMessage(commands, projectKey, workItemId, url)]
      return { messages, body: { messages } }
    }
    const page = Math.max(1, Number(cursor ?? '1') || 1)
    const messages: ContextMessage[] = page === 1 ? [await itemMessage(commands, projectKey, workItemId, url)] : []
    const answer = CommentPageSchema.parse(await commands.meegle(['comment', 'list', '--project-key', projectKey, '--work-item-id', workItemId,
      '--page-num', String(page)]))
    const tally = { skipped: 0 }
    const userKey = commands.deployment.meego?.userKey ?? ''
    messages.push(...validItems(CommentSchema, answer.comments ?? [], tally).map(comment => commentMessage(comment, userKey, url)))
    const next = page < (answer.pagination?.total_pages ?? 1) ? String(page + 1) : undefined
    return { messages, next, body: { messages, next_resource: next ?? null, ...tally.skipped ? { skipped: tally.skipped } : {} } }
  },
}
