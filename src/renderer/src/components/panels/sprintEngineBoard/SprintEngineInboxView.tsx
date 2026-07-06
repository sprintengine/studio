import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { FilePreviewPane, InboxSearchInput, Section, SidePane } from '../../ui'
import { HtmlArtifactFrame } from '../../workspace/guidedBrief/MockupPreviewPane'
import { isEditableTarget } from '../../../utils/keyboard'
import { getSprintEngineArtifactDependencyBlockers } from '../../../utils/sprintengine'
import { joinFilePath, parentPath } from '../../../utils/paths'
import { revealNavRailComponent } from '../../../utils/modelRegistry'
import { dispatchBacklogReveal } from '../../../utils/backlogReveal'
import { useSharedBacklogScan } from '../../../hooks/useSharedBacklogScan'
import type { SprintEngineArtifact, SprintEngineState } from '../../../types/workspace'
import {
  getSprintEngineEvidenceArtifacts,
  getSprintEngineInboxArtifacts,
  sprintEngineInboxEmptyMessage,
} from '../sprintEngineInspector'
import { SprintEngineInboxRow, SprintEngineBlockedByRow } from '../SprintEngineInspectorPanel'
import { SprintEngineEmptyDetail } from './SprintEngineEmptyDetail'
import {
  buildSprintEngineStartedFrom,
  sprintEngineCapturedLabel,
  type SprintEngineSeedRow,
} from './sprintEngineStartedFrom'

// Cap the "Started from" list so a large bundle never dominates the Inbox
// column; "Show N more" reveals the rest. The primary seed is always within
// the cap (it is row 0).
const SPRINT_ENGINE_SEED_ROW_CAP = 4

