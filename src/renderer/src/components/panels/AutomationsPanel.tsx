import React, { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { revealAgentTerminalTab } from '../../utils/agentTabReveal'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import type { AutomationDefinition, AutomationRun } from '../../../../shared/automations/contracts'
import { GhostButton, InlineNotice, PanelHeader, PrimaryButton, SidePane, Spinner, useConfirmDialog } from '../ui'
import { AutomationReportViewer } from '../automations/AutomationReportViewer'
import { extractReportPaths } from '../automations/reportPaths'
import { AutomationDetailPane } from './AutomationsPanel/AutomationDetailPane'
import { AutomationEditor } from './AutomationsPanel/AutomationEditor'
import { DefinitionList, DetailEmptyState } from './AutomationsPanel/AutomationsList'
import { isEditableTarget } from '../../utils/keyboard'
import { sortDefinitions, type EditorState } from './AutomationsPanel/automationsFormat'
import { useAutomationsController } from './AutomationsPanel/useAutomationsController'
import { automationsDoorTarget } from '../automations/runTarget'

// Automations control center: composes the data controller (window.api IPC
// boundary), the definitions list, the run-history/detail pane, and the
// schema-driven editor. Sub-modules live in ./AutomationsPanel/*.
export default function AutomationsPanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const folderPath = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null)
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? null)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const dialog = useConfirmDialog()

  const {
    definitions,
    providers,
    loadState,
    loadError,
    actionError,
    busyId,
    load,
    clearActionError,
    runNow,
    toggleStatus,
    remove,
    applySaved,
  } = useAutomationsController({ folderPath, workspaceId })

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // The run whose report is open in the right-hand viewer pane (null = closed).
  const [viewerRun, setViewerRun] = useState<AutomationRun | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // A slow clock so "in 3h" / "overdue" stay honest without churning the list.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const ordered = useMemo(() => sortDefinitions(definitions, now), [definitions, now])

  // Keep the selection valid as the list changes.
  useEffect(() => {
    if (selectedId && !definitions.some((d) => d.id === selectedId)) setSelectedId(null)
  }, [definitions, selectedId])

  const selected = useMemo(() => definitions.find((d) => d.id === selectedId) ?? null, [definitions, selectedId])

  const handleEditorSaved = useCallback(
    (saved: AutomationDefinition) => {
      applySaved(saved)
      setSelectedId(saved.id)
      setEditor(null)
    },
    [applySaved],
  )

  // Delete drops the definition and its run-history directory in the store, so
  // gate it behind a danger confirm — cancel must leave both untouched.
  const handleDelete = useCallback(
    async (def: AutomationDefinition) => {
      const confirmed = await dialog.confirm({
        title: `Delete ${def.name}?`,
        body: 'This removes the automation and its run history. This cannot be undone.',
        confirmLabel: 'Delete',
        tone: 'danger',
      })
      if (confirmed) await remove(def)
    },
    [dialog, remove],
  )

  // Run now is the only run whose terminal status the renderer observes (the
  // IPC return). On a failed/blocked outcome raise a notification whose Open
  // action deep-links back to this control center and the originating run.
  // Scheduled/background runs notify via T12/T13, not here.
  const handleRunNow = useCallback(
    async (def: AutomationDefinition) => {
      const run = await runNow(def)
      if (!run || (run.status !== 'failed' && run.status !== 'blocked')) return
      publishDiagnosticSync({
        level: run.status === 'failed' ? 'error' : 'warning',
        source: 'automations',
        title: `Automation ${run.status}: ${def.name}`,
        message: run.blockedReason || run.summary || `The run ended ${run.status}.`,
        workspaceId,
        workspaceName: workspaceName ?? undefined,
        // Route to the full-page Automations door (item 1707), not the retired host.
        navigationTarget: automationsDoorTarget(def.id, run.id, folderPath),
      })
    },
    [runNow, workspaceId, workspaceName, folderPath],
  )

  const onListKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
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
    },
    [ordered, selectedId],
  )

  const titleId = `automations-${workspaceId}`

  return (
    // The panel host can squeeze this column very narrow (e.g. a 390px viewport
    // with the workspace sidebar open). Scroll the whole panel horizontally
    // below a readable minimum so the header action, row actions, and detail
    // controls stay reachable instead of clipping offscreen.
    <section
      aria-labelledby={titleId}
      className="flex h-full min-h-0 flex-col overflow-x-auto bg-[color:var(--bg-surface)] text-[color:var(--text-default)]"
    >
      <div className="flex h-full min-h-0 w-full min-w-[16rem] flex-col">
        <PanelHeader
          title="Automations"
          titleId={titleId}
          subtitle="Runs while the app is open"
          count={loadState === 'ready' ? definitions.length : undefined}
          primaryAction={
            <PrimaryButton
              onClick={() => {
                setEditor({ mode: 'create' })
                setSelectedId(null)
                clearActionError()
              }}
              disabled={loadState !== 'ready'}
            >
              New automation
            </PrimaryButton>
          }
        />

        {actionError ? (
          <div className="px-3 pt-3">
            <InlineNotice tone="error" action={<GhostButton onClick={clearActionError}>Dismiss</GhostButton>}>
              {actionError}
            </InlineNotice>
          </div>
        ) : null}

        {/* Content + the right-hand report viewer share a row so the viewer
            docks beside the list/detail rather than stacking below it. */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {loadState === 'loading' || loadState === 'idle' ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-meta text-[color:var(--text-muted)]">
              <Spinner size={14} label="Loading automations" />
              Loading automations…
            </div>
          ) : loadState === 'error' ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="max-w-sm text-meta leading-5 text-[color:var(--text-muted)]">
                Automations are unavailable for this project.
              </p>
              <p className="max-w-sm text-micro leading-5 text-[color:var(--tone-error)]">{loadError}</p>
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
                onSelect={(id) => {
                  setSelectedId(id)
                  setEditor(null)
                }}
                onKeyDown={onListKeyDown}
                onRunNow={handleRunNow}
                onToggleStatus={toggleStatus}
                onEdit={(def) => {
                  setEditor({ mode: 'edit', definition: def })
                  setSelectedId(def.id)
                }}
                onDelete={handleDelete}
                onCreate={() => {
                  setEditor({ mode: 'create' })
                  setSelectedId(null)
                }}
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
                    onOpenAgent={(wsId, agentId) => {
                      // Focus the concrete launched agent tab (T10 reveal); fall
                      // back to activating the workspace when the run carries no
                      // agentId or the agent/workspace is gone.
                      if (agentId && revealAgentTerminalTab({ workspaceId: wsId, agentId })) return
                      setActiveWorkspace(wsId)
                    }}
                    onViewReport={setViewerRun}
                  />
                ) : (
                  <DetailEmptyState hasDefinitions={definitions.length > 0} />
                )}
              </div>
            </div>
          )}
          {viewerRun ? (
            <SidePane side="right" width="md" ariaLabel="Automation run report">
              <AutomationReportViewer
                workspaceRoot={folderPath ?? ''}
                reportPaths={extractReportPaths(viewerRun)}
                pullRequestUrl={viewerRun.pullRequestUrl}
                onClose={() => setViewerRun(null)}
              />
            </SidePane>
          ) : null}
        </div>
      </div>
    </section>
  )
}
