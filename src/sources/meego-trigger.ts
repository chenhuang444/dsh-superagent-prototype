/** Normalizes Feishu Project (Meego) work items and comments, as `meegle` answers them, into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import type { MeegoCli } from '../deployment.ts'
import type { Key } from '../kv.ts'
import { KV } from '../kv.ts'
import { invisibleMarkers, summons, withoutMarkers } from './personal-identity.ts'

export const SOURCE = 'meego'
/** `work_item_id` is unique across spaces, so it alone names a Thread: `meego:<id>`. */
export const meegoThreadKey = (workItemId: string): string => `${SOURCE}:${workItemId}`
/** The page of a work item: `https://<host>/<simple_name>/<type>/detail/<id>`. */
export const meegoPage = (host: string, simpleName: string, type: string, workItemId: string): string =>
  `https://${host}/${simpleName}/${type}/detail/${workItemId}`
/** Where a work item's comments go. */
export interface MeegoAddress { projectKey: string; workItemId: string; url: string }
export const meegoChannel = (address: MeegoAddress): ChannelRef =>
  ({ source: SOURCE, thread: meegoThreadKey(address.workItemId), address: { ...address } })

/** `meegle` writes ids as strings in some answers and as numbers in others. */
const Id = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String)
/** `has_more` is a string (`"True"`) in `view get`, a boolean elsewhere. */
const Flag = z.union([z.boolean(), z.string()]).transform(value => value === true || /^true$/i.test(String(value)))
export const WorkItemAttributeSchema = z.looseObject({
  work_item_id: Id, work_item_name: z.string(),
  create_by: z.looseObject({ key: z.string(), name: z.string().nullish() }).nullish(),
  create_time: z.string().nullish(), update_time: z.string().nullish(),
  work_item_type: z.looseObject({ key: z.string() }),
  owned_project: z.looseObject({ key: z.string(), simple_name: z.string().nullish() }).nullish(),
})
export type WorkItemAttribute = z.infer<typeof WorkItemAttributeSchema>
/** A page of `view get`; its items are read one by one so one unreadable item does not hide the others. */
export const ViewPageSchema = z.looseObject({
  pagination: z.looseObject({ has_more: Flag.nullish() }).nullish(),
  work_item_list: z.array(z.looseObject({ work_item_attribute: z.unknown() })).nullish(),
})
/** A page of `mywork todo`: one row per node or subtask, so ids repeat; `list` is null past the last page. */
export const TodoPageSchema = z.looseObject({ list: z.array(z.unknown()).nullish() })
export const TodoRowSchema = z.looseObject({
  project_key: z.string(),
  work_item_info: z.looseObject({ work_item_id: Id, work_item_name: z.string(), work_item_type_key: z.string() }),
})
/** `workitem get --fields '["description"]'`. */
export const WorkItemSchema = z.looseObject({
  work_item_attribute: WorkItemAttributeSchema,
  work_item_fields: z.array(z.looseObject({ key: z.string(), value: z.unknown() })).nullish(),
})
export const CommentSchema = z.looseObject({
  comment_id: Id, content: z.string().nullish(), created_at: z.string(), creator: z.string(), file_url: z.string().nullish(),
})
export type MeegoComment = z.infer<typeof CommentSchema>
export const CommentPageSchema = z.looseObject({
  comments: z.array(z.unknown()).nullish(),
  pagination: z.looseObject({ total_pages: z.number().int().nullish() }).nullish(),
})
export const ProjectSearchSchema = z.looseObject({
  projects: z.array(z.looseObject({ project_key: z.string(), name: z.string().nullish(), simple_name: z.string().nullish() })).nullish(),
})
export const UrlDecodeSchema = z.looseObject({
  url_kind: z.string(), simple_name: z.string().nullish(), view_id: z.string().nullish(), work_item_id: z.string().nullish(),
})

/** A work item in the Source's scope, with what its Thread and Triggers need. */
export interface MeegoItem {
  projectKey: string; workItemId: string; name: string; type: string; url: string
  /** The creator's user_key and the creation time, when the answer that named the item carried them (todo rows do not). */
  creator?: string; createdAt?: string
}
/** The item's description from `workitem get`, as text. */
export function description(item: z.infer<typeof WorkItemSchema>): string {
  const value = item.work_item_fields?.find(field => field.key === 'description')?.value
  return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
}

/** A mention as Feishu Project writes it, with the `回复` a reply starts with: `回复@名字<!-- mention:{...} -->`. */
const MENTION = /(回复\s*)?@([^@\n<]*?)<!--\s*mention:[\s\S]*?-->/g
/**
 * The text with each mention as an `@m` token, which `summons` reads as a mention before the trigger word; the `回复` before a
 * mention, and a colon after one, go with it, as in `回复@名字<!-- mention -->：agent: 看看`.
 */
export const mentionTokens = (text: string): string =>
  text.replace(new RegExp(`${MENTION.source}(?:[ \\t]*[:：])?`, 'g'), '@m ')
