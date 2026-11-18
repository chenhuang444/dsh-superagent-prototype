import { afterEach, expect, it, vi } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { gitlabLink, sendGitlab } from '../src/sources/gitlab-channel.ts'
import { gitlabChannel } from '../src/sources/gitlab-trigger.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'
import { glab, note, refused, WEB } from './fixtures/gitlab.ts'

const commands = new Commands(() => testGitlabDeployment(), {}, new AbortController().signal)
afterEach(() => vi.restoreAllMocks())
const message = (channel = gitlabChannel(false, 12)): OutboundMessage => ({ id: 'm1', channel, text: 'On it.', kind: 'reply' } as OutboundMessage)
const marker = '<!-- dsh-superagent:m1 -->'

it('posts a top-level note with a hidden marker of the message id', async () => {
  const api = glab(commands, { 'issues/12/notes': (flags: string[]) => flags.includes('POST') ? { id: 9 } : [] })
  expect(await sendGitlab({ commands }, message())).toBe('sent')
  expect(api.calls.at(-1)).toEqual({ path: 'issues/12/notes', flags: ['-X', 'POST', '-f', `body=On it.\n\n${marker}`] })
})

it('sends a message once: a note of the agent with its marker is found again, wherever it went', async () => {
  const api = glab(commands, { 'merge_requests/34/notes': [note(1, 'carol', marker), note(2, 'agent-bot', `Done\n\n${marker}`)] })
  expect(await sendGitlab({ commands }, message(gitlabChannel(true, 34, 'abcdef12')))).toBe('sent')
  expect(api.calls.map(call => call.flags.includes('POST'))).toEqual([false])
})

it('replies into the discussion of the note it answers, and on the MR when that discussion was deleted', async () => {
  const replied = glab(commands, { 'merge_requests/34/discussions/abcdef12/notes': { id: 10 } })
  expect(await sendGitlab({ commands }, message(gitlabChannel(true, 34, 'abcdef12')))).toBe('sent')
  expect(replied.bare()).toEqual(['merge_requests/34/notes', 'merge_requests/34/discussions/abcdef12/notes'])
  vi.restoreAllMocks()
  const fallback = glab(commands, { 'merge_requests/34/discussions/abcdef12/notes': refused(404, '404 Discussion Not Found'),
    'merge_requests/34/notes': (flags: string[]) => flags.includes('POST') ? { id: 11 } : [] })
  expect(await sendGitlab({ commands }, message(gitlabChannel(true, 34, 'abcdef12')))).toBe('sent')
  expect(fallback.calls.filter(call => call.flags.includes('POST')).map(call => call.path))
    .toEqual(['merge_requests/34/discussions/abcdef12/notes', 'merge_requests/34/notes'])
})

it('answers gone for a locked Issue, and throws for other failures so the outbox retries', async () => {
  glab(commands, { 'issues/12/notes': (flags: string[]) => flags.includes('POST') ? refused(403, '403 Forbidden - Your note was not posted because the issue is locked') : [] })
  expect(await sendGitlab({ commands }, message())).toBe('gone')
  vi.restoreAllMocks()
  glab(commands, { 'issues/12/notes': (flags: string[]) => flags.includes('POST') ? refused(403, '403 Forbidden') : [] })
  await expect(sendGitlab({ commands }, message())).rejects.toThrow('403 Forbidden')
  vi.restoreAllMocks()
  glab(commands, { 'issues/12/notes': refused(502, '502 Bad Gateway') })
  await expect(sendGitlab({ commands }, message())).rejects.toThrow('502')
  await expect(sendGitlab({ commands }, message({ source: 'gitlab', thread: 'gitlab:x', address: { kind: 'issue', iid: '../1' } }))).rejects.toThrow('Missing GitLab reply target')
})

it('links an address to its Issue or MR on the configured server', () => {
  const links = { repository: 'acme/widgets', gitlab: { url: 'https://gitlab.example.com' } }
  expect(gitlabLink(gitlabChannel(true, 34).address, links)).toEqual({ url: `${WEB}/-/merge_requests/34`, label: { zh: 'GitLab !34', en: 'GitLab !34' } })
  expect(gitlabLink(gitlabChannel(false, 12, 'abcdef12', `${WEB}/-/issues/12#note_5`).address, links))
    .toEqual({ url: `${WEB}/-/issues/12#note_5`, label: { zh: 'GitLab #12 的讨论', en: 'Discussion on GitLab #12' } })
  expect(gitlabLink(gitlabChannel(false, 12).address, { repository: 'acme/widgets' }).url).toBe('')
})
