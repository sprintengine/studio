import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { revealAutomationAgent } from '../../../../hooks/useAutomationRequests'
import { publishDiagnosticSync } from '../../../../utils/diagnostics'
import { listAutomationProjectFolders } from '../../../../utils/automationsEntry'
import type { AutomationDefinition, AutomationRun, AutomationsInstanceEntry } from '../../../../../../shared/automations/contracts'
import { GhostButton, InlineNotice, OverflowMenu, PointerPopover, PrimaryButton, SidePane, Spinner, useConfirmDialog } from '../../../ui'
import type { OverflowMenuItem } from '../../../ui'
import { FOCUS_RING_CLASS } from '../../../ui/tokens'
import { StatusDot } from '../../../ui/StatusDot'
import { AutomationReportViewer } from '../../../automations/AutomationReportViewer'
import { extractReportPaths } from '../../../automations/reportPaths'
import { automationsDoorTarget } from '../../../automations/runTarget'
import { AutomationEditor } from '../../../panels/AutomationsPanel/AutomationEditor'
import { useAutomationsController } from '../../../panels/AutomationsPanel/useAutomationsController'
import {
  cadenceSummary,
  isEditableTarget,
  isEngineUnreachable,
  type EditorState,
} from '../../../panels/AutomationsPanel/automationsFormat'
import { GlobalSurfaceShell } from '../GlobalSurfaceShell'
import { AutomationsRail } from './AutomationsRail'
import { AutomationSurfaceCanvas } from './AutomationSurfaceCanvas'
import { automationRailState, projectLabel } from './railState'
import {
  consumePendingAutomationSurfaceTarget,
  subscribeAutomationSurfaceTarget,
} from './automationSurfaceTarget'

