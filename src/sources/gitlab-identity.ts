/**
 * Who wrote a GitLab note or item, and whom it addresses, under the deployment's GitLab identity (`GitlabIdentityKind`).
 *
 * `dedicated`: the agent has an account of its own; its notes are the ones that account wrote, and `@<login>` addresses it.
 * `personal`: the agent acts with the operator's own account. Every note, MR description and acknowledgement the host writes
 * carries a hidden marker and a visible signature; a note of that account without the marker is the operator's own, and a
 * line that starts with the trigger word and a colon, after any mentions, addresses the agent.
 */
import { escapeRegExp, sameName } from '../infra/text.ts'
import type { GitlabAccount } from '../deployment.ts'

/** The account and identity a decision reads; tests and channels pass only these fields. */
export type GitlabIdentity = Pick<GitlabAccount, 'login' | 'identity' | 'trigger'>
/** The hidden marker of a message the host wrote; `id` is the outbox message's, or the tool call's, id. */
export const markerOf = (id: string): string => `<!-- dsh-superagent:${id} -->`
const MARKER = /<!-- dsh-superagent:[^\s>]+ -->/
/** True when `body` carries a host marker. */
export const marked = (body: string | null | undefined): boolean => MARKER.test(body ?? '')

/** True when the agent wrote a note or item: its account's, and with `personal` only one the host marked. */
export function byAgent(author: string, body: string | null | undefined, identity: GitlabIdentity): boolean {
  if (!sameName(author, identity.login)) return false
  return identity.identity === 'dedicated' || marked(body)
}
/** True when the operator wrote it with their own account under `personal`: the account's, without the host's marker. */
export const byOwner = (author: string, body: string | null | undefined, identity: GitlabIdentity): boolean =>
  identity.identity === 'personal' && sameName(author, identity.login) && !marked(body)

/** `@login`, in any case, not inside an address or a longer name. */
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?<![\\w@.])@${escapeRegExp(login)}(?![A-Za-z0-9_-]|\\.\\w)`, 'i').test(text)

/**
 * The text of a note a person reads as their own words: without fenced code (``` and ~~~), GitLab's `>>>` quote blocks, `>`
 * quotes and the lines that continue them, HTML comments, `<details>` blocks, indented code and inline code.
 */
export function ownWords(text: string): string {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<details[\s\S]*?<\/details>/gi, '')
  const lines: string[] = []
  let fence: string | undefined
  let quoteBlock = false
  let quoted = false
  for (const line of stripped.split(/\r?\n/)) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) { if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length && !line.trim().slice(open[1]!.length).trim()) fence = undefined; continue }
    if (open) { fence = open[1]; continue }
    if (/^ {0,3}>>>\s*$/.test(line)) { quoteBlock = !quoteBlock; continue }
    if (quoteBlock) continue
    if (/^ {0,3}>/.test(line)) { quoted = true; continue }
    // A line right after a quote, with no blank line between, continues it.
    if (quoted && line.trim()) continue
    quoted = false
    if (/^( {4,}|\t)/.test(line)) continue
    lines.push(line.replace(/(`+)[\s\S]*?\1/g, ''))
  }
  return lines.join('\n')
}
/**
 * True when a line of `text` addresses the agent by `trigger`: at the line's start (at most three spaces in), after any
 * mentions each followed by a separator, the word and a colon (`:` or `：`), in any case. Quotes and code do not count.
 */
export function summons(text: string, trigger: string): boolean {
  if (!trigger) return false
  const mention = '@[\\w.\\-]+(?![\\w.\\-])[\\s,，、]+'
  const line = new RegExp(`^ {0,3}(?:${mention})*${escapeRegExp(trigger)}\\s*[:：]`, 'i')
  return ownWords(text).split('\n').some(item => line.test(item))
}
/** True when a note or item addresses the agent: by `@login` with `dedicated`, by the trigger word with `personal`. */
export const addressesAgent = (text: string, identity: GitlabIdentity): boolean =>
  identity.identity === 'personal' ? summons(text, identity.trigger) : mentions(text, identity.login)
/**
 * True when, under `personal`, a note only asks the operator as a person: it mentions their account and does not address the
 * agent. Such a note is no message for the agent, unless it answers in a discussion the agent took part in.
 */
export const forOwnerOnly = (text: string, identity: GitlabIdentity): boolean =>
  identity.identity === 'personal' && mentions(ownWords(text), identity.login) && !summons(text, identity.trigger)

/** Han characters without kana read as Chinese; anything else as English, as the end notices choose. */
export const chinese = (text: string): boolean => /\p{Script=Han}/u.test(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
/**
 * The visible line a `personal` deployment adds under everything the host writes: who wrote it on whose behalf, and how to
 * address the agent rather than the person. It names the account without `@`, so quoting it mentions nobody.
 */
export function signature(identity: GitlabIdentity, text: string): string {
  const { login, trigger } = identity
  return chinese(text)
    ? `<sub>🤖 由 DSH superagent 代 ${login} 发出。找 agent 请在回复开头写 \`${trigger}:\`；直接 @${'\u200b'}${login} 是找本人。</sub>`
    : `<sub>🤖 Posted by DSH superagent on behalf of ${login}. To address the agent, start your reply with \`${trigger}:\`; mentioning @${'\u200b'}${login} reaches the person.</sub>`
}
/**
 * A body the host posts: the text, under `personal` the signature, and the marker of `id`. `language` is the text whose
 * language the signature follows (the request a reply answers), the text itself by default.
 */
export function signedBody(identity: GitlabIdentity, id: string, text: string, language = text): string {
  const parts = [text.trimEnd()]
  if (identity.identity === 'personal') parts.push(signature(identity, language))
  return `${parts.join('\n\n')}\n\n${markerOf(id)}`
}
