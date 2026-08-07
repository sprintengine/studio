import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { revealAgentTerminalTab } from '../../../../utils/agentTabReveal'
import { publishDiagnosticSync } from '../../../../utils/diagnostics'
import { listAutomationProjectFolders } from '../../../../utils/automationsEntry'
import type { AutomationDefinition, AutomationRun, AutomationsInstanceEntry } from '../../../../../../shared/automations/contracts'
import { GhostButton, InlineNotice, OverflowMenu, PointerPopover, PrimaryButton, SidePane, useConfirmDialog } from '../../../ui'
import type { FilterMenuGroup, OverflowMenuItem } from '../../../ui'
import { FOCUS_RING_CLASS } from '../../../ui/tokens'
import { AutomationReportViewer } from '../../../automations/AutomationReportViewer'
import { extractReportPaths } from '../../../automations/reportPaths'
import { automationsDoorTarget } from '../../../automations/runTarget'
import { AutomationEditor } from '../../../panels/AutomationsPanel/AutomationEditor'
import { useAutomationsController } from '../../../panels/AutomationsPanel/useAutomationsController'
import { isEngineUnreachable, type EditorState } from '../../../panels/AutomationsPanel/automationsFormat'
import { GlobalSurfaceShell } from '../GlobalSurfaceShell'
import { SurfaceCanvasState } from '../surfaceSubstrate'
import { useSurfaceBackNav } from '../surfaceBackNav'
import { AutomationsRail } from './AutomationsRail'
import { AutomationSurfaceCanvas } from './AutomationSurfaceCanvas'
import { SCHEDULER_OFF_NOTICE, automationRailState, enumerationProblemsNotice, projectLabel } from './railState'
import {
  consumePendingAutomationSurfaceTarget,
  subscribeAutomationSurfaceTarget,
  type AutomationSurfaceTarget,
} from './automationSurfaceTarget'

// The Automations tenant of the door-routed full-page surface (global-surfaces
// epic 1704 / item 1707, mockup §3). The rail lists every automation across
// every project in this Multicode with its live state; the canvas is the
// selected automation's runs + setup. Automations stop being workspaces in the
// Projects list — this is where they live now. The engine, executor, and report
// paths underneath are unchanged; this relocates the surface and reads the
// instance-wide index (`useAutomationsController` in instance scope), resolving
// each automation's store root per-entry.

// Filter sentinels for the rail's project/state lenses. A space prefix keeps the
// project sentinel from colliding with a real absolute root.
const ALL_PROJECTS = ' all'
const ALL_STATES = 'all'

