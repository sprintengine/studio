import React from 'react'
import { DiffViewer } from './DiffViewer'

// The standalone diff window (the IDE idiom): the viewer with its own title
// bar, opened by "Open in separate window" from the pane's Diff tab. The
// viewer itself lives in DiffViewer.tsx so the workspace pane hosts the same
// component (browser-pane epic).

type Props = {
  repoRoot: string
  focusPath: string | null
  focusKind: 'staged' | 'unstaged' | null
}

export default function DiffViewerWindow({ repoRoot, focusPath, focusKind }: Props) {
  return <DiffViewer repoRoot={repoRoot} focusPath={focusPath} focusKind={focusKind} variant="window" />
}
