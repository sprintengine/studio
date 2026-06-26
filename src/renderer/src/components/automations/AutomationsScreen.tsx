import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { revealAutomationAgent } from '../../hooks/useAutomationRequests'
import { basename } from '../../utils/paths'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { RUN_TARGET_KIND, encodeRunRef } from './runTarget'
import type { AutomationDefinition } from '../../../../shared/automations/contracts'
import { GhostButton, InlineNotice, PrimaryButton, Spinner, useConfirmDialog } from '../ui'
import { AutomationsWorkspaceTypeIcon } from '../AppIcons'
import { AutomationDetailPane } from '../panels/AutomationsPanel/AutomationDetailPane'
import { AutomationEditor } from '../panels/AutomationsPanel/AutomationEditor'
import { DefinitionList, DetailEmptyState } from '../panels/AutomationsPanel/AutomationsList'
import { isEditableTarget, sortDefinitions, type EditorState } from '../panels/AutomationsPanel/automationsFormat'
import { useAutomationsController } from '../panels/AutomationsPanel/useAutomationsController'

type ProjectOption = {
  path: string
  label: string
}

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
// workspace). Mirrors AutomationsPanel's list/detail/editor body but adds a
// project switcher and is unbound from any single workspace — runs launch into
// a fresh standard workspace (the controller omits workspaceId).
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
    definitions, providers, loadState, loadError, actionError, busyId,
    load, clearActionError, runNow, toggleStatus, remove, applySaved,
  } = useAutomationsController({ folderPath: selectedProject })

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // A run-notification deep-link to apply once its definition has loaded.
  const [pendingRunTarget, setPendingRunTarget] = useState(initialRunTarget ?? null)
  const [focusRunId, setFocusRunId] = useState<string | null>(null)
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

  // Reset the selection/editor when the project changes — definitions belong to
  // a single project store.
  useEffect(() => {
    setSelectedId(null)
    setEditor(null)
    setFocusRunId(null)
  }, [selectedProject])

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
          <label className="flex items-center gap-2 text-[11px] text-[color:var(--text-muted)]">
            <span className="sr-only">Project</span>
            <select
              value={selectedProject ?? ''}
              onChange={(event) => setSelectedProject(event.target.value || null)}
              className="max-w-[220px] rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 py-1 text-[12px] text-[color:var(--text-default)] focus:border-[color:var(--accent-primary)] focus:outline-none"
            >
              {projects.map((project) => (
                <option key={project.path} value={project.path}>
                  {project.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <PrimaryButton
          onClick={() => { setEditor({ mode: 'create' }); setSelectedId(null); clearActionError() }}
          disabled={loadState !== 'ready'}
        >
          New automation
        </PrimaryButton>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close automations"
          className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
        >
          <svg viewBox="0 0 16 16" fill="none" className="icon-sm">
            <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </header>

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
