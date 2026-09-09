// The Changes list: a commit checklist composed from the kit (epic
// `git-commit-window`, T5; mockup 2522 panel 1).
//
// ONE TAB STOP. The list is the `listbox`, it carries `tabIndex=0`, it drives
// the cursor with `aria-activedescendant`, and it owns Space (tick) and Enter
// (open). Four hundred rows must not be four hundred tab stops, which is why
// `check-row`'s box is a drawing rather than an input and why the row is a
// `<div role="option">` rather than a button.
//
// TWO QUESTIONS, KEPT APART. The tick is a value the row carries — it IS the
// index — and the fill and edge are where the person is. Clicking the box ticks
// without picking (the box stops the click); clicking the row picks without
// ticking. Everything below follows from that one sentence.
//
// GROUPS, PLURAL. One "Changes" group ships today and T6 turns it into
// changelists, so this renders whatever `buildGitChangeGroups` hands it: the
// header, the region it folds, the cap notice. Nothing here knows there is
// currently one.

import React from 'react'

import { getGitStatusAppearance } from '../../../utils/gitStatusAppearance'
import {
  CheckRow,
  ContextMenu,
  FileTypeGlyph,
  GroupHeader,
  MenuDivider,
  MenuItem,
  FOCUS_RING_INSET_CLASS,
} from '../../ui'
import type { ChangeRowMenuEntry } from './changeRowMenu'
import { changeRowDomId, gitStatusWord, type GitChangeGroup, type GitChangeRow } from './gitChangesModel'

export type GitChangesListProps = {
  /** Prefix for the region and row ids. Unique per panel instance. */
  listId: string
  groups: GitChangeGroup[]
  /** The rows on screen, in visual order — the keyboard walk and the shift
   *  range. Computed by the panel (which also needs it for the marquee) rather
   *  than derived twice. */
  visibleRows: GitChangeRow[]
  expandedGroupIds: ReadonlySet<string>
  onExpandedChange: (groupId: string, next: boolean) => void
  selectedPaths: ReadonlySet<string>
  cursorPath: string | null
  /** Tick or untick one row. The panel decides which way from the row's state. */
  onToggleRow: (row: GitChangeRow) => void
  /** Tick or untick a whole group. */
  onToggleGroup: (group: GitChangeGroup, next: boolean) => void
  /** A pointer gesture on the row body. Returns true when the gesture was
   *  consumed as SELECTION (marquee, shift-range, cmd-toggle) and must not also
   *  open the diff. */
  onRowClick: (row: GitChangeRow, event: React.MouseEvent) => boolean
  /** Enter, or a plain click on the row body. */
  onActivateRow: (row: GitChangeRow) => void
  /** Move the keyboard cursor, replacing or extending the selection with it. */
  onMoveCursor: (path: string, mode: 'replace' | 'extend') => void
  onSelectAll: () => void
  /** A right-click makes the row the selection when it was outside it, so the
   *  menu's labels describe exactly what the actions will touch. */
  onContextSelect: (row: GitChangeRow) => void
  buildMenu: (row: GitChangeRow) => ChangeRowMenuEntry[]
  registerRowNode: (path: string, node: HTMLElement | null) => void
}

type RowMenuState = { x: number; y: number; row: GitChangeRow }