// The Automations tenant of the door-routed full-page surface (global-surfaces
// epic 1704 / item 1707, mockup §3). The rail lists every automation across
// every project in this Multicode with its live state; the canvas is the
// selected automation's runs + setup. Automations stop being workspaces in the
// Projects list — this is where they live now. The engine, executor, and report
// paths underneath are unchanged; this relocates the surface and reads the
// instance-wide index (`useAutomationsController` in instance scope), resolving
// each automation's store root per-entry.
export default function AutomationsGlobalSurface(): JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const dialog = useConfirmDialog()

  const {
    entries, problems, definitions, providers, engineStatus,
    loadState, loadError, actionError, busyId,
    load, clearActionError, runNow, toggleStatus, remove, applySaved, rootForDefinition,
  } = useAutomationsController({ scope: 'instance' })

  const [selectedId, setSelectedId] = useState<string | null>(null)
  // A create/edit editor plus the store root its writes target (an automation
  // belongs to a project scope, chosen explicitly on create).
  const [editorTarget, setEditorTarget] = useState<{ editor: EditorState; workspaceRoot: string } | null>(null)
  const [viewerRun, setViewerRun] = useState<AutomationRun | null>(null)
  // The New-automation target-project chooser popover, anchored to the button.
  const [chooser, setChooser] = useState<{ x: number; y: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // A deep-link (run notification "Open") latches the automation to select; it
  // applies once that automation has loaded into the index.
  const [pendingAutomationId, setPendingAutomationId] = useState<string | null>(null)

  // A slow clock so relative run times stay honest without churning the rail.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  // Rail order is salience, then name: a running automation leads, then one with
  // an unresolved failure, so what needs attention sits at the top.
  const orderedEntries = useMemo(() => {
    const rank = (entry: AutomationsInstanceEntry): number => {
      const state = automationRailState(entry, now)
      if (state.running) return 0
      if (state.tone === 'warn') return 1
      return 2
    }
    return [...entries].sort((a, b) => {
      const byRank = rank(a) - rank(b)
      return byRank !== 0 ? byRank : a.definition.name.localeCompare(b.definition.name)
    })
  }, [entries, now])

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.definition.id === selectedId) ?? null,
    [entries, selectedId],
  )

  // Keep the selection valid, and default to the first automation once the index
  // loads so the surface opens on content (mockup §3) rather than a blank canvas.
  useEffect(() => {
    if (editorTarget) return
    if (selectedId && entries.some((entry) => entry.definition.id === selectedId)) return
    setSelectedId(orderedEntries[0]?.definition.id ?? null)
  }, [entries, orderedEntries, selectedId, editorTarget])

  const projectFolders = useMemo(() => listAutomationProjectFolders(workspaces), [workspaces])

  // Deep-link: drain the latch on mount and subscribe live, then apply once the
  // named automation is present in the loaded index.
  useEffect(() => {
    const pending = consumePendingAutomationSurfaceTarget()
    if (pending) setPendingAutomationId(pending.automationId)
    return subscribeAutomationSurfaceTarget((ref) => {
      consumePendingAutomationSurfaceTarget()
      setPendingAutomationId(ref.automationId)
    })
  }, [])

  useEffect(() => {
    if (!pendingAutomationId) return
    if (!entries.some((entry) => entry.definition.id === pendingAutomationId)) return
    setEditorTarget(null)
    setSelectedId(pendingAutomationId)
    setPendingAutomationId(null)
  }, [pendingAutomationId, entries])

  const openChooser = useCallback((anchor: { x: number; y: number }) => {
    clearActionError()
    setChooser(anchor)
  }, [clearActionError])

  const startCreate = useCallback((workspaceRoot: string) => {
    setChooser(null)
    setSelectedId(null)
    setEditorTarget({ editor: { mode: 'create' }, workspaceRoot })
  }, [])

  const startEdit = useCallback((entry: AutomationsInstanceEntry) => {
    const workspaceRoot = rootForDefinition(entry.definition.id) ?? entry.workspaceRoot
    setSelectedId(entry.definition.id)
    setEditorTarget({ editor: { mode: 'edit', definition: entry.definition }, workspaceRoot })
  }, [rootForDefinition])

  const handleEditorSaved = useCallback((saved: AutomationDefinition) => {
    applySaved(saved, editorTarget?.workspaceRoot)
    setSelectedId(saved.id)
    setEditorTarget(null)
  }, [applySaved, editorTarget])

  // Run now on the surface: the only run whose terminal status the renderer sees
  // (the IPC return). A failed/blocked outcome raises a notification whose Open
  // deep-links back to this door and the originating run (the door target the
  // scheduled-run observer also uses now).
  const handleRunNow = useCallback(async (entry: AutomationsInstanceEntry) => {
    const run = await runNow(entry.definition)
    if (!run || (run.status !== 'failed' && run.status !== 'blocked')) return
    publishDiagnosticSync({
      level: run.status === 'failed' ? 'error' : 'warning',
      source: 'automations',
      title: `Automation ${run.status}: ${entry.definition.name}`,
      message: run.blockedReason || run.summary || `The run ended ${run.status}.`,
      workspaceId: entry.workspaceId,
      navigationTarget: automationsDoorTarget(entry.definition.id, run.id, entry.workspaceRoot),
    })
  }, [runNow])

  // Delete drops the definition and its run-history directory, so gate it behind
  // a danger confirm — cancel leaves both untouched.
  const handleDelete = useCallback(async (entry: AutomationsInstanceEntry) => {
    const confirmed = await dialog.confirm({
      title: `Delete ${entry.definition.name}?`,
      body: 'This removes the automation and its run history. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (confirmed) await remove(entry.definition)
  }, [dialog, remove])

  const onOpenAgent = useCallback((workspaceId: string, agentId?: string) => {
    // Focus the concrete launched agent tab; fall back to activating the
    // workspace when the run carries no agentId or the agent is gone. Activating
    // a workspace clears this surface — leaving the door to read the run is the
    // intent.
    if (agentId && revealAutomationAgent({ workspaceId, agentId })) return
    setActiveWorkspace(workspaceId)
  }, [setActiveWorkspace])

  const onRailKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (isEditableTarget(event.target) || orderedEntries.length === 0) return
    const index = selectedId ? orderedEntries.findIndex((entry) => entry.definition.id === selectedId) : -1
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault()
      const next = orderedEntries[Math.min(index + 1, orderedEntries.length - 1)] ?? orderedEntries[0]
      setSelectedId(next.definition.id)
      setEditorTarget(null)
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault()
      const prev = orderedEntries[Math.max(index - 1, 0)] ?? orderedEntries[0]
      setSelectedId(prev.definition.id)
      setEditorTarget(null)
    }
  }, [orderedEntries, selectedId])

  // ── Surface bar ────────────────────────────────────────────────────────────
  const bar = useMemo(() => {
    if (editorTarget) {
      return {
        title: editorTarget.editor.mode === 'create' ? 'New automation' : 'Edit automation',
        contextSub: projectLabel(editorTarget.workspaceRoot),
      }
    }
    if (selectedEntry) {
      const def = selectedEntry.definition
      const busy = busyId === def.id
      const overflowItems: OverflowMenuItem[] = [
        {
          id: 'toggle',
          label: def.status === 'enabled' ? 'Pause' : 'Turn on',
          onSelect: () => void toggleStatus(def),
          disabled: busy,
        },
        { kind: 'separator', id: 'sep' },
        { id: 'delete', label: 'Delete', onSelect: () => void handleDelete(selectedEntry), disabled: busy, destructive: true },
      ]
      return {
        title: def.name,
        statusChip: <SurfaceStatus definition={def} />,
        contextSub: `${cadenceSummary(def.trigger)} · ${projectLabel(selectedEntry.workspaceRoot)}`,
        actions: (
          <>
            <GhostButton onClick={() => void handleRunNow(selectedEntry)} disabled={busy}>
              Run now
            </GhostButton>
            <GhostButton onClick={() => startEdit(selectedEntry)}>Edit</GhostButton>
            <OverflowMenu items={overflowItems} ariaLabel={`More actions for ${def.name}`} />
          </>
        ),
      }
    }
    return { title: 'Automations' }
  }, [editorTarget, selectedEntry, busyId, handleRunNow, startEdit, toggleStatus, handleDelete])

  // ── Attention strip: non-blocking degraded signals ──────────────────────────
  const attention = useMemo(() => {
    const banners: React.ReactNode[] = []
    if (isEngineUnreachable(engineStatus)) {
      banners.push(
        <div key="engine" className="px-5 py-2">
          <InlineNotice tone="warn">
            The automation scheduler is not running, so scheduled runs are paused. Automations you run now still execute.
          </InlineNotice>
        </div>,
      )
    }
    if (problems.length > 0) {
      banners.push(
        <div key="problems" className="px-5 py-2">
          <InlineNotice tone="warn">
            {problems.length === 1
              ? 'One project’s automations could not be read and are not listed. The rest are shown.'
              : `${problems.length} projects’ automations could not be read and are not listed. The rest are shown.`}
          </InlineNotice>
        </div>,
      )
    }
    return banners.length > 0 ? <>{banners}</> : undefined
  }, [engineStatus, problems])

  // ── Rail ────────────────────────────────────────────────────────────────────
  const rail = (
    <AutomationsRail
      entries={orderedEntries}
      selectedId={editorTarget ? null : selectedId}
      now={now}
      onSelect={(id) => { setSelectedId(id); setEditorTarget(null) }}
      onKeyDown={onRailKeyDown}
      onCreate={openChooser}
    />
  )

  return (
    <GlobalSurfaceShell
      ariaLabel="Automations"
      bar={bar}
      attention={attention}
      rail={loadState === 'ready' && (entries.length > 0 || editorTarget) ? rail : undefined}
    >
      <div className="flex h-full min-h-0">
        <div className="min-h-0 min-w-0 flex-1">
          {actionError ? (
            <div className="px-6 pt-4">
              <InlineNotice tone="error" action={<GhostButton onClick={clearActionError}>Dismiss</GhostButton>}>
                {actionError}
              </InlineNotice>
            </div>
          ) : null}
          <SurfaceBody
            loadState={loadState}
            loadError={loadError}
            onRetry={() => void load()}
            hasEntries={entries.length > 0}
            editorTarget={editorTarget}
            providers={providers}
            onEditorCancel={() => setEditorTarget(null)}
            onEditorSaved={handleEditorSaved}
            selectedEntry={selectedEntry}
            now={now}
            onOpenAgent={onOpenAgent}
            onViewReport={setViewerRun}
            onCreate={openChooser}
            definitionsCount={definitions.length}
          />
        </div>
        {viewerRun ? (
          <SidePane side="right" width="md" ariaLabel="Automation run report">
            <AutomationReportViewer
              workspaceRoot={selectedEntry?.workspaceRoot ?? ''}
              reportPaths={extractReportPaths(viewerRun)}
              pullRequestUrl={viewerRun.pullRequestUrl}
              onClose={() => setViewerRun(null)}
            />
          </SidePane>
        ) : null}
      </div>

      {chooser ? (
        <PointerPopover x={chooser.x} y={chooser.y} ariaLabel="Choose a project for the new automation" onClose={() => setChooser(null)}>
          <div className="min-w-[240px] max-w-[340px] py-1">
            <div className="px-3 pb-1 pt-1.5 text-[11px] text-[color:var(--text-subtle)]">New automation in…</div>
            {projectFolders.length === 0 ? (
              <p className="px-3 py-2 text-[12px] leading-5 text-[color:var(--text-muted)]">
                Open a project first — an automation runs against a project.
              </p>
            ) : (
              projectFolders.map((folder) => (
                <button
                  key={folder.folderPath}
                  type="button"
                  onClick={() => startCreate(folder.folderPath)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
                >
                  <span className="min-w-0 flex-1 truncate">{folder.displayName}</span>
                </button>
              ))
            )}
          </div>
        </PointerPopover>
      ) : null}
    </GlobalSurfaceShell>
  )
}

