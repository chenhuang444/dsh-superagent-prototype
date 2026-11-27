import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { key, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { apply, gitlabKind, pollRound, pollThreads } from '../src/sources/gitlab.ts'
import { apply as applyGithub } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema } from '../src/policy.ts'
import { testDeployment, testGitlab, testGitlabDeployment } from './fixtures/deployment.ts'
import { markerOf } from '../src/sources/gitlab-identity.ts'
import { agentMr, diffNote, discussion, execution, gitlabHost, glab, issue, mr, note, refused, ticket, type GitlabHost } from './fixtures/gitlab.ts'

// The payloads are of 2026-09-09; the rounds run the next day, within the polling horizon.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-10T00:00:00Z') }) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const SINCE = '2026-09-08T00:00:00.000Z'
/** Both lists read from `SINCE`, as after an earlier round. */
const started = (h: GitlabHost) => { for (const stream of ['issues', 'merge_requests'] as const) h.store.set(KV.gitlab.stream(stream), { since: SINCE }) }
const taken = (h: GitlabHost): Trigger[] => h.receive.mock.calls.map(([trigger]) => trigger)

it('starts each list at its first round, so nothing older is read', async () => {
  const h = gitlabHost()
  const api = glab(h.commands, { issues: [issue(12, { description: '@agent-bot old' })] })
  await pollRound(h.ctx)
  expect(api.reads).toEqual([])
  expect(Date.parse(h.store.get(KV.gitlab.stream('issues'))!.since)).toBeGreaterThan(Date.parse(SINCE))
  expect(h.board.all.gitlab).toMatchObject({ state: 'ready' })
  h.store.close()
})

it('takes in new Issues and notes that mention the agent, once, skips its own and other notes, and moves the cursors', async () => {
  const h = gitlabHost()
  started(h)
  const notes = [note(1, 'alice', '@agent-bot can you take this?'), note(2, 'agent-bot', 'On it @agent-bot'), note(3, 'bob', 'unrelated'),
    note(4, 'alice', 'changed the description', { system: true })]
  const api = glab(h.commands, { issues: [issue(12, { description: '@agent-bot please fix the login' }), issue(13, { description: 'no mention' }),
    issue(14, { created_at: '2026-08-01T00:00:00Z', description: '@agent-bot edited later' })],
    'issues/12/discussions': notes.map((item, index) => discussion(`d${index}abcdef`, [item])) })
  await pollRound(h.ctx)
  expect(taken(h).map(trigger => trigger.id)).toEqual([key('gitlab-issue', '12'), key('gitlab-note', 'issue:12', '1')])
  expect(await h.receive.mock.results[0]!.value).toBe('stored')
  // An allowed sender's mention is an explicit request.
  expect(h.engine.candidate(key('gitlab-issue', '12'))?.strength).toBe('explicit')
  expect(api.reads[0]).toBe(`issues?updated_after=${encodeURIComponent(SINCE)}&order_by=updated_at&sort=asc&per_page=100`)
  expect(Date.parse(h.store.get(KV.gitlab.stream('issues'))!.since)).toBeGreaterThan(Date.parse(SINCE))
  expect(h.store.get(KV.gitlab.cursor('issue:12'))).toBeDefined()
  expect(h.store.threads.get('gitlab:issue:12')!.meta).toMatchObject({ title: 'Login fails', label: '#12 Login fails', facts: { iid: { value: '#12' } } })
  // The next round reads the same items again; their Triggers are duplicates.
  h.store.set(KV.gitlab.stream('issues'), { since: SINCE })
  h.store.set(KV.gitlab.cursor('issue:12'), SINCE)
  await pollRound(h.ctx)
  expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
  expect(h.store.read.threadTriggers('gitlab:issue:12', 10).map(trigger => trigger.id).sort())
    .toEqual([key('gitlab-issue', '12'), key('gitlab-note', 'issue:12', '1')].sort())
  h.store.close()
})

it('takes in every new Issue, MR and note while the observe switches are on, as observed Triggers', async () => {
  const h = gitlabHost({ observeIssues: true, observeMergeRequests: true, observeComments: true })
  started(h)
  glab(h.commands, { issues: [issue(13, { description: 'no mention' })], merge_requests: [mr(13)], 'merge_requests/13': mr(13),
    'merge_requests/13/discussions': [discussion('abcdef12', [diffNote(5, 'bob', 'nit'), note(6, 'carol', 'agreed')])] })
  await pollRound(h.ctx)
  expect(taken(h).map(trigger => [trigger.id, trigger.meta.kind])).toEqual([[key('gitlab-issue', '13'), 'issue'], [key('gitlab-mr', '13'), 'mr'],
    [key('gitlab-note', 'mr:13', '5'), 'diff'], [key('gitlab-note', 'mr:13', '6'), 'note']])
  expect(taken(h)[3]!.channel!.address).toMatchObject({ kind: 'mr', iid: '13', discussion: 'abcdef12' })
  expect(taken(h).every(trigger => !trigger.addressed)).toBe(true)
  h.store.close()
})