/** True when a line of `text` addresses the agent by `trigger`, after any mentions; quotes and code do not count. */
export const addressesAgent = (text: string, trigger: string): boolean => summons(text, trigger, mentionTokens)
/** A colour per character of the prefix, in Feishu Project's `rgb()` form, dark enough to read on white. */
const PALETTE = ['245, 74, 69', '255, 125, 0', '222, 160, 0', '120, 180, 0', '53, 189, 75', '0, 180, 150', '20, 160, 220', '51, 112, 255',
  '100, 80, 230', '150, 70, 220', '215, 60, 180', '240, 70, 120']
/** `[superagent]` in bold, each character in its own colour, which starts every comment the host writes. */
export const MEEGO_PREFIX = [...'[superagent]'].map((char, index) => `<span style="color: rgb(${PALETTE[index % PALETTE.length]})">**${char}**</span>`).join('')
/** The text as a person reads it: mentions as `@名字`, the prefix as `[superagent]`, without colours or invisible markers. */
export const readable = (text: string): string =>
  withoutMarkers(text.replaceAll(MEEGO_PREFIX, '[superagent]').replace(/<span\s[^>]*>|<\/span>/g, '')
    .replace(MENTION, (_match, reply: string | undefined, name: string) => `${reply ? '回复' : ''}@${name.trim()}`))

/**
 * Reads a comment's `created_at` (`2026-11-26 16:35:13`, no zone) as an ISO time: the server renders it in its own zone, whose
 * UTC offset in minutes is `offset`.
 */
export function commentTime(createdAt: string, offset: number): string {
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  const zone = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
  const parsed = Date.parse(`${createdAt.trim().replace(' ', 'T')}${zone}`)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : createdAt
}
/** The UTC offset in minutes of an ISO time that carries one (`+08:00`), or undefined. */
export function offsetOf(time: string | null | undefined): number | undefined {
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(time ?? '')
  if (!match || !/T\d/.test(time ?? '')) return undefined
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
}
const iso = (time: string | null | undefined): string => {
  const parsed = Date.parse(time ?? '')
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString()
}

/** What identity decisions read of the state: whether the host wrote a comment, by its id or its marker. */
export interface MeegoState { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V | undefined): void }
/** The marker bits of `content` that name a message the host wrote. */
export const hostMarker = (state: Pick<MeegoState, 'get'>, content: string | null | undefined): string | undefined =>
  invisibleMarkers(content ?? '').find(bits => state.get(KV.meego.marker(bits)))
/**
 * True when the host wrote the comment: its id is in the written log, or it carries a marker the host stored. Both are written
 * only by the host, so a person's copy of a signature, or an edit that strips the marker, changes nothing.
 */
export const hostWritten = (state: Pick<MeegoState, 'get'>, comment: Pick<MeegoComment, 'comment_id' | 'content'>): boolean =>
  state.get(KV.meego.written(comment.comment_id)) !== undefined || hostMarker(state, comment.content) !== undefined
/** Records a host-written comment found by its marker, so its id alone names it later. */
export function recordWritten(state: MeegoState, comment: Pick<MeegoComment, 'comment_id' | 'content'>, bits = hostMarker(state, comment.content)): void {
  if (!bits) return
  const marker = state.get(KV.meego.marker(bits))
  if (!marker) return
  state.set(KV.meego.written(comment.comment_id), marker.message)
  if (marker.comment !== comment.comment_id) state.set(KV.meego.marker(bits), { ...marker, comment: comment.comment_id })
}

const channelOf = (item: MeegoItem): ChannelRef => meegoChannel({ projectKey: item.projectKey, workItemId: item.workItemId, url: item.url })
/**
 * The Trigger of a work item entering the Source's scope; it never addresses the agent, since a description anyone may edit
 * names no author who asked. One per work item, ever.
 */
export function itemTrigger(item: MeegoItem & { creator: string; createdAt: string }, text: string, via: 'view' | 'todo'): Trigger {
  return { id: key('meego-item', item.workItemId), source: SOURCE, threads: [{ source: SOURCE, id: item.workItemId }],
    actor: { source: SOURCE, id: item.creator }, human: true, at: iso(item.createdAt), text: `${item.name}\n\n${readable(text)}`.trimEnd(),
    channel: channelOf(item), url: item.url,
    meta: { kind: 'item', projectKey: item.projectKey, workItemId: item.workItemId, type: item.type, via } }
}
/**
 * The Trigger of a comment; `addressed` when a line starts with the trigger word. Every comment counts as a person's, since
 * `meegle` cannot tell automation apart; the operator's own carry `owner`.
 */
export function commentTrigger(comment: MeegoComment, item: MeegoItem, meego: Pick<MeegoCli, 'userKey'>, trigger: string, offset: number): Trigger {
  const content = comment.content ?? ''
  const owner = comment.creator === meego.userKey
  return { id: key('meego-comment', item.workItemId, comment.comment_id), source: SOURCE, threads: [{ source: SOURCE, id: item.workItemId }],
    actor: { source: SOURCE, id: comment.creator }, human: true, at: commentTime(comment.created_at, offset), text: readable(content),
    ...addressesAgent(content, trigger) ? { addressed: 'mention' as const } : {},
    channel: channelOf(item), url: item.url,
    meta: { kind: 'comment', projectKey: item.projectKey, workItemId: item.workItemId, commentId: comment.comment_id, ...owner ? { owner: true } : {} } }
}
