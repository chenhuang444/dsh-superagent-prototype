import { expect, it } from 'vitest'
import { key } from '../src/core/index.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import { branchCiTrigger, gitlabChannel, isHumanUser, itemTrigger, ItemSchema, mentions, noteKind, NoteSchema, noteTrigger }
  from '../src/sources/gitlab-trigger.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'
import { diffNote, issue, mr, note, WEB } from './fixtures/gitlab.ts'

const ref = (iid: number, isMr = false) => ({ iid, isMr, url: `${WEB}/-/${isMr ? 'merge_requests' : 'issues'}/${iid}` })
const individual = { id: 'aaaa1111', individual_note: true }
const threaded = { id: 'bbbb2222', individual_note: false }

it('translates a note into a Trigger on its Issue or MR, with a reply address in its discussion', () => {
  const trigger = noteTrigger(NoteSchema.parse(note(5, 'alice', '@agent-bot please fix')), individual, ref(12), 'agent-bot')!
  expect(trigger).toEqual({ id: key('gitlab-note', 'issue:12', '5'), source: 'gitlab', threads: [{ source: 'gitlab', id: 'issue:12' }],
    actor: { source: 'gitlab', id: 'alice' }, human: true, at: '2026-09-09T00:00:05Z', text: '@agent-bot please fix', addressed: 'mention',
    channel: gitlabChannel(false, 12, undefined, `${WEB}/-/issues/12#note_5`), url: `${WEB}/-/issues/12#note_5`,
    meta: { iid: 12, isMr: false, kind: 'note', noteId: 5, discussionId: 'aaaa1111' } })
  expect(trigger.channel!.address).toEqual({ kind: 'issue', iid: '12', url: `${WEB}/-/issues/12#note_5` })
  // A note in a threaded discussion is answered in that discussion.
  const reply = noteTrigger(NoteSchema.parse(note(6, 'alice', 'more')), threaded, ref(34, true), 'agent-bot')!
  expect(reply).toMatchObject({ threads: [{ id: 'mr:34' }], channel: { thread: 'gitlab:mr:34', address: { kind: 'mr', iid: '34', discussion: 'bbbb2222' } } })
  expect(reply).not.toHaveProperty('addressed')
})

it('keeps Issue and MR ids apart, as their iids are separate sequences', () => {
  const opened = itemTrigger(ItemSchema.parse(issue(12, { description: 'Ping @agent-bot' })), false, 'agent-bot')
  const merge = itemTrigger(ItemSchema.parse(mr(12)), true, 'agent-bot')
  expect(opened).toMatchObject({ id: key('gitlab-issue', '12'), threads: [{ id: 'issue:12' }], text: 'Login fails\n\nPing @agent-bot',
    addressed: 'mention', meta: { iid: 12, isMr: false, kind: 'issue' } })
  expect(merge).toMatchObject({ id: key('gitlab-mr', '12'), threads: [{ id: 'mr:12' }], meta: { iid: 12, isMr: true, kind: 'mr', mrAuthor: 'carol' } })
  expect(opened.id).not.toBe(merge.id)
  expect(noteTrigger(NoteSchema.parse(note(5, 'a', 'x')), individual, ref(12), 'agent-bot')!.id)
    .not.toBe(noteTrigger(NoteSchema.parse(note(5, 'a', 'x')), individual, ref(12, true), 'agent-bot')!.id)
})

it('starts a diff note with its file and line, and keeps both in meta', () => {
  const trigger = noteTrigger(NoteSchema.parse(diffNote(7, 'carol', 'Use the theme token')), threaded, ref(34, true), 'agent-bot')!
  expect(trigger.text).toBe('src/render.ts:43\n\nUse the theme token')
  expect(trigger.meta).toMatchObject({ kind: 'diff', path: 'src/render.ts', line: 43, discussionId: 'bbbb2222' })
})

it('makes review decisions of system notes Triggers, and no Trigger of other system notes or the agent\'s own notes', () => {
  const system = (body: string) => NoteSchema.parse(note(8, 'carol', body, { system: true }))
  expect(noteTrigger(system('approved this merge request'), individual, ref(34, true), 'agent-bot')).toMatchObject({ text: 'approved this merge request',
    meta: { kind: 'review' } })
  expect(noteKind(system('requested changes'))).toBe('review')
  expect(noteKind(system('unapproved this merge request'))).toBe('review')
  expect(noteTrigger(system('added 1 commit'), individual, ref(34, true), 'agent-bot')).toBeUndefined()
  expect(noteTrigger(NoteSchema.parse(note(9, 'Agent-Bot', 'pushed')), individual, ref(34, true), 'agent-bot')).toBeUndefined()
  expect(noteTrigger(NoteSchema.parse(note(10, 'alice', '')), individual, ref(34, true), 'agent-bot')).toBeUndefined()
})

it('marks bots, project access tokens and the Ghost User apart from people', () => {
  expect(isHumanUser({ username: 'alice' })).toBe(true)
  expect(isHumanUser({ username: 'renovate', bot: true })).toBe(false)
  expect(isHumanUser({ username: 'ci_bot' })).toBe(false)
  expect(isHumanUser({ username: 'project_42_bot_0123abcd' })).toBe(false)
  expect(isHumanUser({ username: 'group_7_bot' })).toBe(false)
  expect(noteTrigger(NoteSchema.parse({ ...note(11, 'x', 'hi'), author: null }), individual, ref(1), 'agent-bot')!.actor.id).toBe('ghost')
})

