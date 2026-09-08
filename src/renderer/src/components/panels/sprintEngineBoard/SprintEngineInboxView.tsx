import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { FilePreviewPane, FOCUS_RING_INSET_CLASS, GhostButton, InboxRow, InboxSearchInput, InlineNotice, PanelHeader, Section, SidePane, Tooltip } from '../../ui'
import { BacklogRowContent, BacklogRowHoverCard } from '../../backlog/BacklogRow'
import { HtmlArtifactFrame } from '../../htmlArtifact/HtmlArtifactFrame'
import { isEditableTarget } from '../../../utils/keyboard'
import { getSprintEngineArtifactDependencyBlockers, isCanceledSprintEngineRun } from '../../../utils/sprintengine'
import { joinFilePath, parentPath } from '../../../utils/paths'
import { revealBacklogItemInPane } from '../../workspace/pane/backlogPaneReveal'
import { useSharedBacklogScan } from '../../../hooks/useSharedBacklogScan'
import { useRelativeNow } from '../../../hooks/useRelativeNow'
import { epicMetaBySlug, epicSlug, type BacklogEpicMeta } from '../../../utils/backlogEpics'
import type { BacklogItem } from '../../../utils/backlog'
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
  sprintEngineSeedCaptureLabel,
  sprintEngineSeedProvenanceProviderLabel,
  sprintEngineSharedCaptureLabel,
  trackerSeedProvenance,
  type SprintEngineSeedProvenance,
  type SprintEngineSeedRow,
} from './sprintEngineStartedFrom'

