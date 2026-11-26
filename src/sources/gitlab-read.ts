/** Read-only GitLab project, conversation and pipeline inspection for assessments and workers. */
import { z } from 'zod'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import type { CiSnapshot } from './github-read.ts'
import { DiscussionSchema, isHumanUser, ItemSchema, noteKind, notePlace, NoteSchema, type GitlabItem, type GitlabNote }
  from './gitlab-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { byAgent, byOwner, type GitlabIdentity } from './gitlab-identity.ts'
import { gitlabOf } from '../deployment.ts'

const JobSchema = z.looseObject({ name: z.string(), status: z.string(), allow_failure: z.boolean().nullish() })
type Job = z.infer<typeof JobSchema>
const PipelineSchema = z.looseObject({ id: z.number(), sha: z.string().nullish(), status: z.string().nullish() })
/**
 * Maps a job onto a check of `CiSnapshot`: a failed job that may not fail is a failure (one allowed to fail is neutral),
 * canceled is cancelled, skipped and manual are skipped, and every other status is still running.
 */
export function jobCheck(job: Job): CiSnapshot['checks'][number] {
  const conclusion = job.status === 'failed' ? job.allow_failure ? 'neutral' : 'failure' : job.status === 'canceled' ? 'cancelled'
    : job.status === 'success' ? 'success' : job.status === 'skipped' || job.status === 'manual' ? 'skipped' : null
  return { name: job.name, status: conclusion ? 'completed' : job.status, conclusion }
}
/** Reads the jobs of pipeline `id` at commit `head` as a CI snapshot, in a stable order so an unchanged pipeline compares equal. */
export async function pipelineChecks(commands: Commands, id: number, head: string, tally?: Tally): Promise<CiSnapshot> {
  const jobs = await commands.gitlabPages(JobSchema, `pipelines/${id}/jobs?per_page=100`, tally)
  const checks = jobs.map(jobCheck).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return { head, checks, statuses: [] }
}
/** The newest pipeline of `ref` (a branch) or of commit `sha`, or undefined when none ran. */
export async function latestPipeline(commands: Commands, filter: { ref: string } | { sha: string }) {
  const query = 'ref' in filter ? `ref=${encodeURIComponent(filter.ref)}` : `sha=${encodeURIComponent(filter.sha)}`
  return (await commands.gitlab(z.array(PipelineSchema), `pipelines?${query}&order_by=id&sort=desc&per_page=1`))[0]
}
const EMPTY = (head: string): CiSnapshot => ({ head, checks: [], statuses: [] })

const hidden = (part: string): boolean => part === '..' || part.startsWith('.') || part === 'node_modules'
/** Reads a non-hidden file, or a directory listing, from the project's default branch; hidden parts and `node_modules` are refused. */
export async function readGitlabPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(hidden)) throw new Error('Only non-hidden repository source paths are available')
  const { default_branch: branch } = await commands.gitlab(z.looseObject({ default_branch: z.string() }), '')
  const ref = encodeURIComponent(branch)
  if (kind === 'file') return commands.gitlab(`repository/files/${encodeURIComponent(parts.join('/'))}/raw?ref=${ref}`)
  const at = parts.length ? `path=${encodeURIComponent(parts.join('/'))}&` : ''
  const entries = await commands.gitlabPages(z.looseObject({ name: z.string() }), `repository/tree?${at}ref=${ref}&per_page=100`)
  // Git keeps no empty directories, so an empty listing names a file or nothing.
  if (!entries.length) throw new Error(`${path} is not a directory`)
  return entries.map(entry => entry.name).filter(name => !hidden(name)).sort().join('\n')
}

