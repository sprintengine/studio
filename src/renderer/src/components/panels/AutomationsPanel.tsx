import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  Field,
  GhostButton,
  IconButton,
  InlineNotice,
  LifecycleGlyph,
  type LifecycleState,
  PanelHeader,
  PrimaryButton,
  Section,
  Select,
  type SelectItem,
  Spinner,
  Switch,
} from '../ui'
import type {
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationRun,
  AutomationRunStatus,
  AutomationStatus,
  AutomationsProviderView,
  AutomationsProviders,
  ScheduleTriggerConfig,
} from '../../../../shared/automations/contracts'

// ---------------------------------------------------------------------------
// Status mapping — status reads by glyph shape + text label, never colour alone
// (non-color-only accessibility). The shared LifecycleGlyph carries the shape.
// ---------------------------------------------------------------------------

const DEFINITION_LIFECYCLE: Record<AutomationStatus, LifecycleState> = {
  enabled: 'ready',
  paused: 'paused',
  // No distinct "blocked" shape exists; map to needs_input (warn ring + "!").
  blocked: 'needs_input',
}

const DEFINITION_STATUS_LABEL: Record<AutomationStatus, string> = {
  enabled: 'Enabled',
  paused: 'Paused',
  blocked: 'Blocked',
}

const RUN_LIFECYCLE: Record<AutomationRunStatus, LifecycleState> = {
  queued: 'todo',
  running: 'in_progress',
  completed: 'done',
  failed: 'failed',
  blocked: 'needs_input',
  skipped: 'archived',
}

const RUN_STATUS_LABEL: Record<AutomationRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Skipped',
}

// ---------------------------------------------------------------------------
// Time + cadence formatting
// ---------------------------------------------------------------------------

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function relativeFromNow(at: number, now: number): string {
  const deltaSec = Math.round((at - now) / 1000)
  const abs = Math.abs(deltaSec)
  if (abs < 60) return RELATIVE.format(deltaSec, 'second')
  if (abs < 3600) return RELATIVE.format(Math.round(deltaSec / 60), 'minute')
  if (abs < 86400) return RELATIVE.format(Math.round(deltaSec / 3600), 'hour')
  return RELATIVE.format(Math.round(deltaSec / 86400), 'day')
}

function absoluteTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function isScheduleConfig(config: unknown): config is ScheduleTriggerConfig {
  return Boolean(config) && typeof config === 'object' && (config as { kind?: unknown }).kind === 'schedule'
}

function cadenceSummary(trigger: AutomationDefinition['trigger']): string {
  if (trigger.kind !== 'schedule' || !isScheduleConfig(trigger.config)) return trigger.kind
  const cadence = trigger.config.cadence
  switch (cadence.type) {
    case 'interval': {
      const m = cadence.everyMinutes
      return m % 60 === 0 ? `Every ${m / 60}h` : `Every ${m} min`
    }
    case 'daily':
      return `Daily at ${cadence.timeLocal}`
    case 'weekly': {
      const days = [...cadence.daysOfWeek].sort((a, b) => a - b).map((d) => WEEKDAY_SHORT[d] ?? d).join(', ')
      return `Weekly · ${days} at ${cadence.timeLocal}`
    }
    case 'cron':
      return `Cron · ${cadence.expression}`
  }
}

// ---------------------------------------------------------------------------
// Default-focus ordering (Q1): blocked first, then overdue, then soonest due,
// then everything without a next run (paused / no schedule) at the bottom.
// ---------------------------------------------------------------------------

function isOverdue(def: AutomationDefinition, now: number): boolean {
  if (def.status !== 'enabled') return false
  const next = parseTime(def.nextRunAt)
  return next !== null && next < now
}

function sortDefinitions(defs: AutomationDefinition[], now: number): AutomationDefinition[] {
  const rank = (def: AutomationDefinition): number => {
    if (def.status === 'blocked') return 0
    if (isOverdue(def, now)) return 1
    if (def.status === 'enabled' && parseTime(def.nextRunAt) !== null) return 2
    return 3
  }
  return [...defs].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    const na = parseTime(a.nextRunAt)
    const nb = parseTime(b.nextRunAt)
    if (na !== null && nb !== null && na !== nb) return na - nb
    if (na !== null && nb === null) return -1
    if (na === null && nb !== null) return 1
    return a.name.localeCompare(b.name)
  })
}

// ---------------------------------------------------------------------------
// Editable-target guard so list shortcuts stay inert while typing.
// ---------------------------------------------------------------------------

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

type AsyncState = 'idle' | 'loading' | 'ready' | 'error'

type EditorState =
  | { mode: 'create' }
  | { mode: 'edit'; definition: AutomationDefinition }