export default function AutomationsGlobalSurface(): JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const dialog = useConfirmDialog()
  const back = useSurfaceBackNav()

  const {
    entries, problems, providers, engineStatus,
    loadState, loadError, actionError, busyId,
    load, clearActionError, runNow, toggleStatus, remove, applySaved, rootForDefinition,
  } = useAutomationsController({ scope: 'instance' })

  const [selectedId, setSelectedId] = useState<string | null>(null)
  // A create/edit editor plus the store root its writes target (an automation
  // belongs to a project scope, chosen explicitly on create).
  const [editorTarget, setEditorTarget] = useState<{ editor: EditorState; workspaceRoot: string } | null>(null)
  // The run whose report is open, WITH the store root it lives under — captured
  // at open time so switching to another automation (a different project root)
  // never re-points the open report at the wrong root.
  const [viewerRun, setViewerRun] = useState<{ run: AutomationRun; workspaceRoot: string } | null>(null)
  // The New-automation target-project chooser popover, anchored to the button.
  const [chooser, setChooser] = useState<{ x: number; y: number } | null>(null)
  // The bar's action slot while the editor is open. The editor keeps its own save
  // state and portals its buttons here, so the door bar carries the CTA (mockup
  // §.canvas-bar) without the surface holding a second copy of the form's state.
  const [editorActionsEl, setEditorActionsEl] = useState<HTMLElement | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // A deep-link latches the automation to select and what to show of it: a run
  // notification's "Open" names a run to scroll into view, the Extensions shelf
  // asks for the editor (MC-2035). Either applies once that automation has
  // loaded into the index.
  const [pendingTarget, setPendingTarget] = useState<AutomationSurfaceTarget | null>(null)
  const [focusRunId, setFocusRunId] = useState<string | null>(null)
  // Bumped each time a target is applied so re-opening the same run's
  // notification re-triggers the scroll even though the run id is unchanged.
  const [focusNonce, setFocusNonce] = useState(0)

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

  // The rail's lens (the Backlog toolbar idiom): search over name/project, a
  // project filter, and a state filter. Transient per-window view state — it
  // narrows the rail only, never the canvas selection.
  const [railSearch, setRailSearch] = useState('')
  const [railProject, setRailProject] = useState<string>(ALL_PROJECTS)
  const [railState, setRailState] = useState<string>(ALL_STATES)

  const visibleEntries = useMemo(() => {
    const query = railSearch.trim().toLowerCase()
    return orderedEntries.filter((entry) => {
      if (railProject !== ALL_PROJECTS && entry.workspaceRoot !== railProject) return false
      if (railState !== ALL_STATES) {
        const state = automationRailState(entry, now)
        if (railState === 'running' && !state.running) return false
        if (railState === 'attention' && state.tone !== 'warn') return false
        if (railState === 'paused' && entry.definition.status !== 'paused') return false
      }
      if (!query) return true
      return (
        entry.definition.name.toLowerCase().includes(query) ||
        projectLabel(entry.workspaceRoot).toLowerCase().includes(query)
      )
    })
  }, [orderedEntries, railSearch, railProject, railState, now])

  // One filter group per axis. Projects are offered only when there is a second
  // one to choose between — a lone option beside "All projects" filters nothing.
  const railFilterGroups = useMemo(() => {
    const byRoot = new Map<string, number>()
    for (const entry of entries) byRoot.set(entry.workspaceRoot, (byRoot.get(entry.workspaceRoot) ?? 0) + 1)
    const projectItems = [
      { value: ALL_PROJECTS, label: `All projects · ${entries.length}` },
      ...[...byRoot.entries()]
        .map(([root, count]) => ({ value: root, label: `${projectLabel(root)} · ${count}` }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ]
    const groups: FilterMenuGroup[] = []
    if (byRoot.size > 1) {
      groups.push({
        label: 'Project',
        items: projectItems,
        value: railProject,
        defaultValue: ALL_PROJECTS,
        onChange: setRailProject,
      })
    }
    groups.push({
      label: 'State',
      items: [
        { value: ALL_STATES, label: 'All' },
        { value: 'running', label: 'Running' },
        { value: 'attention', label: 'Needs attention' },
        { value: 'paused', label: 'Paused' },
      ],
      value: railState,
      defaultValue: ALL_STATES,
      onChange: setRailState,
    })
    return groups
  }, [entries, railProject, railState])

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
    if (pending) setPendingTarget(pending)
    return subscribeAutomationSurfaceTarget((ref) => {
      consumePendingAutomationSurfaceTarget()
      setPendingTarget(ref)
    })
  }, [])

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

  // Apply a latched deep-link once its automation is in the loaded index. The
  // `editor` view is the shelf's hand-off (MC-2035): the automation it just added
  // arrives selected AND open in the editor, so Get is one navigation rather than
  // "it was added somewhere, go and find it". It routes through the SAME
  // `startEdit` a rail Edit uses — there is one editor and one save path.
  useEffect(() => {
    if (!pendingTarget) return
    const entry = entries.find((candidate) => candidate.definition.id === pendingTarget.ref.automationId)
    if (!entry) return
    if (pendingTarget.view === 'editor') {
      setFocusRunId(null)
      startEdit(entry)
    } else {
      setEditorTarget(null)
      setSelectedId(entry.definition.id)
      setFocusRunId(pendingTarget.ref.runId)
      setFocusNonce((n) => n + 1)
    }
    setPendingTarget(null)
  }, [pendingTarget, entries, startEdit])

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
    if (agentId && revealAgentTerminalTab({ workspaceId, agentId })) return
    setActiveWorkspace(workspaceId)
  }, [setActiveWorkspace])

  // ── Surface bar ────────────────────────────────────────────────────────────
  const bar = useMemo(() => {
    if (editorTarget) {
      // Editing: the bar is info plus ONE call to action (mockup
      // 2026-07-30-automation-starter-editor §.canvas-bar). The info is where the
      // save lands — the project and its automations store — because the editor
      // body already carries the automation's own name and publisher, and the
      // CTA is the editor's own Save, portaled into `editorActionsEl` so there
      // is exactly one save affordance and one save path.
      return {
        title: (
          <span className="truncate font-mono text-meta font-normal text-[color:var(--text-subtle)]">
            {`${projectLabel(editorTarget.workspaceRoot)} · .multi-code/automations`}
          </span>
        ),
        actions: <span ref={setEditorActionsEl} className="flex items-center gap-1.5" />,
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
      // Name and controls only: the canvas states what this automation does, when
      // it next runs, and whether it is paused — the bar restating it made the
      // door two headers deep before any content.
      return {
        title: def.name,
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
          <InlineNotice tone="warn">{SCHEDULER_OFF_NOTICE}</InlineNotice>
        </div>,
      )
    }
    if (problems.length > 0) {
      banners.push(
        <div key="problems" className="px-5 py-2">
          <InlineNotice tone="warn">{enumerationProblemsNotice(problems.length)}</InlineNotice>
        </div>,
      )
    }
    return banners.length > 0 ? <>{banners}</> : undefined
  }, [engineStatus, problems])

  // ── Rail ────────────────────────────────────────────────────────────────────
  const rail = (
    <AutomationsRail
      entries={visibleEntries}
      selectedId={editorTarget ? null : selectedId}
      now={now}
      onSelect={(id) => { setSelectedId(id); setEditorTarget(null); setFocusRunId(null) }}
      onCreate={openChooser}
      search={{
        value: railSearch,
        onChange: setRailSearch,
        placeholder: 'Search automations…',
        ariaLabel: 'Search automations across every project',
      }}
      filter={{ ariaLabel: 'Filter automations', groups: railFilterGroups }}
      // The lens is narrower than the automations behind it. Say so, rather
      // than letting an empty rail read as "you have no automations".
      emptyNotice={entries.length > 0 ? 'No automations match.' : undefined}
    />
  )

  return (
    <GlobalSurfaceShell
      ariaLabel="Automations"
      bar={bar}
      attention={attention}
      onBack={back.onBack}
      canGoBack={back.canGoBack}
      // The rail is DECLARED, not derived from what the door happens to hold
      // (T19): it is present in every load state, so opening the door replaces
      // the projects rail immediately rather than once there is an automation in
      // it. Gating it on `entries.length > 0` left a first-run or still-loading
      // Automations door with the projects sidebar beside its own canvas — two
      // navigation columns, which item 1993 forbids outright. Loading, empty and
      // error are the canvas's to say, beside a rail that still carries New.
      rail={rail}
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
            editorActionsSlot={{ el: editorActionsEl }}
            providers={providers}
            onEditorCancel={() => setEditorTarget(null)}
            onEditorSaved={handleEditorSaved}
            selectedEntry={selectedEntry}
            now={now}
            focusRunId={focusRunId}
            focusNonce={focusNonce}
            onOpenAgent={onOpenAgent}
            onViewReport={(run) => { if (selectedEntry) setViewerRun({ run, workspaceRoot: selectedEntry.workspaceRoot }) }}
            onCreate={openChooser}
          />
        </div>
        {viewerRun ? (
          <SidePane side="right" width="md" ariaLabel="Automation run report">
            <AutomationReportViewer
              workspaceRoot={viewerRun.workspaceRoot}
              reportPaths={extractReportPaths(viewerRun.run)}
              pullRequestUrl={viewerRun.run.pullRequestUrl}
              onClose={() => setViewerRun(null)}
            />
          </SidePane>
        ) : null}
      </div>

      {chooser ? (
        <PointerPopover x={chooser.x} y={chooser.y} ariaLabel="Choose a project for the new automation" onClose={() => setChooser(null)}>
          <div className="min-w-[240px] max-w-[340px] py-1">
            <div className="px-3 pb-1 pt-1.5 text-micro text-[color:var(--text-subtle)]">New automation in…</div>
            {projectFolders.length === 0 ? (
              <p className="px-3 py-2 text-meta leading-5 text-[color:var(--text-muted)]">
                Open a project first — an automation runs against a project.
              </p>
            ) : (
              projectFolders.map((folder) => (
                <button
                  key={folder.folderPath}
                  type="button"
                  onClick={() => startCreate(folder.folderPath)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-body text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
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

// The canvas body: loading / error / empty / editor / selected — the four shared
// states (SurfaceCanvasState) plus the editor. Split out so the surface's return
// stays readable.
function SurfaceBody({
  loadState, loadError, onRetry, hasEntries, editorTarget, editorActionsSlot, providers, onEditorCancel, onEditorSaved,
  selectedEntry, now, focusRunId, focusNonce, onOpenAgent, onViewReport, onCreate,
}: {
  loadState: string
  loadError: string | null
  onRetry: () => void
  hasEntries: boolean
  editorTarget: { editor: EditorState; workspaceRoot: string } | null
  editorActionsSlot: Parameters<typeof AutomationEditor>[0]['actionsSlot']
  providers: Parameters<typeof AutomationEditor>[0]['providers']
  onEditorCancel: () => void
  onEditorSaved: (saved: AutomationDefinition) => void
  selectedEntry: AutomationsInstanceEntry | null
  now: number
  focusRunId: string | null
  focusNonce: number
  onOpenAgent: (workspaceId: string, agentId?: string) => void
  onViewReport: (run: AutomationRun) => void
  onCreate: (anchor: { x: number; y: number }) => void
}): JSX.Element {
  if (editorTarget) {
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <AutomationEditor
          key={editorTarget.editor.mode === 'edit' ? editorTarget.editor.definition.id : 'create'}
          editor={editorTarget.editor}
          providers={providers}
          workspaceRoot={editorTarget.workspaceRoot}
          actionsSlot={editorActionsSlot}
          onCancel={onEditorCancel}
          onSaved={onEditorSaved}
        />
      </div>
    )
  }
  if (loadState === 'loading' || loadState === 'idle') {
    return <SurfaceCanvasState kind="loading" label="Loading automations…" />
  }
  if (loadState === 'error') {
    return (
      <SurfaceCanvasState
        kind="error"
        title="Couldn’t load your automations."
        hint="This is usually temporary."
        detail={loadError ?? undefined}
        onRetry={onRetry}
      />
    )
  }
  if (!hasEntries) {
    return (
      <SurfaceCanvasState
        kind="empty"
        glyph={<AutomationsGlyph />}
        title="No automations yet"
        body="Automations run agents and tasks on a schedule — a nightly review, backlog triage — while the app is open."
        action={
          <PrimaryButton
            onClick={(event) => {
              const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
              onCreate({ x: rect.left, y: rect.bottom })
            }}
          >
            New automation
          </PrimaryButton>
        }
      />
    )
  }
  if (selectedEntry) {
    return (
      <AutomationSurfaceCanvas
        entry={selectedEntry}
        now={now}
        focusRunId={focusRunId}
        focusNonce={focusNonce}
        onOpenAgent={onOpenAgent}
        onViewReport={onViewReport}
      />
    )
  }
  // Entries exist but none selected — a one-render gap before the auto-select
  // effect fires. A calm prompt, never a blank canvas.
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-meta text-[color:var(--text-muted)]">
      Select an automation to see its runs and setup.
    </div>
  )
}

function AutomationsGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-icon-md" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 5v3l2 1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