it('takes in a review decision on the agent\'s MR as a review Trigger, and skips other system notes', async () => {
  const h = gitlabHost()
  started(h)
  glab(h.commands, { merge_requests: [agentMr(34, 'agent/fix')], 'merge_requests/34': agentMr(34, 'agent/fix'),
    'merge_requests/34/discussions': [discussion('a1111111', [note(7, 'carol', 'approved this merge request', { system: true })]),
      discussion('a2222222', [note(8, 'carol', 'added 1 commit', { system: true })]),
      discussion('a3333333', [note(9, 'carol', 'requested changes', { system: true })])] })
  await pollRound(h.ctx)
  expect(taken(h).map(trigger => [trigger.text, trigger.meta.kind, trigger.addressed])).toEqual([['approved this merge request', 'review', undefined],
    ['requested changes', 'review', undefined]])
  h.store.close()
})

it('keeps every read position when the Source stops during a read', async () => {
  const h = gitlabHost()
  started(h)
  const controller = new AbortController()
  glab(h.commands, { issues: [issue(12, { created_at: '2026-08-01T00:00:00Z' })],
    'issues/12/discussions': () => { controller.abort(); return [discussion('d1abcdef', [note(1, 'alice', '@agent-bot more')])] } })
  await pollRound(h.ctx, controller.signal)
  expect(h.receive).not.toHaveBeenCalled()
  expect(h.store.get(KV.gitlab.stream('issues'))).toEqual({ since: SINCE })
  expect(h.store.get(KV.gitlab.cursor('issue:12'))).toBeUndefined()
  h.store.close()
})

it('keeps a list\'s cursor before an item whose read failed, reads the other items, and fails the round', async () => {
  const h = gitlabHost()
  started(h)
  glab(h.commands, { issues: [issue(12, { updated_at: '2026-09-09T00:00:00Z' }), issue(13, { updated_at: '2026-09-09T01:00:00Z', description: '@agent-bot hi' })],
    'issues/12/discussions': refused(502, '502 Bad Gateway') })
  await expect(pollRound(h.ctx)).rejects.toThrow('1 GitLab reads failed: #12: Error: glab: 502 Bad Gateway (HTTP 502)')
  expect(taken(h).map(trigger => trigger.id)).toEqual([key('gitlab-issue', '13')])
  expect(h.store.get(KV.gitlab.stream('issues'))).toEqual({ since: '2026-09-08T23:59:59.000Z' })
  expect(h.store.get(KV.gitlab.cursor('issue:12'))).toBeUndefined()
  h.store.close()
})

it('polls a subscribed Thread for every note since its cursor, and the pipeline of a ticket\'s MR after a first look', async () => {
  const h = gitlabHost()
  h.store.tickets.save(ticket('t1', { execution: execution('fix'), follows: [{ thread: 'gitlab:mr:34', own: true }] }))
  h.store.threads.save({ key: 'gitlab:mr:34', ref: { source: 'gitlab', id: 'mr:34' }, createdAt: '2026-09-01T00:00:00Z', lastAt: new Date().toISOString(),
    subscriptions: ['t1'], correlated: [], pending: [], meta: {} })
  let status = 'running'
  const api = glab(h.commands, { 'merge_requests/34': agentMr(34, 'agent/fix', { head_pipeline: { id: 9, sha: 'abc1234def', status: 'running' } }),
    'pipelines/9/jobs': () => [{ name: 'unit', status }],
    'merge_requests/34/discussions': [discussion('a1111111', [note(1, 'agent-bot', 'mine'), note(2, 'bob', 'no mention')], true)] })
  await pollRound(h.ctx)
  expect(taken(h).map(trigger => [trigger.actor.id, trigger.text])).toEqual([['bob', 'no mention']])
  expect(h.store.get(KV.gitlab.cursor('mr:34'))).toBeDefined()
  expect(api.bare().filter(path => path === 'merge_requests/34')).toEqual(['merge_requests/34'])
  expect(h.store.threads.get('gitlab:mr:34')!.meta.facts).toMatchObject({ ci: { label: { en: 'CI running' } } })
  status = 'failed'
  await pollRound(h.ctx)
  expect(taken(h).at(-1)).toMatchObject({ id: key('gitlab-ci', 'mr:34', '1'), human: false, meta: { ci: true, iid: 34 },
    text: 'CI failed 1/1 on MR !34 at abc1234: unit\nRead gitlab/merge_requests/34/pipelines for every check.' })
  h.store.close()
})