export default function AutomationsPanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const folderPath = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)

  const [definitions, setDefinitions] = useState<AutomationDefinition[]>([])
  const [providers, setProviders] = useState<AutomationsProviders | null>(null)
  const [loadState, setLoadState] = useState<AsyncState>('idle')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [now, setNow] = useState(() => Date.now())
  const listRef = useRef<HTMLUListElement>(null)

  // A slow clock so "in 3h" / "overdue" stay honest without churning the list.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const load = useCallback(async () => {
    if (!folderPath) {
      setLoadState('error')
      setLoadError('This workspace has no folder, so its automations store is unavailable.')
      return
    }
    setLoadState('loading')
    setLoadError(null)
    const [list, provs] = await Promise.all([
      window.api.listAutomations({ workspaceRoot: folderPath }),
      window.api.listAutomationProviders(),
    ])
    if (!list.ok) {
      setLoadState('error')
      setLoadError(list.message)
      return
    }
    if (!provs.ok) {
      setLoadState('error')
      setLoadError(provs.message)
      return
    }
    setDefinitions(list.value)
    setProviders(provs.value)
    setLoadState('ready')
  }, [folderPath])

  useEffect(() => {
    void load()
  }, [load])

  const ordered = useMemo(() => sortDefinitions(definitions, now), [definitions, now])

  // Keep the selection valid as the list changes.
  useEffect(() => {
    if (selectedId && !definitions.some((d) => d.id === selectedId)) setSelectedId(null)
  }, [definitions, selectedId])

  const selected = useMemo(
    () => definitions.find((d) => d.id === selectedId) ?? null,
    [definitions, selectedId],
  )

  const handleRunNow = useCallback(async (def: AutomationDefinition) => {
    if (!folderPath) return
    setActionError(null)
    setBusyId(def.id)
    const result = await window.api.runAutomationNow({ workspaceRoot: folderPath, automationId: def.id })
    setBusyId(null)
    if (!result.ok) {
      setActionError(result.message)
      return
    }
    setDefinitions((prev) => prev.map((d) => (d.id === result.value.definition.id ? result.value.definition : d)))
  }, [folderPath])

  const handleToggleStatus = useCallback(async (def: AutomationDefinition) => {
    if (!folderPath) return
    setActionError(null)
    setBusyId(def.id)
    const nextStatus: AutomationStatus = def.status === 'enabled' ? 'paused' : 'enabled'
    const result = await window.api.updateAutomation({
      workspaceRoot: folderPath,
      automationId: def.id,
      patch: { status: nextStatus },
    })
    setBusyId(null)
    if (!result.ok) {
      setActionError(result.message)
      return
    }
    setDefinitions((prev) => prev.map((d) => (d.id === result.value.id ? result.value : d)))
  }, [folderPath])

  const handleDelete = useCallback(async (def: AutomationDefinition) => {
    if (!folderPath) return
    setActionError(null)
    setBusyId(def.id)
    const result = await window.api.deleteAutomation({ workspaceRoot: folderPath, automationId: def.id })
    setBusyId(null)
    if (!result.ok) {
      setActionError(result.message)
      return
    }
    setDefinitions((prev) => prev.filter((d) => d.id !== def.id))
    if (selectedId === def.id) setSelectedId(null)
  }, [folderPath, selectedId])

  const handleEditorSaved = useCallback((saved: AutomationDefinition) => {
    setDefinitions((prev) => {
      const exists = prev.some((d) => d.id === saved.id)
      return exists ? prev.map((d) => (d.id === saved.id ? saved : d)) : [...prev, saved]
    })
    setSelectedId(saved.id)
    setEditor(null)
  }, [])

  const onListKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (isEditableTarget(event.target) || ordered.length === 0) return
    const index = selectedId ? ordered.findIndex((d) => d.id === selectedId) : -1
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault()
      const next = ordered[Math.min(index + 1, ordered.length - 1)] ?? ordered[0]
      setSelectedId(next.id)
      setEditor(null)
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault()
      const prev = ordered[Math.max(index - 1, 0)] ?? ordered[0]
      setSelectedId(prev.id)
      setEditor(null)
    } else if (event.key === 'Escape') {
      setSelectedId(null)
    }
  }, [ordered, selectedId])

  const titleId = `automations-${workspaceId}`

  return (
    <section
      aria-labelledby={titleId}
      className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)]"
    >
      <PanelHeader
        title="Automations"
        titleId={titleId}
        subtitle="Runs while Multicode is open"
        count={loadState === 'ready' ? definitions.length : undefined}
        primaryAction={
          <PrimaryButton
            onClick={() => { setEditor({ mode: 'create' }); setSelectedId(null); setActionError(null) }}
            disabled={loadState !== 'ready'}
          >
            New automation
          </PrimaryButton>
        }
      />

      {actionError ? (
        <div className="px-3 pt-3">
          <InlineNotice tone="error" action={<GhostButton onClick={() => setActionError(null)}>Dismiss</GhostButton>}>
            {actionError}
          </InlineNotice>
        </div>
      ) : null}

      {loadState === 'loading' || loadState === 'idle' ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-[color:var(--text-muted)]">
          <Spinner size={14} label="Loading automations" />
          Loading automations…
        </div>
      ) : loadState === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="max-w-sm text-[12px] leading-5 text-[color:var(--text-muted)]">
            Automations are unavailable for this project.
          </p>
          <p className="max-w-sm text-[11px] leading-5 text-[color:var(--tone-error)]">{loadError}</p>
          <GhostButton onClick={() => void load()}>Retry</GhostButton>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <DefinitionList
            ref={listRef}
            definitions={ordered}
            selectedId={editor ? null : selectedId}
            busyId={busyId}
            now={now}
            onSelect={(id) => { setSelectedId(id); setEditor(null) }}
            onKeyDown={onListKeyDown}
            onRunNow={handleRunNow}
            onToggleStatus={handleToggleStatus}
            onEdit={(def) => { setEditor({ mode: 'edit', definition: def }); setSelectedId(def.id) }}
            onDelete={handleDelete}
            onCreate={() => { setEditor({ mode: 'create' }); setSelectedId(null) }}
          />
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-[color:var(--border-default)] md:border-l md:border-t-0">
            {editor ? (
              <AutomationEditor
                key={editor.mode === 'edit' ? editor.definition.id : 'create'}
                editor={editor}
                providers={providers}
                workspaceRoot={folderPath ?? ''}
                onCancel={() => setEditor(null)}
                onSaved={handleEditorSaved}
              />
            ) : selected ? (
              <DetailPane
                definition={selected}
                workspaceRoot={folderPath ?? ''}
                now={now}
                onOpenAgent={(wsId) => setActiveWorkspace(wsId)}
              />
            ) : (
              <DetailEmptyState hasDefinitions={definitions.length > 0} />
            )}
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Definition list
// ---------------------------------------------------------------------------

