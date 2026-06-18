import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AutomationDefinition } from '../../../../shared/automations/contracts'
import { GhostButton, InlineNotice, PanelHeader, PrimaryButton, Spinner, useConfirmDialog } from '../ui'
import { AutomationDetailPane } from './AutomationsPanel/AutomationDetailPane'
import { AutomationEditor } from './AutomationsPanel/AutomationEditor'
import { DefinitionList, DetailEmptyState } from './AutomationsPanel/AutomationsList'
import { isEditableTarget, sortDefinitions, type EditorState } from './AutomationsPanel/automationsFormat'
import { useAutomationsController } from './AutomationsPanel/useAutomationsController'

// Automations control center: composes the data controller (window.api IPC
// boundary), the definitions list, the run-history/detail pane, and the
// schema-driven editor. Sub-modules live in ./AutomationsPanel/*.
export default function AutomationsPanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const folderPath = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const dialog = useConfirmDialog()

  const {
    definitions, providers, loadState, loadError, actionError, busyId,
    load, clearActionError, runNow, toggleStatus, remove, applySaved,
  } = useAutomationsController(folderPath)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [now, setNow] = useState(() => Date.now())
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
            onClick={() => { setEditor({ mode: 'create' }); setSelectedId(null); clearActionError() }}
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
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
          <DefinitionList
            ref={listRef}
            definitions={ordered}
            selectedId={editor ? null : selectedId}
            busyId={busyId}
            now={now}
            onSelect={(id) => { setSelectedId(id); setEditor(null) }}
            onKeyDown={onListKeyDown}
            onRunNow={runNow}
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