it('tells of the default branch\'s pipeline when its failed jobs change and once it passes again, after a first look', async () => {
  const h = gitlabHost({ observeCi: true })
  started(h)
  let jobs = [{ name: 'unit', status: 'failed' }]
  glab(h.commands, { '': { default_branch: 'main' }, pipelines: [{ id: 9, sha: 'abc1234def' }], 'pipelines/9/jobs': () => jobs })
  await pollRound(h.ctx)
  expect(h.receive).not.toHaveBeenCalled()
  jobs = [{ name: 'unit', status: 'running' }]
  await pollRound(h.ctx)
  expect(h.receive).not.toHaveBeenCalled()
  jobs = [{ name: 'unit', status: 'success' }]
  await pollRound(h.ctx)
  expect(taken(h)).toEqual([expect.objectContaining({ id: key('gitlab-ci', 'branch:main', '1'), threads: [{ source: 'gitlab', id: 'ci:main' }],
    url: 'https://gitlab.example.com/acme/widgets/-/pipelines/9', text: expect.stringMatching(/^CI passed 1\/1 on main at abc1234/) })])
  // A subscribed default-branch Thread has no Issue to read.
  h.store.threads.save({ key: 'gitlab:ci:main', ref: { source: 'gitlab', id: 'ci:main' }, createdAt: new Date().toISOString(), lastAt: new Date().toISOString(),
    subscriptions: ['t'], correlated: [], pending: [], meta: {} })
  await pollThreads(h.ctx)
  expect(h.store.threads.get('gitlab:ci:main')!.meta.pollError).toBeUndefined()
  h.store.close()
})

