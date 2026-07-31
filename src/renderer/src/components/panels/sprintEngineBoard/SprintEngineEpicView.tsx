import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { FOCUS_RING_INSET_CLASS, GhostButton, SidePane, Tooltip } from '../../ui'
import {
  BACKLOG_STATUS_LABEL,
  BacklogRowContent,
  BacklogRowHoverCard,
  EpicProgressMeter,
} from '../../backlog/BacklogRow'
import { BacklogItemDetailPane } from '../../backlog/BacklogItemDetailPane'
import { useSprintEngineEpicBacklog } from './useSprintEngineEpicBacklog'
import { useRelativeNow } from '../../../hooks/useRelativeNow'
import { basename } from '../../../utils/paths'
import type {
  SprintEngineEpicChildRow,
  SprintEngineEpicMapping,
  SprintEngineEpicSeed,
} from './sprintEngineEpicModel'
import type { SprintEngineTask } from '../../../types/workspace'

// Epic tab (item 2028): the backlog epic this sprint was seeded from, whole —
// its children, their status, and which task delivers each one.
//
// The list is the Backlog's own rows narrowed to one epic (`BacklogRowContent`)
// and the aside is the Backlog's own detail (`BacklogItemDetailPane`), so intent,
// acceptance and mockups read here exactly as they do in the Backlog door and
// can never drift. The one thing this surface adds is the mapping cell: the task
// delivering the item, read from that task's backlog pointer.
//
// Containment is carried by indentation alone — no card, no divider rule between
// the heading and its rows, no left bar. The rows are list-rows: no border,
// radius, hover and selected fills.
export function SprintEngineEpicView({
  seed,
  tasks,
  folderPath,
  workspaceId,
  onOpenTask,
  onRevealInBacklog,
}: {
  seed: SprintEngineEpicSeed
  tasks: ReadonlyArray<SprintEngineTask>
  /** Project root; null while the run's folder is unresolved. */
  folderPath: string | null
  workspaceId: string
  /** Show the delivering task on the Tasks tab. Null on a mount whose view is
   *  fixed (the affordance is then not offered rather than doing nothing). */
  onOpenTask: ((taskId: string) => void) | null
  /** Reveal an item that is not one of this epic's children — a prerequisite,
   *  or the epic itself — in the Backlog panel. */
  onRevealInBacklog: (relativePath: string) => void
}): JSX.Element {
  const backlog = useSprintEngineEpicBacklog({ seed, tasks, folderPath })
  const now = useRelativeNow()
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  // Why a cross-link went nowhere. Only ever set by the one path that can fail:
  // a jump to an item outside this epic with no workspace to reveal it in.
  const [notice, setNotice] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  // Picking a child moves focus to this list. That is what makes the tier real:
  // the list holds the one full-strength selection while every other pane —
  // including the door's rail, which lists sprints — drops to its resting fill
  // (assets/index.css, "Selection tiers"). A pointer click alone would leave two
  // selections at full strength.
  const selectChild = useCallback((key: string) => {
    setSelectedKey(key)
    setNotice(null)
    listRef.current?.focus()
  }, [])

  const model = backlog.model
  const rows = useMemo(() => model?.rows ?? [], [model])
  // Only real items are selectable; an unavailable file has no content to show.
  const optionRows = useMemo(
    () => rows.filter((row): row is Extract<SprintEngineEpicChildRow, { kind: 'item' }> => row.kind === 'item'),
    [rows],
  )
  const selectedRow = optionRows.find((row) => row.key === selectedKey) ?? null
  // Option ordinals for `aria-activedescendant`, resolved once per scan rather
  // than by scanning the list again for every row it renders.
  const optionIndexByKey = useMemo(
    () => new Map(optionRows.map((row, index) => [row.key, index])),
    [optionRows],
  )

  // Never auto-select: a scan landing (or a child leaving the epic) must not
  // silently swap what the aside is showing.
  useEffect(() => {
    if (selectedKey && !optionRows.some((row) => row.key === selectedKey)) setSelectedKey(null)
  }, [selectedKey, optionRows])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLUListElement>) => {
      if (optionRows.length === 0) return
      const index = selectedKey ? optionRows.findIndex((row) => row.key === selectedKey) : -1
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const next =
          index === -1
            ? event.key === 'ArrowDown'
              ? 0
              : optionRows.length - 1
            : (index + delta + optionRows.length) % optionRows.length
        selectChild(optionRows[next].key)
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        selectChild(optionRows[0].key)
        return
      }
      if (event.key === 'End') {
        event.preventDefault()
        selectChild(optionRows[optionRows.length - 1].key)
        return
      }
      if (event.key === 'Escape' && selectedKey) {
        event.preventDefault()
        setSelectedKey(null)
        setNotice(null)
      }
    },
    [optionRows, selectedKey, selectChild],
  )

  const epicTitle = model?.epic?.title ?? basename(seed.relativePath)
  const epicColor = backlog.feed.derived.epicMetaBySlug.get(seed.slug)?.color ?? null

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Epic">
        {/* Heading + completion, then the children indented beneath it. No rule
            between the two: space is what groups them. */}
        <header className="flex shrink-0 items-center gap-2.5 px-3 pb-2 pt-4">
          <h3 className="min-w-0 truncate text-heading font-semibold text-[color:var(--text-strong)]">
            {epicTitle}
          </h3>
          {model?.epic?.displayId ? (
            <span className="shrink-0 font-mono text-micro tabular-nums text-[color:var(--text-subtle)]">
              {model.epic.displayId}
            </span>
          ) : null}
          {model ? (
            <span className="ml-auto shrink-0">
              <EpicProgressMeter progress={model.progress} color={epicColor} />
            </span>
          ) : null}
        </header>

        {model?.epicUnavailableReason ? (
          <p className="shrink-0 px-3 pb-2 text-micro leading-4 text-[color:var(--tone-warn)]">
            {seed.relativePath} — {model.epicUnavailableReason}
          </p>
        ) : null}
        {backlog.error ? (
          <p role="status" className="shrink-0 px-3 pb-2 text-micro leading-4 text-[color:var(--tone-warn)]">
            {backlog.error}
          </p>
        ) : null}
        {backlog.actionError ? (
          <p role="status" className="shrink-0 px-3 pb-2 text-micro leading-4 text-[color:var(--tone-warn)]">
            {backlog.actionError}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="shrink-0 px-3 pb-2 text-micro leading-4 text-[color:var(--text-muted)]">
            {notice}
          </p>
        ) : null}

        {!model ? (
          <p className="px-3 py-6 text-meta text-[color:var(--text-muted)]">
            {folderPath ? 'Reading the backlog…' : 'This sprint’s project folder is not resolved yet.'}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-6 text-meta text-[color:var(--text-muted)]">This epic has no items.</p>
        ) : (
          <ul
            ref={listRef}
            role="listbox"
            aria-label={`${epicTitle} items`}
            // `auto`: this list carries the full-strength selection only while
            // it holds focus, and the door's own rail — a `primary` pane —
            // rests the moment it does. Two `primary` panes on one screen would
            // both stay lit, which is the rule this surface must not break.
            data-selection-pane="auto"
            tabIndex={0}
            onKeyDown={onKeyDown}
            aria-activedescendant={
              selectedKey ? `sprintengine-epic-opt-${optionIndexByKey.get(selectedKey)}` : undefined
            }
            // Fills the canvas rather than hugging its rows: the keyboard focus
            // ring then outlines the PANE, the way every other list in the
            // product draws it — a ring around the rows alone would read as the
            // card this surface must not have.
            className={`min-h-0 min-w-0 flex-1 overflow-auto pb-3 outline-none ${FOCUS_RING_INSET_CLASS}`}
          >
            {rows.map((row) =>
              row.kind === 'item' ? (
                <li
                  key={row.key}
                  id={`sprintengine-epic-opt-${optionIndexByKey.get(row.key)}`}
                  role="option"
                  aria-selected={row.key === selectedKey}
                  onClick={() => selectChild(row.key)}
                  // list-row: no border, radius, hover and selected fills. The
                  // left margin is the epic's containment — an indent, never a
                  // spine or a coloured bar.
                  className={`ml-6 mr-2 cursor-pointer rounded-md px-2.5 py-1.5 transition-colors ${
                    row.key === selectedKey
                      ? 'bg-[color:var(--bg-selected)]'
                      : 'hover:bg-[color:var(--bg-hover)]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <Tooltip
                        content={<BacklogRowHoverCard item={row.item} />}
                        placement="top"
                        openDelayMs={600}
                        wrapperClassName="block"
                        wrapperRole="presentation"
                      >
                        <BacklogRowContent
                          item={row.item}
                          now={now}
                          plainTitle
                          selected={row.key === selectedKey}
                        />
                      </Tooltip>
                    </div>
                    <SprintEngineEpicMappingCell
                      statusLabel={BACKLOG_STATUS_LABEL[row.item.status]}
                      mapping={row.mapping}
                    />
                  </div>
                </li>
              ) : (
                <li
                  key={row.key}
                  // Still an option of this list — the epic contains it — but
                  // there is no readable item behind it to open, so it is
                  // disabled rather than silently dropped.
                  role="option"
                  aria-selected={false}
                  aria-disabled
                  className="ml-6 mr-2 flex items-start gap-3 rounded-md px-2.5 py-1.5"
                >
                  {/* Same two-line anatomy as a readable row — leading mark,
                      then the identity and its supporting line — so a missing
                      file keeps the list's left edge instead of breaking it. */}
                  <span className="flex min-w-0 flex-1 items-start gap-2">
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      className="icon-sm mt-0.5 shrink-0 text-[color:var(--tone-warn)]"
                      role="img"
                      aria-label="Unavailable"
                    >
                      <path d="M8 2.75 14.5 13.5h-13z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                      <path d="M8 6.4v3.1M8 11.4h.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span
                        className="min-w-0 truncate font-mono text-meta text-[color:var(--text-default)]"
                        title={row.relativePath}
                      >
                        {row.relativePath}
                      </span>
                      <span className="text-micro leading-4 text-[color:var(--text-muted)]">{row.reason}</span>
                    </span>
                  </span>
                  <SprintEngineEpicMappingCell statusLabel="Unavailable" mapping={row.mapping} />
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      <SidePane as="aside" side="right" width="md" ariaLabel="Backlog item">
        {selectedRow ? (
          <BacklogItemDetailPane
            item={selectedRow.item}
            project={backlog.project}
            feed={backlog.feed}
            // Live run state belongs to the task, which the band below the title
            // names; this surface resolves no run glyph of its own.
            resolveRunGlyph={() => undefined}
            now={now}
            actions={backlog.actions}
            linkProviders={backlog.linkProviders}
            epicChoices={backlog.epicChoices}
            dependencyChoices={backlog.dependencyChoices}
            showBack={false}
            onBack={() => undefined}
            onNavigate={(itemId) => {
              const target = optionRows.find((row) => row.item.id === itemId)
              if (target) {
                selectChild(target.key)
                return
              }
              // Outside this epic (a prerequisite, or the epic itself): the
              // Backlog panel is where that item lives. With no workspace open
              // on this run there is nowhere to reveal it, and a dead click is
              // worse than saying so.
              const outside = backlog.feed.items.find((entry) => entry.item.id === itemId)
              if (!outside) return
              if (workspaceId) onRevealInBacklog(outside.item.relativePath)
              else setNotice(`${outside.item.title} is outside this epic, and this sprint’s workspace is closed — open it in the project’s Backlog.`)
            }}
            headerExtra={
              selectedRow.mapping ? (
                <SprintEngineEpicTaskBand mapping={selectedRow.mapping} onOpenTask={onOpenTask} />
              ) : undefined
            }
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-meta text-[color:var(--text-muted)]">
            Select an item to preview.
          </div>
        )}
      </SidePane>
    </div>
  )
}

// The mapping column: the task delivering this item and who is working it. A
// child with no task keeps the cell — empty — rather than losing the column, so
// the list still scans straight down (and an item added to the epic mid-sprint
// reads as un-mapped, not as an error).
function SprintEngineEpicMappingCell({
  statusLabel,
  mapping,
}: {
  statusLabel: string
  mapping: SprintEngineEpicMapping | null
}): JSX.Element {
  return (
    <span className="flex shrink-0 flex-col items-end gap-0.5 pt-0.5 text-micro">
      <span className="text-[color:var(--text-muted)]">{statusLabel}</span>
      <span className="font-mono tabular-nums text-[color:var(--text-subtle)]">
        {mapping ? `→ ${mapping.label}${mapping.agentId ? ` · ${mapping.agentId}` : ''}` : ''}
      </span>
    </span>
  )
}

// One band under the detail title: the task delivering this item. The item's
// intent, acceptance and mockups stay the detail pane's — this only says which
// task carries them and offers the jump to it.
function SprintEngineEpicTaskBand({
  mapping,
  onOpenTask,
}: {
  mapping: SprintEngineEpicMapping
  onOpenTask: ((taskId: string) => void) | null
}): JSX.Element {
  return (
    <div className="mt-3 flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate font-mono text-micro tabular-nums text-[color:var(--text-muted)]">
        {mapping.label}
        {mapping.agentId ? ` · ${mapping.agentId}` : ''}
      </span>
      {onOpenTask ? (
        <GhostButton size="xs" onClick={() => onOpenTask(mapping.taskId)}>
          Open task
        </GhostButton>
      ) : null}
    </div>
  )
}