// Inbox tab: list + detail. The artifact queue sits in the primary content
// column on the left; the inspector fills the remaining width when something
// is selected, and a quiet empty state when not. This matches the review inbox's
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
  // A seeded backlog item IS a backlog item, so the seeded-documents list renders
  // it with the Backlog's own row (`BacklogRowContent`) rather than a file-path
  // line of its own — same status glyph, id, size, priority and touched-time as
  // the Backlog panel, narrowed to the documents this sprint was launched from.
  // Those fields live in the backlog store, not in run state, so they come from
  // the shared scan — gated on the seed actually naming a backlog file, to avoid
  // scanning backlog/ for a run seeded by a raw document.
  const needsBacklogScan = Boolean(startedFrom?.rows.some((row) => row.backlogPath))
  const { scan: backlogScan } = useSharedBacklogScan(needsBacklogScan ? folderPath : null)
  const backlogItemByPath = useMemo(() => {
    const map = new Map<string, BacklogItem>()
    for (const item of backlogScan?.items ?? []) {
      map.set(item.relativePath.toLowerCase(), item)
    }
    return map
  }, [backlogScan])
  // Identity (title/colour/id) for a seeded EPIC row — the primary of an epic
  // launch — so it tints its layers glyph exactly as it does in the Backlog. The
  // children never pill their parent: the epic row directly above them names it.
  const epicMetaMap = useMemo(() => epicMetaBySlug(backlogScan?.items ?? []), [backlogScan])
  // Tracker provenance (native key + issue URL) for proxy-seeded rows (MC-1639),
  // derived from the backlog scan already loaded above — no extra file reads. A
  // native (non-proxy) seed contributes nothing, so its row stays unchanged.
  const provenanceByPath = useMemo(() => {
    const map = new Map<string, SprintEngineSeedProvenance>()
    for (const item of backlogScan?.items ?? []) {
      const provenance = trackerSeedProvenance(item.sourceContent)
      if (provenance) map.set(item.relativePath.toLowerCase(), provenance)
    }
    return map
  }, [backlogScan])

  // Human title for the seed inbox row: the launching backlog item's title when
  // we have it, else the primary seed's file name — never empty.
  const seedTitle = useMemo(() => {
    const primary = startedFrom?.rows[0]
    if (!primary) return null
    const fromBacklog = primary.backlogPath
      ? backlogItemByPath.get(primary.backlogPath.toLowerCase())?.title
      : undefined
    return fromBacklog?.trim() || primary.fileName
  }, [startedFrom, backlogItemByPath])

  // The seed is a normal inbox row now. Selecting it opens the "Seeded
  // documents" list in the detail pane; opening one of those rows previews the
  // file. Both are local selection state — the parent owns artifact/task
  // selection, and picking a real artifact/task clears both here.
  const [seedSelected, setSeedSelected] = useState(false)
  const [selectedSeed, setSelectedSeed] = useState<SprintEngineSeedRow | null>(null)
  useEffect(() => {
    // Only a genuine artifact selection (truthy id) evicts the seed panes — the
    // transition back to null when we open the seed ourselves must not clobber
    // it.
    if (selectedArtifactId) {
      setSelectedSeed(null)
      setSeedSelected(false)
    }
  }, [selectedArtifactId])
  useEffect(() => {
    setSelectedSeed((current) =>
      current && startedFrom?.rows.some((row) => row.key === current.key) ? current : null,
    )
    if (!startedFrom) setSeedSelected(false)
  }, [startedFrom])

  const handleSelectSeed = useCallback(() => {
    // Clear the artifact inspector so the seeded-documents list owns the pane.
    onSelectArtifact(null)
    setSelectedSeed(null)
    setSeedSelected(true)
  }, [onSelectArtifact])
  const handleOpenSeed = useCallback(
    (row: SprintEngineSeedRow) => {
      // Preview one seeded document; keep the seed selected so Back returns to
      // the list rather than the empty state.
      onSelectArtifact(null)
      setSelectedSeed(row)
    },
    [onSelectArtifact],
  )
  const handleSelectTask = useCallback(
    (taskId: string) => {
      setSelectedSeed(null)
      setSeedSelected(false)
      onSelectTask(taskId)
    },
    [onSelectTask],
  )
  const handleOpenInBacklog = useCallback(
    (backlogPath: string) => {
      if (!workspaceId) return
      revealBacklogItemInPane(workspaceId, backlogPath)
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

  // A canceled run's review queue is suppressed upstream (the parent passes no
  // review artifacts), so name that state instead of the phase-based prompt —
  // otherwise an empty inbox would read as "waiting for work" on a stopped run.
  const runCanceled = isCanceledSprintEngineRun(sprintEngineState)
  const inboxEmptyMessage = runCanceled
    ? 'This sprint was canceled. Nothing is waiting for review.'
    : sprintEngineInboxEmptyMessage(runPhase)
  const filteringActive = search.trim().length > 0
  const emptyMessage =
    filteringActive && inboxArtifacts.length > 0
      ? 'No inbox artifacts match the current search.'
      : inboxEmptyMessage

  // The seed row is the sprint's origin — the oldest entry — so it sits at the
  // BOTTOM of the queue, in the same list flow as every other row (never a
  // pinned box). It participates in search like any other item.
  const seedRowVisible = useMemo(() => {
    if (!startedFrom || !seedTitle) return false
    if (!filteringActive) return true
    const query = search.trim().toLowerCase()
    return (
      seedTitle.toLowerCase().includes(query) ||
      startedFrom.subtitle.toLowerCase().includes(query) ||
      'seed input'.includes(query)
    )
  }, [startedFrom, seedTitle, filteringActive, search])

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
              className={`${FOCUS_RING_INSET_CLASS}`}
              role="region"
              aria-label="Inbox artifacts (use arrow keys)"
            >
              {visibleArtifacts.length === 0 && !seedRowVisible ? (
                // The queue is empty and there is no seed row. Suppress the empty
                // copy when evidence is present below, so it never reads as
                // "nothing here" over a populated Evidence grouping.
                visibleEvidence.length === 0 ? (
                  <div className="px-3 py-6 text-meta leading-5 text-[color:var(--text-muted)]">
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
                  {/* The seed sits last — it is the sprint's origin, the oldest
                      entry in the stack. */}
                  {seedRowVisible && startedFrom && seedTitle ? (
                    <li>
                      <SprintEngineSeedInboxRow
                        title={seedTitle}
                        subtitle={startedFrom.subtitle}
                        selected={seedSelected}
                        onSelect={handleSelectSeed}
                      />
                    </li>
                  ) : null}
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
      ) : seedSelected && startedFrom ? (
        <section
          className="flex min-w-0 flex-1 flex-col"
          aria-label="Seeded documents"
        >
          <SprintEngineSeededDocumentsPanel
            startedFrom={startedFrom}
            seedTitle={seedTitle}
            // In this branch selectedSeed is null (a chosen seed swaps this
            // pane for the preview above), so no list row is ever highlighted.
            selectedSeedKey={null}
            backlogItemByPath={backlogItemByPath}
            epicMetaMap={epicMetaMap}
            provenanceByPath={provenanceByPath}
            onOpenSeed={handleOpenSeed}
            onOpenInBacklog={handleOpenInBacklog}
            onBack={() => setSeedSelected(false)}
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
              : 'Nothing is queued for review. New artifacts land here as agents finish and reviewers gate them.'
          }
        />
      )}
    </div>
  )
}

