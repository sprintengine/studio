import React, { useEffect, useState } from 'react'

import { DiffViewer } from '../../auxWindows/DiffViewer'
import { EmptyState } from '../../ui/EmptyState'
import {
  consumePendingDiffPopoutTarget,
  subscribeDiffPopoutTarget,
  type DiffPopoutTarget,
} from './diffPopoutTarget'

// The Diff popout: the pane's Diff tab, floated at workbench width (the
// pane-to-popup mechanism, 2026-09-05). A diff is two columns of code, and the
// pane column beside a chat is too narrow to read one in; the popout is the
// same viewer in the same window with room to read. It is the shell's core
// `diff` modal surface (WorkspaceManager mounts it like Settings — it belongs
// to the app, not to a module), so it gets the workbench Modal, the frame's
// title bar with its one X, Escape, and focus back to the strip button that
// opened it, all for free.
//
// The viewer is the pane variant, branch steps included, so what the popout
// shows is exactly what the tab showed — one file further along, at most. Its
// own band keeps "Open in separate window" for the person who wants the diff
// beside the app rather than over it.
//
// The target arrives through the latch (diffPopoutTarget.ts): drained on
// mount, and re-read live so a second "Open in a popup" retargets this one.
export default function DiffPopoutSurface(): JSX.Element {
  const [target, setTarget] = useState<DiffPopoutTarget | null>(() => consumePendingDiffPopoutTarget())
  useEffect(
    () =>
      subscribeDiffPopoutTarget((next) => {
        consumePendingDiffPopoutTarget()
        setTarget(next)
      }),
    [],
  )
  if (!target) {
    // Opened with nothing latched — a stale deep-link, or a programmatic open
    // with no workspace to read. Not an error: there is simply nothing to show.
    return <EmptyState density="pane" title="No diff to show" />
  }
  return (
    <DiffViewer
      // Keyed on the repo only: a retarget within the same repository walks
      // the mounted viewer through its focus props rather than remounting
      // Monaco under the diff widget (the pane's own rule).
      key={target.repoRoot}
      repoRoot={target.repoRoot}
      focusPath={target.focusPath}
      focusKind={target.focusKind}
      variant="pane"
      branchSteps
    />
  )
}