type DefinitionListProps = {
  definitions: AutomationDefinition[]
  selectedId: string | null
  busyId: string | null
  now: number
  onSelect: (id: string) => void
  onKeyDown: (event: React.KeyboardEvent) => void
  onRunNow: (def: AutomationDefinition) => void
  onToggleStatus: (def: AutomationDefinition) => void
  onEdit: (def: AutomationDefinition) => void
  onDelete: (def: AutomationDefinition) => void
  onCreate: () => void
}

const DefinitionList = React.forwardRef<HTMLUListElement, DefinitionListProps>(function DefinitionList(
  { definitions, selectedId, busyId, now, onSelect, onKeyDown, onRunNow, onToggleStatus, onEdit, onDelete, onCreate },
  ref,
) {
  if (definitions.length === 0) {
    return (
      <div className="flex w-full shrink-0 flex-col items-center justify-center gap-3 px-6 py-10 text-center md:w-[340px] md:border-r md:border-[color:var(--border-default)]">
        <p className="text-[12px] font-medium text-[color:var(--text-strong)]">No automations yet</p>
        <p className="max-w-[15rem] text-[11px] leading-5 text-[color:var(--text-muted)]">
          Schedule an agent to run on this project — a nightly review, a recurring check.
        </p>
        <PrimaryButton onClick={onCreate}>New automation</PrimaryButton>
      </div>
    )
  }
  return (
    <ul
      ref={ref}
      aria-label="Automations. Use j and k or the arrow keys to move between automations."
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="w-full shrink-0 overflow-y-auto py-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[color:var(--accent-primary)] md:w-[340px] md:border-r md:border-[color:var(--border-default)]"
    >
      {definitions.map((def) => (
        <DefinitionRow
          key={def.id}
          def={def}
          selected={def.id === selectedId}
          busy={busyId === def.id}
          now={now}
          onSelect={() => onSelect(def.id)}
          onRunNow={() => onRunNow(def)}
          onToggleStatus={() => onToggleStatus(def)}
          onEdit={() => onEdit(def)}
          onDelete={() => onDelete(def)}
        />
      ))}
    </ul>
  )
})

