import React from 'react'
import { DiffViewer } from './DiffViewer'
import type { EditorRange } from '../../../../shared/editor-reveal'

// The standalone diff window: the viewer with its own title
// bar, opened by "Open in separate window" from the pane's Diff tab. The
// viewer itself lives in DiffViewer.tsx so the workspace pane hosts the same
// component (browser-pane epic).

type Props = {
  repoRoot: string
  focusPath: string | null
  focusKind: 'staged' | 'unstaged' | null
  /** Show only one changelist's files; null is all changes. */
  changelistId?: string | null
  /** The workspace this diff was opened from: where "Show in the app" hands it back. */
  workspaceId: string | null
  /** An agent's reveal (editor.open_diff); absent for a person's own diff. */
  pathsFilter?: string[] | null
  focusRange?: EditorRange | null
  focusSide?: 'modified' | 'original'
  revealKey?: string | null
}

export default function DiffViewerWindow({
  repoRoot,
  focusPath,
  focusKind,
  changelistId = null,
  workspaceId,
  pathsFilter = null,
  focusRange = null,
  focusSide = 'modified',
  revealKey = null,
}: Props) {
  return (
    <DiffViewer
      repoRoot={repoRoot}
      focusPath={focusPath}
      focusKind={focusKind}
      changelistId={changelistId}
      workspaceId={workspaceId}
      variant="window"
      pathsFilter={pathsFilter}
      focusRange={focusRange}
      focusSide={focusSide}
      revealKey={revealKey}
    />
  )
}
