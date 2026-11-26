/** The Executor tools of a GitLab deployment: the host writes to GitLab for a worker, on the ticket's own threads, signed and marked. */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { z } from 'zod'
// The Executor tools first: they load the resources the shared tool primitives read.
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import { draftTitle, gitlabTools } from '../src/app/tools/gitlab.ts'
import { githubForge } from '../src/forge/github.ts'
import { gitlabForge } from '../src/forge/gitlab.ts'
import type { Ticket } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Tool } from '../src/app/tools/tool.ts'
import { testDeployment, testGitlab, testGitlabDeployment } from './fixtures/deployment.ts'
import { agentMr, execution, gitlabHost, glab, note, refused, ticket, WEB } from './fixtures/gitlab.ts'

const signal = new AbortController().signal
const setup = (fields: Partial<Ticket> = {}, personal = false) => {
  const h = gitlabHost({}, personal ? { deployment: testGitlabDeployment({ gitlab: testGitlab({ identity: 'personal' }) }) } : {})
  h.store.tickets.save(ticket('t1', { execution: execution('fix-1'),
    channels: [{ source: 'gitlab', thread: 'gitlab:issue:3', address: { kind: 'issue', iid: '3' } }],
    follows: [{ thread: 'gitlab:mr:9', own: true }, { thread: 'gitlab:mr:12', own: false }], ...fields }))
  const tools = new Map(gitlabTools(h.ctx, 't1').map(item => [item.name, item]))
  const run = (name: string, args: unknown) => {
    const found: Tool = tools.get(name)!
    return found.execute(found.schema.parse(args), signal)
  }
  return { ...h, run }
}
const bodyOf = (flags: string[], field: string) => flags.find(flag => flag.startsWith(`${field}=`))?.slice(field.length + 1)

it('registers the GitLab tools for a GitLab deployment only', () => {
  const host = (forge: typeof githubForge, deployment = testDeployment()) => ({ forge, forgeContext: { deployment } as unknown as SourceContext,
    resources: { forge: forge.kind } }) as unknown as ExecutorToolsHost
  const names = (tools: Tool[]) => tools.map(item => item.name)
  expect(names(executorTools(host(githubForge), { id: 't' } as Ticket)).filter(item => item.startsWith('gitlab_'))).toEqual([])
  expect(names(executorTools(host(gitlabForge, testGitlabDeployment()), { id: 't' } as Ticket)).filter(item => item.startsWith('gitlab_')))
    .toEqual(['gitlab_reply', 'gitlab_resolve', 'gitlab_mr_create', 'gitlab_mr_update', 'gitlab_mr_close', 'gitlab_upload', 'gitlab_job_retry'])
})

it('writes only to the ticket\'s own Issues and MRs, never one it follows for context, nor for an ended ticket', async () => {
  const h = setup({ follows: [{ thread: 'gitlab:mr:9', own: true }, { thread: 'gitlab:issue:20', own: false }] })
  h.store.threads.save({ key: 'gitlab:issue:20', ref: { source: 'gitlab', id: 'issue:20' }, createdAt: '2026-09-01T00:00:00Z',
    subscriptions: ['t1'], context: ['t1'], correlated: [], pending: [], meta: {} })
  const calls = glab(h.commands, { 'issues/3/notes': (flags: string[]) => flags.includes('POST') ? { id: 77 } : [] })
  await expect(h.run('gitlab_reply', { kind: 'issue', iid: 4, text: 'hi' })).rejects.toThrow('#4 is not one of this ticket\'s GitLab threads; this ticket\'s GitLab threads are !9, #3')
  await expect(h.run('gitlab_reply', { kind: 'issue', iid: 20, text: 'hi' })).rejects.toThrow('#20 is not one of')
  // An MR's iid is no Issue's.
  await expect(h.run('gitlab_reply', { kind: 'issue', iid: 9, text: 'hi' })).rejects.toThrow('#9 is not one of')
  await expect(h.run('gitlab_resolve', { mr_iid: 3, discussion_id: 'abcdef12', resolved: true })).rejects.toThrow('!3 is not one of')
  expect(calls.reads).toEqual([])
  expect(await h.run('gitlab_reply', { kind: 'issue', iid: 3, text: 'hi' })).toEqual({ note_id: 77, url: `${WEB}/-/issues/3#note_77`, reused: false })
  h.store.tickets.save({ ...h.store.tickets.get('t1')!, ended: { at: '2026-09-02T00:00:00Z', by: 'executor', outcome: 'completed' } })
  await expect(h.run('gitlab_reply', { kind: 'issue', iid: 3, text: 'hi' })).rejects.toThrow('Ticket ended')
  h.store.close()
})