/** The deployment's GitLab identity, which marks the agent's and the person's own messages under `personal`. */
const identityOf = (commands: Commands): GitlabIdentity => gitlabOf(commands.deployment)
/** `agent` and `owner` under `personal`, where the agent and a person share one account; nothing under `dedicated`. */
function whose(author: string, body: string | null | undefined, identity: GitlabIdentity): Pick<ContextMessage, 'agent' | 'owner'> {
  if (identity.identity !== 'personal') return {}
  return byAgent(author, body, identity) ? { agent: true } : byOwner(author, body, identity) ? { owner: true } : {}
}
/** Formats a note as a model-facing message; a bot's message never authorizes work. */
function noteMessage(note: GitlabNote, id: string, url: string, identity: GitlabIdentity): ContextMessage {
  const place = noteKind(note) === 'diff' ? notePlace(note) : undefined
  return { id, from: note.author.username, at: note.created_at, text: note.body ?? '', ...!isHumanUser(note.author) ? { bot: true } : {},
    ...note.system ? {} : whose(note.author.username, note.body, identity),
    url, ...place ? { path: place.path, ...place.line != null ? { line: place.line } : {} } : {} }
}
function itemMessage(item: GitlabItem, id: string, text: string, identity: GitlabIdentity): ContextMessage {
  return { id, from: item.author.username, at: item.created_at, text, ...!isHumanUser(item.author) ? { bot: true } : {},
    ...whose(item.author.username, item.description, identity), url: item.web_url }
}
/** The notes worth reading: people's and bots' notes, and the system notes that are review decisions. */
const readable = (notes: GitlabNote[]): GitlabNote[] => notes.filter(note => noteKind(note) !== undefined)
/** The messages of one discussion; every later note replies to its first. */
function discussionMessages(notes: GitlabNote[], web: string, id: (note: GitlabNote) => string, identity: GitlabIdentity): ContextMessage[] {
  const [first] = notes
  return notes.map(note => ({ ...noteMessage(note, id(note), `${web}#note_${note.id}`, identity), ...first && note !== first ? { reply_to: id(first) } : {} }))
}
async function discussion(commands: Commands, item: string, id: string, tally?: Tally): Promise<GitlabNote[]> {
  const found = await commands.gitlab(DiscussionSchema, `${item}/discussions/${id}`)
  return readable(validItems(NoteSchema, found.notes, tally))
}
const DescriptionSchema = ItemSchema.extend({ source_branch: z.string().nullish(), target_branch: z.string().nullish(),
  draft: z.boolean().nullish(), labels: z.array(z.string()).nullish() })
const RESOURCE = /^gitlab\/(issues|merge_requests)\/([1-9]\d*)(?:\/(notes|discussion|pipelines)(?:\/([0-9a-f]+))?)?$/

