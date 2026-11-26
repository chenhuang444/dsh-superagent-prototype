/** Merge request binding, lifecycle observation, and terminal IM notification helpers, as `github-pull.ts` has them for PRs. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import { gitlabOf, type Deployment } from '../deployment.ts'
import type { ForgeDeployment } from '../forge/types.ts'
import { sameName } from '../infra/text.ts'
import { chinese, marked, signedBody } from './gitlab-identity.ts'
import type { SourceContext } from './host.ts'
import { ticketBranch } from './github-pull.ts'
import { gitlabPage, ItemSchema, SOURCE, threadId } from './gitlab-trigger.ts'

/** An MR as `merge_requests/<iid>` returns it; only this endpoint carries `head_pipeline`. */
export const MrSchema = ItemSchema.extend({
  source_branch: z.string(), target_branch: z.string(), source_project_id: z.number().nullish(), sha: z.string().nullish(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish(), merge_when_pipeline_succeeds: z.boolean().nullish(),
  draft: z.boolean().nullish(), labels: z.array(z.string()).nullish(),
  head_pipeline: z.looseObject({ id: z.number(), sha: z.string().nullish(), status: z.string().nullish() }).nullish(),
})
export type Mr = z.infer<typeof MrSchema>
export const readMr = (ctx: Pick<SourceContext, 'commands'>, iid: number, signal?: AbortSignal): Promise<Mr> =>
  ctx.commands.withSignal(signal).gitlab(MrSchema, `merge_requests/${iid}`)
const MR_PREFIX = `${SOURCE}:mr:`
const mrIid = (thread: string): number | undefined => thread.startsWith(MR_PREFIX) ? Number(thread.slice(MR_PREFIX.length)) : undefined
/** The iids of the MRs a ticket follows (only the open ones with `open`). */
export const mrsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => mrIid(item.thread) ?? [])
/** The MR a ticket card names: the open MR it followed last, else the last one. */
export const mrOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => mrsOf(ticket, true).at(-1) ?? mrsOf(ticket).at(-1)
/**
 * True when the agent account opened the MR from a branch of the configured project, not of a fork. Under `personal` the
 * account is a person's own, so the MR must also be the agent's: its description carries the host's marker, or its source
 * branch is the branch of an open ticket (`tickets`); a marker a push option removed does not make it the person's.
 */
export const agentMr = (mr: Pick<Mr, 'author' | 'source_project_id'> & Partial<Pick<Mr, 'description' | 'source_branch'>>,
  deployment: Pick<Deployment, 'gitlab'>, tickets: readonly Pick<Ticket, 'execution'>[] = []): boolean => {
  const { login, projectId, identity } = gitlabOf(deployment)
  if (!sameName(mr.author.username, login) || mr.source_project_id !== projectId) return false
  return identity !== 'personal' || marked(mr.description)
    || (!!mr.source_branch && tickets.some(ticket => ticketBranch(ticket, mr.source_branch!)))
}
const ended = (mr: Pick<Mr, 'state'>): boolean => mr.state === 'merged' || mr.state === 'closed'
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }

/**
 * Binds an open MR to a ticket when it is the ticket's source MR, or the agent's MR from the ticket's branch; one MR binds to at
 * most one open ticket. Returns the refusal, or undefined when the MR is bound or not open (which is no refusal).
 */
export function claimMr(ctx: SourceContext, ticketId: string, mr: Mr): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its MR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.isMr === true && source.meta.iid === mr.iid
  const opened = agentMr(mr, ctx.deployment, [ticket]) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    const { login } = gitlabOf(ctx.deployment)
    return `MR does not belong to this ticket: use the source MR or an MR by ${login} from a branch of this project whose last path segment is DSH_SUPERAGENT_NAME; omit mr_number when no MR exists`
  }
  const owner = ctx.tickets.open().find(item => mrsOf(item, true).includes(mr.iid))
  if (owner && owner.id !== ticketId) return 'MR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${MR_PREFIX}${mr.iid}`)
  if (!ended(mr) && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, mr, opened)
  return undefined
}
/**
 * Reconciles a polled MR's state and auto-merge fact with the tickets that follow it or work on its branch. An open agent MR
 * binds to the single open ticket on its branch unless that ticket already follows another open MR.
 * @returns whether the MR has ended.
 */
