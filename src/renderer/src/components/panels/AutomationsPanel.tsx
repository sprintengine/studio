import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { revealAutomationAgent } from '../../hooks/useAutomationRequests'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { consumePendingRevealTarget, subscribeRevealTarget } from '../../utils/revealTarget'
import type { NotificationNavigationTarget } from '../../types/workspace'
import type { AutomationDefinition } from '../../../../shared/automations/contracts'
import { GhostButton, InlineNotice, LifecycleGlyph, PanelHeader, PrimaryButton, Spinner, useConfirmDialog } from '../ui'
import { AutomationDetailPane } from './AutomationsPanel/AutomationDetailPane'
import { AutomationEditor } from './AutomationsPanel/AutomationEditor'
import { DefinitionList, DetailEmptyState } from './AutomationsPanel/AutomationsList'
import { AutomationsRunsFeed } from './AutomationsPanel/AutomationsRunsFeed'
import { engineHealth, isEditableTarget, isEngineUnreachable, sortDefinitions, type EditorState, type EngineHealth } from './AutomationsPanel/automationsFormat'
import { useAutomationsController } from './AutomationsPanel/useAutomationsController'
import { RUN_TARGET_KIND, decodeRunRef, encodeRunRef } from '../automations/runTarget'

type AutomationsView = 'definitions' | 'runs'

