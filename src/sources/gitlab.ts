/** GitLab source kind definition, project polling loop, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type Thread } from '../core/index.ts'
import { GitlabAccountsSchema, gitlabOf } from '../deployment.ts'
import { CliError, validItems, type Tally } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { ciCounts, ciFact, ciFailures, ciSummary, type CiSnapshot } from './github-read.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { mrsOf, observeMr, readMr, type Mr } from './gitlab-mr.ts'
import { gitlabThreadContext, latestPipeline, pipelineChecks } from './gitlab-read.ts'
import { branchCiTrigger, ciTrigger, DiscussionSchema, ItemSchema, mentions, noteKind, NoteSchema, noteTrigger, itemTrigger,
  SOURCE, threadId, type GitlabItem, type ItemRef } from './gitlab-trigger.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'

const GitlabConfigSchema = GitlabAccountsSchema.extend({ pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observeMergeRequests: z.boolean().default(false), observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false) }).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', merge_requests: 'observeMergeRequests', comments: 'observeComments', ci: 'observeCi' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'mr') return 'merge_requests'
  return meta.kind === 'note' || meta.kind === 'diff' || meta.kind === 'review' ? 'comments' : undefined
}
const USERNAME = '[A-Za-z0-9_.\\-]+'
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；接收项目里 @ 它的 Issue、MR 和评论，已订阅 Issue 与 MR 的讨论，MR 审批，流水线变化和 MR 合并关闭。', en: 'The agent\'s GitLab account; receives Issues, merge requests and comments in the project that mention it, discussion on subscribed Issues and MRs, MR approvals, pipeline changes, and MR merge or close.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'url', type: 'text', pattern: 'https://[A-Za-z0-9.\\-]+(:\\d+)?', label: { zh: 'GitLab 地址', en: 'GitLab address' },
      hint: { zh: '你们自己的 GitLab 的地址，写作 https://主机[:端口]，不带路径和结尾的斜杠，例如 https://gitlab.example.com。保存时检查智能体账号能否推送到项目，然后重启 dsh-superagent。', en: 'The address of your own GitLab, written https://host[:port] without a path or trailing slash, for example https://gitlab.example.com. Saving checks that the agent account can push to the project, then restarts dsh-superagent.' } },
    { key: 'project', type: 'text', pattern: '[A-Za-z0-9_.\\-]+(/[A-Za-z0-9_.\\-]+)+', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '写作 group/name，可以带子组（group/subgroup/name）。这个来源接收这个项目的 Issue、MR 和讨论；智能体账号至少要有 Developer 权限。', en: 'Written group/name, with subgroups if any (group/subgroup/name). This Source receives the project\'s Issues, merge requests and discussion; the agent account needs at least the Developer role.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 glab', en: 'Agent glab' },
      hint: { zh: '命令名或绝对路径，通常是用 GLAB_CONFIG_DIR 登录智能体账号的 glab 包装脚本。智能体以它登录的账号行事，执行器以 glab 调用它。保存时检查它登录的账号能否推送到项目，然后重启 dsh-superagent。', en: 'A command name or absolute path, usually a glab wrapper signed in to the agent account through GLAB_CONFIG_DIR. The agent acts as the account it is signed in to, and the Executor calls it as glab. Saving checks that this account can push to the project, then restarts dsh-superagent.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' }, hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeMergeRequests', type: 'switch', label: { zh: '接收项目里的新 MR', en: 'Receive new merge requests in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 MR 也会收到，由策略的接收表决定是否成为候选。', en: 'New merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive comments in the project' },
      hint: { zh: '打开后，Issue 和 MR 上没有 @ 智能体的评论和代码评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments and diff comments on Issues and MRs that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收默认分支的流水线', en: 'Receive the default branch\'s pipeline' },
      hint: { zh: '打开后，默认分支流水线的失败和恢复会收到，由策略的接收表决定是否成为候选。', en: 'Failures of the default branch\'s pipeline, and its recovery, are received, and the Policy\'s admission table decides whether they become candidates.' } }],
  // What the Source observes across the project it receives in full; elsewhere, only what addresses the agent.
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['gitlab'],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  // `!12` names MR 12, `#12` Issue 12, and so does their page on any GitLab server.
  find: query => {
    const text = query.trim()
    const short = /^([!#])(\d+)$/.exec(text)
    const page = /[^/\s]+\/[^\s]+?\/-\/(issues|merge_requests)\/(\d+)/.exec(text)
    const isMr = short ? short[1] === '!' : page?.[1] === 'merge_requests'
    const iid = Number(short?.[2] ?? page?.[2])
    return { threads: iid ? [`${SOURCE}:${threadId(isMr, iid)}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '用户名', en: 'Username' }, pattern: USERNAME }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号（例如项目访问令牌的 project_12_bot_…）的评论在来源收到时成为推断的候选，交给评估：评论 @ 了智能体，或者打开了“接收项目里的评论”。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。', en: 'A comment of a bot account on this list, such as a project access token\'s project_12_bot_…, becomes an inferred candidate for an assessment when the Source receives it: when it mentions the agent, or with Receive comments in the project on. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '用户名', en: 'Username' }, pattern: USERNAME }] }],
    explicit: { zh: '名单里的账号在 Issue、MR 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue, a merge request or a comment.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: Localized) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('merge_requests', { zh: '新 MR', en: 'New merge requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        // A pipeline has no sender, so only the cell of a sender off the list who does not address the agent applies.
        { id: 'ci', label: { zh: '默认分支的流水线', en: 'Default branch pipeline' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_URL', description: { zh: 'GitLab 的地址，https://主机[:端口]', en: 'The GitLab server\'s address, https://host[:port]' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的项目，group/name。智能体在这里开的 MR，源分支最后一段是 DSH_SUPERAGENT_NAME 时（例如 agent/$DSH_SUPERAGENT_NAME）会关联到工单', en: 'The project this Source watches, as group/name. An MR the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT_ID', description: { zh: '项目的数字 id，glab api 的 projects/<id>/… 路径用它', en: 'The project\'s numeric id, which glab api paths projects/<id>/… take' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 用户名；glab 以它登录，GitLab 操作都用 glab，不用其他账号或凭据', en: 'The agent\'s GitLab username. glab is signed in to it; use glab for every GitLab operation, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ISSUE_IID', description: { zh: '接下工单的 Issue 的编号（iid）；工单不是从 GitLab Issue 来的时为空', en: 'iid of the Issue that started the ticket; empty when the ticket did not start on a GitLab Issue' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_IID', description: { zh: '接下工单的 MR 的编号（iid）；工单不是从 GitLab MR 来的时为空', en: 'iid of the merge request that started the ticket; empty when the ticket did not start on a GitLab MR' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', description: { zh: '接下工单的 MR 的 head 引用 refs/merge-requests/<iid>/head；不是 MR 时为空', en: 'Head ref refs/merge-requests/<iid>/head of the MR that started the ticket; empty when it was not an MR' } },
    ],
    values: ({ deployment, trigger }) => {
      const gitlab = deployment.gitlab
      const iid = trigger?.threads[0]?.source === SOURCE ? Number(trigger.meta.iid) || 0 : 0
      const isMr = iid > 0 && trigger?.meta.isMr === true
      return { DSH_SUPERAGENT_GITLAB_URL: gitlab?.url ?? '', DSH_SUPERAGENT_GITLAB_PROJECT: gitlab ? deployment.repository : '',
        DSH_SUPERAGENT_GITLAB_PROJECT_ID: gitlab ? String(gitlab.projectId) : '', DSH_SUPERAGENT_GITLAB_ACCOUNT: gitlab?.login ?? '',
        DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: gitlab?.email ?? '', DSH_SUPERAGENT_GITLAB_ISSUE_IID: iid && !isMr ? String(iid) : '',
        DSH_SUPERAGENT_GITLAB_MR_IID: isMr ? String(iid) : '', DSH_SUPERAGENT_GITLAB_MR_HEAD: isMr ? `refs/merge-requests/${iid}/head` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
    project: { zh: `项目 id ${deployment.gitlab.projectId}`, en: `Project id ${deployment.gitlab.projectId}` },
  } : {},
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
const pollFailure = (failures: number, threshold: number, error: unknown): Health | undefined =>
  failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  if (ctx.deployment.account.kind !== 'gitlab') { ctx.report('gitlab', health('paused', 'notForge')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) await pollRound(ctx, signal)
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause((ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round {
  started: string; signal?: AbortSignal | undefined
  mrs: Map<number, Promise<Mr>>; read: Set<string>; failures: string[]; dropped: string[]; tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, mrs: new Map(), read: new Set(),
  failures: [], dropped: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
/** True when GitLab answers 404 for one Issue or MR of a project it still lists: the item was deleted or moved. */
const deleted = (error: unknown): boolean => error instanceof CliError && error.code === 404
/** `#12` for Issue 12, `!34` for MR 34, from a Thread id. */
const named = (thread: string): string => thread.replace(/^issue:/, '#').replace(/^mr:/, '!')
/** Counts a failed read in the round: a deleted Issue or MR (404) is only named in the health detail. */
function counted(round: Round, thread: string, error: unknown): void {
  if (deleted(error)) round.dropped.push(named(thread)); else round.failures.push(`${named(thread)}: ${String(error)}`)
}
function failed(ctx: SourceContext, round: Round, thread: string, error: unknown): void {
  counted(round, thread, error)
  ctx.threads.patch(`${SOURCE}:${thread}`, { pollError: String(error) })
}
/**
 * One polling round: the project's Issues and MRs updated since each list's cursor with their new notes, then the MRs of open
 * tickets with their pipelines, then subscribed Threads, then the default branch's pipeline. Each step and each Issue, MR or
 * Thread fails on its own, so every step runs before the round fails; an Issue or MR GitLab answers 404 for is only recorded.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const round = newRound(signal)
  let listed = 0
  for (const stream of ['issues', 'merge_requests'] as const) {
    if (stopped(ctx, round)) return
    try { listed += await pollStream(ctx, round, stream) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${stream}: ${String(error)}`) }
  }
  await pollTicketMrs(ctx, signal, round)
  await pollThreads(ctx, signal, round)
  await pollProjectCi(ctx, round)
  if (stopped(ctx, round)) return
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const dropped = (round.dropped.length ? `; gone from GitLab: ${[...new Set(round.dropped)].join(', ')}` : '')
    + (round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : '')
  ctx.report('gitlab', { state: 'ready', detail: `${listed} updated Issues and merge requests${dropped}`, at: round.started })
}
/** The later of two timestamps. */
const later = (a: string, b: string): string => Date.parse(a) >= Date.parse(b) ? a : b
/**
 * Reads one list (`issues` or `merge_requests`) of the items updated since its cursor, oldest first, and each item's new notes;
 * the first round starts the cursor, so nothing older is read. The cursor moves to five seconds before the round started once
 * every item was read, or stays before the first item whose read failed so the next round reads it again. Items beyond the
 * polling horizon are not read.
 * @returns how many items the list named.
 */
