/** Workspaces view under Execution: each Ticket directory with its Ticket, Executor, git state, size and cleanup state, and cleanup actions. */
import { useState } from 'react'
import { WORKSPACE_FILTERS, type WorkspaceFilter } from '../app/api.ts'
import type { WorkspaceRow } from '../app/workspaces.ts'
import { usePoll } from './api.ts'
import { Button, Icon, Modal, Pill, Tag, type DotState, type IconName, type TagTone } from './controls.tsx'
import { ticketMark } from './marks.ts'
import { useAction, usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint, LabelValue, LoadState, SessionButton, StageMark, When } from './widgets.tsx'

const MARKS: Record<WorkspaceRow['state'], { dot: DotState; icon: IconName; tone: TagTone }> = {
  active: { dot: 'ongoing', icon: 'running', tone: 'info' },
  retained: { dot: 'idle', icon: 'clock', tone: 'quiet' },
  due: { dot: 'warning', icon: 'trash', tone: 'warning' },
  skipped: { dot: 'warning', icon: 'blocked', tone: 'warning' },
  failed: { dot: 'error', icon: 'alert', tone: 'danger' },
  cleaned: { dot: 'done', icon: 'decision', tone: 'success' },
  orphan: { dot: 'warning', icon: 'question', tone: 'warning' },
}
/** Bytes as people read disk usage, in binary units. */
export function size(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function WorkspaceList({ filter }: { filter: WorkspaceFilter }) {
  const { t, call, navigate, notify } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET workspaces', { query: { filter } }), [filter])
  const scan = useAction(async () => { await call('POST workspaces/scan'); await reload() })
  return <>
    <div className="dt-row-meta dt-status-line">
      {data && <>
        <LabelValue label={t('workspaceRoot')} value={<span className="dt-mono">{data.root}</span>} />
        <span>{t('workspaceRetention', { days: String(data.retentionDays) })}</span>
        <span>{data.scannedAt ? <>{t('workspaceScanned', { when: '' })}<When at={data.scannedAt} /></> : t('workspaceNotScanned')}</span>
      </>}
      <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={scan.busy || !!data?.scanning}
        onClick={() => { void scan.run() }}>{t('workspaceScan')}</Button>
    </div>
    {data && !data.cleanupCommand && <Hint>{t('workspaceNoCommand')}</Hint>}
    <div className="dt-filters">
      {WORKSPACE_FILTERS.map(value => <Pill key={value} active={filter === value}
        onClick={() => { navigate({ page: 'execution', query: { view: 'workspaces', ...value === 'attention' ? {} : { filter: value } } }, true) }}>
        {t(`workspaceFilter.${value}`)}{data ? <span className="dt-count">{data.counts[value]}</span> : null}</Pill>)}
    </div>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(row => <WorkspaceLine key={row.name} row={row}
      onChanged={reload} notify={notify} />)}</ul> : <Hint>{t('none')}</Hint>)}
  </>
}

