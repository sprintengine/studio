// The one Backlog item detail pane every full-page surface mounts (MC-1836 /
// MC-1917). It renders the WORKSPACE panel's `BacklogDetail` — one detail
// implementation, so an epic's crumb, linked-children roll-up, triage, mockups and
// body can never drift between the aside, the Backlog door and the Horizon door.
//
// This adapter maps a per-project feed (`useAllProjectsBacklog`) onto the panel's
// props and degrades the workspace-only inputs explicitly:
//   • scan/loading — an item is always selected here, so the panel's pre-scan
//     early returns are unreachable (scan: null, loading: false).
//   • agent send — no per-workspace agent roster at a door; the flyout shows its
//     own "No running agents" state.
//   • external actions — workspace-launch actions stay on the panel for now.
//   • mockup preview — hosted here (the panel lifts it to its parent the same
//     way); pop-out needs a workspace editor tab, so a door's preview keeps its
//     own back/close-only chrome.
//
// It lives beside the other backlog components rather than inside one door, so a
// second door mounting it is an import, not a copy.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { BacklogDetail } from '../panels/BacklogPanel'
import { FilePreviewPane } from '../ui/FilePreviewPane'
import { HtmlArtifactFrame } from '../workspace/guidedBrief/MockupPreviewPane'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { deriveBacklogDependencies } from '../../utils/backlogDependencies'
import { resolveFirstMockupCandidate } from '../../utils/backlogMockups'
import { epicSlug } from '../../utils/backlogEpics'
import { basename, joinFilePath, parentPath } from '../../utils/paths'
import type { BacklogItem } from '../../utils/backlog'
import type { BacklogLinkProvider } from '../../modules/renderer-host'
import type { BacklogRunGlyph } from './BacklogRow'
import type { BacklogActions, BacklogDependencyChoice, BacklogEpicChoice } from './BacklogItemContextMenu'
import type {
  BacklogProjectFeed,
  BacklogProjectRef,
} from '../../hooks/useAllProjectsBacklog'

