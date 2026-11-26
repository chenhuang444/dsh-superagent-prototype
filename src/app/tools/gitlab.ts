/**
 * Executor tools of a GitLab deployment. Every write a worker makes on GitLab goes through the host's glab, on this ticket's own
 * Issues and MRs only: a note or discussion reply, a resolution, an MR opened, updated or closed, an upload, a job retried.
 * Each body carries the host's marker, and under `personal` its signature, so the agent's notes stay apart from a person's even
 * when both write with one account; a retried call finds what an earlier attempt posted by that marker.
 */
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import { key, liveTicket, type Ticket } from '../../core/index.ts'
import { gitlabOf } from '../../deployment.ts'
import { CliError, type Commands } from '../../infra/commands.ts'
import { sameName } from '../../infra/text.ts'
import { ticketBranch } from '../../sources/github-pull.ts'
import { markerOf, signedBody } from '../../sources/gitlab-identity.ts'
import { gitlabPage, SOURCE } from '../../sources/gitlab-trigger.ts'
import type { SourceContext } from '../../sources/host.ts'
import { tool, type Tool } from './tool.ts'

/** The Issues and MRs a ticket may write to: its own, never one it follows only for context. */
interface Scope {
  ticket: Ticket
  issues: Set<number>
  mrs: Set<number>
  /** The MRs it follows, such as its source MR and the MRs it opened. */
  followed: Set<number>
  /** The MRs it opened. */
  own: Set<number>
}
const THREAD = /^gitlab:(issue|mr):([1-9]\d*)$/
const IID = /^[1-9]\d*$/
const DISCUSSION = /^[0-9a-f]{8,64}$/i
const name = (isMr: boolean, iid: number): string => `${isMr ? '!' : '#'}${iid}`

/**
 * The ticket's GitLab Issues and MRs: those of its channels and of the trigger that started it, and the Threads it follows
 * other than for context.
 * @throws Error when the ticket has ended.
 */
function scopeOf(ctx: SourceContext, ticketId: string): Scope {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) throw new Error('Ticket ended; do not write to GitLab for it')
  const scope: Scope = { ticket, issues: new Set(), mrs: new Set(), followed: new Set(), own: new Set() }
  const add = (kind: string | undefined, iid: number) => {
    if (kind === 'mr') scope.mrs.add(iid)
    else if (kind === 'issue') scope.issues.add(iid)
  }
  for (const channel of ticket.channels) {
    if (channel.source === SOURCE && IID.test(channel.address.iid ?? '')) add(channel.address.kind, Number(channel.address.iid))
  }
  const origin = ctx.triggers.get(ticket.origin.triggerId)
  for (const ref of origin?.source === SOURCE ? origin.threads : []) {
    const match = THREAD.exec(`${ref.source}:${ref.id}`)
    if (match) add(match[1], Number(match[2]))
  }
  for (const follow of ticket.follows ?? []) {
    const match = THREAD.exec(follow.thread)
    if (!match || ctx.threads.get(follow.thread)?.context?.includes(ticketId)) continue
    const iid = Number(match[2])
    add(match[1], iid)
    if (match[1] === 'mr') { scope.followed.add(iid); if (follow.own) scope.own.add(iid) }
  }
  return scope
}
function refuse(scope: Scope, what: string): never {
  const names = [...[...scope.mrs].map(iid => name(true, iid)), ...[...scope.issues].map(iid => name(false, iid))]
  throw new Error(`${what}; this ticket's GitLab threads are ${names.length ? names.join(', ') : 'none yet'}`)
}
/** The API path of an Issue or MR this ticket may write to. */
function itemOf(scope: Scope, isMr: boolean, iid: number): string {
  if (!(isMr ? scope.mrs : scope.issues).has(iid)) refuse(scope, `${name(isMr, iid)} is not one of this ticket's GitLab threads`)
  return `${isMr ? 'merge_requests' : 'issues'}/${iid}`
}
/** An MR this ticket follows, which `orchestrator_report` with `mr_number` binds. */
function followedMr(scope: Scope, iid: number): string {
  if (!scope.followed.has(iid)) refuse(scope, `!${iid} is not an MR this ticket follows; report it with orchestrator_report mr_number first`)
  return `merge_requests/${iid}`
}