// Inbox tab: list + detail. The artifact queue sits in the primary content
// column on the left; the inspector fills the remaining width when something
// is selected, and a quiet empty state when not. This matches Watchtower's
// two-pane chrome — the roster lives on its own tab now, so the right pane
// never has to compete for width with a third column. The "Inbox · N"
// header and search live inside the list pane so the active tab carries
// its own identity (the panel-wide hero shows run status, not list state).
export function SprintEngineInboxView({
  sprintEngineState,
  reviewArtifacts,
  runPhase,
  workspaceId,
  folderPath,
  selectedArtifactId,
  onSelectArtifact,
  onSelectTask,
  inspectorContent,
  inspectorExpanded,
}: {
  sprintEngineState: SprintEngineState
  reviewArtifacts: SprintEngineArtifact[]
  runPhase: string
  /** Owning workspace id — powers the "Open in Backlog" reveal. */
  workspaceId: string
  /** Project root, for resolving project-relative seed paths to disk and for
   *  the epic-child backlog status scan. Null when the folder is unresolved. */
  folderPath: string | null
  selectedArtifactId: string | null
  onSelectArtifact: (artifactId: string | null) => void
  onSelectTask: (taskId: string) => void
  inspectorContent: React.ReactNode
  inspectorExpanded: boolean
}) {
  // "Started from" seed docs, projected at run creation (T2). Null for legacy
  // runs with no recorded seed → the section is omitted entirely.
  const startedFrom = useMemo(
    () => buildSprintEngineStartedFrom(sprintEngineState.source, sprintEngineState.sourceBundle),
    [sprintEngineState.source, sprintEngineState.sourceBundle],
  )
  // Epic children show a green tick when their backlog frontmatter status is
  // 'completed'. That status is owned by the backlog store, not run state, so
  // read it from the shared scan — but only for epic launches, to avoid
  // scanning backlog/ for every non-epic run.
  const { scan: backlogScan } = useSharedBacklogScan(startedFrom?.epic ? folderPath : null)
  const backlogStatusByPath = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of backlogScan?.items ?? []) {
      map.set(item.relativePath.toLowerCase(), item.status)
    }
    return map
  }, [backlogScan])

  // Opening a seed row previews the file in the detail pane. Selection is owned
  // here (the parent owns artifact/task selection); a seed preview takes over
  // the right pane until the user opens an artifact/task, which clears it.
  const [selectedSeed, setSelectedSeed] = useState<SprintEngineSeedRow | null>(null)
  useEffect(() => {
    if (selectedArtifactId) setSelectedSeed(null)
  }, [selectedArtifactId])
  useEffect(() => {
    setSelectedSeed((current) =>
      current && startedFrom?.rows.some((row) => row.key === current.key) ? current : null,
    )
  }, [startedFrom])

  const handleOpenSeed = useCallback(
    (row: SprintEngineSeedRow) => {
      // Clear the artifact inspector so the seed preview owns the detail pane.
      onSelectArtifact(null)
      setSelectedSeed(row)
    },
    [onSelectArtifact],
  )
  const handleSelectTask = useCallback(
    (taskId: string) => {
      setSelectedSeed(null)
      onSelectTask(taskId)
    },
    [onSelectTask],
  )
  const handleOpenInBacklog = useCallback(
    (backlogPath: string) => {
      if (!workspaceId) return
      revealNavRailComponent(workspaceId, 'backlog', 'Backlog')
      dispatchBacklogReveal({ workspaceId, relativePath: backlogPath })
    },
    [workspaceId],
  )

  const seedAbsolutePath =
    selectedSeed && folderPath ? joinFilePath(folderPath, selectedSeed.path) : null
  const tasksById = useMemo(
    () => Object.fromEntries(sprintEngineState.tasks.map((task) => [task.id, task])),
    [sprintEngineState.tasks]
  )
  const inboxArtifacts = useMemo(
    () => getSprintEngineInboxArtifacts(reviewArtifacts),
    [reviewArtifacts]
  )
  const evidenceArtifacts = useMemo(
    () => getSprintEngineEvidenceArtifacts(reviewArtifacts),
    [reviewArtifacts]
  )
  const [search, setSearch] = useState('')
  const matchesSearch = useCallback(
    (artifact: SprintEngineArtifact, query: string) => {
      const task = tasksById[artifact.taskId]
      const haystack = [
        artifact.id,
        artifact.title,
        artifact.kind,
        artifact.createdBy,
        task?.id,
        task?.title,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(query)
    },
    [tasksById]
  )
  const visibleArtifacts = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return inboxArtifacts
    return inboxArtifacts.filter((artifact) => matchesSearch(artifact, query))
  }, [inboxArtifacts, search, matchesSearch])
  const visibleEvidence = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return evidenceArtifacts
    return evidenceArtifacts.filter((artifact) => matchesSearch(artifact, query))
  }, [evidenceArtifacts, search, matchesSearch])
  const blockedByArtifacts = useMemo(() => (
    sprintEngineState.tasks
      .map((task) => ({
        task,
        blockers: getSprintEngineArtifactDependencyBlockers(task, sprintEngineState.tasks, reviewArtifacts),
      }))
      .filter(({ blockers }) => blockers.length > 0)
  ), [reviewArtifacts, sprintEngineState.tasks])

  const inboxEmptyMessage = sprintEngineInboxEmptyMessage(runPhase)
  const filteringActive = search.trim().length > 0
  const emptyMessage =
    filteringActive && inboxArtifacts.length > 0
      ? 'No inbox artifacts match the current search.'
      : inboxEmptyMessage

  // Drop a selection when the search has filtered it out so the inspector
  // never shows an artifact that isn't visible in either grouping (queue or
  // evidence).
  useEffect(() => {
    if (
      selectedArtifactId
      && !visibleArtifacts.some((artifact) => artifact.id === selectedArtifactId)
      && !visibleEvidence.some((artifact) => artifact.id === selectedArtifactId)
    ) {
      onSelectArtifact(null)
    }
  }, [selectedArtifactId, visibleArtifacts, visibleEvidence, onSelectArtifact])
  const handleInboxKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEditableTarget(event.target)) return
      if (visibleArtifacts.length === 0) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const currentIndex = selectedArtifactId
          ? visibleArtifacts.findIndex((artifact) => artifact.id === selectedArtifactId)
          : -1
        const delta = event.key === 'ArrowDown' ? 1 : -1
        let nextIndex: number
        if (currentIndex === -1) {
          nextIndex = event.key === 'ArrowDown' ? 0 : visibleArtifacts.length - 1
        } else {
          nextIndex = (currentIndex + delta + visibleArtifacts.length) % visibleArtifacts.length
        }
        onSelectArtifact(visibleArtifacts[nextIndex].id)
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        onSelectArtifact(visibleArtifacts[0].id)
        return
      }
      if (event.key === 'End') {
        event.preventDefault()
        onSelectArtifact(visibleArtifacts[visibleArtifacts.length - 1].id)
        return
      }
      if (event.key === 'Escape' && selectedArtifactId) {
        event.preventDefault()
        onSelectArtifact(null)
      }
    },
    [visibleArtifacts, onSelectArtifact, selectedArtifactId]
  )

  const hasInspector = inspectorContent !== null && inspectorContent !== undefined

  return (
    <div className="flex min-h-0 flex-1 min-w-0">
      {inspectorExpanded ? null : (
        <SidePane as="section" side="left" width="lg" ariaLabel="Inbox">
          <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border-default)] px-3 py-2">
            <InboxSearchInput
              value={search}
              onChange={setSearch}
              ariaLabel="Search inbox artifacts"
            />
          </div>
          <div className="flex flex-1 flex-col overflow-auto">
            <div
              tabIndex={0}
              onKeyDown={handleInboxKeyDown}
              className="focus:outline-none"
              role="region"
              aria-label="Inbox artifacts (use arrow keys)"
            >
              {visibleArtifacts.length === 0 ? (
                // The queue is empty. Suppress the empty copy when evidence is
                // present below, so it never reads as "nothing here" over a
                // populated Evidence grouping.
                visibleEvidence.length === 0 ? (
                  <div className="px-3 py-6 text-[12px] leading-5 text-[color:var(--text-muted)]">
                    {emptyMessage}
                  </div>
                ) : null
              ) : (
                <ul>
                  {visibleArtifacts.map((artifact) => (
                    <li key={artifact.id}>
                      <SprintEngineInboxRow
                        artifact={artifact}
                        task={tasksById[artifact.taskId]}
                        selected={selectedArtifactId === artifact.id}
                        onSelect={() => onSelectArtifact(artifact.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {visibleEvidence.length > 0 ? (
              <div role="region" aria-label="Recorded evidence">
                <Section
                  title="Evidence"
                  count={visibleEvidence.length}
                  level={3}
                  inset={false}
                  className="border-t border-[color:var(--border-default)]"
                >
                  <ul>
                    {visibleEvidence.map((artifact) => (
                      <li key={artifact.id}>
                        <SprintEngineInboxRow
                          artifact={artifact}
                          task={tasksById[artifact.taskId]}
                          selected={selectedArtifactId === artifact.id}
                          onSelect={() => onSelectArtifact(artifact.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </Section>
              </div>
            ) : null}

            {blockedByArtifacts.length > 0 ? (
              <div role="region" aria-label="Tasks blocked by review">
                <Section
                  title="Blocked by review"
                  count={blockedByArtifacts.length}
                  level={3}
                  inset={false}
                  className="border-t border-[color:var(--border-default)]"
                >
                  <ul>
                    {blockedByArtifacts.map(({ task, blockers }) => (
                      <li key={task.id}>
                        <SprintEngineBlockedByRow
                          task={task}
                          blockers={blockers}
                          selected={false}
                          onSelect={() => handleSelectTask(task.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </Section>
              </div>
            ) : null}
          </div>

          {startedFrom ? (
            <SprintEngineStartedFromSection
              startedFrom={startedFrom}
              selectedSeedKey={selectedSeed?.key ?? null}
              backlogStatusByPath={backlogStatusByPath}
              onOpenSeed={handleOpenSeed}
              onOpenInBacklog={handleOpenInBacklog}
            />
          ) : null}
        </SidePane>
      )}

      {selectedSeed ? (
        <section
          className="flex min-w-0 flex-1 flex-col"
          aria-label="Seed document preview"
        >
          <SprintEngineSeedPreview
            row={selectedSeed}
            absolutePath={seedAbsolutePath}
            onBack={() => setSelectedSeed(null)}
          />
        </section>
      ) : hasInspector ? (
        <section
          className="flex min-w-0 flex-1 flex-col"
          aria-label="Selected item detail"
        >
          {inspectorContent}
        </section>
      ) : (
        <SprintEngineEmptyDetail
          message={
            inboxArtifacts.length > 0
              ? 'Pick an artifact on the left to review evidence, approve, or request changes.'
              : 'Nothing is queued for review. New artifacts land here as workers finish and reviewers gate them.'
          }
        />
      )}
    </div>
  )
}

// The pinned, collapsible "Started from" section. Sits at the bottom of the
// Inbox column (shrink-0, so it never scrolls out of reach) and lists the seed
// documents the run was launched from. Collapse and cap-expand are local UI
// state; selection is owned by the parent.
function SprintEngineStartedFromSection({
  startedFrom,
  selectedSeedKey,
  backlogStatusByPath,
  onOpenSeed,
  onOpenInBacklog,
}: {
  startedFrom: NonNullable<ReturnType<typeof buildSprintEngineStartedFrom>>
  selectedSeedKey: string | null
  backlogStatusByPath: Map<string, string>
  onOpenSeed: (row: SprintEngineSeedRow) => void
  onOpenInBacklog: (backlogPath: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [capExpanded, setCapExpanded] = useState(false)
  const rows = startedFrom.rows
  const hiddenCount = Math.max(0, rows.length - SPRINT_ENGINE_SEED_ROW_CAP)
  const visibleRows = capExpanded ? rows : rows.slice(0, SPRINT_ENGINE_SEED_ROW_CAP)

  return (
    <section
      className="shrink-0 border-t border-[color:var(--border-default)]"
      aria-label="Started from"
    >
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        aria-expanded={!collapsed}
        className="interactive flex w-full min-w-0 items-baseline gap-2 px-3 py-2 text-left transition-colors hover:bg-[color:var(--bg-surface)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] focus-visible:ring-inset"
      >
        <svg
          viewBox="0 0 16 16"
          className={`icon-sm shrink-0 self-center text-[color:var(--text-disabled)] transition-transform ${collapsed ? '' : 'rotate-90'}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[12px] font-semibold text-[color:var(--text-strong)]">Started from</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[color:var(--text-muted)]">
          {startedFrom.subtitle}
        </span>
      </button>

      {collapsed ? null : (
        <ul className="pb-1">
          {visibleRows.map((row) => (
            <li key={row.key}>
              <SprintEngineSeedRowButton
                row={row}
                selected={selectedSeedKey === row.key}
                completed={
                  row.role === 'epic-child' && row.backlogPath
                    ? backlogStatusByPath.get(row.backlogPath.toLowerCase()) === 'completed'
                    : false
                }
                onOpen={() => onOpenSeed(row)}
                onOpenInBacklog={onOpenInBacklog}
              />
            </li>
          ))}
          {hiddenCount > 0 ? (
            <li>
              <button
                type="button"
                onClick={() => setCapExpanded((prev) => !prev)}
                className="interactive flex w-full items-center px-3 py-1.5 pl-8 text-left text-[11px] text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-default)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] focus-visible:ring-inset"
              >
                {capExpanded ? 'Show fewer' : `Show ${hiddenCount} more`}
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  )
}

// One seed row. Epic children are indented under a hairline tree guide and show
// a green tick when their backlog item is completed. The whole row opens the
// file in the detail pane; backlog rows carry a hover/focus-revealed
// "Open in Backlog" jump-out.
function SprintEngineSeedRowButton({
  row,
  selected,
  completed,
  onOpen,
  onOpenInBacklog,
}: {
  row: SprintEngineSeedRow
  selected: boolean
  completed: boolean
  onOpen: () => void
  onOpenInBacklog: (backlogPath: string) => void
}) {
  const isChild = row.role === 'epic-child'
  const capturedLabel = sprintEngineCapturedLabel(row.capturedAt, row.mode)
  const modeLabel = row.mode === 'reference' ? 'Reference' : 'Copy'

  return (
    <div
      className={`group relative flex items-stretch ${selected ? 'bg-[color:var(--bg-selected)]' : ''}`}
    >
      {isChild ? (
        <span aria-hidden="true" className="ml-4 w-3 shrink-0 border-l border-[color:var(--border-default)]" />
      ) : null}
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'true' : undefined}
        className={`interactive flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 pr-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] focus-visible:ring-inset ${isChild ? 'pl-2' : 'pl-8'} ${selected ? '' : 'hover:bg-[color:var(--bg-surface)]'}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {completed ? (
            <svg
              viewBox="0 0 16 16"
              className="icon-xs shrink-0 text-[color:var(--tone-good)]"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-label="Completed"
              role="img"
            >
              <path d="M3.5 8.5l3 3 6-6.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : null}
          <span className="min-w-0 truncate text-[12px] font-medium text-[color:var(--text-strong)]">
            {row.fileName}
          </span>
          {row.isPrimary ? (
            <span className="shrink-0 rounded-sm border border-[color:var(--border-default)] px-1 text-[10px] leading-4 text-[color:var(--text-muted)]">
              Launched from
            </span>
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-[color:var(--text-muted)]">
          <span className="shrink-0">{row.kindLabel}</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate font-mono text-[color:var(--text-subtle)]">{row.path}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{modeLabel}</span>
          {capturedLabel ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">{capturedLabel}</span>
            </>
          ) : null}
        </span>
      </button>
      {row.backlogPath ? (
        <button
          type="button"
          onClick={() => onOpenInBacklog(row.backlogPath as string)}
          className="interactive mr-2 shrink-0 self-center rounded px-1.5 py-1 text-[11px] font-medium text-[color:var(--text-muted)] opacity-0 transition-opacity transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] group-hover:opacity-100 group-focus-within:opacity-100"
        >
          Open in Backlog
        </button>
      ) : null}
    </div>
  )
}

// Detail-pane preview for a selected seed row. HTML routes to the sandboxed
// frame (with T4's opt-in Source toggle); everything else routes to
// FilePreviewPane, which renders markdown or a plain-text fallback by
// extension. A missing project root or file surfaces an explicit unavailable
// state rather than an empty pane.
function SprintEngineSeedPreview({
  row,
  absolutePath,
  onBack,
}: {
  row: SprintEngineSeedRow
  absolutePath: string | null
  onBack: () => void
}) {
  if (!absolutePath) {
    return (
      <SprintEngineSeedPreviewShell title={row.fileName} path={row.path} onBack={onBack}>
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <span className="text-[12px] font-semibold text-[color:var(--tone-warn)]">Preview unavailable</span>
          <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">
            The project folder is not resolved yet, so this file cannot be read from disk.
          </span>
        </div>
      </SprintEngineSeedPreviewShell>
    )
  }

  if (row.previewKind === 'html') {
    return (
      <SprintEngineSeedPreviewShell title={row.fileName} path={row.path} onBack={onBack}>
        <div className="flex h-full min-h-0 flex-col p-3">
          <HtmlArtifactFrame
            absolutePath={absolutePath}
            relativePath={row.path}
            watchDirectoryPath={parentPath(absolutePath)}
            enableSourceView
          />
        </div>
      </SprintEngineSeedPreviewShell>
    )
  }

  return <SprintEngineSeedFilePreview row={row} absolutePath={absolutePath} onBack={onBack} />
}

type SeedFileState =
  | { kind: 'loading' }
  | { kind: 'ready'; content: string }
  | { kind: 'unavailable'; reason: string }

function SprintEngineSeedFilePreview({
  row,
  absolutePath,
  onBack,
}: {
  row: SprintEngineSeedRow
  absolutePath: string
  onBack: () => void
}) {
  const [state, setState] = useState<SeedFileState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    const load = async () => {
      try {
        const exists = await window.api.pathExists(absolutePath)
        if (cancelled) return
        if (!exists) {
          setState({ kind: 'unavailable', reason: `${row.path} is missing on disk.` })
          return
        }
        const content = await window.api.readfile(absolutePath)
        if (cancelled) return
        setState({ kind: 'ready', content })
      } catch (error) {
        if (cancelled) return
        setState({
          kind: 'unavailable',
          reason: error instanceof Error ? `Could not read ${row.path}: ${error.message}` : `Could not read ${row.path}.`,
        })
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [absolutePath, row.path])

  if (state.kind === 'ready') {
    return (
      <FilePreviewPane title={row.fileName} path={row.path} content={state.content} onBack={onBack} />
    )
  }

  return (
    <SprintEngineSeedPreviewShell title={row.fileName} path={row.path} onBack={onBack}>
      {state.kind === 'loading' ? (
        <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--text-muted)]">
          Loading preview…
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <span className="text-[12px] font-semibold text-[color:var(--tone-warn)]">Preview unavailable</span>
          <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">{state.reason}</span>
        </div>
      )}
    </SprintEngineSeedPreviewShell>
  )
}

// Shared preview chrome (Back + title) for the non-FilePreviewPane cases (HTML,
// loading, unavailable). Mirrors FilePreviewPane's header so the Back
// affordance and title sit in the same place across every preview kind.
function SprintEngineSeedPreviewShell({
  title,
  path,
  onBack,
  children,
}: {
  title: string
  path: string
  onBack: () => void
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border-default)] px-5 py-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded px-2 text-[12px] font-semibold text-[color:var(--text-muted)] interactive transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          aria-label="Back"
        >
          <svg viewBox="0 0 16 16" fill="none" className="icon-xs">
            <path
              d="M10 4L6 8L10 12"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Back
        </button>
        <span className="min-w-0 truncate text-[13px] font-medium text-[color:var(--text-strong)]" title={path}>
          {title}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  )
}