function DefinitionRow({
  def, selected, busy, now, onSelect, onRunNow, onToggleStatus, onEdit, onDelete,
}: {
  def: AutomationDefinition
  selected: boolean
  busy: boolean
  now: number
  onSelect: () => void
  onRunNow: () => void
  onToggleStatus: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const overdue = isOverdue(def, now)
  const nextAt = parseTime(def.nextRunAt)
  const lastAt = parseTime(def.lastRunAt)
  const statusLabel = def.status === 'enabled' && overdue ? 'Overdue' : DEFINITION_STATUS_LABEL[def.status]

  return (
    <li
      id={`automation-row-${def.id}`}
      aria-current={selected ? 'true' : undefined}
      className={[
        'group relative border-b border-[color:var(--border-subtle)] py-2 transition-colors',
        selected
          ? 'border-l-[3px] border-l-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)] pl-[13px] pr-3'
          : 'px-4 hover:bg-[color:var(--bg-hover)]',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-start gap-2 text-left outline-none"
      >
        {busy ? (
          <Spinner size={14} label="Working" className="mt-[2px]" />
        ) : (
          <LifecycleGlyph
            state={DEFINITION_LIFECYCLE[def.status]}
            live={def.status === 'enabled'}
            label={statusLabel}
            className="mt-[1px] translate-y-[1px]"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[12px] font-medium text-[color:var(--text-strong)]">{def.name}</span>
            <span
              className={[
                'shrink-0 text-[10px]',
                overdue ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-subtle)]',
              ].join(' ')}
            >
              {statusLabel}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-[color:var(--text-muted)]">
            {cadenceSummary(def.trigger)}
            <span aria-hidden="true" className="mx-1.5 text-[color:var(--text-disabled)]">·</span>
            {nextAt !== null ? (
              <span className="tabular-nums" title={absoluteTime(nextAt)}>
                {overdue ? 'Was due ' : 'Next '}{relativeFromNow(nextAt, now)}
              </span>
            ) : lastAt !== null ? (
              <span className="tabular-nums" title={absoluteTime(lastAt)}>Ran {relativeFromNow(lastAt, now)}</span>
            ) : (
              <span>No upcoming run</span>
            )}
          </div>
        </div>
      </button>

      {/* Trailing actions: revealed on hover/focus/selection so a resting row stays calm. */}
      <div
        className={[
          'mt-1.5 flex items-center gap-1 pl-6 transition-opacity',
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
        ].join(' ')}
      >
        <GhostButton
          onClick={(e) => { e.stopPropagation(); onRunNow() }}
          disabled={busy || def.status === 'paused'}
          className="h-6 px-2 text-[11px]"
        >
          Run now
        </GhostButton>
        <GhostButton
          onClick={(e) => { e.stopPropagation(); onToggleStatus() }}
          disabled={busy}
          className="h-6 px-2 text-[11px]"
        >
          {def.status === 'enabled' ? 'Pause' : 'Enable'}
        </GhostButton>
        <GhostButton
          onClick={(e) => { e.stopPropagation(); onEdit() }}
          disabled={busy}
          className="h-6 px-2 text-[11px]"
        >
          Edit
        </GhostButton>
        <IconButton
          aria-label={`Delete ${def.name}`}
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          disabled={busy}
          className="h-6 w-6"
        >
          <svg viewBox="0 0 16 16" className="icon-xs" fill="none" aria-hidden="true">
            <path d="M3.5 4.5h9M6.5 4.5V3.5h3v1M5 4.5l.5 8h5l.5-8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconButton>
      </div>
    </li>
  )
}

function DetailEmptyState({ hasDefinitions }: { hasDefinitions: boolean }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <p className="max-w-xs text-[11px] leading-5 text-[color:var(--text-muted)]">
        {hasDefinitions
          ? 'Select an automation to see its run history and details.'
          : 'Create an automation to schedule agents on this project.'}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail pane — selected definition's run timeline + summary
// ---------------------------------------------------------------------------

function DetailPane({
  definition, workspaceRoot, now, onOpenAgent,
}: {
  definition: AutomationDefinition
  workspaceRoot: string
  now: number
  onOpenAgent: (workspaceId: string) => void
}) {
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [state, setState] = useState<AsyncState>('idle')
  const [error, setError] = useState<string | null>(null)

  const loadRuns = useCallback(async () => {
    if (!workspaceRoot) return
    setState('loading')
    setError(null)
    const result = await window.api.listAutomationRuns({ workspaceRoot, automationId: definition.id })
    if (!result.ok) {
      setState('error')
      setError(result.message)
      return
    }
    // Newest first for the timeline.
    setRuns([...result.value].sort((a, b) => (parseTime(b.dueAt) ?? 0) - (parseTime(a.dueAt) ?? 0)))
    setState('ready')
  }, [workspaceRoot, definition.id, definition.lastRunId])

  useEffect(() => { void loadRuns() }, [loadRuns])

  const nextAt = parseTime(definition.nextRunAt)
  const lastAt = parseTime(definition.lastRunAt)

  return (
    <div className="flex flex-col">
      <div className="border-b border-[color:var(--border-default)] px-4 py-3">
        <div className="flex items-center gap-2">
          <LifecycleGlyph
            state={DEFINITION_LIFECYCLE[definition.status]}
            live={definition.status === 'enabled'}
            label={DEFINITION_STATUS_LABEL[definition.status]}
          />
          <h3 className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">{definition.name}</h3>
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
          <Meta label="Trigger" value={cadenceSummary(definition.trigger)} />
          <Meta label="Action" value={`${definition.action.kind} · ${definition.autonomyDefault === 'allow_changes' ? 'Allow changes' : 'Review only'}`} />
          <Meta label="Next run" value={nextAt !== null ? `${relativeFromNow(nextAt, now)} (${absoluteTime(nextAt)})` : definition.status === 'enabled' ? 'Pending' : 'Paused'} />
          <Meta label="Last run" value={lastAt !== null ? `${relativeFromNow(lastAt, now)} (${absoluteTime(lastAt)})` : 'Never run'} />
        </dl>
        {definition.status === 'blocked' ? (
          <div className="mt-2">
            <InlineNotice tone="warn">
              This automation is blocked and will not fire until the cause is resolved. See the latest run below.
            </InlineNotice>
          </div>
        ) : null}
      </div>

      <Section title="Run history" count={state === 'ready' ? runs.length : undefined} action={<GhostButton onClick={() => void loadRuns()} className="h-6 px-2 text-[11px]">Refresh</GhostButton>}>
        {state === 'loading' || state === 'idle' ? (
          <div className="flex items-center gap-2 py-3 text-[11px] text-[color:var(--text-muted)]">
            <Spinner size={12} label="Loading runs" /> Loading runs…
          </div>
        ) : state === 'error' ? (
          <InlineNotice tone="error" action={<GhostButton onClick={() => void loadRuns()}>Retry</GhostButton>}>
            {error}
          </InlineNotice>
        ) : runs.length === 0 ? (
          <p className="py-3 text-[11px] leading-5 text-[color:var(--text-muted)]">
            No runs yet. {definition.status === 'enabled' ? 'The first run will appear here when the schedule fires or you run it now.' : 'Enable the automation to schedule runs.'}
          </p>
        ) : (
          <ol className="flex flex-col">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} now={now} onOpenAgent={onOpenAgent} />
            ))}
          </ol>
        )}
      </Section>
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[color:var(--text-subtle)]">{label}</dt>
      <dd className="min-w-0 truncate text-[color:var(--text-default)]" title={value}>{value}</dd>
    </>
  )
}