const NoteSchema = z.looseObject({ id: z.number(), body: z.string().nullish(), author: z.looseObject({ username: z.string() }).nullish() })
const IdSchema = z.looseObject({ id: z.number() })
const MrSchema = z.looseObject({ iid: z.number(), title: z.string(), web_url: z.string(), state: z.string().nullish(),
  author: z.looseObject({ username: z.string() }).nullish(), source_branch: z.string().nullish(), source_project_id: z.number().nullish() })
const missing = (error: unknown): boolean => error instanceof CliError && error.code === 404
/**
 * Posts `body` as a note of `item`, into `discussion` when it names one, unless the account already posted a note with
 * `marker` there, which an earlier attempt of the same call did.
 */
async function postNote(commands: Commands, login: string, item: string, discussion: string | undefined, body: string, marker: string) {
  const notes = await commands.gitlabPages(NoteSchema, `${item}/notes?per_page=100`)
  const found = notes.find(note => sameName(note.author?.username ?? '', login) && (note.body ?? '').includes(marker))
  if (found) return { id: found.id, reused: true }
  const path = discussion ? `${item}/discussions/${discussion}/notes` : `${item}/notes`
  const posted = await commands.gitlab(IdSchema, path, '-X', 'POST', '-f', `body=${body}`).catch((error: unknown) => {
    if (discussion && missing(error)) throw new Error(`Discussion ${discussion} is not on this Issue or MR`)
    throw error
  })
  return { id: posted.id, reused: false }
}
/** A title with GitLab's draft prefix when `draft`, and without one otherwise. */
export const draftTitle = (title: string, draft: boolean): string => {
  const bare = title.replace(/^\s*(?:draft\s*:|\[draft\]|\(draft\))\s*/i, '').trim()
  return draft ? `Draft: ${bare}` : bare
}
const Text = (limit: number) => z.string().trim().min(1).max(limit)
const Iid = z.number().int().positive()
const Discussion = z.string().regex(DISCUSSION, 'A discussion id is the hexadecimal id GitLab gives it')
const Labels = z.array(z.string().trim().min(1).max(255).refine(label => !label.includes(','), 'A label has no comma')).max(50)
const Branch = z.string().trim().min(1).max(255)

