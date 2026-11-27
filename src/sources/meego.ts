/** Feishu Project (Meego) source kind definition and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { MeegoCliSchema } from '../deployment.ts'
import { KV } from '../kv.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { bindMeego, meegoLink, sendMeego } from './meego-channel.ts'
import { watchMeego } from './meego-loops.ts'
import { meegoThreadContext } from './meego-read.ts'
import { meegoThreadKey, ProjectSearchSchema, SOURCE } from './meego-trigger.ts'

export { pollRound } from './meego-loops.ts'
const unique = <T>(rows: T[], id: (row: T) => string): boolean => new Set(rows.map(id)).size === rows.length
const MeegoConfigSchema = MeegoCliSchema.extend({
  trigger: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/, 'a word of letters, digits, _ and -').default('agent'),
  spaces: z.array(z.object({ projectKey: z.string().trim().regex(/^[A-Za-z0-9_-]+$/) }).strict())
    .refine(rows => unique(rows, row => row.projectKey), 'Duplicate spaces').default([]),
  views: z.array(z.object({ url: z.string().trim().regex(/^https:\/\/\S+$/, 'a view page link') }).strict())
    .refine(rows => unique(rows, row => row.url), 'Duplicate views').default([]),
  todo: z.boolean().default(false),
  notify: z.enum(['replies', 'all', 'none']).default('replies'),
  watch: z.boolean().default(true),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  maxItems: z.number().int().min(1).max(200).default(40),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
}).strict()
export type MeegoConfig = z.infer<typeof MeegoConfigSchema>
/** A Trigger's admission row: work items entering the scope, or comments. */
const rowOf = (meta: Record<string, unknown>): 'items' | 'comments' => meta.kind === 'item' ? 'items' : 'comments'
export const meegoKind: SourceKind<MeegoConfig> = {
  kind: SOURCE,
  title: { zh: '飞书项目', en: 'Feishu Project' },
  description: { zh: '用你本人的飞书项目账号轮询：关注的视图和（可选）我的待办里新出现的工作项，以及其上的评论；在评论开头写触发词加冒号就是找智能体。智能体的评论带署名。', en: 'Polls with your own Feishu Project account: work items new in the watched views and, optionally, your to-do list, and their comments; a comment starting with the trigger word and a colon addresses the agent. The agent signs its comments.' },
  schema: MeegoConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: 'meegle', en: 'meegle' },
      hint: { zh: 'meegle 的命令名或绝对路径。dsh-superagent 每次调用都带 --profile，只用下面的 profile。保存时检查它是否已登录，然后重启 dsh-superagent。', en: 'A command name or absolute path of meegle. dsh-superagent passes --profile on every call and uses only the profile below. Saving checks that it is signed in, then restarts dsh-superagent.' } },
    { key: 'profile', type: 'text', pattern: '[A-Za-z0-9_.\\-]{1,64}', label: { zh: 'meegle profile', en: 'meegle profile' },
      hint: { zh: '和你自己用的 profile 分开。在终端用 meegle --profile <profile> auth login --host <host> 登录，例如 --host project.example.com。保存后重启 dsh-superagent。', en: 'Keep it apart from the profile you use yourself. Sign it in from a terminal with meegle --profile <profile> auth login --host <host>, for example --host project.example.com. Saving restarts dsh-superagent.' } },
    { key: 'trigger', type: 'text', pattern: '[A-Za-z][A-Za-z0-9_\\-]{0,31}', label: { zh: '触发词', en: 'Trigger' },
      hint: { zh: '评论里某行行首（前面可以有 @ 某人）写这个词加冒号就是找智能体，例如 agent: 看看。引用和代码里的不算；工作项描述里的也不算。', en: 'This word and a colon at the start of a line of a comment, after any mentions, addresses the agent, as in agent: take a look. Quotes and code do not count, and neither does a work item\'s description.' } },
    { key: 'spaces', type: 'rows', label: { zh: '空间', en: 'Spaces' },
      hint: { zh: '只接收这些空间里的工作项。去掉一个空间后，它的工作项不再接收。', en: 'Only work items of these spaces are received. After a space is removed, its work items are no longer received.' },
      columns: [{ key: 'projectKey', type: 'text', label: { zh: '空间', en: 'Space' }, pattern: '[A-Za-z0-9_\\-]+',
        choose: { zh: '选择最近访问的空间', en: 'Choose a recently visited space' }, refresh: { zh: '刷新空间列表', en: 'Refresh spaces' } }] },
    { key: 'views', type: 'rows', label: { zh: '关注的视图', en: 'Watched views' },
      hint: { zh: '粘贴视图页面的链接，例如 https://project.example.com/acme/issueView/AbC123。视图里新出现的工作项（你自己建的除外）成为触发；加上视图时已有的工作项不算。视图要属于上面的空间。', en: 'Paste a view page link, such as https://project.example.com/acme/issueView/AbC123. Work items new in the view, other than those you created, become Triggers; those already there when the view is added do not. The view must belong to a space above.' },
      columns: [{ key: 'url', type: 'text', label: { zh: '视图链接', en: 'View link' }, pattern: 'https://\\S+' }] },
    { key: 'todo', type: 'switch', label: { zh: '也关注我的待办', en: 'Also watch my to-do list' },
      hint: { zh: '打开后，「我的待办」里新出现的、属于上面空间的工作项也成为触发。打开时已有的不算。', en: 'Work items new in your to-do list that belong to a space above become Triggers too. Those already there when switched on do not.' } },
    { key: 'notify', type: 'select', label: { zh: '评论里 @ 我', en: 'Mention me in comments' },
      options: [{ value: 'replies', label: { zh: '回复和结果', en: 'Replies and results' } }, { value: 'all', label: { zh: '所有评论，也包括“收到”', en: 'Every comment, acknowledgements too' } },
        { value: 'none', label: { zh: '不 @', en: 'Never' } }],
      hint: { zh: '智能体用你的账号评论，飞书不会因此提醒你；在评论开头 @ 你，飞书才会通知。“回复和结果”不 @ 刚接下请求时的“收到”。', en: 'The agent comments with your account, which Feishu does not notify you of; a mention of you at the start of the comment does. Replies and results leaves out the acknowledgement posted when a request is taken.' } },
    { key: 'watch', type: 'switch', label: { zh: '评论时把我加为关注人', en: 'Add me as a watcher when commenting' },
      hint: { zh: '智能体在工作项上评论时，你不在关注人里就把你加上，之后这个工作项的变化飞书会通知你。从关注人里去掉自己后，智能体下次评论时又会加上。', en: 'When the agent comments on a work item you do not watch, it adds you to the watchers, so Feishu notifies you of later changes. If you remove yourself, the agent\'s next comment adds you again.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'maxItems', type: 'number', advanced: true, min: 1, max: 200, label: { zh: '每轮读评论的工作项数', en: 'Work items whose comments a poll reads' },
      hint: { zh: '关注范围超过这个数时，评论分几轮轮流读，延迟随之变长；有进行中工单的工作项每轮都读。', en: 'When the scope holds more work items, their comments are read by turns over several polls, which adds delay; work items with a live Ticket are read every poll.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' }, hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
  ],
  health: ['meego'],
  // The admission row follows the Trigger's kind, never the view, so removing a view revokes no Mandate.
  scope: ({ meta }, config) => {
    if (!config.spaces.some(space => space.projectKey === meta.projectKey)) return { listened: false, reason: 'space_not_listened' }
    return { listened: true, observed: meta.kind === 'item', row: rowOf(meta) }
  },
  // A reply goes only to a work item of a space the Source still receives.
  channel: { allowed: (address, config) => config.spaces.some(space => space.projectKey === address.projectKey), send: sendMeego, link: meegoLink },
  threadContext: meegoThreadContext,
  // A work item's page on any host names its Thread.
  find: query => {
    const page = /\/[^/\s]+\/[^/\s]+\/detail\/(\d+)/.exec(query)
    return { threads: page ? [meegoThreadKey(page[1]!)] : [], terms: [] }
  },
  policy: {
    unnamed: { person: { zh: '飞书项目用户', en: 'Feishu Project user' }, bot: { zh: '飞书项目机器人', en: 'Feishu Project bot' } },
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^\d+$/), name: z.string().trim().max(100).optional() }).strict())
      .refine(users => unique(users, user => user.id), 'Duplicate user_keys').default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的飞书项目用户', en: 'Feishu Project users who may originate work' },
      hint: { zh: '填 user_key（meegle user me 或 user search 能查到）。智能体用你的账号行事，建议只填你自己。', en: 'Enter user_keys, which meegle user me or user search shows. The agent acts with your account, so consider listing only yourself.' },
      columns: [{ key: 'id', type: 'text', label: { zh: 'user_key', en: 'user_key' }, pattern: '\\d+' },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的人在关注范围内的工作项上发出评论，某行行首写触发词加冒号。', en: 'Someone on the list writes a comment on a watched work item with a line that starts with the trigger word and a colon.' },
    rows: () => [
      { id: 'items', label: { zh: '新进入关注范围的工作项', en: 'Work items new in scope' }, note: { zh: '全部', en: 'All' },
        cells: { listedUnaddressed: true, unlistedAddressed: false, unlistedUnaddressed: true } },
      { id: 'comments', label: { zh: '评论', en: 'Comments' }, note: { zh: '仅触发词', en: 'Trigger word only' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
    ],
  },
  async refreshLabels(host, signal) {
    const ctx = sourceContext(host, meegoKind)
    const commands = ctx.commands.withSignal(signal)
    const config = host.sources.instance<MeegoConfig>(SOURCE)?.config
    const names: Record<string, string> = {}
    const add = (answer: unknown) => {
      for (const project of ProjectSearchSchema.parse(answer).projects ?? []) names[project.project_key] = (project.name ?? '').trim() || project.project_key
    }
    add(await commands.meegle(['project', 'search']))
    for (const { projectKey } of config?.spaces ?? []) {
      if (!names[projectKey]) add(await commands.meegle(['project', 'search', '--project-key', projectKey]).catch(() => ({})))
    }
    ctx.state.set(KV.sources.labels(SOURCE), names)
    return names
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_MEEGO_ITEM', description: { zh: '接下工单的飞书项目工作项的链接；工单不是从飞书项目来的时为空', en: 'Link of the Feishu Project work item that started the ticket; empty when the ticket did not start on Feishu Project' } },
      { key: 'DSH_SUPERAGENT_MEEGO_TRIGGER', description: { zh: '人在飞书项目评论的行首写这个词加冒号来找智能体', en: 'People address the agent by this word and a colon at the start of a line of a Feishu Project comment' } },
    ],
    values: ({ config, trigger }) => ({ DSH_SUPERAGENT_MEEGO_ITEM: trigger?.source === SOURCE ? trigger.url ?? '' : '',
      DSH_SUPERAGENT_MEEGO_TRIGGER: config.trigger }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.meego ? {
    cli: { zh: `当前账号 ${deployment.meego.name}（${deployment.meego.host}）`, en: `Current account ${deployment.meego.name} (${deployment.meego.host})` },
  } : {},
}
export const name = 'dsh-superagent-meego'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(meegoKind), 'meego: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, meegoKind)
    // The channel and the context reader get only `commands` from the registry; they read the Source's state through this.
    const unbind = bindMeego({ state: source.state, config: kind => source.config(kind) })
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watchMeego(source, controller.signal)
      .catch((error: unknown) => { source.report('meego', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running; unbind() }
  })
}
