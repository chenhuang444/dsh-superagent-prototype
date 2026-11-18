/**
 * The review a ticket follows, as its card names it: a GitHub PR as `pr_number`, a GitLab MR as `mr_number`. Read from the
 * Threads the ticket follows, so a card needs no forge: the open review the ticket follows last, else the last one.
 */
import type { Ticket } from '../core/index.ts'

/**
 * The card key of each forge Source's reviews, by the Source of the Thread, and the prefix of a review's Thread id: GitHub's
 * Issues and PRs share one number sequence (`github:<n>`), whereas GitLab's MRs have their own (`gitlab:mr:<iid>`).
 */
const REVIEW_KEYS: Readonly<Record<string, { key: string; prefix: string }>> = { github: { key: 'pr_number', prefix: '' }, gitlab: { key: 'mr_number', prefix: 'mr:' } }
const numberOf = (thread: string): { key: string; number: number } | undefined => {
  const at = thread.indexOf(':')
  const review = REVIEW_KEYS[thread.slice(0, at)]
  const id = thread.slice(at + 1)
  if (!review || !id.startsWith(review.prefix)) return undefined
  const number = Number(id.slice(review.prefix.length))
  return Number.isInteger(number) && number > 0 ? { key: review.key, number } : undefined
}
/** `{ pr_number }` or `{ mr_number }` of the ticket's review, or nothing when it follows none. */
export function reviewOf(ticket: Pick<Ticket, 'follows'>): Record<string, number> {
  const reviews = (ticket.follows ?? []).flatMap(follow => { const review = numberOf(follow.thread); return review ? [{ ...review, closed: !!follow.closed }] : [] })
  const review = reviews.filter(item => !item.closed).at(-1) ?? reviews.at(-1)
  return review ? { [review.key]: review.number } : {}
}