async function pollStream(ctx: SourceContext, round: Round, stream: 'issues' | 'merge_requests'): Promise<number> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return 0
  const isMr = stream === 'merge_requests'
  const cursor = KV.gitlab.stream(stream)
  const stored = ctx.state.get(cursor)?.since
  if (!stored) { ctx.state.set(cursor, { since: cursorAt(round.started) }); return 0 }
  const since = new Date(Math.max(Date.parse(stored), Date.parse(round.started) - POLL_HORIZON_MS)).toISOString()
  const path = `${stream}?updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=asc&per_page=100`
  const items = await ctx.commands.withSignal(round.signal).gitlabPages(ItemSchema, path, round.tally)
  const { login } = gitlabOf(ctx.deployment)
  let held: string | undefined
  for (const item of items) {
    // Stopping mid-list aborts before moving the cursor, so the unread items are read again.
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    const thread = threadId(isMr, item.iid)
    try {
      const ref: ItemRef = { iid: item.iid, isMr, url: item.web_url }
      if (isMr) ref.mrAuthor = (await mr(ctx, round, item.iid)).author.username
      const opened = Date.parse(item.created_at) >= Date.parse(since) && !sameName(item.author.username, login)
      if (opened && (mentions(item.description ?? '', login) || config[isMr ? 'observeMergeRequests' : 'observeIssues'])) {
        await ctx.receive(itemTrigger(item, isMr, login))
      }
      nameThread(ctx, item, isMr)
      const subscribed = !!ctx.threads.get(`${SOURCE}:${thread}`)?.subscriptions.length
      await intakeNotes(ctx, round, ref, later(ctx.state.get(KV.gitlab.cursor(thread)) ?? since, since), subscribed || config.observeComments)
      ctx.state.set(KV.gitlab.cursor(thread), cursorAt(round.started))
      ctx.threads.patch(`${SOURCE}:${thread}`, { pollError: undefined })
      round.read.add(thread)
    } catch (error) {
      if (stopped(ctx, round)) throw error
      failed(ctx, round, thread, error)
      // GitLab reads `updated_after` inclusively; one second before the item reads it again, and its own cursor keeps its notes once.
      if (!deleted(error) && !held) held = new Date(Date.parse(item.updated_at ?? item.created_at) - 1000).toISOString()
    }
  }
  ctx.state.set(cursor, { since: held ? later(held, since) : cursorAt(round.started) })
  return items.length
}
/** Reads and observes an MR at most once per polling round. */
function mr(ctx: SourceContext, round: Round, iid: number): Promise<Mr> {
  let read = round.mrs.get(iid)
  if (!read) {
    read = readMr(ctx, iid, round.signal).then(async item => { await observeMr(ctx, item); return item })
    round.mrs.set(iid, read)
  }
  return read
}
/**
 * Receives the notes of an Issue's or MR's discussions written since `since`: all of them with `all`; otherwise those that mention
 * the agent, and the review decisions on the agent's MRs. The agent's own notes and other system notes make no Trigger.
 */