export async function observeMr(ctx: SourceContext, mr: Mr): Promise<boolean> {
  const done = ended(mr)
  if (done) closeMr(ctx, mr)
  else {
    const open = ctx.tickets.open()
    const candidates = agentMr(mr, ctx.deployment, open) ? open.filter(ticket => ticketBranch(ticket, mr.source_branch)) : []
    if (candidates.length) await guardPersonalMr(ctx, mr)
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // An MR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === `${MR_PREFIX}${mr.iid}` && item.closed)
    if (ticket && (reopened || mrsOf(ticket, true).every(iid => iid === mr.iid))) claimMr(ctx, ticket.id, mr)
  }
  ctx.threads.describe(`${MR_PREFIX}${mr.iid}`, { facts: { autoMerge: !done && mr.merge_when_pipeline_succeeds ? AUTO_MERGE_ON : null } })
  return done
}
/**
 * Under `personal`, where the agent works with a person's account, a ticket's MR stays the agent's: auto-merge, such as one a
 * push option enabled, is withdrawn, since a person merges; and a description without the host's marker, such as one a push
 * option opened or rewrote, gets the marker and the signature again. A failure leaves both to the next read.
 */
async function guardPersonalMr(ctx: SourceContext, mr: Mr): Promise<void> {
  const gitlab = gitlabOf(ctx.deployment)
  if (gitlab.identity !== 'personal') return
  try {
    if (mr.merge_when_pipeline_succeeds) {
      await ctx.commands.gitlab(z.unknown(), `merge_requests/${mr.iid}/cancel_merge_when_pipeline_succeeds`, '-X', 'POST')
      mr.merge_when_pipeline_succeeds = false
    }
    if (!marked(mr.description)) {
      const description = signedBody(gitlab, `mr-${mr.iid}`, mr.description ?? '')
      await ctx.commands.gitlab(z.unknown(), `merge_requests/${mr.iid}`, '-X', 'PUT', '-f', `description=${description}`)
      mr.description = description
    }
  } catch { /* GitLab refused or failed; the next poll reads the MR and tries again. */ }
}
function bind(ctx: SourceContext, ticketId: string, mr: Mr, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: threadId(true, mr.iid) }, own)
    ctx.threads.patch(`${MR_PREFIX}${mr.iid}`, { iid: mr.iid, isMr: true, url: mr.web_url, mrAuthor: mr.author.username })
  })
}
/** Reports a merged or closed MR to the open tickets that follow it; their subscription stays so a later note resumes them. */
function closeMr(ctx: SourceContext, mr: Mr): void {
  if (!ctx.tickets.open().some(ticket => mrsOf(ticket, true).includes(mr.iid))) return
  const at = mr.merged_at ?? mr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: threadId(true, mr.iid) }, mr.state === 'merged' ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent notices to a ticket's other conversations once it ended with its MR (the last-closed MR it opened, else the
 * last it followed), in Chinese when the request has Han characters and no kana, otherwise English. GitLab shows the end itself.
 */
export function mrEndNotices(ticket: Ticket, request: string, deployment: Pick<ForgeDeployment, 'gitlab' | 'repository'>): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && mrIid(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow || !deployment.gitlab) return []
  const iid = mrIid(follow.thread)!
  const url = gitlabPage(deployment.gitlab.url, deployment.repository, true, iid)
  const text = chinese(request)
    ? outcome === 'merged' ? `[MR !${iid}](${url}) 已合并。` : `[MR !${iid}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${iid}](${url}) has merged.` : `[MR !${iid}](${url}) was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', String(iid), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
