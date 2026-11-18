/** Normalizes GitLab Issues, merge requests, notes, review decisions and pipeline changes into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/** Issue and MR iids are separate sequences, so a Thread id names the kind: `issue:12`, `mr:34`. */
export const threadId = (isMr: boolean, iid: number): string => `${isMr ? 'mr' : 'issue'}:${iid}`
/** The GitLab reply address: an Issue or MR, and the discussion a reply goes into when the note was in a thread. */
export const gitlabChannel = (isMr: boolean, iid: number, discussion?: string, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `${SOURCE}:${threadId(isMr, iid)}`,
    address: { kind: isMr ? 'mr' : 'issue', iid: String(iid), ...discussion ? { discussion } : {}, ...url ? { url } : {} } })
/** The web page of an Issue or MR on the server at `url` (`https://host[:port]`). */
export const gitlabPage = (url: string, repository: string, isMr: boolean, iid: number): string =>
  `${url}/${repository}/-/${isMr ? 'merge_requests' : 'issues'}/${iid}`
/** GitLab returns a deleted account as `null`; it shows it as the Ghost User. */
export const UserSchema = z.looseObject({ username: z.string(), bot: z.boolean().nullish() }).nullable()
  .transform(user => user ?? { username: 'ghost' })
export type GitlabUser = z.infer<typeof UserSchema>
/** An Issue or MR as the list and single-item endpoints return it. */
export const ItemSchema = z.looseObject({
  iid: z.number().int().positive(), title: z.string(), description: z.string().nullish(), state: z.string(), web_url: z.string(),
  author: UserSchema, created_at: z.string(), updated_at: z.string().nullish(),
})
export type GitlabItem = z.infer<typeof ItemSchema>
/** A note; a diff note carries its `position` in the MR's diff. */
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: UserSchema, created_at: z.string(), updated_at: z.string().nullish(),
  system: z.boolean().nullish(), type: z.string().nullish(),
  position: z.looseObject({ new_path: z.string().nullish(), new_line: z.number().nullish(), old_path: z.string().nullish(),
    old_line: z.number().nullish() }).nullish(),
  resolvable: z.boolean().nullish(), resolved: z.boolean().nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>
/** A discussion; its notes are read one by one so one unreadable note does not hide the others. */
export const DiscussionSchema = z.looseObject({ id: z.string(), individual_note: z.boolean().nullish(), notes: z.array(z.unknown()) })
export type GitlabDiscussion = z.infer<typeof DiscussionSchema>
export interface ItemRef { iid: number; isMr: boolean; url: string; mrAuthor?: string }
/**
 * True when GitLab reports a person rather than a bot: not `bot`, and not a bot name such as `ci_bot` or a project or group
 * access token's `project_12_bot_…`.
 */
export const isHumanUser = (user: { username: string; bot?: boolean | null | undefined }): boolean =>
  !user.bot && !/(_bot$|^(project|group)_\d+_bot)/i.test(user.username)
/** `@login`, in any case, not inside an address or a longer name. */
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?<![\\w@.])@${escapeRegExp(login)}(?![A-Za-z0-9_-]|\\.\\w)`, 'i').test(text)
/** The system notes that are review decisions; other system notes (pushes, label changes) are no event. */
const REVIEW = /^(approved this merge request|unapproved this merge request|requested changes)\b/i
/** The kind of a note's Trigger, or undefined for a system note that is no review decision. */
export function noteKind(note: Pick<GitlabNote, 'system' | 'type' | 'body'>): 'note' | 'diff' | 'review' | undefined {
  if (note.system) return REVIEW.test(note.body ?? '') ? 'review' : undefined
  return note.type === 'DiffNote' ? 'diff' : 'note'
}
/** The file and line of a diff note: the new side, or the old side for a removed line. */
export function notePlace(note: GitlabNote): { path: string; line?: number } | undefined {
  const position = note.position
  const path = position?.new_path ?? position?.old_path
  const line = position?.new_line ?? position?.old_line
  return path ? { path, ...line != null ? { line } : {} } : undefined
}
const author = (user: GitlabUser, agent: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: isHumanUser(user) && !sameName(user.username, agent) })
/**
 * Builds the Trigger of a note in `discussion`; none for the agent's own note, a system note that is no review decision, or an
 * empty one. A note keeps its id when edited or resolved, so a later read of it is a duplicate.
 */
export function noteTrigger(note: GitlabNote, discussion: Pick<GitlabDiscussion, 'id' | 'individual_note'>, ref: ItemRef,
  agent: string): Trigger | undefined {
  const kind = noteKind(note)
  if (!kind || sameName(note.author.username, agent)) return undefined
  const place = kind === 'diff' ? notePlace(note) : undefined
  const text = [place ? `${place.path}${place.line != null ? `:${place.line}` : ''}` : '', note.body ?? ''].filter(Boolean).join('\n\n')
  if (!text) return undefined
  const url = `${ref.url}#note_${note.id}`
  const thread = threadId(ref.isMr, ref.iid)
  return { id: key('gitlab-note', thread, String(note.id)), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    ...author(note.author, agent), at: note.created_at, text,
    ...kind !== 'review' && mentions(note.body ?? '', agent) ? { addressed: 'mention' as const } : {},
    channel: gitlabChannel(ref.isMr, ref.iid, discussion.individual_note ? undefined : discussion.id, url), url,
    meta: { iid: ref.iid, isMr: ref.isMr, kind, noteId: note.id, discussionId: discussion.id, ...ref.mrAuthor ? { mrAuthor: ref.mrAuthor } : {},
      ...place ? { path: place.path, line: place.line ?? null } : {} } }
}
/** Builds the Trigger of a new Issue's or MR's title and description; Issues and MRs have ids of their own. */
export function itemTrigger(item: GitlabItem, isMr: boolean, agent: string): Trigger {
  const body = item.description ?? ''
  const thread = threadId(isMr, item.iid)
  return { id: key(isMr ? 'gitlab-mr' : 'gitlab-issue', String(item.iid)), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    ...author(item.author, agent), at: item.created_at, text: `${item.title}\n\n${body}`,
    ...mentions(body, agent) ? { addressed: 'mention' as const } : {},
    channel: gitlabChannel(isMr, item.iid, undefined, item.web_url), url: item.web_url,
    meta: { iid: item.iid, isMr, kind: isMr ? 'mr' : 'issue', ...isMr ? { mrAuthor: item.author.username } : {} } }
}
/** Builds the Trigger of a change of an MR's pipeline; CI has no sender. */
export function ciTrigger(mr: { iid: number; web_url: string; author: { username: string } }, revision: number, summary: string): Trigger {
  return { id: key('gitlab-ci', `mr:${mr.iid}`, String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: threadId(true, mr.iid) }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(), text: summary,
    channel: gitlabChannel(true, mr.iid), url: mr.web_url,
    meta: { iid: mr.iid, isMr: true, mrAuthor: mr.author.username, ci: true, revision } }
}
/** Builds the Trigger of a change of the default branch's pipeline; nobody asked there, so it has no `channel`. */
export function branchCiTrigger(branch: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('gitlab-ci', `branch:${branch}`, String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: `ci:${branch}` }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(), text: summary, url,
    meta: { ci: true, branch, revision } }
}
