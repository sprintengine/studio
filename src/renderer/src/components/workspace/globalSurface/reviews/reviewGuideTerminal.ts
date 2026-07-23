import type { ReviewGuideTerminal } from '../../../../../../shared/electron-api'

// Where a review's guide terminal is, from the renderer's side (MC-1783).
//
// The guide runs as an ordinary agent terminal in the project workspace the
// review belongs to, under a per-review agent id. `reviewStartBriefRun` and
// `reviewAskGuide` both report those coordinates, but the run-status IPC does
// not: it answers "is a run open, and in what phase", which is deliberately
// transport-neutral. So a remount that seeds a live run from the registry has a
// phase and no handle — and still has to offer a working "open its terminal"
// link. These helpers close that gap by deriving the same coordinates the main
// process would: the agent id is a pure function of the review id, and the
// workspace is the one opened on the review's project root.

// Must match `reviewGuideAgentId` in src/main/review/guide-terminal-service.ts:
// the terminal session id equals the agent id, which is what lets a tab reattach
// to a guide this window never started.
const REVIEW_GUIDE_AGENT_ID_PREFIX = 'review-guide-'

export function reviewGuideAgentId(reviewId: string): string {
  return `${REVIEW_GUIDE_AGENT_ID_PREFIX}${reviewId}`
}

// True for any agent id the review guide owns. Used where a session has to be
// recognised as a guide without knowing which review it belongs to.
export function isReviewGuideAgentId(agentId: string): boolean {
  return agentId.startsWith(REVIEW_GUIDE_AGENT_ID_PREFIX)
}

// The minimum a workspace row has to expose to be matched by project root. Keeps
// this module free of the store's Workspace type (and its import graph).
export interface GuideProjectWorkspace {
  id: string
  folderPath?: string | null
}

export interface ResolvedGuideTerminal {
  workspaceId: string
  agentId: string
  // The CLI the guide runs under, when something has reported it. Absent on a
  // derived handle: the agent record keeps whatever CLI it was spawned with, and
  // guessing one here would relabel a running terminal.
  cli?: string
}

// Resolve the guide terminal for a review. A handle reported by the main process
// wins; otherwise the coordinates are derived from the review id plus the open
// workspace whose folder IS the review's project root. Null when that project is
// not open in this window — there is no terminal to focus, and the caller must
// withhold the link rather than open an empty tab.
export function resolveGuideTerminal({
  reviewId,
  workspaceRoot,
  guide,
  workspaces,
}: {
  reviewId: string | null
  workspaceRoot: string | null
  guide: ReviewGuideTerminal | null
  workspaces: GuideProjectWorkspace[]
}): ResolvedGuideTerminal | null {
  if (guide) return { workspaceId: guide.workspaceId, agentId: guide.agentId, cli: guide.cli }
  if (!reviewId || !workspaceRoot) return null
  const workspace = workspaces.find((candidate) => normalizeRoot(candidate.folderPath) === normalizeRoot(workspaceRoot))
  if (!workspace) return null
  return { workspaceId: workspace.id, agentId: reviewGuideAgentId(reviewId) }
}

// Path comparison for roots that came from two places (a workspace row the user
// picked, a review record written earlier). Only a trailing separator differs in
// practice; case and separator style are left alone so two genuinely different
// folders never collapse into one.
function normalizeRoot(path: string | null | undefined): string {
  if (!path) return ''
  return path.replace(/[\\/]+$/u, '')
}