it('signs and marks a reply, posts it into its discussion, and posts nothing again when retried', async () => {
  for (const personal of [false, true]) {
    const h = setup({}, personal)
    const posted: string[] = []
    const calls = glab(h.commands, {
      'merge_requests/9/notes': () => posted.map((body, index) => note(80 + index, 'agent-bot', body)),
      'merge_requests/9/discussions/abcdef12/notes': (flags: string[]) => { posted.push(bodyOf(flags, 'body')!); return { id: 80 } },
    })
    const args = { kind: 'mr', iid: 9, discussion_id: 'abcdef12', text: '没有改，因为它已经是默认值。' }
    expect(await h.run('gitlab_reply', args)).toMatchObject({ note_id: 80, reused: false })
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatch(/^没有改，因为它已经是默认值。\n\n/)
    expect(posted[0]).toMatch(/<!-- dsh-superagent:[0-9a-f]{32} -->$/)
    expect(posted[0]!.includes('由 DSH superagent 代 agent-bot 发出')).toBe(personal)
    // The same call finds its note by the marker; another text is another note.
    expect(await h.run('gitlab_reply', args)).toMatchObject({ note_id: 80, reused: true })
    expect(posted).toHaveLength(1)
    expect(calls.bare().filter(path => path?.endsWith('/discussions/abcdef12/notes'))).toHaveLength(1)
    h.store.close()
  }
})

it('opens an MR only from the ticket\'s branch, signs its description, and returns an open one of the account', async () => {
  const h = setup({}, true)
  let created: string[] = []
  const open: unknown[] = []
  glab(h.commands, {
    '': { default_branch: 'main' },
    merge_requests: (flags: string[]) => {
      if (!flags.includes('POST')) return open
      created = flags
      return agentMr(15, 'agent/fix-1')
    },
  })
  await expect(h.run('gitlab_mr_create', { source_branch: 'agent/other', title: 'Fix', description: 'Fixes the margin.' }))
    .rejects.toThrow('last path segment is fix-1')
  expect(await h.run('gitlab_mr_create', { source_branch: 'agent/fix-1', title: 'Fix', description: 'Fixes the margin.', draft: true, labels: ['agent'] }))
    .toEqual({ mr_number: 15, url: `${WEB}/-/merge_requests/15`, reused: false })
  expect(created).toEqual(expect.arrayContaining(['source_branch=agent/fix-1', 'target_branch=main', 'title=Draft: Fix', 'labels=agent']))
  expect(bodyOf(created, 'description')).toMatch(/^Fixes the margin\.\n\n<sub>🤖 Posted by DSH superagent on behalf of agent-bot\..*<\/sub>\n\n<!-- dsh-superagent:\w+ -->$/s)
  // An MR the account already opened from the branch, such as one an earlier attempt opened, is returned as it is.
  open.push(agentMr(15, 'agent/fix-1'))
  expect(await h.run('gitlab_mr_create', { source_branch: 'agent/fix-1', title: 'Fix', description: 'Fixes the margin.' }))
    .toEqual({ mr_number: 15, url: `${WEB}/-/merge_requests/15`, reused: true })
  h.store.close()
})