// The seed inbox row: one ordinary Inbox entry standing in for what launched
// the sprint. Its title is the launching backlog item's title (or the seed file
// name); selecting it opens the "Seeded documents" list in the detail pane, the
// same as any other inbox row opens its inspector.
function SprintEngineSeedInboxRow({
  title,
  subtitle,
  selected,
  onSelect,
}: {
  title: string
  subtitle: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <InboxRow
      hideDot
      leading={
        <svg
          viewBox="0 0 16 16"
          className="icon-sm text-[color:var(--text-muted)]"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <path d="M4 2.5h5l3 3V13a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 13V3a.5.5 0 0 1 .5-.5Z" strokeLinejoin="round" />
          <path d="M9 2.5V5.5h3" strokeLinejoin="round" />
        </svg>
      }
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 rounded-sm border border-[color:var(--border-default)] px-1 text-micro font-medium leading-4 text-[color:var(--text-muted)]">
            Seed input
          </span>
          <span className="min-w-0 truncate">{title}</span>
        </span>
      }
      supporting={subtitle}
      selected={selected}
      onSelect={onSelect}
      ariaLabel={`Seed input: ${title}, ${subtitle}`}
    />
  )
}

// Detail-pane list of the documents the sprint was seeded from — the content
// behind the seed inbox row. Opening a row previews that file (handled by the
// parent, which swaps this pane for the preview). Selection is owned by the
// parent so a highlighted row survives the preview round-trip.
//
// A row that names a backlog file renders as a BACKLOG ROW — the Backlog's own
// `BacklogRowContent`, the same anatomy the Backlog panel, the Epic tab and the
// New sprint dialog draw — so a seeded item reads here exactly as it does
// everywhere else, and the list is simply the backlog narrowed to what this
// sprint was launched from. Only a seed with no backlog item behind it (a
// mockup, a plan, a typed brief) keeps the file-oriented line, because for those
// the path IS the identity.
function SprintEngineSeededDocumentsPanel({
  startedFrom,
  seedTitle,
  selectedSeedKey,
  backlogItemByPath,
  epicMetaMap,
  provenanceByPath,
  onOpenSeed,
  onOpenInBacklog,
  onBack,
}: {
  startedFrom: NonNullable<ReturnType<typeof buildSprintEngineStartedFrom>>
  seedTitle: string | null
  selectedSeedKey: string | null
  backlogItemByPath: Map<string, BacklogItem>
  epicMetaMap: Map<string, BacklogEpicMeta>
  provenanceByPath: Map<string, SprintEngineSeedProvenance>
  onOpenSeed: (row: SprintEngineSeedRow) => void
  onOpenInBacklog: (backlogPath: string) => void
  onBack: () => void
}) {
  const rows = startedFrom.rows
  const documentWord = rows.length === 1 ? 'document' : 'documents'
  // Ticks only while this pane is mounted — the backlog rows' touched-times are
  // the only thing on the surface that ages.
  const now = useRelativeNow()
  // The capture provenance, said once when every row agrees on it (the common
  // launch). Null keeps it on the rows, where a genuine difference is visible.
  const sharedCapture = useMemo(() => sprintEngineSharedCaptureLabel(rows), [rows])

  return (
    <SprintEngineSeedPreviewShell title="Seeded documents" path={seedTitle ?? 'Seeded documents'} onBack={onBack}>
      <div className="px-5 py-3 text-meta leading-5 text-[color:var(--text-muted)]">
        <p>This sprint was seeded from the following {documentWord}. Open one to preview it.</p>
        {sharedCapture ? (
          <p className="mt-0.5 text-micro text-[color:var(--text-subtle)]">{sharedCapture}</p>
        ) : null}
      </div>
      <ul className="pb-2">
        {rows.map((row) => {
          const item = row.backlogPath ? backlogItemByPath.get(row.backlogPath.toLowerCase()) ?? null : null
          return (
            <li key={row.key}>
              <SprintEngineSeedRowButton
                row={row}
                item={item}
                epicMeta={item?.isEpic ? epicMetaMap.get(epicSlug(item)) : undefined}
                now={now}
                selected={selectedSeedKey === row.key}
                captureLabel={sharedCapture ? null : sprintEngineSeedCaptureLabel(row)}
                provenance={row.backlogPath ? provenanceByPath.get(row.backlogPath.toLowerCase()) ?? null : null}
                onOpen={() => onOpenSeed(row)}
                onOpenInBacklog={onOpenInBacklog}
              />
            </li>
          )
        })}
      </ul>
    </SprintEngineSeedPreviewShell>
  )
}

