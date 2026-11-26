import { AGENT } from './fixtures/gitlab-identity.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { gitlabForge } from '../src/forge/gitlab.ts'
import { forgeOf } from '../src/forge/index.ts'
import { gitlabThreadContext, jobCheck, readGitlab, readGitlabPath } from '../src/sources/gitlab-read.ts'
import { ciCounts, ciFailures, ciSummary } from '../src/sources/github-read.ts'
import { noteTrigger, NoteSchema } from '../src/sources/gitlab-trigger.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'
import { diffNote, discussion, glab, issue, mr, note, WEB } from './fixtures/gitlab.ts'

const commands = new Commands(() => testGitlabDeployment(), {}, new AbortController().signal)
afterEach(() => vi.restoreAllMocks())

it('registers the GitLab forge with its review parameter, resources and repository reads', () => {
  expect(forgeOf('gitlab')).toBe(gitlabForge)
  expect(gitlabForge).toMatchObject({ kind: 'gitlab', source: 'gitlab', setupFields: ['url', 'project', 'cli', 'identity', 'workerCli', 'trigger'], skill: 'gitlab',
    resource: { prefix: 'gitlab/' }, review: { param: { name: 'mr_number' } } })
  expect(gitlabForge.review.param.describe({ kind: 'gitlab', login: 'agent-bot', email: '', repository: '', web: '' })).toContain('agent-bot')
})

it('reads an Issue or MR as its author, time, title, state, description and an MR\'s branches', async () => {
  glab(commands, { 'merge_requests/34': mr(34, { draft: true, labels: ['ui'], description: 'Details' }) })
  expect(await readGitlab(commands, 'gitlab/merge_requests/34')).toEqual({ iid: 34, title: 'Fix the margin', state: 'opened', draft: true,
    source_branch: 'fix', target_branch: 'main', labels: ['ui'], id: '34', from: 'carol', at: '2026-09-09T00:00:00Z', text: 'Details',
    url: `${WEB}/-/merge_requests/34` })
})

it('reads a page of notes as messages, without system notes other than review decisions, and names the next page', async () => {
  const notes = [note(1, 'alice', 'first'), note(2, 'alice', 'added 1 commit', { system: true }), note(3, 'carol', 'approved this merge request', { system: true }),
    diffNote(4, 'review_bot', 'nit'), ...Array.from({ length: 16 }, (_, index) => note(10 + index, 'alice', 'more'))]
  const api = glab(commands, { 'issues/12': issue(12), 'issues/12/notes': notes })
  const page = await readGitlab(commands, 'gitlab/issues/12/notes/2') as { messages: Record<string, unknown>[]; next_resource: string }
  expect(api.reads.at(-1)).toBe('issues/12/notes?sort=asc&order_by=created_at&per_page=20&page=2')
  expect(page.next_resource).toBe('gitlab/issues/12/notes/3')
  expect(page.messages.slice(0, 3)).toEqual([
    { id: '1', from: 'alice', at: '2026-09-09T00:00:01Z', text: 'first', url: `${WEB}/-/issues/12#note_1` },
    { id: '3', from: 'carol', at: '2026-09-09T00:00:03Z', text: 'approved this merge request', url: `${WEB}/-/issues/12#note_3` },
    { id: '4', from: 'review_bot', at: '2026-09-09T00:00:04Z', text: 'nit', bot: true, url: `${WEB}/-/issues/12#note_4`, path: 'src/render.ts', line: 43 }])
})

it('reads one discussion, each later note replying to its first', async () => {
  glab(commands, { 'merge_requests/34': mr(34), 'merge_requests/34/discussions/abcdef12': discussion('abcdef12', [diffNote(1, 'carol', 'why?'), note(2, 'alice', 'because')]) })
  const read = await readGitlab(commands, 'gitlab/merge_requests/34/discussion/abcdef12') as { messages: { id: string; reply_to?: string }[] }
  expect(read.messages.map(message => [message.id, message.reply_to])).toEqual([['1', undefined], ['2', '1']])
})

it('rejects unsupported or escaping resources without a request', async () => {
  const api = glab(commands, {})
  for (const resource of ['gitlab/../x', 'gitlab/issues/1/pipelines', 'gitlab/merge_requests/1/pipelines/2', 'gitlab/issues/1?x=1',
    'gitlab/issues/1/discussion/12', 'gitlab/issues/1/notes/abc', 'gitlab/pulls/1', 'github/issues/1']) {
    await expect(readGitlab(commands, resource), resource).rejects.toThrow()
  }
  expect(api.run).not.toHaveBeenCalled()
})

