/** Execution status view (active Tickets and pause control) and Execution settings group (Executor capacity and workspace environment). */
import { useRef, useState } from 'react'
import { TICKET_FILTERS, type TicketFilter, type WorkspaceFilter } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import { usePoll, type SettingsView, type SourceView, type StateView } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip, Input, Pill } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { ConfigHistory, Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized } from './text.ts'
import { WorkspaceList } from './workspaces.tsx'
import { ConfirmButton, Hint, LabelValue, LoadMore, LoadState, Section, StatusHead } from './widgets.tsx'

export function ExecutionStatus({ filter: current = 'open', workspaces, state, reload }: {
  filter?: TicketFilter; workspaces?: WorkspaceFilter; state: StateView; reload: () => Promise<void>
}) {
  const { t, call, navigate } = usePanel()
  const { paused, load: { maxWorkers } } = state
  // Pausing uses its own block revision so toggling pause does not invalidate an open Execution settings draft.
  const pause = async () => { await call('POST executor/pause', { body: { paused: !paused } }); await reload() }
  const status = state.setup.problem ? { tone: 'warning', label: t('executorWaitingSetup') } : paused ? { tone: 'warning',
    label: t('processingPaused') }
    : { tone: 'ongoing', label: t('executorRunning') }
  const action = paused ? 'resumeProcessing' : 'pauseProcessing'
  return <>
    <StatusHead hint={t('executionStatusIntro')} settings="execution" />
    <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state={status.tone}>{status.label}</span>
      {!state.setup.problem && <>
        <LabelValue label={t('executingLabel')}
          value={`${state.load.running} / ${maxWorkers}`} /><LabelValue label={t('queuedLabel')} value={state.load.queued} />
      </>}
      <ConfirmButton variant="outline" icon={paused ? 'play' : 'pause'} label={t(action)} title={t(action)} message={t(paused
        ? 'resumeProcessingConfirm' : 'pauseProcessingConfirm')}
        onConfirm={pause} />
    </div>
    <div className="dt-filters">
      {TICKET_FILTERS.map(value => <Pill key={value} active={!workspaces && current === value}
        onClick={() => { navigate({ page: 'execution', query: value === 'open' ? {} : { filter: value } }, true) }}>{t(`ticketFilter.${value}`)}</Pill>)}
      <span className="dt-filter-gap" aria-hidden="true" />
      <Pill active={!!workspaces} onClick={() => { navigate({ page: 'execution', query: { view: 'workspaces' } }, true) }}>
        <Icon name="inbox" size={13} /> {t('workspacesView')}</Pill>
    </div>
    {workspaces ? <WorkspaceList filter={workspaces} /> : <TicketList filter={current} />}
  </>
}
function TicketList({ filter: current }: { filter: TicketFilter }) {
  const { t, call } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error, reload: reloadTickets } = usePoll(() => call('GET tickets', { query: { state: current, limit } }), [current, limit])
  return <>
    {current === 'idle' && <Hint>{t('idleHint')}</Hint>}
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(ticket => ticket.stage === 'person'
      ? <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reloadTickets} /> : <TicketLine key={ticket.id} ticket={ticket} />)}</ul> : <Hint>{t('none')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </>
}