// One seed row. A backlog-backed seed is the Backlog's own row interior; every
// other seed keeps the file-oriented two-line form (name, then path + kind).
// Epic children sit under the epic on an indent alone — no tree guide, no left
// bar: the Epic tab already rules that containment inside a sprint surface is
// carried by indentation, and the row's own status glyph now says what the
// hand-rolled green tick used to. The whole row opens the file in the detail
// pane; backlog rows carry a hover/focus-revealed "Open in Backlog" jump-out.
function SprintEngineSeedRowButton({
  row,
  item,
  epicMeta,
  now,
  selected,
  captureLabel,
  provenance,
  onOpen,
  onOpenInBacklog,
}: {
  row: SprintEngineSeedRow
  /** The backlog item behind this seed, when the scan resolved one. Null for a
   *  non-backlog document, and while the scan is still in flight. */
  item: BacklogItem | null
  /** An epic row's OWN identity, tinting its layers glyph. Undefined on leaves —
   *  a child never pills the epic listed directly above it. */
  epicMeta: BacklogEpicMeta | undefined
  now: number
  selected: boolean
  /** This row's capture provenance, or null when the list hoisted a shared one
   *  into its header. */
  captureLabel: string | null
  provenance: SprintEngineSeedProvenance | null
  onOpen: () => void
  onOpenInBacklog: (backlogPath: string) => void
}) {
  const isChild = row.role === 'epic-child'

  return (
    <div
      className={`group relative flex items-stretch ${selected ? 'bg-[color:var(--bg-selected)]' : ''}`}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'true' : undefined}
        // design-tokens-allow: alignment — an epic's child row indents one glyph slot past the epic row's own text edge
        className={`interactive flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 pr-3 text-left focus-visible:focus-ring-inset ${isChild ? 'pl-10' : 'pl-5'} ${selected ? '' : 'hover:bg-[color:var(--bg-surface)]'}`}
      >
        {item ? (
          <Tooltip
            content={<BacklogRowHoverCard item={item} />}
            placement="top"
            openDelayMs={600}
            wrapperClassName="block"
            wrapperRole="presentation"
          >
            <BacklogRowContent item={item} now={now} plainTitle selected={selected} epicMeta={epicMeta} />
          </Tooltip>
        ) : (
          <>
            <span className="min-w-0 truncate text-meta font-medium text-[color:var(--text-strong)]">
              {row.fileName}
            </span>
            {/* Path on its own truncating line, then the short labels wrap — so
                every metadata item stays visible with no horizontal overflow even
                at the Inbox column's 320px minimum width. */}
            <span className="flex min-w-0 flex-col gap-0.5 text-micro text-[color:var(--text-muted)]">
              <span
                className="min-w-0 truncate font-mono text-[color:var(--text-subtle)]"
                title={row.path}
              >
                {row.path}
              </span>
              <SprintEngineSeedMetaLine
                kindLabel={row.kindLabel}
                provenance={provenance}
                captureLabel={captureLabel}
              />
            </span>
          </>
        )}
        {/* A backlog row's own supporting line is already full — id, size,
            priority, touched-time — so the seed-specific metadata it cannot hold
            rides beneath it, aligned to the title behind the status glyph. Its
            kind is omitted: the row itself says "backlog item" better than a
            word can. */}
        {item ? (
          <SprintEngineSeedMetaLine
            kindLabel={null}
            provenance={provenance}
            captureLabel={captureLabel}
            className="pl-[22px]"
          />
        ) : null}
      </button>
      {/* The launch seed's mark. A backlog row's title line has no slot to take
          it inline, so it holds the trailing edge — where every row's actions
          also live — rather than displacing the title. */}
      {row.isPrimary ? (
        <span className="mr-2 shrink-0 self-center rounded-sm border border-[color:var(--border-default)] px-1 text-micro leading-4 text-[color:var(--text-muted)]">
          Launched from
        </span>
      ) : null}
      {provenance?.url ? (
        <button
          type="button"
          onClick={() => void window.api.openExternal(provenance.url)}
          aria-label={`View ${provenance.nativeKey} in ${sprintEngineSeedProvenanceProviderLabel(provenance.provider)}`}
          className="interactive mr-1 shrink-0 self-center rounded px-1.5 py-1 text-micro font-medium text-[color:var(--text-muted)] opacity-0 transition-opacity hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:opacity-100 focus-visible:focus-ring group-hover:opacity-100 group-focus-within:opacity-100"
        >
          View in {sprintEngineSeedProvenanceProviderLabel(provenance.provider)}
        </button>
      ) : null}
      {row.backlogPath ? (
        <button
          type="button"
          onClick={() => onOpenInBacklog(row.backlogPath as string)}
          aria-label={`Open ${row.fileName} in Backlog`}
          className="interactive mr-2 shrink-0 self-center rounded px-1.5 py-1 text-micro font-medium text-[color:var(--text-muted)] opacity-0 transition-opacity hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:opacity-100 focus-visible:focus-ring group-hover:opacity-100 group-focus-within:opacity-100"
        >
          Open in Backlog
        </button>
      ) : null}
    </div>
  )
}