async function intakeNotes(ctx: SourceContext, round: Round, ref: ItemRef, since: string, all: boolean): Promise<void> {
  const item = `${ref.isMr ? 'merge_requests' : 'issues'}/${ref.iid}`
  const discussions = await ctx.commands.withSignal(round.signal).gitlabPages(DiscussionSchema, `${item}/discussions?per_page=100`, round.tally)
  const { login } = gitlabOf(ctx.deployment)
  const mine = !!ref.mrAuthor && sameName(ref.mrAuthor, login)
  for (const discussion of discussions) {
    for (const note of validItems(NoteSchema, discussion.notes, round.tally)) {
      // Stopping mid-read throws so the Thread's cursor stays where it was.
      if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
      if (!(Date.parse(note.created_at) >= Date.parse(since))) continue
      const trigger = noteTrigger(note, discussion, ref, login)
      if (!trigger) continue
      if (all || trigger.addressed || (mine && noteKind(note) === 'review')) await ctx.receive(trigger)
    }
  }
}
function nameThread(ctx: SourceContext, item: Pick<GitlabItem, 'iid' | 'title' | 'web_url'>, isMr: boolean): void {
  const key = `${SOURCE}:${threadId(isMr, item.iid)}`
  const name = named(threadId(isMr, item.iid))
  ctx.threads.patch(key, { iid: item.iid, isMr, title: item.title, url: item.web_url })
  ctx.threads.describe(key, { label: `${name} ${item.title}`, url: item.web_url, facts: { iid: { value: name } } })
}
/** Reads the MRs of open tickets once each, and the pipeline of each one still open. */
export async function pollTicketMrs(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const iids = [...new Set(ctx.tickets.open().flatMap(ticket => mrsOf(ticket, true)))]
  for (const iid of iids) {
    if (stopped(ctx, round)) return
    try {
      const item = await mr(ctx, round, iid)
      if (item.state !== 'merged' && item.state !== 'closed') await pollPipeline(ctx, round, item)
    } catch (error) { if (!stopped(ctx, round)) failed(ctx, round, threadId(true, iid), error) }
  }
}
/** Reads an MR's head pipeline; only changes after the first look become Triggers. */
async function pollPipeline(ctx: SourceContext, round: Round, item: Mr): Promise<void> {
  const head = item.head_pipeline?.sha ?? item.sha ?? ''
  const commands = ctx.commands.withSignal(round.signal)
  const snapshot: CiSnapshot = item.head_pipeline ? await pipelineChecks(commands, item.head_pipeline.id, head, round.tally)
    : { head, checks: [], statuses: [] }
  const fingerprint = key(JSON.stringify(snapshot))
  const previous = ctx.state.get(KV.gitlab.ci(item.iid))
  if (previous?.fingerprint === fingerprint) return
  const revision = previous ? previous.revision + 1 : 0
  const summary = ciSummary(snapshot, `MR !${item.iid}`, `gitlab/merge_requests/${item.iid}/pipelines`)
  if (previous) await ctx.receive(ciTrigger(item, revision, summary))
  ctx.state.set(KV.gitlab.ci(item.iid), { fingerprint, revision })
  ctx.threads.describe(`${SOURCE}:${threadId(true, item.iid)}`, { facts: { ci: ciFact(ciCounts(snapshot)) } })
}
/**
 * Reads the newest pipeline of the default branch while `observeCi` is on; a Trigger tells when its failed jobs change after the
 * first look, and once it passes again. Switching it off forgets the failures and keeps the revision, so later ids stay unique.
 */
