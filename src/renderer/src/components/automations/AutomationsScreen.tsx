import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { revealAutomationAgent } from '../../hooks/useAutomationRequests'
import { basename } from '../../utils/paths'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { RUN_TARGET_KIND, encodeRunRef } from './runTarget'
import { AutomationReportViewer } from './AutomationReportViewer'
import { extractReportPaths } from './reportPaths'
import type { AutomationDefinition, AutomationRun } from '../../../../shared/automations/contracts'
import { GhostButton, InlineNotice, LifecycleGlyph, PrimaryButton, Select, SidePane, Spinner, useConfirmDialog } from '../ui'
import { AutomationsWorkspaceTypeIcon } from '../AppIcons'
import { AutomationDetailPane } from '../panels/AutomationsPanel/AutomationDetailPane'
import { AutomationEditor } from '../panels/AutomationsPanel/AutomationEditor'
import { DefinitionList, DetailEmptyState } from '../panels/AutomationsPanel/AutomationsList'
import { AutomationsRunsFeed } from '../panels/AutomationsPanel/AutomationsRunsFeed'
import { engineHealth, isEditableTarget, isEngineUnreachable, sortDefinitions, type EditorState, type EngineHealth } from '../panels/AutomationsPanel/automationsFormat'
import { useAutomationsController } from '../panels/AutomationsPanel/useAutomationsController'

type ProjectOption = {
  path: string
  label: string
}

type AutomationsView = 'definitions' | 'runs'

// Distinct folder-backed projects for the switcher: the open workspaces' folders
// (a primitive `\n`-joined key, a stable store subscription rather than a fresh
// array selector) plus any `extra` folders that must be selectable even with no
// open workspace — the deep-linked project and the current selection. The global
// Automations screen is project-scoped (automations live in each project's
// `.multi-code/automations/`), independent of which workspaces are open.
function buildProjectOptions(folderKey: string, extras: Array<string | null>): ProjectOption[] {
  const seen = new Map<string, ProjectOption>()
  const add = (path: string | null | undefined) => {
    if (!path || seen.has(path)) return
    seen.set(path, { path, label: basename(path) || path })
  }
  for (const path of folderKey.split('\n')) add(path)
  for (const extra of extras) add(extra)
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label))
}