// The seed-specific metadata a row carries beneath its identity, dot-separated
// and rendered only when something is actually earned: what kind of document it
// is (file rows only — a backlog row's own anatomy says that better than a word
// can), the native tracker key of a proxy-seeded item, and the capture label on
// a mixed-capture launch where the header could not hoist a shared one.
function SprintEngineSeedMetaLine({
  kindLabel,
  provenance,
  captureLabel,
  className = '',
}: {
  kindLabel: string | null
  provenance: SprintEngineSeedProvenance | null
  captureLabel: string | null
  className?: string
}) {
  const parts: React.ReactNode[] = []
  if (kindLabel) parts.push(<span key="kind">{kindLabel}</span>)
  if (provenance) {
    // Native tracker key, verbatim (mono, tabular) — the provenance of a
    // proxy-seeded run (MC-1639). The provider is named by the "View in …"
    // jump-out beside the row, not repeated here.
    parts.push(
      <span key="tracker" className="font-mono tabular-nums">
        {provenance.nativeKey}
      </span>,
    )
  }
  if (captureLabel) parts.push(<span key="capture">{captureLabel}</span>)
  if (parts.length === 0) return null
  return (
    <span
      className={`flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-micro text-[color:var(--text-subtle)] ${className}`}
    >
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          {part}
        </React.Fragment>
      ))}
    </span>
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
          <span className="text-meta font-semibold text-[color:var(--tone-warn)]">Preview unavailable</span>
          <span className="text-meta leading-5 text-[color:var(--text-muted)]">
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
        <div className="flex h-full items-center justify-center text-meta text-[color:var(--text-muted)]">
          Loading preview…
        </div>
      ) : (
        <div className="flex h-full items-start justify-center px-6 py-6">
          {/* Degraded, not failed: the seed still opens, only the preview does not. */}
          <InlineNotice tone="warn" title="Preview unavailable" hint={state.reason} className="w-full max-w-md" />
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
      {/* Drill-in shell on the shared identity row — it hand-rolled the band at
          `px-5 py-3`, 4px taller and 8px further in than the panel it drills
          out of (2112). Back is the row's `leading` control; the file's path is
          its scope. */}
      <PanelHeader
        title={title}
        subtitle={path}
        leading={
          <GhostButton size="xs" onClick={onBack} className="shrink-0" aria-label="Back">
            <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
              <path
                d="M10 4L6 8L10 12"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Back
          </GhostButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  )
}