it('maps pipeline jobs onto CI checks: failures that may not fail, cancels, skips and running jobs', () => {
  const jobs = [{ name: 'lint', status: 'failed', allow_failure: false }, { name: 'flaky', status: 'failed', allow_failure: true },
    { name: 'e2e', status: 'canceled' }, { name: 'unit', status: 'success' }, { name: 'deploy', status: 'manual' },
    { name: 'docs', status: 'skipped' }, { name: 'build', status: 'running' }, { name: 'pack', status: 'pending' }]
  const snapshot = { head: 'abc1234def', checks: jobs.map(jobCheck), statuses: [] }
  expect(ciCounts(snapshot)).toEqual({ failed: 2, running: 2 })
  expect(ciFailures(snapshot)).toEqual(['e2e', 'lint'])
  expect(ciSummary(snapshot, 'MR !34', 'gitlab/merge_requests/34/pipelines')).toBe(
    'CI failed 2/8 on MR !34 at abc1234: lint, e2e; 2 still running\nRead gitlab/merge_requests/34/pipelines for every check.')
})

it('reads an MR\'s head pipeline and a commit\'s newest pipeline as CI snapshots', async () => {
  const api = glab(commands, { 'merge_requests/34': mr(34, { head_pipeline: { id: 9, sha: 'abc1234def', status: 'failed' } }),
    'pipelines/9/jobs': [{ name: 'unit', status: 'success' }, { name: 'lint', status: 'failed', allow_failure: false }],
    pipelines: [{ id: 9, sha: 'abc1234def' }] })
  const mrChecks = { head: 'abc1234def', checks: [{ name: 'lint', status: 'completed', conclusion: 'failure' },
    { name: 'unit', status: 'completed', conclusion: 'success' }], statuses: [] }
  expect(await readGitlab(commands, 'gitlab/merge_requests/34/pipelines')).toEqual(mrChecks)
  expect(await readGitlab(commands, 'gitlab/commits/abc1234def/pipelines')).toEqual(mrChecks)
  expect(api.reads).toContain('pipelines?sha=abc1234def&order_by=id&sort=desc&per_page=1')
  glab(commands, { 'merge_requests/35': mr(35) })
  expect(await readGitlab(commands, 'gitlab/merge_requests/35/pipelines')).toEqual({ head: 'abc1234def', checks: [], statuses: [] })
})

it('reads files and directories of the default branch, and refuses hidden paths', async () => {
  const api = glab(commands, { '': { default_branch: 'main' }, 'repository/files/src%2Findex.ts/raw': 'export {}\n',
    'repository/tree': [{ name: 'b.ts' }, { name: '.env' }, { name: 'a.ts' }, { name: 'node_modules' }] })
  expect(await readGitlabPath(commands, 'src/index.ts', 'file')).toBe('export {}\n')
  expect(await readGitlabPath(commands, 'src', 'directory')).toBe('a.ts\nb.ts')
  expect(api.reads).toEqual(['', 'repository/files/src%2Findex.ts/raw?ref=main', '', 'repository/tree?path=src&ref=main&per_page=100'])
  for (const path of ['.git/config', 'src/../x', 'node_modules/a']) await expect(readGitlabPath(commands, path, 'file')).rejects.toThrow('non-hidden')
})

it('gives an assessment of a threaded note its discussion, and of another note the conversation by page', async () => {
  const thread = [note(1, 'carol', 'why?'), note(2, 'alice', '@agent-bot see above')]
  glab(commands, { 'merge_requests/34': mr(34), 'merge_requests/34/discussions/abcdef12': discussion('abcdef12', thread),
    'merge_requests/34/notes': thread })
  const trigger = noteTrigger(NoteSchema.parse(thread[1]), { id: 'abcdef12', individual_note: false },
    { iid: 34, isMr: true, url: `${WEB}/-/merge_requests/34` }, AGENT)!
  const context = gitlabThreadContext
  const read = await context.read(commands, trigger, 'thread', undefined, {})
  expect(read).toMatchObject({ status: 'discussion' })
  expect(read.messages.map(message => message.id)).toEqual([`${WEB}/-/merge_requests/34#note_1`, `${WEB}/-/merge_requests/34#note_2`])
  expect(context.messageId(trigger)).toBe(read.messages[1]!.id)
  expect((await context.read(commands, trigger, 'parent', undefined, {})).messages.map(message => message.id)).toEqual([read.messages[0]!.id])
  const plain = { ...trigger, channel: { ...trigger.channel!, address: { kind: 'mr', iid: '34' } } }
  const page = await context.read(commands, plain, 'thread', undefined, {})
  expect(page.messages.map(message => message.id)).toEqual([`${WEB}/-/merge_requests/34`, ...read.messages.map(message => message.id)])
  expect(page.next).toBeUndefined()
})
