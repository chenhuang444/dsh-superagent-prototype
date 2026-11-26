/** GitLab outbound channel: posts notes on Issues and MRs, and replies into their discussions, under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { markerOf, signedBody } from './gitlab-identity.ts'
import { gitlabOf } from '../deployment.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { gitlabPage } from './gitlab-trigger.ts'

const NoteSchema = z.looseObject({ id: z.number(), body: z.string().nullish(), author: z.looseObject({ username: z.string() }).nullish() })
/** True when GitLab refuses notes for good: the Issue or MR is locked (403 naming it). 404 is retried, as on GitHub. */
const gone = (error: unknown): boolean => error instanceof CliError && error.code === 403 && /locked/i.test(error.message)
const missing = (error: unknown): boolean => error instanceof CliError && error.code === 404
/**
 * Posts a note once per message id: into the address's discussion when it names one (a top-level note when that discussion
 * was deleted), else on the Issue or MR. A hidden marker in the body lets a retry find a note an earlier attempt posted; under
 * `personal` a visible signature above it says the agent wrote it, in the language of the message.
 */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const gitlab = gitlabOf(commands.deployment)
  const { login } = gitlab
  const { kind, iid, discussion } = message.channel.address
  if ((kind !== 'issue' && kind !== 'mr') || !/^[1-9]\d*$/.test(iid ?? '')) throw new Error('Missing GitLab reply target')
  const item = `${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
  const marker = markerOf(message.id)
  const body = `body=${signedBody(gitlab, message.id, message.text)}`
  try {
    // The notes of an Issue or MR include those in its discussions, so one list finds an earlier attempt wherever it went.
    const notes = await commands.gitlabPages(NoteSchema, `${item}/notes?per_page=100`)
    if (notes.some(note => sameName(note.author?.username ?? '', login) && (note.body ?? '').includes(marker))) return 'sent'
    if (discussion && /^[0-9a-f]+$/i.test(discussion)) {
      const replied = await commands.gitlab(z.unknown(), `${item}/discussions/${discussion}/notes`, '-X', 'POST', '-f', body)
        .then(() => true, (error: unknown) => { if (missing(error)) return false; throw error })
      if (replied) return 'sent'
    }
    await commands.gitlab(z.unknown(), `${item}/notes`, '-X', 'POST', '-f', body)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** The page of the address's Issue or MR, or of its note; empty while the deployment's GitLab address is unknown. */
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const isMr = address.kind === 'mr'
  const iid = Number(address.iid)
  const name = `${isMr ? '!' : '#'}${address.iid ?? ''}`
  const page = links.gitlab?.url && links.repository && iid ? gitlabPage(links.gitlab.url, links.repository, isMr, iid) : ''
  return { url: address.url ?? page,
    label: address.discussion ? { zh: `GitLab ${name} 的讨论`, en: `Discussion on GitLab ${name}` } : { zh: `GitLab ${name}`, en: `GitLab ${name}` } }
}