// Automations control center: composes the data controller (window.api IPC
// boundary), the definitions list, the run-history/detail pane, and the
// schema-driven editor. Sub-modules live in ./AutomationsPanel/*.
export default function AutomationsPanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const folderPath = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null)
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? null)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const dialog = useConfirmDialog()

  const {
    definitions, providers, engineStatus, loadState, loadError, actionError, busyId,
    load, clearActionError, runNow, toggleStatus, remove, applySaved,
    feedRuns, feedState, feedError, feedPartialCount, loadRunsFeed, finalizeFeedRun,
  } = useAutomationsController({ folderPath, workspaceId })

  const [view, setView] = useState<AutomationsView>('definitions')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Run a notification's Open action latches a target here; it is applied once
  // the named definition has loaded, then the run is scrolled into view.
  const [pendingRunTarget, setPendingRunTarget] = useState<{ automationId: string; runId: string } | null>(null)
  const [focusRunId, setFocusRunId] = useState<string | null>(null)
  // Bumped each time a reveal target is applied so re-opening the same run's
  // notification re-triggers the scroll/highlight even though the run id is
  // unchanged.
  const [focusNonce, setFocusNonce] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  // A slow clock so "in 3h" / "overdue" stay honest without churning the list.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const ordered = useMemo(() => sortDefinitions(definitions, now), [definitions, now])

  // Aggregate the runs feed on demand — only while the runs view is open, and
  // refreshed when the definition set changes underneath it.
  useEffect(() => {
    if (view === 'runs' && loadState === 'ready') void loadRunsFeed()
  }, [view, loadState, loadRunsFeed])

  const engine = engineHealth(engineStatus)
  const engineUnreachable = isEngineUnreachable(engineStatus)

  // Keep the selection valid as the list changes.
  useEffect(() => {
    if (selectedId && !definitions.some((d) => d.id === selectedId)) setSelectedId(null)
  }, [definitions, selectedId])

  const selected = useMemo(
    () => definitions.find((d) => d.id === selectedId) ?? null,
    [definitions, selectedId],
  )

  const handleEditorSaved = useCallback((saved: AutomationDefinition) => {
    applySaved(saved)
    setSelectedId(saved.id)
    setEditor(null)
  }, [applySaved])

  // Delete drops the definition and its run-history directory in the store, so
  // gate it behind a danger confirm — cancel must leave both untouched.
  const handleDelete = useCallback(async (def: AutomationDefinition) => {
    const confirmed = await dialog.confirm({
      title: `Delete ${def.name}?`,
      body: 'This removes the automation and its run history. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (confirmed) await remove(def)
  }, [dialog, remove])

  // Run now is the only run whose terminal status the renderer observes (the
  // IPC return). On a failed/blocked outcome raise a notification whose Open
  // action deep-links back to this control center and the originating run.
  // Scheduled/background runs notify via T12/T13, not here.
  const handleRunNow = useCallback(async (def: AutomationDefinition) => {
    const run = await runNow(def)
    if (!run || (run.status !== 'failed' && run.status !== 'blocked')) return
    publishDiagnosticSync({
      level: run.status === 'failed' ? 'error' : 'warning',
      source: 'automations',
      title: `Automation ${run.status}: ${def.name}`,
      message: run.blockedReason || run.summary || `The run ended ${run.status}.`,
      workspaceId,
      workspaceName: workspaceName ?? undefined,
      navigationTarget: { kind: RUN_TARGET_KIND, ref: encodeRunRef(def.id, run.id, folderPath) },
    })
  }, [runNow, workspaceId, workspaceName, folderPath])

  // Deep-link from an automations run notification. The shell reveals the
  // workspace; this latches the target (drained on mount AND via the live
  // event, refreshed through a ref so re-renders don't churn the listener) and
  // applies it once the definition has loaded.
  const revealTargetHandlerRef = useRef<(target: NotificationNavigationTarget) => void>(() => {})
  revealTargetHandlerRef.current = (target) => {
    if (target.kind !== RUN_TARGET_KIND) return
    const decoded = decodeRunRef(target.ref)
    if (decoded) setPendingRunTarget(decoded)
  }
  useEffect(() => {
    const pending = consumePendingRevealTarget(workspaceId)
    if (pending) revealTargetHandlerRef.current(pending)
    return subscribeRevealTarget((detail) => {
      if (detail.workspaceId !== workspaceId) return
      // Clear the latch so the mount-drain path can't re-fire the same target.
      consumePendingRevealTarget(workspaceId)
      revealTargetHandlerRef.current(detail.target)
    })
  }, [workspaceId])

  // Apply a latched target once its definition is present (the list loads
  // asynchronously, so the target can arrive before the row exists).
  useEffect(() => {
    if (!pendingRunTarget || !definitions.some((d) => d.id === pendingRunTarget.automationId)) return
    setEditor(null)
    setSelectedId(pendingRunTarget.automationId)
    setFocusRunId(pendingRunTarget.runId)
    setFocusNonce((n) => n + 1)
    setPendingRunTarget(null)
  }, [pendingRunTarget, definitions])

  // Drill from a runs-feed row into its owning definition: switch to the
  // Definitions view, select the definition, and focus the run in its detail
  // timeline — reusing the same focusRunId/focusNonce plumbing the run
  // notifications use. The definition is already loaded (the feed is built from
  // the loaded set), so the target is applied directly rather than latched.
  const handleOpenRunDefinition = useCallback((automationId: string, runId: string) => {
    setView('definitions')
    setEditor(null)
    setSelectedId(automationId)
    setFocusRunId(runId)
    setFocusNonce((n) => n + 1)
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
    // The panel host can squeeze this column very narrow (e.g. a 390px viewport
    // with the workspace sidebar open). Scroll the whole panel horizontally
    // below a readable minimum so the header action, row actions, and detail
    // controls stay reachable instead of clipping offscreen.
    <section
      aria-labelledby={titleId}
      className="flex h-full min-h-0 flex-col overflow-x-auto bg-[color:var(--bg-app)] text-[color:var(--text-default)]"
    >
      <div className="flex h-full min-h-0 w-full min-w-[16rem] flex-col">
        <PanelHeader
          title="Automations"
          titleId={titleId}
          subtitle="Runs while Multicode is open"
          count={loadState === 'ready' ? definitions.length : undefined}
          primaryAction={
            <PrimaryButton
              onClick={() => { setView('definitions'); setEditor({ mode: 'create' }); setSelectedId(null); clearActionError() }}
              disabled={loadState !== 'ready'}
            >
              New automation
            </PrimaryButton>
          }
        />

        {loadState === 'ready' ? (
          <div className="flex items-center justify-between gap-3 border-b border-[color:var(--border-subtle)] px-3 py-1.5">
            <div role="group" aria-label="Automations view" className="flex items-center gap-1">
              <ViewTab label="Definitions" active={view === 'definitions'} onClick={() => setView('definitions')} />
              <ViewTab label="Runs" active={view === 'runs'} onClick={() => setView('runs')} />
            </div>
            <EngineHealthIndicator engine={engine} />
          </div>
        ) : null}

        {actionError ? (
          <div className="px-3 pt-3">
            <InlineNotice tone="error" action={<GhostButton onClick={clearActionError}>Dismiss</GhostButton>}>
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
          <div className="flex min-h-0 flex-1 flex-col">
            {engineUnreachable ? (
              <div className="px-3 pt-3">
                <InlineNotice tone={engine.tone === 'error' ? 'error' : 'warn'}>
                  {engine.label}
                  {engine.detail ? ` — ${engine.detail}` : ''}. Automations won’t run until the scheduler recovers.
                </InlineNotice>
              </div>
            ) : null}
            {view === 'runs' ? (
              <AutomationsRunsFeed
                feedRuns={feedRuns}
                state={feedState}
                error={feedError}
                partialCount={feedPartialCount}
                now={now}
                onReload={() => void loadRunsFeed()}
                onOpenAgent={(wsId, agentId) => {
                  if (agentId && revealAutomationAgent({ workspaceId: wsId, agentId })) return
                  setActiveWorkspace(wsId)
                }}
                onOpenDefinition={handleOpenRunDefinition}
                onFinalize={finalizeFeedRun}
              />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
                <DefinitionList
                  ref={listRef}
                  definitions={ordered}
                  selectedId={editor ? null : selectedId}
                  busyId={busyId}
                  now={now}
                  onSelect={(id) => { setSelectedId(id); setEditor(null); setFocusRunId(null) }}
                  onKeyDown={onListKeyDown}
                  onRunNow={handleRunNow}
                  onToggleStatus={toggleStatus}
                  onEdit={(def) => { setEditor({ mode: 'edit', definition: def }); setSelectedId(def.id) }}
                  onDelete={handleDelete}
                  onCreate={() => { setEditor({ mode: 'create' }); setSelectedId(null) }}
                />
                <div className="min-h-0 flex-1 border-t border-[color:var(--border-default)] md:overflow-y-auto md:border-l md:border-t-0">
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
                    <AutomationDetailPane
                      definition={selected}
                      workspaceRoot={folderPath ?? ''}
                      now={now}
                      focusRunId={selected.id === selectedId ? focusRunId : null}
                      focusNonce={focusNonce}
                      onOpenAgent={(wsId, agentId) => {
                        // Focus the concrete launched agent tab (T10 reveal); fall
                        // back to activating the workspace when the run carries no
                        // agentId or the agent/workspace is gone.
                        if (agentId && revealAutomationAgent({ workspaceId: wsId, agentId })) return
                        setActiveWorkspace(wsId)
                      }}
                    />
                  ) : (
                    <DetailEmptyState hasDefinitions={definitions.length > 0} />
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function ViewTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        'h-6 rounded px-2 text-[11px] font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary)]',
        active
          ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
          : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)]',
      ].join(' ')}
    >
      {label}
    </button>
  )
}

// Quiet, glyph-led engine-health status. The LifecycleGlyph carries the
// accessible state; the text label is a decorative duplicate for sighted users.
// No pill — earned chrome only.
function EngineHealthIndicator({ engine }: { engine: EngineHealth }) {
  const toneClass = engine.tone === 'error'
    ? 'text-[color:var(--tone-error)]'
    : engine.tone === 'warn'
      ? 'text-[color:var(--tone-warn)]'
      : 'text-[color:var(--text-muted)]'
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <LifecycleGlyph state={engine.glyph} label={engine.label} className="translate-y-[0.5px]" />
      <span aria-hidden="true" className={`text-[11px] ${toneClass}`}>{engine.label}</span>
    </span>
  )
}