it('waits for setup, stays off on another forge, pauses while off, and reports a failure escaping the loop as its health', async () => {
  const start = async (overrides: Parameters<typeof gitlabHost>[1], enabled = true) => {
    const board = new HealthBoard()
    const settings = SettingsSchema.parse({ sources: { gitlab: { enabled, config: {} } } })
    const sources = new SourceRegistry(() => settings, board)
    const h = gitlabHost({}, { sources, ...overrides })
    const disposers: (() => unknown)[] = []
    apply({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(board.all.gitlab?.state).not.toBe('starting'))
    const health = { ...board.all.gitlab }
    expect(sources.kind('gitlab')).toBe(gitlabKind)
    for (const dispose of disposers) await dispose()
    expect(sources.kind('gitlab')).toBeUndefined()
    h.store.close()
    return health
  }
  expect(await start({ configured: () => false })).toMatchObject({ state: 'paused', code: 'setupPending' })
  expect(await start({ deployment: testDeployment() })).toMatchObject({ state: 'paused', code: 'notForge', detail: 'Off: not this deployment\'s code host' })
  expect(await start({}, false)).toMatchObject({ state: 'paused', code: 'sourceOff' })
  expect(await start({ ready: Promise.reject(new Error('lock held')) })).toMatchObject({ state: 'error', detail: expect.stringContaining('lock held') })
})

it('keeps the GitHub Source off on a GitLab deployment', async () => {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
  const h = gitlabHost({}, { sources })
  const disposers: (() => unknown)[] = []
  applyGithub({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
  await vi.waitFor(() => expect(board.all.github).toMatchObject({ state: 'paused', code: 'notForge' }))
  for (const dispose of disposers) await dispose()
  h.store.close()
})

describe('personal identity', () => {
  const personal = testGitlabDeployment({ gitlab: testGitlab({ identity: 'personal', login: 'alice', workerCli: '/bin/false' }) })
  const host = (config: Record<string, unknown> = {}) => {
    const h = gitlabHost(config, { deployment: personal })
    vi.spyOn(h.commands, 'deployment', 'get').mockReturnValue(personal)
    return h
  }

  it('takes the person\'s own notes and summons, skips the agent\'s marked notes and notes only for the person', async () => {
    const h = host()
    started(h)
    const notes = [note(1, 'alice', 'agent: please fix the login'), note(2, 'alice', `On it.\n\n${markerOf('m1')}`),
      note(3, 'bob', '@alice can you look?'), note(4, 'bob', '@alice agent: change the label'), note(5, 'alice', '@agent-bot old style')]
    glab(h.commands, { issues: [issue(12, { description: 'details' })],
      'issues/12/discussions': notes.map((item, index) => discussion(`d${index}abcdef`, [item])) })
    await pollRound(h.ctx)
    expect(taken(h).map(trigger => trigger.id)).toEqual([key('gitlab-note', 'issue:12', '1'), key('gitlab-note', 'issue:12', '4')])
    expect(taken(h)[0]).toMatchObject({ human: true, addressed: 'mention', actor: { id: 'alice' } })
    h.store.close()
  })

  it('reads every note of a subscribed Thread but drops one only for the person outside the agent\'s discussions', async () => {
    const h = host()
    h.store.tickets.save(ticket('t1', { execution: execution('t1') }))
    h.store.threads.save({ key: 'gitlab:issue:12', ref: { source: 'gitlab', id: 'issue:12' }, createdAt: SINCE, lastAt: new Date().toISOString(),
      subscriptions: ['t1'], correlated: [], pending: [], meta: {} })
    const agentReply = note(2, 'alice', `Which one?\n\n${markerOf('m2')}`)
    glab(h.commands, { 'issues/12': issue(12), 'issues/12/discussions': [
      discussion('aaaa1111', [note(1, 'bob', '@alice you around?')]),
      discussion('bbbb2222', [note(3, 'carol', 'the button'), agentReply, note(4, 'bob', '@alice this one')], true)] })
    await pollThreads(h.ctx)
    expect(taken(h).map(trigger => trigger.meta.noteId)).toEqual([3, 4])
    h.store.close()
  })

  it('treats an MR of the person\'s account on a ticket branch as the agent\'s, signs it and withdraws auto-merge', async () => {
    const h = host({ observeMergeRequests: true })
    started(h)
    h.store.tickets.save(ticket('t1', { execution: execution('t1') }))
    const opened = mr(30, { author: { id: 1, username: 'alice' }, source_branch: 'agent/t1', description: 'pushed with -o', merge_when_pipeline_succeeds: true })
    const api = glab(h.commands, { merge_requests: [opened], 'merge_requests/30': (flags: string[]) => flags.includes('PUT') ? {} : opened,
      'merge_requests/30/cancel_merge_when_pipeline_succeeds': {} })
    await pollRound(h.ctx)
    expect(taken(h).map(trigger => trigger.id)).not.toContain(key('gitlab-mr', '30'))
    expect(api.calls.some(call => call.path === 'merge_requests/30/cancel_merge_when_pipeline_succeeds')).toBe(true)
    const put = api.calls.find(call => call.path === 'merge_requests/30' && call.flags.includes('PUT'))!
    expect(put.flags.find(flag => flag.startsWith('description='))).toContain(markerOf('mr-30'))
    h.store.close()
  })
})

it('warns under personal of a Maintainer role, unreported scopes and tokens about to expire', () => {
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
  const facts = gitlabKind.facts!(testGitlabDeployment({ gitlab: testGitlab({ identity: 'personal', workerCli: '/bin/false', accessLevel: 40,
    tokenUnchecked: true, expiresAt: '2027-12-31', workerExpiresAt: soon }) }))
  expect(facts.identity).toMatchObject({ en: expect.stringContaining('Maintainer') })
  expect((facts.identity as { en: string }).en).toContain('15.5')
  expect(facts.workerCli).toMatchObject({ en: expect.stringContaining(`workerCli ${soon}`) })
  expect(gitlabKind.facts!(testGitlabDeployment({ gitlab: testGitlab({ accessLevel: 40 }) })).identity).toBeUndefined()
})
it('warns when a dedicated account that is no bot is on the allowed list, which drops every request it makes', () => {
  const allowed = { allowed: [{ id: 'Agent-Bot' }] }
  expect(gitlabKind.facts!(testGitlabDeployment(), allowed).identity).toMatchObject({ en: expect.stringContaining('set Identity to personal') })
  // A project access token's bot user, someone else on the list, or personal identity need no warning.
  expect(gitlabKind.facts!(testGitlabDeployment({ gitlab: testGitlab({ bot: true }) }), allowed).identity).toBeUndefined()
  expect(gitlabKind.facts!(testGitlabDeployment(), { allowed: [{ id: 'alice' }] }).identity).toBeUndefined()
  expect(gitlabKind.facts!(testGitlabDeployment(), undefined).identity).toBeUndefined()
  expect(gitlabKind.facts!(testGitlabDeployment({ gitlab: testGitlab({ identity: 'personal', workerCli: '/bin/false' }) }), allowed).identity).toBeUndefined()
})
it('warns under dedicated of a token about to expire, on the address', () => {
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
  expect(gitlabKind.facts!(testGitlabDeployment({ gitlab: testGitlab({ expiresAt: soon }) })).url).toMatchObject({ en: expect.stringContaining(`cli ${soon}`) })
  expect(gitlabKind.facts!(testGitlabDeployment({ gitlab: testGitlab({ expiresAt: '2099-01-01' }) }))).not.toHaveProperty('url')
})