// The door renders the WORKSPACE panel's BacklogDetail (MC-1836) — one detail
// implementation, so an epic's crumb, linked-children roll-up, triage, and body
// can never drift between the aside and the door. This adapter maps the door's
// per-project feed onto the panel's props and degrades the workspace-only
// inputs explicitly:
//   • scan/loading — an item is always selected here, so the panel's pre-scan
//     early returns are unreachable (scan: null, loading: false).
//   • agent send — no per-workspace agent roster at the door; the flyout shows
//     its own "No running agents" state.
//   • external actions — workspace-launch actions stay on the panel for now.
//   • mockup preview — hosted here (the panel lifts it to its parent the same
//     way); pop-out needs a workspace editor tab, so the door's preview keeps
//     its own back/close-only chrome.
export function BacklogItemDetailPane({
  item,
  project,
  feed,
  runGlyph,
  resolveRunGlyph,
  now,
  actions,
  linkProviders,
  epicChoices,
  dependencyChoices,
  showBack,
  onBack,
  onNavigate,
  headerExtra,
  headerAction,
}: {
  item: BacklogItem
  project: BacklogProjectRef
  feed: BacklogProjectFeed
  runGlyph?: BacklogRunGlyph
  /** This project's live run glyph for an item, or undefined. A resolver rather
   *  than a map so the pane never has to know a host's row-key scheme. */
  resolveRunGlyph: (item: BacklogItem) => BacklogRunGlyph | undefined
  now: number
  actions: BacklogActions
  linkProviders: ReadonlyArray<BacklogLinkProvider>
  epicChoices: BacklogEpicChoice[]
  dependencyChoices: BacklogDependencyChoice[]
  showBack: boolean
  onBack: () => void
  onNavigate: (itemId: string) => void
  /** A host band rendered directly under the title — the Horizon door's run
   *  strip (MC-1923). Omitted by the Backlog door, which has no run to show. */
  headerExtra?: React.ReactNode
  /** A host's one loud action on the title row — the Horizon door's
   *  "Start sprint". Omitted by the Backlog door. */
  headerAction?: React.ReactNode
}): JSX.Element {
  // Inline mockup preview: clicking an attached/detected mockup swaps this pane
  // for the rendered file (the panel's behaviour). Resolution re-runs across BOTH
  // tolerated roots from the authored ref, and a missing/unreadable file leaves
  // the preview closed rather than opening an empty frame.
  const [previewedMockup, setPreviewedMockup] = useState<{
    relativePath: string
    absolutePath: string
    content: string
  } | null>(null)
  useEffect(() => setPreviewedMockup(null), [item.id, project.rootKey])

  const openMockup = useCallback(
    (target: { path: string }) => {
      void (async () => {
        const found = await resolveFirstMockupCandidate(target.path, async (relativePath) => {
          const absolutePath = joinFilePath(project.root, relativePath)
          if (!(await window.api.pathExists(absolutePath))) return null
          return { relativePath, absolutePath, content: await window.api.readfile(absolutePath) }
        })
        if (found) setPreviewedMockup(found)
      })()
    },
    [project.root],
  )

  // This project's items and derivations, in the shapes the panel reads. The
  // dependency node comes from the item's OWN project — a prerequisite never
  // crosses a project boundary.
  const projectItems = useMemo(() => feed.items.map((entry) => entry.item), [feed])
  const dependencyNode = useMemo(() => {
    if (item.isEpic) return null
    const graph = deriveBacklogDependencies(projectItems)
    return graph.nodes.find((candidate) => candidate.item.id === item.id) ?? null
  }, [projectItems, item])
  const runGlyphById = useMemo(() => {
    const map = new Map<string, BacklogRunGlyph>()
    for (const entry of feed.items) {
      const glyph = resolveRunGlyph(entry.item)
      if (glyph) map.set(entry.item.id, glyph)
    }
    return map
  }, [feed, resolveRunGlyph])

  // A workspace already open on this project, for the link providers that
  // resolve a linked run's live state. The empty-string sentinel degrades the
  // workspace-only lookups instead of hiding the whole Links section.
  const workspaceId = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.folderPath === project.root)?.id ?? null,
  )

  // Every hook above runs unconditionally — this early return must stay BELOW
  // them so the preview opening/closing never changes the hook order.
  if (previewedMockup) {
    const isHtml = /\.html?$/i.test(previewedMockup.relativePath)
    return (
      <FilePreviewPane
        title={basename(previewedMockup.relativePath)}
        path={previewedMockup.absolutePath}
        content={previewedMockup.content}
        onBack={() => setPreviewedMockup(null)}
        onClose={() => setPreviewedMockup(null)}
        body={
          isHtml ? (
            <HtmlArtifactFrame
              absolutePath={previewedMockup.absolutePath}
              relativePath={previewedMockup.relativePath}
              watchDirectoryPath={parentPath(previewedMockup.absolutePath)}
              enableSourceView
            />
          ) : undefined
        }
      />
    )
  }

  return (
    <BacklogDetail
      scan={null}
      loading={false}
      folderPath={project.root}
      selected={item}
      selectedRunGlyph={runGlyph}
      runGlyphById={runGlyphById}
      now={now}
      hasItems
      externalActions={[]}
      workspaceId={workspaceId ?? ''}
      linkProviders={linkProviders}
      showBack={showBack}
      onBack={onBack}
      actions={actions}
      epicChoices={epicChoices}
      items={projectItems}
      epicMetaBySlug={feed.derived.epicMetaBySlug}
      dependencyNode={dependencyNode}
      dependencyState={feed.derived.dependencyStateById.get(item.id) ?? null}
      dependencyStateById={feed.derived.dependencyStateById}
      epicBlockedRollup={item.isEpic ? feed.derived.epicBlockedBySlug.get(epicSlug(item)) : undefined}
      dependencyChoices={dependencyChoices}
      onNavigate={onNavigate}
      agentTargets={[]}
      agentSessions={null}
      onAgentFlyoutOpen={() => {}}
      onSendToAgent={() => {}}
      previewedMockup={null}
      onOpenMockup={openMockup}
      onCloseMockupPreview={() => {}}
      onPopOutMockup={() => {}}
      headerExtra={headerExtra}
      headerAction={headerAction}
    />
  )
}