// The one status idiom in the bar: a toned dot with its label, never a pill.
function SurfaceStatus({ definition }: { definition: AutomationDefinition }): JSX.Element {
  const [tone, label] =
    definition.status === 'enabled'
      ? (['good', 'On'] as const)
      : definition.status === 'paused'
        ? (['neutral', 'Paused'] as const)
        : (['warn', 'Blocked'] as const)
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--text-default)]">
      <StatusDot tone={tone} label={`Automation is ${label.toLowerCase()}`} />
      {label}
    </span>
  )
}

// The canvas body: loading / error / empty / editor / selected. Split out so the
// surface's return stays readable.
function SurfaceBody({
  loadState, loadError, onRetry, hasEntries, editorTarget, providers, onEditorCancel, onEditorSaved,
  selectedEntry, now, onOpenAgent, onViewReport, onCreate, definitionsCount,
}: {
  loadState: string
  loadError: string | null
  onRetry: () => void
  hasEntries: boolean
  editorTarget: { editor: EditorState; workspaceRoot: string } | null
  providers: Parameters<typeof AutomationEditor>[0]['providers']
  onEditorCancel: () => void
  onEditorSaved: (saved: AutomationDefinition) => void
  selectedEntry: AutomationsInstanceEntry | null
  now: number
  onOpenAgent: (workspaceId: string, agentId?: string) => void
  onViewReport: (run: AutomationRun) => void
  onCreate: (anchor: { x: number; y: number }) => void
  definitionsCount: number
}): JSX.Element {
  if (editorTarget) {
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <AutomationEditor
          key={editorTarget.editor.mode === 'edit' ? editorTarget.editor.definition.id : 'create'}
          editor={editorTarget.editor}
          providers={providers}
          workspaceRoot={editorTarget.workspaceRoot}
          onCancel={onEditorCancel}
          onSaved={onEditorSaved}
        />
      </div>
    )
  }
  if (loadState === 'loading' || loadState === 'idle') {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-[color:var(--text-muted)]">
        <Spinner size={14} label="Loading automations" /> Loading automations…
      </div>
    )
  }
  if (loadState === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="max-w-sm text-[13px] text-[color:var(--text-default)]">Automations could not be loaded.</p>
        {loadError ? <p className="max-w-md text-[11px] leading-5 text-[color:var(--tone-error)]">{loadError}</p> : null}
        <GhostButton onClick={onRetry}>Retry</GhostButton>
      </div>
    )
  }
  if (!hasEntries) {
    return <ZeroState onCreate={onCreate} />
  }
  if (selectedEntry) {
    return <AutomationSurfaceCanvas entry={selectedEntry} now={now} onOpenAgent={onOpenAgent} onViewReport={onViewReport} />
  }
  // Entries exist but none selected (transient) — keep the space calm.
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-[color:var(--text-muted)]">
      {definitionsCount > 0 ? 'Select an automation to see its runs and setup.' : null}
    </div>
  )
}

// Zero automations across every project: the CTA lives where the blank space is.
function ZeroState({ onCreate }: { onCreate: (anchor: { x: number; y: number }) => void }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <h3 className="text-[15px] font-semibold text-[color:var(--text-strong)]">No automations yet</h3>
      <p className="max-w-[46ch] text-[12px] leading-5 text-[color:var(--text-muted)]">
        Automations run agents and tasks on a schedule — a nightly review, backlog triage — while Multicode is open.
      </p>
      <PrimaryButton
        className="mt-2"
        onClick={(event) => {
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
          onCreate({ x: rect.left, y: rect.bottom })
        }}
      >
        New automation
      </PrimaryButton>
    </div>
  )
}