const firstSentence = (text: string): string => /^[^。；;.]*(?:[。；;]|\.(?=\s|$))?/.exec(text)?.[0] ?? text
function EnvironmentVariables({ groups, sources,
  onPick }: { groups: SettingsView['environment']['variables']; sources: SourceView[]; onPick: (key: string) => void }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const owner = (id: string) => id === 'executor' ? t('term.executor') : localized(t, sources.find(source => source.id === id)?.title ?? id)
  const count = groups.reduce((sum, group) => sum + group.variables.length, 0)
  return <DisclosureRow icon={<Icon name="hash" />} title={<>{t('environmentVariables')} <span className="dt-count">{count}</span></>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('environmentPick')}</Hint>
      <table className="dt-table">
        <thead><tr><th>{t('environmentKey')}</th><th>{t('environmentDescription')}</th><th>{t('environmentOwner')}</th></tr></thead>
        <tbody>{groups.flatMap(group => group.variables.map(variable => <tr key={variable.key}>
          <td><button type="button" className="dt-textlink dt-mono" onClick={() => onPick(variable.key)}>{variable.key}</button></td>
          <td title={localized(t, variable.description)}>{firstSentence(localized(t, variable.description))}</td>
          <td>{owner(group.owner)}{!group.enabled && <span className="dt-hint"> · {t('sourceOff')}</span>}</td>
        </tr>))}</tbody>
      </table>
    </div>
  </DisclosureRow>
}
type Tier = Omit<SettingsView['blocks']['executor']['value']['tiers'][number], 'model'> & { model: Parameters<typeof ModelField>[0]['value'] }
/** Edits the Executor's model tiers: each a name, an optional hint for the main Session, and a model. */
function TierList({ tiers, onChange }: { tiers: Tier[]; onChange: (next: Tier[]) => void }) {
  const { t } = usePanel()
  const set = (index: number, next: Partial<Tier>) => onChange(tiers.map((tier, position) => position === index ? { ...tier, ...next } : tier))
  return <Section title={t('modelTiers')} hint={t('modelTiersHint')} action={tiers.length < LIMITS.tiers ? <Button variant="ghost" size="sm"
    icon={<Icon name="plus" />} onClick={() => onChange([...tiers, { name: '', hint: '', model: null }])}>{t('addTier')}</Button> : undefined}>
    {tiers.map((tier, index) => <div key={index} className="dt-form dt-block">
      <div className="dt-grid3">
        <Field label={t('tierName')}>
          <Input className="dt-mono" required pattern="[a-z][a-z0-9\-]{0,31}" spellCheck={false} value={tier.name} placeholder="ui"
            onChange={event => set(index, { name: event.target.value })} />
        </Field>
        <Field label={t('tierHint')}>
          <Input maxLength={LIMITS.tierHint} value={tier.hint} placeholder={t('tierHintPlaceholder')}
            onChange={event => set(index, { hint: event.target.value })} />
        </Field>
        <div className="dt-field"><Button variant="ghost" size="sm" icon={<Icon name="trash" />} aria-label={t('removeTier')}
          onClick={() => onChange(tiers.filter((_, position) => position !== index))}>{t('removeTier')}</Button></div>
      </div>
      <ModelField id={`dt-tier-model-${index}`} value={tier.model} onChange={model => set(index, { model })} />
    </div>)}
  </Section>
}
export function ExecutionSettings() {
  const { t } = usePanel()
  const { blocks, environment, sources } = useSettings().settings
  // Keep raw user text (such as separators between blocked commands) in the draft and parse only on save.
  const executor = blocks.executor.value
  const saved = { ...executor, tiers: executor.tiers as Tier[], maxWorkers: String(executor.maxWorkers),
    retentionDays: String(executor.retentionDays), blockedCommands: executor.blockedCommands.join(' ') }
  const draft = useBlockDraft('executor', saved, blocks.executor.revision,
    value => ({ ...value, maxWorkers: numberOf(value.maxWorkers), retentionDays: numberOf(value.retentionDays),
      blockedCommands: value.blockedCommands.split(/[\s,]+/).filter(Boolean) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const prepare = useRef<HTMLTextAreaElement>(null), cleanup = useRef<HTMLTextAreaElement>(null)
  // A chosen variable goes into the command edited last, the prepare command at first.
  const [target, setTarget] = useState<'prepare' | 'cleanup'>('prepare')
  const insert = (key: string) => {
    const field = (target === 'prepare' ? prepare : cleanup).current, text = value[target]
    const at = field?.selectionStart ?? text.length, to = field?.selectionEnd ?? at
    edit({ [target]: `${text.slice(0, at)}"$${key}"${text.slice(to)}` })
    requestAnimationFrame(() => { field?.focus(); const caret = at + key.length + 3; field?.setSelectionRange(caret, caret) })
  }
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.executor')}<InfoTip text={t('executorIntro')} /></h2>
          <Section title={t('executorModel')} hint={t('executorModelHint')}><ModelField id="dt-worker-model" value={value.model}
            onChange={model => edit({ model })} /></Section>
          <TierList tiers={value.tiers} onChange={tiers => edit({ tiers })} />
          <Field label={t('maxWorkers')} hint={t('maxWorkersHint')}>
            <Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={value.maxWorkers}
              onChange={event => edit({ maxWorkers: event.target.value })} />
          </Field>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.environment')}<InfoTip text={t('environmentIntro')} /></h2>
          <Field label={t('executionDirectory')} hint={t('executionDirectoryHint')} note={value.directory ? undefined
            : t('executionDirectoryDefault', { root: environment.root })}>
            <Input className="dt-mono" value={value.directory} placeholder={t('executionDirectoryEmpty')} spellCheck={false} pattern="/.*"
              onChange={event => edit({ directory: event.target.value })} />
          </Field>
          <Field label={t('prepareCommand')} hint={t('prepareCommandHint')}>
            <textarea ref={prepare} className="dt-textarea dt-mono" rows={3} maxLength={LIMITS.prepareCommand} spellCheck={false}
              placeholder={t('prepareCommandEmpty')} value={value.prepare} onFocus={() => setTarget('prepare')}
              onChange={event => edit({ prepare: event.target.value })} />
          </Field>
          <Field label={t('cleanupCommand')} hint={t('cleanupCommandHint')}>
            <textarea ref={cleanup} className="dt-textarea dt-mono" rows={2} maxLength={LIMITS.prepareCommand} spellCheck={false}
              placeholder={t('cleanupCommandEmpty')} value={value.cleanup} onFocus={() => setTarget('cleanup')}
              onChange={event => edit({ cleanup: event.target.value })} />
          </Field>
          <Field label={t('retentionDays')} hint={t('retentionDaysHint')}>
            <Input type="number" min={LIMITS.retentionDays.min} max={LIMITS.retentionDays.max} required value={value.retentionDays}
              onChange={event => edit({ retentionDays: event.target.value })} />
          </Field>
          <EnvironmentVariables groups={environment.variables} sources={sources} onPick={insert} />
          <Field label={t('blockedCommands')} hint={t('blockedCommandsHint')}>
            <Input className="dt-mono" value={value.blockedCommands} placeholder={t('blockedCommandsNone')} spellCheck={false}
              onChange={event => edit({ blockedCommands: event.target.value })} />
          </Field>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['executor', 'pause']} />
  </div>
}