export function GitChangesList({
  listId,
  groups,
  visibleRows,
  expandedGroupIds,
  onExpandedChange,
  selectedPaths,
  cursorPath,
  onToggleRow,
  onToggleGroup,
  onRowClick,
  onActivateRow,
  onMoveCursor,
  onSelectAll,
  onContextSelect,
  buildMenu,
  registerRowNode,
}: GitChangesListProps): JSX.Element {
  const [rowMenu, setRowMenu] = React.useState<RowMenuState | null>(null)
  // Which fill a picked row takes: the accent edge belongs to the pane the
  // person is driving, and exactly one edge may be on screen at a time.
  const [listFocused, setListFocused] = React.useState(false)
  const listRef = React.useRef<HTMLDivElement | null>(null)

  const cursorIndex = cursorPath ? visibleRows.findIndex((row) => row.path === cursorPath) : -1

  function moveTo(index: number, extend: boolean): void {
    const row = visibleRows[Math.min(Math.max(index, 0), visibleRows.length - 1)]
    if (!row) return
    onMoveCursor(row.path, extend ? 'extend' : 'replace')
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    // Only when focus is on the list itself. The group headers' chevron and
    // checkbox are real controls inside this subtree and own their own keys.
    if (event.target !== event.currentTarget) return
    if (visibleRows.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveTo(cursorIndex < 0 ? 0 : cursorIndex + 1, event.shiftKey)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveTo(cursorIndex < 0 ? visibleRows.length - 1 : cursorIndex - 1, event.shiftKey)
    } else if (event.key === 'Home') {
      event.preventDefault()
      moveTo(0, event.shiftKey)
    } else if (event.key === 'End') {
      event.preventDefault()
      moveTo(visibleRows.length - 1, event.shiftKey)
    } else if (event.key === 'a' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      onSelectAll()
    } else if (event.key === ' ') {
      // Space ticks, and only ticks. The list owns this key because the box is
      // a drawing — there is nothing else for the keyboard to press.
      event.preventDefault()
      const row = visibleRows[cursorIndex]
      if (row) onToggleRow(row)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const row = visibleRows[cursorIndex]
      if (row) onActivateRow(row)
    }
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-multiselectable="true"
      aria-label="Changed files"
      aria-activedescendant={cursorPath ? changeRowDomId(listId, cursorPath) : undefined}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        // The rows are not focusable — the LIST is the tab stop — so a click on
        // a row has to hand focus to the list, or the arrow keys do nothing
        // until the person has tabbed to it. A group header owns its own
        // controls and keeps their focus.
        if (event.target instanceof Element && event.target.closest('[data-git-group-header="true"]')) return
        listRef.current?.focus()
      }}
      onFocus={() => setListFocused(true)}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setListFocused(false)
      }}
      className={`rounded-xs ${FOCUS_RING_INSET_CLASS}`}
    >
      {groups.map((group) => {
        const regionId = `${listId}-${group.id}-rows`
        const expanded = expandedGroupIds.has(group.id)
        return (
          <div key={group.id} role="group" aria-label={group.title}>
            {/* The band is not an `option`; the marquee reads this attribute so
                a drag started on a header does not clear the selection. */}
            <div data-git-group-header="true">
              <GroupHeader
                title={group.title}
                count={group.totalCount === 1 ? '1 file' : `${group.totalCount} files`}
                expanded={expanded}
                onExpandedChange={(next) => onExpandedChange(group.id, next)}
                controls={regionId}
                checked={group.checked ?? undefined}
                // Handed over even while a command is in flight: the panel's
                // `runAction` already refuses a second one, and withholding the
                // handler here would make the box a dead area that the row
                // underneath answers for.
                onCheckedChange={
                  group.checked === null ? undefined : (next) => onToggleGroup(group, next)
                }
                checkLabel={`Stage every file in ${group.title}`}
              />
            </div>
            {/* Hidden, never unmounted: `aria-controls` above has to resolve. */}
            <div id={regionId} hidden={!expanded}>
              {group.rows.map((row) => {
                const appearance = getGitStatusAppearance(row.status)
                const statusWord = gitStatusWord(row.status)
                const isSelected = selectedPaths.has(row.path)
                return (
                  <CheckRow
                    key={row.path}
                    id={changeRowDomId(listId, row.path)}
                    ref={(node) => registerRowNode(row.path, node)}
                    data-git-change-row="true"
                    role="option"
                    checked={row.checked}
                    // Always present. `check-row` only swallows the click when
                    // it has a handler to run, so a box that dropped its
                    // handler while busy would let the click through to the row
                    // and OPEN THE DIFF — a tick that shows a diff instead.
                    onCheckedChange={() => onToggleRow(row)}
                    glyph={<FileTypeGlyph name={row.filename} tone="kind" className="icon-sm" />}
                    name={
                      // The status tint travels with the name, and the word
                      // travels with it: T5 dropped the trailing status letter,
                      // so this clause is the only non-colour carrier left and
                      // colour alone is not an accessible signal.
                      <span className={appearance.textClass}>
                        {row.filename}
                        {statusWord ? <span className="sr-only">, {statusWord}</span> : null}
                      </span>
                    }
                    directory={row.directory || undefined}
                    selected={isSelected && listFocused}
                    resting={isSelected && !listFocused}
                    cursor={cursorPath === row.path}
                    onClick={(event) => {
                      if (onRowClick(row, event)) return
                      onActivateRow(row)
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      onContextSelect(row)
                      // A keyboard-summoned menu (Shift+F10, the Menu key)
                      // carries no pointer; open it on the row rather than at
                      // the viewport corner.
                      const rect = event.currentTarget.getBoundingClientRect()
                      setRowMenu({ x: event.clientX || rect.left, y: event.clientY || rect.bottom, row })
                    }}
                  />
                )
              })}
              {group.omittedCount > 0 ? (
                <div className="mx-2 mt-1 rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-2 py-1.5 text-micro text-[color:var(--text-subtle)]">
                  {group.omittedCount} more changes are hidden to keep the panel responsive. The group’s
                  checkbox still stages or unstages every one of them.
                </div>
              ) : null}
            </div>
          </div>
        )
      })}
      {rowMenu ? (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          ariaLabel={`Actions for ${rowMenu.row.relativePath}`}
          onClose={() => setRowMenu(null)}
          surfaceClassName="min-w-[240px]"
        >
          {buildMenu(rowMenu.row).map((entry) =>
            entry.kind === 'divider' ? (
              <MenuDivider key={entry.id} />
            ) : (
              <MenuItem
                key={entry.id}
                icon={entry.icon}
                shortcut={entry.shortcut}
                variant={entry.danger ? 'danger' : undefined}
                disabled={entry.disabled}
                onClick={() => {
                  setRowMenu(null)
                  entry.onSelect()
                }}
              >
                {entry.label}
              </MenuItem>
            ),
          )}
        </ContextMenu>
      ) : null}
    </div>
  )
}
