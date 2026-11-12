/**
 * The review a ticket follows, as its card names it: a GitHub PR as `pr_number`, a Gerrit change as `change_number`. Read from
 * the Threads the ticket follows, so a card needs no forge: the open review the ticket follows last, else the last one.
 */
import type { Ticket } from '../core/index.ts'

/** The card key of each forge Source's reviews, by the Source of the Thread. */
const REVIEW_KEYS: Readonly<Record<string, string>> = { github: 'pr_number', gerrit: 'change_number' }
const numberOf = (thread: string): { key: string; number: number } | undefined => {
  const at = thread.indexOf(':')
  const key = REVIEW_KEYS[thread.slice(0, at)]
  const number = Number(thread.slice(at + 1))
  return key && Number.isInteger(number) && number > 0 ? { key, number } : undefined
}
/** `{ pr_number }` or `{ change_number }` of the ticket's review, or nothing when it follows none. */
export function reviewOf(ticket: Pick<Ticket, 'follows'>): Record<string, number> {
  const reviews = (ticket.follows ?? []).flatMap(follow => { const review = numberOf(follow.thread); return review ? [{ ...review, closed: !!follow.closed }] : [] })
  const review = reviews.filter(item => !item.closed).at(-1) ?? reviews.at(-1)
  return review ? { [review.key]: review.number } : {}
}
