import { useState } from 'react'

import type { DiffView } from '../../../../shared/review'
import { ReviewWalkthrough } from './ReviewWalkthrough'
import { reviewFixture } from './fixtures'
import { resolveActivePaneId } from './reviewSelectors'

// Zero-IPC harness: mounts the full walkthrough against the stored fixture triple
// with local (in-memory) reviewer state. It is the deterministic regression net
// for the surface — the render test drives it with no store and no window.api,
// and it doubles as a hand-inspectable route for the walkthrough in isolation.
export function ReviewWalkthroughHarness({ monacoTheme = 'vs-dark' as const }: { monacoTheme?: 'vs' | 'vs-dark' }) {
  const { changeset, brief } = reviewFixture
  const [readFiles, setReadFiles] = useState<Set<string>>(new Set(reviewFixture.state.readFiles))
  const [diffView, setDiffView] = useState<DiffView>(reviewFixture.state.diffView)
  const [activePaneId, setActivePaneId] = useState<string>(resolveActivePaneId(brief, reviewFixture.state))

  return (
    <ReviewWalkthrough
      changeset={changeset}
      brief={brief}
      readFiles={readFiles}
      diffView={diffView}
      activePaneId={activePaneId}
      monacoTheme={monacoTheme}
      rerunning={false}
      onSetActivePane={setActivePaneId}
      onSetDiffView={setDiffView}
      onToggleRead={(path) =>
        setReadFiles((prev) => {
          const next = new Set(prev)
          if (next.has(path)) next.delete(path)
          else next.add(path)
          return next
        })
      }
      onRequestComment={() => {}}
      onAskGuide={() => {}}
      onRerun={() => {}}
    />
  )
}

export default ReviewWalkthroughHarness