// Watchtower-style run row: leading lifecycle glyph (shape-coded), identifier in
// mono, timing in tabular figures, and a trailing "Open agent" when a run
// launched one.
function RunRow({ run, now, onOpenAgent }: { run: AutomationRun; now: number; onOpenAgent: (workspaceId: string) => void }) {
  const dueAt = parseTime(run.dueAt)
  const startedAt = parseTime(run.startedAt)
  const completedAt = parseTime(run.completedAt)
  const stamp = completedAt ?? startedAt ?? dueAt

  return (
    <li className="flex items-start gap-2 border-b border-[color:var(--border-subtle)] py-2 last:border-b-0">
      <LifecycleGlyph
        state={RUN_LIFECYCLE[run.status]}
        live={run.status === 'running'}
        label={RUN_STATUS_LABEL[run.status]}
        className="mt-[1px] translate-y-[1px]"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-medium text-[color:var(--text-strong)]">{RUN_STATUS_LABEL[run.status]}</span>
          {stamp !== null ? (
            <span className="shrink-0 tabular-nums text-[10px] text-[color:var(--text-subtle)]" title={absoluteTime(stamp)}>
              {relativeFromNow(stamp, now)}
            </span>
          ) : null}
        </div>
        {run.summary ? (
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-[color:var(--text-muted)]">{run.summary}</p>
        ) : null}
        {run.blockedReason ? (
          <p className="mt-0.5 text-[11px] leading-4 text-[color:var(--tone-warn)]">{run.blockedReason}</p>
        ) : null}
        {(run.workspaceId || run.agentId) ? (
          <div className="mt-1 flex items-center gap-2">
            {run.agentId ? (
              <span className="font-mono text-[10px] text-[color:var(--text-subtle)]">{run.agentId}</span>
            ) : null}
            {run.workspaceId ? (
              <GhostButton onClick={() => onOpenAgent(run.workspaceId!)} className="h-5 px-1.5 text-[10px]">
                Open agent
              </GhostButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Editor — schema-driven create / edit form
// ---------------------------------------------------------------------------

type CadenceType = 'interval' | 'daily' | 'weekly'

type EditorFormState = {
  name: string
  enabled: boolean
  autonomy: AutomationDefinition['autonomyDefault']
  actionKind: string
  cadenceType: CadenceType
  everyMinutes: number
  timeLocal: string
  daysOfWeek: number[]
  config: Record<string, string>
}

// Action config keys the engine owns internally — never exposed as form fields.
const INTERNAL_CONFIG_KEYS = new Set(['workspaceId', 'folderPath', 'requiredIntegrations'])

const CONFIG_FIELD_LABEL: Record<string, string> = {
  prompt: 'Prompt',
  cli: 'CLI',
  name: 'Agent name',
  skill: 'Skill',
}

function schemaStringKeys(schema: AutomationsProviderView['configSchema']): string[] {
  const properties = (schema as { properties?: Record<string, unknown> }).properties
  if (!properties) return []
  return Object.keys(properties).filter((key) => {
    if (INTERNAL_CONFIG_KEYS.has(key)) return false
    const prop = properties[key]
    return Boolean(prop) && typeof prop === 'object' && (prop as { type?: unknown }).type === 'string'
  })
}

function schemaRequiredKeys(schema: AutomationsProviderView['configSchema']): Set<string> {
  const required = (schema as { required?: unknown }).required
  return new Set(Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : [])
}

function initialFormState(editor: EditorState, providers: AutomationsProviders): EditorFormState {
  const firstAvailableAction =
    providers.actions.find((a) => a.missingIntegrations.length === 0) ?? providers.actions[0]
  if (editor.mode === 'create') {
    return {
      name: '',
      enabled: true,
      autonomy: 'review_only',
      actionKind: firstAvailableAction?.kind ?? '',
      cadenceType: 'interval',
      everyMinutes: 30,
      timeLocal: '09:00',
      daysOfWeek: [1, 2, 3, 4, 5],
      config: {},
    }
  }
  const def = editor.definition
  const schedule = isScheduleConfig(def.trigger.config) ? def.trigger.config : null
  const cadence = schedule?.cadence
  const config: Record<string, string> = {}
  if (def.action.config && typeof def.action.config === 'object') {
    for (const [key, value] of Object.entries(def.action.config as Record<string, unknown>)) {
      if (!INTERNAL_CONFIG_KEYS.has(key) && typeof value === 'string') config[key] = value
    }
  }
  return {
    name: def.name,
    enabled: def.status !== 'paused',
    autonomy: def.autonomyDefault,
    actionKind: def.action.kind,
    cadenceType: cadence?.type === 'daily' || cadence?.type === 'weekly' ? cadence.type : 'interval',
    everyMinutes: cadence?.type === 'interval' ? cadence.everyMinutes : 30,
    timeLocal: cadence && (cadence.type === 'daily' || cadence.type === 'weekly') ? cadence.timeLocal : '09:00',
    daysOfWeek: cadence?.type === 'weekly' ? cadence.daysOfWeek : [1, 2, 3, 4, 5],
    config,
  }
}

function buildCadence(form: EditorFormState): ScheduleTriggerConfig['cadence'] {
  if (form.cadenceType === 'daily') return { type: 'daily', timeLocal: form.timeLocal }
  if (form.cadenceType === 'weekly') return { type: 'weekly', timeLocal: form.timeLocal, daysOfWeek: form.daysOfWeek }
  return { type: 'interval', everyMinutes: form.everyMinutes }
}

function AutomationEditor({
  editor, providers, workspaceRoot, onCancel, onSaved,
}: {
  editor: EditorState
  providers: AutomationsProviders | null
  workspaceRoot: string
  onCancel: () => void
  onSaved: (saved: AutomationDefinition) => void
}) {
  const [form, setForm] = useState<EditorFormState>(() =>
    providers ? initialFormState(editor, providers) : {
      name: '', enabled: true, autonomy: 'review_only', actionKind: '',
      cadenceType: 'interval', everyMinutes: 30, timeLocal: '09:00', daysOfWeek: [1, 2, 3, 4, 5], config: {},
    })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const actionProvider = providers?.actions.find((a) => a.kind === form.actionKind) ?? null
  const actionMissing = actionProvider?.missingIntegrations ?? []
  const configKeys = actionProvider ? schemaStringKeys(actionProvider.configSchema) : []
  const requiredKeys = actionProvider ? schemaRequiredKeys(actionProvider.configSchema) : new Set<string>()

  const update = useCallback(<K extends keyof EditorFormState>(key: K, value: EditorFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }, [])

  const validationError = useMemo((): string | null => {
    if (!form.name.trim()) return 'Give the automation a name.'
    if (!actionProvider) return 'No action provider is available.'
    if (actionMissing.length > 0) return `The "${form.actionKind}" action needs ${actionMissing.join(', ')}, which is not available.`
    if (form.cadenceType === 'interval' && form.everyMinutes < 5) return 'Interval must be at least 5 minutes.'
    if (form.cadenceType === 'weekly' && form.daysOfWeek.length === 0) return 'Pick at least one day for a weekly schedule.'
    for (const key of requiredKeys) {
      if (INTERNAL_CONFIG_KEYS.has(key)) continue
      if (!form.config[key]?.trim()) return `${CONFIG_FIELD_LABEL[key] ?? key} is required.`
    }
    return null
  }, [form, actionProvider, actionMissing, requiredKeys])

  const handleSubmit = useCallback(async () => {
    if (validationError || !workspaceRoot) { setError(validationError); return }
    setSaving(true)
    setError(null)
    const config: Record<string, string> = {}
    for (const key of configKeys) {
      const value = form.config[key]?.trim()
      if (value) config[key] = value
    }
    const draft: AutomationDefinitionDraft = {
      name: form.name.trim(),
      status: form.enabled ? 'enabled' : 'paused',
      autonomyDefault: form.autonomy,
      trigger: {
        kind: 'schedule',
        config: {
          kind: 'schedule',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          cadence: buildCadence(form),
        } satisfies ScheduleTriggerConfig,
      },
      action: { kind: form.actionKind, config },
    }
    const result = editor.mode === 'create'
      ? await window.api.createAutomation({ workspaceRoot, definition: draft })
      : await window.api.updateAutomation({
        workspaceRoot,
        automationId: editor.definition.id,
        patch: {
          name: draft.name,
          status: draft.status,
          autonomyDefault: draft.autonomyDefault,
          trigger: draft.trigger,
          action: draft.action,
        },
      })
    setSaving(false)
    if (!result.ok) { setError(result.message); return }
    onSaved(result.value)
  }, [validationError, workspaceRoot, configKeys, form, editor, onSaved])

  const actionItems: SelectItem[] = (providers?.actions ?? []).map((a) => ({
    value: a.kind,
    label: a.missingIntegrations.length > 0 ? `${a.kind} (needs ${a.missingIntegrations.join(', ')})` : a.kind,
    disabled: a.missingIntegrations.length > 0,
  }))

  return (
    <form
      className="flex flex-col gap-4 px-4 py-4"
      onSubmit={(e) => { e.preventDefault(); void handleSubmit() }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-[color:var(--text-strong)]">
          {editor.mode === 'create' ? 'New automation' : 'Edit automation'}
        </h3>
        <GhostButton type="button" onClick={onCancel} className="h-6 px-2 text-[11px]">Cancel</GhostButton>
      </div>

      <Field label="Name" htmlFor="automation-name" required>
        <input
          id="automation-name"
          type="text"
          value={form.name}
          onChange={(e) => update('name', e.target.value)}
          placeholder="Nightly review of this repo"
          className="w-full rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] px-2.5 py-1.5 text-[12px] text-[color:var(--text-default)] outline-none focus-visible:border-[color:var(--accent-primary)]"
        />
      </Field>

      {/* Schedule (trigger) — the schedule provider's cadence oneOf. */}
      <fieldset className="flex flex-col gap-3 rounded-md border border-[color:var(--border-subtle)] p-3">
        <legend className="px-1 text-[11px] font-medium text-[color:var(--text-muted)]">Schedule</legend>
        <Field label="Cadence" htmlFor="automation-cadence">
          <Select<CadenceType>
            ariaLabel="Cadence"
            value={form.cadenceType}
            onChange={(value) => update('cadenceType', value)}
            items={[
              { value: 'interval', label: 'Every N minutes' },
              { value: 'daily', label: 'Daily' },
              { value: 'weekly', label: 'Weekly' },
            ]}
          />
        </Field>
        {form.cadenceType === 'interval' ? (
          <Field label="Run every (minutes)" htmlFor="automation-interval" help="Minimum 5 minutes.">
            <input
              id="automation-interval"
              type="number"
              min={5}
              value={form.everyMinutes}
              onChange={(e) => update('everyMinutes', Math.max(5, Number(e.target.value) || 0))}
              className="w-32 rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] px-2.5 py-1.5 text-[12px] tabular-nums text-[color:var(--text-default)] outline-none focus-visible:border-[color:var(--accent-primary)]"
            />
          </Field>
        ) : (
          <Field label="Time" htmlFor="automation-time" help="Local time, 24-hour (HH:MM).">
            <input
              id="automation-time"
              type="time"
              value={form.timeLocal}
              onChange={(e) => update('timeLocal', e.target.value)}
              className="w-32 rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] px-2.5 py-1.5 text-[12px] tabular-nums text-[color:var(--text-default)] outline-none focus-visible:border-[color:var(--accent-primary)]"
            />
          </Field>
        )}
        {form.cadenceType === 'weekly' ? (
          <fieldset>
            <legend className="mb-1 text-[11px] text-[color:var(--text-subtle)]">Days</legend>
            <div className="flex flex-wrap gap-1">
              {WEEKDAY_SHORT.map((label, day) => {
                const checked = form.daysOfWeek.includes(day)
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={checked}
                    onClick={() => update('daysOfWeek', checked ? form.daysOfWeek.filter((d) => d !== day) : [...form.daysOfWeek, day])}
                    className={[
                      'h-7 w-9 rounded-md border text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary)]',
                      checked
                        ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
                        : 'border-[color:var(--border-strong)] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)]',
                    ].join(' ')}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </fieldset>
        ) : null}
      </fieldset>

      {/* Action — schema-driven from providers:list. */}
      <fieldset className="flex flex-col gap-3 rounded-md border border-[color:var(--border-subtle)] p-3">
        <legend className="px-1 text-[11px] font-medium text-[color:var(--text-muted)]">Action</legend>
        <Field label="Action" htmlFor="automation-action">
          <Select
            ariaLabel="Action"
            value={form.actionKind || null}
            onChange={(value) => update('actionKind', value)}
            items={actionItems}
            placeholder="Select an action…"
          />
        </Field>
        {actionMissing.length > 0 ? (
          <InlineNotice tone="warn">
            This action needs {actionMissing.join(', ')}, which is not connected. Connect it to enable this action.
          </InlineNotice>
        ) : (
          configKeys.map((key) => {
            const required = requiredKeys.has(key)
            const label = CONFIG_FIELD_LABEL[key] ?? key
            const id = `automation-config-${key}`
            return (
              <Field key={key} label={label} htmlFor={id} required={required}>
                {key === 'prompt' ? (
                  <textarea
                    id={id}
                    rows={4}
                    value={form.config[key] ?? ''}
                    onChange={(e) => update('config', { ...form.config, [key]: e.target.value })}
                    placeholder="Review the changes on this repo and summarise risks."
                    className="w-full resize-y rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] px-2.5 py-1.5 text-[12px] leading-5 text-[color:var(--text-default)] outline-none focus-visible:border-[color:var(--accent-primary)]"
                  />
                ) : (
                  <input
                    id={id}
                    type="text"
                    value={form.config[key] ?? ''}
                    onChange={(e) => update('config', { ...form.config, [key]: e.target.value })}
                    className="w-full rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] px-2.5 py-1.5 text-[12px] text-[color:var(--text-default)] outline-none focus-visible:border-[color:var(--accent-primary)]"
                  />
                )}
              </Field>
            )
          })
        )}
      </fieldset>

      <div className="flex items-center justify-between gap-3">
        <label htmlFor="automation-autonomy" className="flex items-center gap-2 text-[12px] text-[color:var(--text-default)]">
          <Switch
            id="automation-autonomy"
            checked={form.autonomy === 'allow_changes'}
            onChange={(next) => update('autonomy', next ? 'allow_changes' : 'review_only')}
            ariaLabel="Allow the agent to change files"
          />
          Allow changes
          <span className="text-[11px] text-[color:var(--text-subtle)]">{form.autonomy === 'allow_changes' ? '(agent may edit files)' : '(review only)'}</span>
        </label>
        <label htmlFor="automation-enabled" className="flex items-center gap-2 text-[12px] text-[color:var(--text-default)]">
          <Switch
            id="automation-enabled"
            checked={form.enabled}
            onChange={(next) => update('enabled', next)}
            ariaLabel="Enable this automation"
          />
          Enabled
        </label>
      </div>

      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}

      <div className="flex items-center gap-2">
        <PrimaryButton type="submit" disabled={saving || validationError !== null}>
          {saving ? 'Saving…' : editor.mode === 'create' ? 'Create automation' : 'Save changes'}
        </PrimaryButton>
        <GhostButton type="button" onClick={onCancel}>Cancel</GhostButton>
        {validationError ? (
          <span className="text-[11px] text-[color:var(--text-subtle)]">{validationError}</span>
        ) : null}
      </div>
    </form>
  )
}