// The Automations control center, hosted as a global app screen (not a
// workspace). Reuses the AutomationsPanel/* list, detail, and editor
// sub-components but adds a project switcher and is unbound from any single
// workspace — runs launch into a fresh standard workspace (the controller omits
// workspaceId).
export default function AutomationsScreen({
  initialProjectPath,
  initialRunTarget,
  titleId,
  onClose,
}: {
  initialProjectPath: string | null
  /** A run-notification deep-link: select this automation and focus the run. */
  initialRunTarget?: { automationId: string; runId: string } | null
  titleId: string
  onClose: () => void
}): JSX.Element {
  const folderKey = useWorkspaceStore((s) =>
    s.workspaces.map((w) => (!w.folderPath || w.folderMissing ? '' : w.folderPath)).join('\n'),
  )
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const dialog = useConfirmDialog()

  // Default the switcher to the requested project (the active workspace's
  // folder at open time, or a deep-link's project), falling back to the first
  // open-workspace project.
  const [selectedProject, setSelectedProject] = useState<string | null>(
    () => initialProjectPath ?? buildProjectOptions(folderKey, [])[0]?.path ?? null,
  )

  // The deep-linked and currently-selected projects stay selectable even when no
  // workspace is open for them (a background run can fail in a project nothing is
  // open for), so the switcher never strands the screen off the run's project.
  const projects = useMemo(
    () => buildProjectOptions(folderKey, [initialProjectPath, selectedProject]),
    [folderKey, initialProjectPath, selectedProject],
  )

  // Keep the selection valid as projects come and go; never strand the screen on
  // a folder that no longer has any workspace.
  useEffect(() => {
    if (selectedProject && projects.some((p) => p.path === selectedProject)) return
    setSelectedProject(projects[0]?.path ?? null)
  }, [projects, selectedProject])

  const {
    definitions, providers, engineStatus, loadState, loadError, actionError, busyId,
    load, clearActionError, runNow, toggleStatus, remove, applySaved,
    feedRuns, feedState, feedError, feedPartialCount, loadRunsFeed, finalizeFeedRun,
  } = useAutomationsController({ folderPath: selectedProject })

  const [view, setView] = useState<AutomationsView>('definitions')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // A run-notification deep-link to apply once its definition has loaded.
  const [pendingRunTarget, setPendingRunTarget] = useState(initialRunTarget ?? null)
  const [focusRunId, setFocusRunId] = useState<string | null>(null)
  // The run whose report is open in the in-app viewer overlay (null = closed).
  const [viewerRun, setViewerRun] = useState<AutomationRun | null>(null)
  // Bumped each time a target is applied so re-opening the same run re-fires the
  // detail pane's scroll/highlight even though the run id is unchanged.
  const [focusNonce, setFocusNonce] = useState(0)
  const appliedRunTargetRef = useRef(initialRunTarget ?? null)
  const listRef = useRef<HTMLUListElement>(null)

  // A slow clock so "in 3h" / "overdue" stay honest without churning the list.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  // A deep-link that arrives while the screen is already open (a new overlay
  // open) re-targets: switch to the run's project and queue the target.
  useEffect(() => {
    const target = initialRunTarget ?? null
    if (target === appliedRunTargetRef.current) return
    appliedRunTargetRef.current = target
    setPendingRunTarget(target)
    if (target && initialProjectPath) setSelectedProject(initialProjectPath)
  }, [initialRunTarget, initialProjectPath])

  // Reset the selection/editor/view when the project changes — definitions and
  // the runs feed both belong to a single project store.
  useEffect(() => {
    setView('definitions')
    setSelectedId(null)
    setEditor(null)
    setFocusRunId(null)
    setViewerRun(null)
  }, [selectedProject])

  // Aggregate the runs feed on demand — only while the runs view is open, and
  // refreshed when the definition set changes underneath it (the controller
  // re-scopes to selectedProject via folderPath).
  useEffect(() => {
    if (view === 'runs' && loadState === 'ready') void loadRunsFeed()
  }, [view, loadState, loadRunsFeed])

  // Apply a queued run-target once its definition is present (the list loads
  // async, so the target can arrive before the row exists).
  useEffect(() => {
    if (!pendingRunTarget || !definitions.some((d) => d.id === pendingRunTarget.automationId)) return
    setEditor(null)
    setSelectedId(pendingRunTarget.automationId)
    setFocusRunId(pendingRunTarget.runId)
    setFocusNonce((n) => n + 1)
    setPendingRunTarget(null)
  }, [pendingRunTarget, definitions])

  const ordered = useMemo(() => sortDefinitions(definitions, now), [definitions, now])

  const engine = engineHealth(engineStatus)
  const engineUnreachable = isEngineUnreachable(engineStatus)

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

  const handleDelete = useCallback(async (def: AutomationDefinition) => {
    const confirmed = await dialog.confirm({
      title: `Delete ${def.name}?`,
      body: 'This removes the automation and its run history. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (confirmed) await remove(def)
  }, [dialog, remove])

  // Run now is the only run whose terminal status the screen observes (the IPC
  // return). On a failed/blocked outcome raise a notification whose Open action
  // deep-links back to this screen and the originating run; scheduled/background
  // runs notify via the AutomationsRunSupervisor instead.
  const handleRunNow = useCallback(async (def: AutomationDefinition) => {
    const run = await runNow(def)
    if (!run || (run.status !== 'failed' && run.status !== 'blocked')) return
    publishDiagnosticSync({
      level: run.status === 'failed' ? 'error' : 'warning',
      source: 'automations',
      title: `Automation ${run.status}: ${def.name}`,
      message: run.blockedReason || run.summary || `The run ended ${run.status}.`,
      workspaceId: run.workspaceId,
      navigationTarget: { kind: RUN_TARGET_KIND, ref: encodeRunRef(def.id, run.id, selectedProject) },
    })
  }, [runNow, selectedProject])

  // Drill from a runs-feed row into its owning definition: switch to the
  // Definitions view, select the definition, and focus the run in its detail
  // timeline — reusing the focusRunId/focusNonce plumbing the run notifications
  // use. The definition is already loaded (the feed is built from the loaded
  // set), so the target is applied directly rather than latched.
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
      setFocusRunId(null)
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault()
      const prev = ordered[Math.max(index - 1, 0)] ?? ordered[0]
      setSelectedId(prev.id)
      setEditor(null)
      setFocusRunId(null)
    } else if (event.key === 'Escape') {
      setSelectedId(null)
    }
  }, [ordered, selectedId])

  const noProjects = projects.length === 0

  return (
    <section
      aria-labelledby={titleId}
      className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)]"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-[color:var(--border-default)] px-4 py-3">
        <AutomationsWorkspaceTypeIcon className="h-5 w-5 shrink-0 text-[color:var(--accent-primary)]" />
        <div className="min-w-0 flex-1">
          <h1 id={titleId} className="truncate text-[14px] font-semibold text-[color:var(--text-strong)]">
            Automations
          </h1>
          <p className="truncate text-[11px] text-[color:var(--text-muted)]">
            Schedule agents on a project. Runs while Multicode is open.
          </p>
        </div>

        {!noProjects ? (
          <Select
            ariaLabel="Project"
            items={projects.map((project) => ({ value: project.path, label: project.label }))}
            value={selectedProject}
            onChange={(value) => setSelectedProject(value || null)}
            className="max-w-[220px]"
          />
        ) : null}

        <PrimaryButton
          onClick={() => { setView('definitions'); setEditor({ mode: 'create' }); setSelectedId(null); clearActionError() }}
          disabled={loadState !== 'ready'}
        >
          New automation
        </PrimaryButton>
      </header>

      {loadState === 'ready' ? (
        <div className="flex items-center justify-between gap-3 border-b border-[color:var(--border-subtle)] px-4 py-1.5">
          <div role="group" aria-label="Automations view" className="flex items-center gap-1">
            <ViewTab label="Definitions" active={view === 'definitions'} onClick={() => setView('definitions')} />
            <ViewTab label="Runs" active={view === 'runs'} onClick={() => setView('runs')} />
          </div>
          <EngineHealthIndicator engine={engine} />
        </div>
      ) : null}

      {actionError ? (
        <div className="px-4 pt-3">
          <InlineNotice tone="error" action={<GhostButton onClick={clearActionError}>Dismiss</GhostButton>}>
            {actionError}
          </InlineNotice>
        </div>
      ) : null}

      {noProjects ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="max-w-sm text-[12px] leading-5 text-[color:var(--text-muted)]">
            Open a project workspace first. Automations are scheduled per project, so there is nothing to manage yet.
          </p>
        </div>
      ) : loadState === 'loading' || loadState === 'idle' ? (
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
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
          {engineUnreachable ? (
            <div className="px-4 pt-3">
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
                // Open the launched agent and leave the area so the user arrives
                // on it (mirrors the detail-pane Open-agent behaviour).
                if (agentId) revealAutomationAgent({ workspaceId: wsId, agentId })
                setActiveWorkspace(wsId)
                onClose()
              }}
              onViewReport={setViewerRun}
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
                workspaceRoot={selectedProject ?? ''}
                onCancel={() => setEditor(null)}
                onSaved={handleEditorSaved}
              />
            ) : selected ? (
              <AutomationDetailPane
                definition={selected}
                workspaceRoot={selectedProject ?? ''}
                now={now}
                focusRunId={selected.id === selectedId ? focusRunId : null}
                focusNonce={focusNonce}
                onOpenAgent={(wsId, agentId) => {
                  // Launched-agent runs land in a real workspace; reveal it and
                  // dismiss the screen so the user arrives on the agent.
                  if (agentId) revealAutomationAgent({ workspaceId: wsId, agentId })
                  setActiveWorkspace(wsId)
                  onClose()
                }}
                onViewReport={setViewerRun}
              />
            ) : (
              <DetailEmptyState hasDefinitions={definitions.length > 0} />
            )}
          </div>
            </div>
          )}
          </div>
          {viewerRun ? (
            <SidePane side="right" width="md" ariaLabel="Automation run report">
              <AutomationReportViewer
                workspaceRoot={selectedProject ?? ''}
                reportPaths={extractReportPaths(viewerRun)}
                pullRequestUrl={viewerRun.pullRequestUrl}
                onClose={() => setViewerRun(null)}
              />
            </SidePane>
          ) : null}
        </div>
      )}
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