it('reads a mention of the agent in any case, and not inside an address or a longer name', () => {
  for (const text of ['@agent-bot fix', 'cc @Agent-Bot.', '(@agent-bot)', 'ping @agent-bot, please']) expect(mentions(text, 'agent-bot'), text).toBe(true)
  for (const text of ['mail@agent-bot', '@agent-bot-2', '@agent-bot_x', 'x.@agent-bot', '@agent-bot.example', '@@agent-bot']) {
    expect(mentions(text, 'agent-bot'), text).toBe(false)
  }
})

it('gives the default branch\'s pipeline a Thread of its own and no reply address', () => {
  expect(branchCiTrigger('main', 2, 'CI failed', `${WEB}/-/pipelines/9`)).toMatchObject({ id: key('gitlab-ci', 'branch:main', '2'),
    threads: [{ source: 'gitlab', id: 'ci:main' }], human: false, actor: { id: '' }, meta: { ci: true, branch: 'main' } })
  expect(branchCiTrigger('main', 2, 'x', '')).not.toHaveProperty('channel')
})

it('finds !12, #12 and the pages of Issues and MRs on any server', () => {
  const find = gitlabKind.find!
  expect(find('!12').threads).toEqual(['gitlab:mr:12'])
  expect(find(' #12 ').threads).toEqual(['gitlab:issue:12'])
  expect(find(`${WEB}/-/merge_requests/34#note_5`).threads).toEqual(['gitlab:mr:34'])
  expect(find('https://code.example.org:8443/group/sub/name/-/issues/7').threads).toEqual(['gitlab:issue:7'])
  expect(find('12').threads).toEqual([])
  expect(find('https://github.com/acme/widgets/pull/3').threads).toEqual([])
})

it('scopes Triggers onto the admission rows the observe switches open', () => {
  const config = gitlabKind.schema.parse({ observeComments: true })
  const scope = (meta: Record<string, unknown>) => gitlabKind.scope!({ meta }, config)
  expect(scope({ kind: 'issue' })).toEqual({ listened: true, observed: false, row: 'issues' })
  expect(scope({ kind: 'mr' })).toEqual({ listened: true, observed: false, row: 'merge_requests' })
  expect(scope({ kind: 'diff' })).toEqual({ listened: true, observed: true, row: 'comments' })
  expect(scope({ kind: 'review' })).toEqual({ listened: true, observed: true, row: 'comments' })
  expect(scope({ ci: true, branch: 'main' })).toEqual({ listened: true, observed: false, row: 'ci' })
  expect(scope({ ci: true, iid: 3 })).toEqual({ listened: true, observed: false })
  expect(gitlabKind.policy!.rows!({}).map(row => row.id)).toEqual(['issues', 'merge_requests', 'comments', 'ci'])
  expect(() => gitlabKind.policy!.schema.parse({ allowed: [{ id: 'alice.smith_2' }], bots: [{ id: 'project_42_bot_x' }] })).not.toThrow()
  expect(() => gitlabKind.policy!.schema.parse({ allowed: [{ id: 'alice smith' }] })).toThrow()
})

it('gives a ticket from an MR its iid and head ref, and leaves the Issue variable empty', () => {
  const deployment = testGitlabDeployment()
  const config = gitlabKind.schema.parse({})
  const fromMr = itemTrigger(ItemSchema.parse(mr(34)), true, 'agent-bot')
  expect(gitlabKind.environment!.values({ deployment, config, trigger: fromMr })).toEqual({
    DSH_SUPERAGENT_GITLAB_URL: 'https://gitlab.example.com', DSH_SUPERAGENT_GITLAB_PROJECT: 'acme/widgets', DSH_SUPERAGENT_GITLAB_PROJECT_ID: '42',
    DSH_SUPERAGENT_GITLAB_ACCOUNT: 'agent-bot', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: 'agent-bot@example.com', DSH_SUPERAGENT_GITLAB_ISSUE_IID: '',
    DSH_SUPERAGENT_GITLAB_MR_IID: '34', DSH_SUPERAGENT_GITLAB_MR_HEAD: 'refs/merge-requests/34/head' })
  const fromIssue = gitlabKind.environment!.values({ deployment, config, trigger: itemTrigger(ItemSchema.parse(issue(12)), false, 'agent-bot') })
  expect(fromIssue).toMatchObject({ DSH_SUPERAGENT_GITLAB_ISSUE_IID: '12', DSH_SUPERAGENT_GITLAB_MR_IID: '', DSH_SUPERAGENT_GITLAB_MR_HEAD: '' })
  expect(Object.values(gitlabKind.environment!.values({ deployment: { ...deployment, gitlab: undefined }, config })).every(value => value === '')).toBe(true)
  expect(gitlabKind.facts!(deployment)).toMatchObject({ cli: { en: 'Current account @agent-bot' } })
})
