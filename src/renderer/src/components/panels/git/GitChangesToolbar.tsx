// The Commit window's glyph band, under the panel's view strip (epic
// `git-commit-window`, T5; mockup 2522 panel 1).
//
// Nine controls are grouped by what they act on: six that act on the files
// — refresh, discard, move to changelist, stash, write the message, show the
// diff — then the kit's one vertical divider, then three that act on the VIEW:
// group by, expand all, collapse all. The divider is the only thing in a band
// of identical 26px squares that can say which three are which.
//
// Glyph-only, and every word rides the tooltip and the accessible name: the
// band has to fit nine controls in a 340px pane, and a labelled button ramp
// would fit four. Two of the nine are disabled and stay in the band anyway —
// "which actions exist" is information, and a control that appears when a
// feature lands moves everything beside it (`Toolbar` keeps a disabled item's
// place but takes it out of the arrow walk).

import React from 'react'

import {
  CollapseAllGlyph,
  ContextMenu,
  ExpandAllGlyph,
  GroupByGlyph,
  MenuItem,
  MoveToChangelistGlyph,
  NextDifferenceGlyph,
  RefreshIcon,
  RollbackGlyph,
  StashGlyph,
  Toolbar,
  ToolbarButton,
  ToolbarDivider,
  Tooltip,
  WriteCommitMessageGlyph,
} from '../../ui'

/** Where a "show diff" request should land. `default` honours the sticky
 *  preference T3 introduced; the other two are the explicit overrides the menu
 *  corner exists for. */
export type ShowDiffPlacement = 'default' | 'app' | 'window'

export type GitChangesToolbarProps = {
  busy: boolean
  /** No file is picked: discard and show-diff have nothing to act on. */
  hasTarget: boolean
  onRefresh: () => void
  onDiscard: () => void
  onStash: () => void
  onShowDiff: (placement: ShowDiffPlacement) => void
  onExpandAll: () => void
  onCollapseAll: () => void
}

export function GitChangesToolbar({
  busy,
  hasTarget,
  onRefresh,
  onDiscard,
  onStash,
  onShowDiff,
  onExpandAll,
  onCollapseAll,
}: GitChangesToolbarProps): JSX.Element {
  const [diffMenu, setDiffMenu] = React.useState<{ x: number; y: number } | null>(null)

  return (
    // Borderless: the view strip above already draws a hairline, and two rules
    // 30px apart is a ladder rather than a structure.
    <Toolbar ariaLabel="Changed files" borderless className="shrink-0">
      <Tooltip content="Refresh the working tree" placement="bottom">
        <ToolbarButton ariaLabel="Refresh the working tree" disabled={busy} onClick={onRefresh}>
          <RefreshIcon />
        </ToolbarButton>
      </Tooltip>
      <Tooltip content="Discard changes in the selected files" placement="bottom">
        <ToolbarButton
          ariaLabel="Discard changes in the selected files"
          disabled={busy || !hasTarget}
          onClick={onDiscard}
        >
          <RollbackGlyph />
        </ToolbarButton>
      </Tooltip>
      {/* T6 (changelists) is what makes this a destination. Present and
          disabled, with the tooltip saying why rather than a dead click. */}
      <Tooltip content="Move to another changelist — arrives with changelists" placement="bottom">
        <ToolbarButton ariaLabel="Move to another changelist" disabled>
          <MoveToChangelistGlyph />
        </ToolbarButton>
      </Tooltip>
      <Tooltip content="Stash changes…" placement="bottom">
        <ToolbarButton ariaLabel="Stash changes" disabled={busy} onClick={onStash}>
          <StashGlyph />
        </ToolbarButton>
      </Tooltip>
      <Tooltip content="Write commit message — coming with the composer" placement="bottom">
        <ToolbarButton ariaLabel="Write commit message" disabled>
          <WriteCommitMessageGlyph />
        </ToolbarButton>
      </Tooltip>
      <Tooltip content="Show diff" placement="bottom">
        <ToolbarButton
          ariaLabel="Show diff"
          menu
          expanded={Boolean(diffMenu)}
          disabled={!hasTarget}
          onClick={(event) => {
            // The corner mark says this opens a menu, so it opens a menu — the
            // plain "Show diff" is its first item rather than a click that does
            // one thing and a corner that does three.
            const rect = event.currentTarget.getBoundingClientRect()
            setDiffMenu({ x: rect.left, y: rect.bottom })
          }}
        >
          <NextDifferenceGlyph />
        </ToolbarButton>
      </Tooltip>
      <ToolbarDivider />
      <Tooltip content="Group by — arrives with changelists" placement="bottom">
        <ToolbarButton ariaLabel="Group by" disabled>
          <GroupByGlyph />
        </ToolbarButton>
      </Tooltip>
      <Tooltip content="Expand all groups" placement="bottom">
        <ToolbarButton ariaLabel="Expand all groups" onClick={onExpandAll}>
          <ExpandAllGlyph />
        </ToolbarButton>
      </Tooltip>
      <Tooltip content="Collapse all groups" placement="bottom">
        <ToolbarButton ariaLabel="Collapse all groups" onClick={onCollapseAll}>
          <CollapseAllGlyph />
        </ToolbarButton>
      </Tooltip>
      {diffMenu ? (
        <ContextMenu
          x={diffMenu.x}
          y={diffMenu.y}
          ariaLabel="Show diff"
          onClose={() => setDiffMenu(null)}
          surfaceClassName="min-w-[200px]"
        >
          <MenuItem
            onClick={() => {
              setDiffMenu(null)
              onShowDiff('default')
            }}
          >
            Show diff
          </MenuItem>
          <MenuItem
            onClick={() => {
              setDiffMenu(null)
              onShowDiff('app')
            }}
          >
            Show diff in the app
          </MenuItem>
          <MenuItem
            onClick={() => {
              setDiffMenu(null)
              onShowDiff('window')
            }}
          >
            Show diff in a window
          </MenuItem>
        </ContextMenu>
      ) : null}
    </Toolbar>
  )
}