async function pollProjectCi(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config || stopped(ctx, round)) return
  const previous = ctx.state.get(KV.gitlab.branchCi)
  if (!config.observeCi) { ctx.state.set(KV.gitlab.branchCi, previous && { revision: previous.revision }); return }
  try {
    const commands = ctx.commands.withSignal(round.signal)
    const { default_branch: branch } = await commands.gitlab(z.looseObject({ default_branch: z.string() }), '')
    const pipeline = await latestPipeline(commands, { ref: branch })
    if (!pipeline) return
    const sha = pipeline.sha ?? ''
    const snapshot = await pipelineChecks(commands, pipeline.id, sha, round.tally)
    // The first look after switching on or renaming the default branch is the baseline.
    const known = previous?.branch === branch ? previous.failures : undefined
    const failures = ciFailures(snapshot)
    const counts = ciCounts(snapshot)
    // Keep the earlier failures while jobs still run, so recovery is told only once every job passed.
    const now = failures.length || !counts.running ? failures : known ?? []
    let revision = previous?.revision ?? 0
    if (known && JSON.stringify(now) !== JSON.stringify(known)) {
      revision += 1
      const { url } = gitlabOf(ctx.deployment)
      const summary = ciSummary(snapshot, branch, `gitlab/commits/${sha}/pipelines`)
      await ctx.receive(branchCiTrigger(branch, revision, summary, `${url}/${ctx.deployment.repository}/-/pipelines/${pipeline.id}`))
      ctx.threads.describe(`${SOURCE}:ci:${branch}`, { label: `CI on ${branch}`, facts: { ci: ciFact(counts) } })
    }
    ctx.state.set(KV.gitlab.branchCi, { branch, failures: now, revision })
  } catch (error) { if (!stopped(ctx, round)) round.failures.push(`default branch pipeline: ${String(error)}`) }
}
/** Polls subscribed Issue and MR Threads the round has not read yet, each taking every note since its cursor. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (!stopped(ctx, round)) counted(round, thread.ref.id, error)
      throw error
    }
  }, thread => round.read.has(thread.ref.id))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  // The default branch's pipeline Thread has no Issue or MR to read; its pipeline arrives as Triggers.
  if (thread.ref.id.startsWith('ci:')) return
  const match = /^(issue|mr):([1-9]\d*)$/.exec(thread.ref.id)
  if (!match) throw new Error('Subscribed thread has no GitLab Issue or MR')
  const isMr = match[1] === 'mr'
  const iid = Number(match[2])
  round.read.add(thread.ref.id)
  const item = isMr ? await mr(ctx, round, iid) : await ctx.commands.withSignal(round.signal).gitlab(ItemSchema, `issues/${iid}`)
  nameThread(ctx, item, isMr)
  const checkpoint = KV.gitlab.cursor(thread.ref.id)
  const ref: ItemRef = { iid, isMr, url: item.web_url, ...isMr ? { mrAuthor: item.author.username } : {} }
  await intakeNotes(ctx, round, ref, ctx.state.get(checkpoint) ?? thread.createdAt, true)
  ctx.state.set(checkpoint, cursorAt(round.started))
}