function WorkspaceLine({ row, onChanged, notify }: { row: WorkspaceRow; onChanged: () => Promise<void>; notify: (text: string) => void }) {
  const { t, navigate } = usePanel()
  const mark = MARKS[row.state]
  const { facts, ticket, cleanup } = row
  const label = row.cleaning ? t('workspaceCleaning') : t(`workspaceState.${row.state}`)
  const stage = ticket && ticketMark(t, ticket as Parameters<typeof ticketMark>[1])
  return <li className="dt-row dt-ticket dt-workspace" data-state={mark.dot === 'error' ? 'error' : undefined}>
    <div className="dt-ticket-stage"><StageMark state={row.cleaning ? 'ongoing' : mark.dot} icon={mark.icon} label={label} /></div>
    <div className="dt-ticket-body">
      <div className="dt-row-title">
        <span className="dt-mono" title={row.directory}>{row.name}</span>
        {row.reason && <Tag tone={mark.tone}>{t(`workspaceReason.${row.reason}`)}</Tag>}
        {row.dueAt && <span className="dt-hint">{t('workspaceDueIn', { when: '' })}<When at={row.dueAt} /></span>}
      </div>
      <div className="dt-row-meta dt-line">
        {ticket ? <>
          <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'execution', id: ticket.id })}>{ticket.title}</button>
          {stage && <span className="dt-hint">{stage.label}</span>}
          {ticket.tier && <span className="dt-hint">{ticket.tier}</span>}
        </> : <span className="dt-hint">{t('workspaceOrphanHint')}</span>}
      </div>
      <div className="dt-row-meta dt-line">
        {!row.exists ? <span>{t('workspaceMissing')}</span> : facts ? <>
          <LabelValue label={t('workspaceKind')} value={t(`workspaceKind.${facts.kind}`)} />
          {facts.branch && <LabelValue label={t('workspaceBranch')} value={<span className="dt-mono">{facts.branch}</span>} />}
          {facts.bytes !== undefined && <LabelValue label={t('workspaceSize')} value={size(facts.bytes)} />}
          {facts.kind !== 'plain' && !facts.error && <span className={facts.changedCount ? 'dt-error-text' : undefined}
            title={facts.changed.join('\n') || undefined}>{facts.changedCount ? t('workspaceChanged', { count: String(facts.changedCount) })
              : t('workspaceClean')}</span>}
          {!!facts.unpushed && <span>{t('workspaceUnpushed', { count: String(facts.unpushed) })}</span>}
          {facts.error && <span className="dt-error-text">{t('workspaceReadFailed', { error: facts.error })}</span>}
        </> : <span className="dt-hint">{t('workspaceNotScanned')}</span>}
      </div>
      {cleanup && <div className="dt-row-meta dt-line">
        <span className={cleanup.state === 'failed' ? 'dt-error-text' : undefined}>
          {t(cleanup.state === 'failed' ? 'workspaceFailedAt' : 'workspaceCleanedAt', { when: '' })}<When at={cleanup.at} />
          {cleanup.forced && ` · ${t('workspaceForced')}`}
        </span>
        {cleanup.rebuiltAt && row.exists && <span>{t('workspaceRebuilt', { when: '' })}<When at={cleanup.rebuiltAt} /></span>}
      </div>}
      {cleanup?.output && cleanup.state === 'failed' && <pre className="dt-detail dt-mono dt-clamp dt-workspace-output">{cleanup.output}</pre>}
      <div className="dt-ticket-actions">
        {ticket?.sessionId && <SessionButton variant="outline" sessionId={ticket.sessionId} />}
        {row.actions.clean && <CleanButtons row={row} onChanged={onChanged} notify={notify} />}
      </div>
    </div>
  </li>
}

function CleanButtons({ row, onChanged, notify }: { row: WorkspaceRow; onChanged: () => Promise<void>; notify: (text: string) => void }) {
  const { t, call } = usePanel()
  const [asking, setAsking] = useState<'clean' | 'force'>()
  const clean = useAction(async () => {
    try {
      const record = await call('POST workspaces/:name/clean', { name: row.name, body: { force: asking === 'force' } })
      notify(t(record.state === 'cleaned' ? 'workspaceCleanDone' : 'workspaceCleanFailed', { name: row.name }))
    } catch (error) { notify(errorText(error)) }
    await onChanged()
  })
  const changed = row.facts?.changed ?? []
  const message = asking === 'force' ? t('workspaceForceConfirm', { name: row.name }) : t('workspaceCleanConfirm', { name: row.name })
  // A plain cleanup that the checks would refuse is not offered: it can only be forced.
  const plain = row.state !== 'skipped' && !row.facts?.changedCount
  return <>
    {plain && <Button variant="outline" size="sm" icon={<Icon name="trash" size={14} />} onClick={() => setAsking('clean')}>{t('workspaceCleanNow')}</Button>}
    <Button variant="outline" size="sm" icon={<Icon name="alert" size={14} />} onClick={() => setAsking('force')}>{t('workspaceForce')}</Button>
    <Modal open={!!asking} onClose={() => setAsking(undefined)} title={t(asking === 'force' ? 'workspaceForce' : 'workspaceCleanNow')}
      closeLabel={t('close')} description={message}
      footer={<>
        <Button variant="ghost" onClick={() => setAsking(undefined)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={clean.busy} onClick={() => { void clean.run().then(() => setAsking(undefined)) }}>{t('confirm')}</Button>
      </>}>
      {asking === 'force' && changed.length > 0 && <p className="dt-error-text dt-mono">{t('workspaceForceLoses', { files: changed.join(', ') })}</p>}
    </Modal>
  </>
}
