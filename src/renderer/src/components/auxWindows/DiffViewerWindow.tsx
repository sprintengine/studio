import React from 'react'
import { DiffViewer } from './DiffViewer'

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
}

export default function DiffViewerWindow({ repoRoot, focusPath, focusKind, changelistId = null, workspaceId }: Props) {
  return (
    <DiffViewer
      repoRoot={repoRoot}
      focusPath={focusPath}
      focusKind={focusKind}
      changelistId={changelistId}
      workspaceId={workspaceId}
      variant="window"
    />
  )
}