/**
 * Reads an Issue or MR, a page of its notes, one discussion, or a pipeline as model-facing `{ id, from, at, text, reply_to?,
 * path?, line?, url }` messages or a CI snapshot, rather than raw GitLab records.
 */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  // A commit's pipeline, such as the default branch's, which no MR names.
  const commit = /^gitlab\/commits\/([0-9a-f]{7,64})\/pipelines$/.exec(resource)
  if (commit) {
    const pipeline = await latestPipeline(commands, { sha: commit[1]! })
    return pipeline ? pipelineChecks(commands, pipeline.id, commit[1]!) : EMPTY(commit[1]!)
  }
  const match = RESOURCE.exec(resource)
  if (!match) {
    throw new Error('Use gitlab/issues/<iid>, gitlab/merge_requests/<iid>, or append /notes/<page>, /discussion/<discussion-id> or /pipelines; or gitlab/commits/<sha>/pipelines')
  }
  const [, kind, iid, section, arg] = match
  const item = `${kind}/${iid}`
  if (section === 'pipelines') {
    if (kind !== 'merge_requests') throw new Error('Pipelines require a merge request')
    if (arg) throw new Error('Pipelines do not take a page number')
    const mr = await commands.gitlab(z.looseObject({ sha: z.string().nullish(),
      head_pipeline: PipelineSchema.nullish() }), item)
    const head = mr.head_pipeline?.sha ?? mr.sha ?? ''
    return mr.head_pipeline ? pipelineChecks(commands, mr.head_pipeline.id, head) : EMPTY(head)
  }
  if (section === 'discussion' && (!arg || !/^[0-9a-f]{8,64}$/.test(arg))) {
    throw new Error('Name the discussion by its id: gitlab/<kind>/<iid>/discussion/<discussion-id>')
  }
  if (section === 'notes' && arg && !/^[1-9]\d*$/.test(arg)) throw new Error('A page of notes is a number from 1')
  const web = await commands.gitlab(DescriptionSchema, item)
  if (!section) {
    const branches = web.source_branch && web.target_branch ? { source_branch: web.source_branch, target_branch: web.target_branch } : {}
    return { iid: web.iid, title: web.title, state: web.state, ...web.draft ? { draft: true } : {}, ...branches,
      ...web.labels?.length ? { labels: web.labels } : {}, ...itemMessage(web, String(web.iid), web.description ?? '', identityOf(commands)) }
  }
  if (section === 'discussion') {
    const notes = await discussion(commands, item, arg!)
    if (!notes.length) throw new Error('This discussion has no notes to read')
    return { messages: discussionMessages(notes, web.web_url, note => String(note.id), identityOf(commands)) }
  }
  const page = Number(arg ?? '1')
  const listed = await commands.gitlab(z.array(z.unknown()), `${item}/notes?sort=asc&order_by=created_at&per_page=20&page=${page}`)
  const tally = { skipped: 0 }
  const messages = readable(validItems(NoteSchema, listed, tally)).map(note => noteMessage(note, String(note.id), `${web.web_url}#note_${note.id}`, identityOf(commands)))
  return { messages, ...tally.skipped ? { skipped: tally.skipped } : {},
    ...listed.length === 20 ? { next_resource: `gitlab/${item}/notes/${page + 1}` } : {} }
}
/** Reads one page of an Issue's or MR's notes, the title and description first on page 1, with page URLs as message ids. */
async function conversationPage(commands: Commands, item: string, page: number) {
  const web = await commands.gitlab(ItemSchema, item)
  const identity = identityOf(commands)
  const messages: ContextMessage[] = page === 1 ? [itemMessage(web, web.web_url, `${web.title}\n\n${web.description ?? ''}`, identity)] : []
  const listed = await commands.gitlab(z.array(z.unknown()), `${item}/notes?sort=asc&order_by=created_at&per_page=100&page=${page}`)
  const tally = { skipped: 0 }
  messages.push(...readable(validItems(NoteSchema, listed, tally)).map(note => {
    const url = `${web.web_url}#note_${note.id}`
    return noteMessage(note, url, url, identity)
  }))
  return { messages, next_resource: listed.length === 100 ? String(page + 1) : null, ...tally.skipped ? { skipped: tally.skipped } : {} }
}
/**
 * Context reader for a GitLab Trigger: the discussion of a note in a threaded discussion (whose first note is its root and
 * parent), or the Issue's or MR's notes by page otherwise (whose first page holds its root and parent).
 */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? '',
  read: async (commands, trigger, part, cursor) => {
    // The default branch's pipeline has no conversation; its Trigger is its context.
    if (typeof trigger.meta.branch === 'string') {
      const message = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true as const }
      return { messages: [message], body: { status: 'branch_ci', messages: [message] }, status: 'branch_ci' }
    }
    const item = `${trigger.meta.isMr === true ? 'merge_requests' : 'issues'}/${Number(trigger.meta.iid)}`
    const threaded = trigger.channel?.address.discussion
    if (threaded) {
      const web = await commands.gitlab(ItemSchema, item)
      const messages = discussionMessages(await discussion(commands, item, threaded), web.web_url, note => `${web.web_url}#note_${note.id}`, identityOf(commands))
      const read = part === 'thread' ? messages : messages.slice(0, 1)
      return { messages: read, body: { status: 'discussion', messages: read }, status: 'discussion' }
    }
    const body = await conversationPage(commands, item, Number(cursor ?? '1'))
    return { messages: body.messages, next: body.next_resource ?? undefined, body }
  },
}