/** The ticket's GitLab write tools; each call rereads the ticket, so a Thread bound later is in scope at once. */
export function gitlabTools(ctx: SourceContext, ticketId: string): Tool[] {
  const commandsOf = (signal: AbortSignal) => ctx.commands.withSignal(signal)
  /** The marker id of one call: the same call made again names the same id, and finds what it posted. */
  const idOf = (toolName: string, args: unknown): string => key('gitlab-tool', ticketId, toolName, JSON.stringify(args))
  const page = (isMr: boolean, iid: number): string => {
    const { url } = gitlabOf(ctx.deployment)
    return gitlabPage(url, ctx.deployment.repository, isMr, iid)
  }
  return [
    tool({
      name: 'gitlab_reply',
      description: 'Post a note on one of this ticket\'s GitLab Issues or MRs, as the communication section says: into the discussion '
        + 'discussion_id names, otherwise as a top-level note. The host signs it; write only the text. Calling again with the same '
        + 'arguments posts nothing new.',
      schema: z.object({
        kind: z.enum(['issue', 'mr']),
        iid: Iid,
        discussion_id: Discussion.optional().describe('The discussion to reply in, as its notes\' reply_to shows; omit for a top-level note.'),
        text: Text(20_000).describe('Markdown.'),
      }).strict(),
      execute: async (args, signal) => {
        const scope = scopeOf(ctx, ticketId)
        const isMr = args.kind === 'mr'
        const item = itemOf(scope, isMr, args.iid)
        const id = idOf('gitlab_reply', args)
        const gitlab = gitlabOf(ctx.deployment)
        const note = await postNote(commandsOf(signal), gitlab.login, item, args.discussion_id, signedBody(gitlab, id, args.text), markerOf(id))
        return { note_id: note.id, url: `${page(isMr, args.iid)}#note_${note.id}`, reused: note.reused }
      },
    }),
    tool({
      name: 'gitlab_resolve',
      description: 'Resolve, or unresolve, a discussion of one of this ticket\'s MRs, as the communication section says.',
      schema: z.object({ mr_iid: Iid, discussion_id: Discussion, resolved: z.boolean() }).strict(),
      execute: async (args, signal) => {
        const item = itemOf(scopeOf(ctx, ticketId), true, args.mr_iid)
        await commandsOf(signal).gitlab(z.unknown(), `${item}/discussions/${args.discussion_id}?resolved=${String(args.resolved)}`, '-X', 'PUT')
          .catch((error: unknown) => { if (missing(error)) throw new Error(`Discussion ${args.discussion_id} is not on !${args.mr_iid}`); throw error })
        return { mr_iid: args.mr_iid, discussion_id: args.discussion_id, resolved: args.resolved }
      },
    }),
    tool({
      name: 'gitlab_mr_create',
      description: 'Open an MR in the deployment\'s project from this ticket\'s branch, which you pushed; its last path segment is '
        + 'DSH_SUPERAGENT_NAME. The host signs the description. When the branch already has an open MR of the account, returns it. '
        + 'Then report it with orchestrator_report mr_number.',
      schema: z.object({
        source_branch: Branch,
        target_branch: Branch.optional().describe('The project\'s default branch when omitted.'),
        title: Text(255),
        description: Text(100_000).describe('Markdown, as the delivery requirements section says.'),
        draft: z.boolean().optional().describe('Open it as a draft.'),
        labels: Labels.optional(),
      }).strict(),
      execute: async (args, signal) => {
        const scope = scopeOf(ctx, ticketId)
        if (!ticketBranch(scope.ticket, args.source_branch)) {
          throw new Error(`An MR of this ticket comes from a branch whose last path segment is ${scope.ticket.execution?.name ?? 'the ticket\'s name'}`)
        }
        const commands = commandsOf(signal)
        const gitlab = gitlabOf(ctx.deployment)
        const open = await commands.gitlab(z.array(MrSchema),
          `merge_requests?state=opened&source_branch=${encodeURIComponent(args.source_branch)}&per_page=100`)
        const existing = open.find(item => sameName(item.author?.username ?? '', gitlab.login) && item.source_project_id === gitlab.projectId)
        if (existing) return { mr_number: existing.iid, url: existing.web_url, reused: true }
        const target = args.target_branch ?? (await commands.gitlab(z.looseObject({ default_branch: z.string() }), '')).default_branch
        const id = idOf('gitlab_mr_create', { source_branch: args.source_branch })
        const created = await commands.gitlab(MrSchema, 'merge_requests', '-X', 'POST', '-f', `source_branch=${args.source_branch}`,
          '-f', `target_branch=${target}`, '-f', `title=${draftTitle(args.title, args.draft ?? false)}`,
          '-f', `description=${signedBody(gitlab, id, args.description)}`, ...args.labels?.length ? ['-f', `labels=${args.labels.join(',')}`] : [])
        return { mr_number: created.iid, url: created.web_url, reused: false }
      },
    }),
    tool({
      name: 'gitlab_mr_update',
      description: 'Change the title, description, labels, draft state or reviewers of an MR this ticket follows. The host signs a new '
        + 'description; write only its text.',
      schema: z.object({
        iid: Iid,
        title: Text(255).optional(),
        description: Text(100_000).optional().describe('The whole new description, in Markdown.'),
        labels: Labels.optional().describe('Replaces every label.'),
        add_labels: Labels.optional(),
        remove_labels: Labels.optional(),
        draft: z.boolean().optional(),
        reviewer_usernames: z.array(z.string().trim().min(1).max(255)).max(20).optional().describe('Replaces the reviewers; [] removes them all.'),
      }).strict(),
      execute: async (args, signal) => {
        const scope = scopeOf(ctx, ticketId)
        const item = followedMr(scope, args.iid)
        const commands = commandsOf(signal)
        const gitlab = gitlabOf(ctx.deployment)
        const flags: string[] = []
        const field = (name: string, value: string) => { flags.push('-f', `${name}=${value}`) }
        if (args.title !== undefined || args.draft !== undefined) {
          // A new title keeps the MR's draft state unless `draft` changes it.
          const current = args.title === undefined || args.draft === undefined ? (await commands.gitlab(MrSchema, item)).title : ''
          const draft = args.draft ?? /^\s*(?:draft\s*:|\[draft\]|\(draft\))/i.test(current)
          field('title', draftTitle(args.title ?? current, draft))
        }
        if (args.description !== undefined) field('description', signedBody(gitlab, idOf('gitlab_mr_update', { iid: args.iid, description: args.description }), args.description))
        if (args.labels) field('labels', args.labels.join(','))
        if (args.add_labels?.length) field('add_labels', args.add_labels.join(','))
        if (args.remove_labels?.length) field('remove_labels', args.remove_labels.join(','))
        if (args.reviewer_usernames) {
          const ids: number[] = []
          for (const username of args.reviewer_usernames) {
            const members = await commands.gitlab(z.array(z.looseObject({ id: z.number(), username: z.string() })),
              `members/all?query=${encodeURIComponent(username)}&per_page=100`)
            const member = members.find(candidate => sameName(candidate.username, username))
            if (!member) throw new Error(`${username} is no member of the project, so they cannot review`)
            ids.push(member.id)
          }
          flags.push('-F', `reviewer_ids=${JSON.stringify(ids)}`)
        }
        if (!flags.length) throw new Error('Name at least one change')
        const updated = await commands.gitlab(MrSchema, item, '-X', 'PUT', ...flags)
        return { mr_number: updated.iid, url: updated.web_url, title: updated.title }
      },
    }),
    tool({
      name: 'gitlab_mr_close',
      description: 'Close an MR this ticket opened, after posting one note on it that says why, as the delivery requirements section says.',
      schema: z.object({ iid: Iid, note: Text(20_000).describe('Why it closes, such as the person\'s MR that carries this work.') }).strict(),
      execute: async (args, signal) => {
        const scope = scopeOf(ctx, ticketId)
        if (!scope.own.has(args.iid)) refuse(scope, `!${args.iid} is not an MR this ticket opened`)
        const item = `merge_requests/${args.iid}`
        const commands = commandsOf(signal)
        const gitlab = gitlabOf(ctx.deployment)
        const id = idOf('gitlab_mr_close', args)
        const note = await postNote(commands, gitlab.login, item, undefined, signedBody(gitlab, id, args.note), markerOf(id))
        const closed = await commands.gitlab(MrSchema, item, '-X', 'PUT', '-f', 'state_event=close')
        return { mr_number: closed.iid, state: closed.state ?? 'closed', note_id: note.id }
      },
    }),
    tool({
      name: 'gitlab_upload',
      description: 'Upload a file of this ticket\'s directory, such as a screenshot, to the project; returns the Markdown that shows it in '
        + 'an MR description or a note.',
      schema: z.object({ path: z.string().trim().min(1).describe('A file inside the ticket directory, relative to it or absolute.') }).strict(),
      execute: async (args, signal) => {
        const directory = scopeOf(ctx, ticketId).ticket.execution?.directory
        if (!directory) throw new Error('This ticket has no directory yet')
        const root = await realpath(directory)
        const file = await realpath(resolve(root, args.path)).catch(() => { throw new Error(`${args.path} does not exist`) })
        const inside = relative(root, file)
        if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Only files inside the ticket directory can be uploaded')
        if (!(await stat(file)).isFile()) throw new Error(`${args.path} is not a file`)
        const uploaded = await commandsOf(signal).gitlab(z.looseObject({ markdown: z.string(), url: z.string() }), 'uploads', '-X', 'POST',
          '--form', `file=@${file}`)
        return { markdown: uploaded.markdown, url: uploaded.url }
      },
    }),
    tool({
      name: 'gitlab_job_retry',
      description: 'Retry a job of a pipeline of an MR this ticket follows, such as a flaky one.',
      schema: z.object({ job_id: z.number().int().positive() }).strict(),
      execute: async (args, signal) => {
        const scope = scopeOf(ctx, ticketId)
        const commands = commandsOf(signal)
        const job = await commands.gitlab(z.looseObject({ id: z.number(), ref: z.string().nullish() }), `jobs/${args.job_id}`)
          .catch((error: unknown) => { if (missing(error)) throw new Error(`Job ${args.job_id} is not in the project`); throw error })
        const ref = job.ref ?? ''
        const mrRef = /^refs\/merge-requests\/([1-9]\d*)\//.exec(ref)
        let ours = ticketBranch(scope.ticket, ref) || (!!mrRef && scope.followed.has(Number(mrRef[1])))
        for (const iid of ours ? [] : scope.followed) {
          if ((await commands.gitlab(MrSchema, `merge_requests/${iid}`)).source_branch === ref) { ours = true; break }
        }
        if (!ours) refuse(scope, `Job ${args.job_id} runs for ${ref || 'no ref'}, which is no MR of this ticket`)
        const retried = await commands.gitlab(z.looseObject({ id: z.number(), status: z.string().nullish(), web_url: z.string().nullish() }),
          `jobs/${args.job_id}/retry`, '-X', 'POST')
        return { job_id: retried.id, status: retried.status ?? null, url: retried.web_url ?? null }
      },
    }),
  ]
}