it('updates an MR the ticket follows, re-signing its description and naming reviewers by id, and closes only one it opened', async () => {
  const h = setup()
  const calls = glab(h.commands, {
    'merge_requests/12': (flags: string[]) => flags.includes('PUT') ? agentMr(12, 'fix') : agentMr(12, 'fix', { title: 'Draft: Fix it' }),
    'members/all': [{ id: 5, username: 'Dana' }, { id: 6, username: 'danae' }],
    'merge_requests/9': (flags: string[]) => agentMr(9, 'agent/fix-1', flags.includes('state_event=close') ? { state: 'closed' } : {}),
    'merge_requests/9/notes': (flags: string[]) => flags.includes('POST') ? { id: 90 } : [],
  })
  await expect(h.run('gitlab_mr_update', { iid: 13, title: 'x' })).rejects.toThrow('!13 is not an MR this ticket follows')
  await expect(h.run('gitlab_mr_update', { iid: 12 })).rejects.toThrow('Name at least one change')
  await h.run('gitlab_mr_update', { iid: 12, draft: false, description: 'Now with tests.', reviewer_usernames: ['dana'], add_labels: ['ui'] })
  const put = calls.calls.find(call => call.path === 'merge_requests/12' && call.flags.includes('PUT'))!.flags
  expect(put).toEqual(expect.arrayContaining(['title=Fix it', 'add_labels=ui', 'reviewer_ids=[5]']))
  expect(bodyOf(put, 'description')).toMatch(/^Now with tests\.\n\n<!-- dsh-superagent:\w+ -->$/)
  // A new title keeps the draft state the MR has.
  await h.run('gitlab_mr_update', { iid: 12, title: 'Fix the margin' })
  expect(calls.calls.filter(call => call.path === 'merge_requests/12' && call.flags.includes('PUT')).at(-1)!.flags).toContain('title=Draft: Fix the margin')
  await expect(h.run('gitlab_mr_update', { iid: 12, reviewer_usernames: ['nobody'] })).rejects.toThrow('nobody is no member')
  await expect(h.run('gitlab_mr_close', { iid: 12, note: 'Carried by !20.' })).rejects.toThrow('!12 is not an MR this ticket opened')
  expect(await h.run('gitlab_mr_close', { iid: 9, note: 'Carried by !20.' })).toEqual({ mr_number: 9, state: 'closed', note_id: 90 })
  const order = calls.calls.filter(call => call.flags.includes('POST') || call.flags.includes('PUT')).map(call => call.path)
  expect(order.slice(-2)).toEqual(['merge_requests/9/notes', 'merge_requests/9'])
  h.store.close()
})

it('uploads only a file inside the ticket directory, and retries only a job of the ticket\'s MRs', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ticket-')))
  mkdirSync(join(root, 'shots'))
  writeFileSync(join(root, 'shots', 'after.png'), 'png')
  writeFileSync(join(tmpdir(), 'outside.png'), 'png')
  const h = setup({ execution: { name: 'fix-1', directory: root, assignment: '' } })
  const calls = glab(h.commands, {
    uploads: { markdown: '![after](/uploads/a/after.png)', url: '/uploads/a/after.png' },
    'jobs/1': { id: 1, ref: 'agent/fix-1' },
    'jobs/2': { id: 2, ref: 'refs/merge-requests/12/head' },
    'jobs/3': { id: 3, ref: 'main' },
    'jobs/1/retry': { id: 101, status: 'pending', web_url: `${WEB}/-/jobs/101` },
    'jobs/2/retry': { id: 102, status: 'pending' },
    'merge_requests/9': agentMr(9, 'agent/fix-1'),
    'merge_requests/12': agentMr(12, 'fix'),
  })
  expect(await h.run('gitlab_upload', { path: 'shots/after.png' })).toEqual({ markdown: '![after](/uploads/a/after.png)', url: '/uploads/a/after.png' })
  expect(calls.calls.at(-1)!.flags).toEqual(['-X', 'POST', '--form', `file=@${join(root, 'shots', 'after.png')}`])
  await expect(h.run('gitlab_upload', { path: '../outside.png' })).rejects.toThrow(/inside the ticket directory|does not exist/)
  await expect(h.run('gitlab_upload', { path: 'shots' })).rejects.toThrow('is not a file')
  expect(await h.run('gitlab_job_retry', { job_id: 1 })).toEqual({ job_id: 101, status: 'pending', url: `${WEB}/-/jobs/101` })
  expect(await h.run('gitlab_job_retry', { job_id: 2 })).toMatchObject({ job_id: 102 })
  await expect(h.run('gitlab_job_retry', { job_id: 3 })).rejects.toThrow('Job 3 runs for main, which is no MR of this ticket')
  glab(h.commands, { 'jobs/4': refused(404, '404 Not Found') })
  await expect(h.run('gitlab_job_retry', { job_id: 4 })).rejects.toThrow('Job 4 is not in the project')
  h.store.close()
})

it('writes GitLab\'s draft prefix once', () => {
  expect(draftTitle('Draft: Fix', true)).toBe('Draft: Fix')
  expect(draftTitle('[Draft] Fix', false)).toBe('Fix')
  expect(draftTitle('Fix', true)).toBe('Draft: Fix')
  expect(z.string().parse(draftTitle('Fix', false))).toBe('Fix')
})
