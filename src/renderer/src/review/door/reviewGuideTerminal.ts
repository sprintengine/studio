import type { ReviewGuideTerminal, TerminalSessionSnapshot } from '../../../../shared/electron-api'

// Where a review's guide terminal is, from the renderer's side (MC-1783).
//
// The guide runs as an ordinary agent terminal under a per-review agent id, in
// the project's Reviews-host workspace (MC-1911). `reviewStartBriefRun` and
// `reviewAskGuide` both report its coordinates, but the run-status IPC does not:
// it answers "is a run open, and in what phase", which is deliberately
// transport-neutral. So a remount that seeds a live run from the registry has a
// phase and no handle — and still has to offer a working "open its terminal"
// link. These helpers close that gap by finding the guide among the live
// terminal sessions: the agent id is a pure function of the review id, and the
// session carries the workspace, session id, and CLI it was really spawned with.
//
// Deriving the workspace by matching folder paths (what this did before) cannot
// work now and was never quite honest: the session knows where it lives.

// Must match `reviewGuideAgentId` in src/main/review/guide-terminal-service.ts.
// The agent id — NOT the terminal session id, which is minted per spawn because
// a Claude-harness CLI is launched with `--session-id <it>` and rejects
// anything that is not a UUID.
const REVIEW_GUIDE_AGENT_ID_PREFIX = 'review-guide-'

export function reviewGuideAgentId(reviewId: string): string {
  return `${REVIEW_GUIDE_AGENT_ID_PREFIX}${reviewId}`
}

// True for any agent id the review guide owns. Used where a session has to be
// recognised as a guide without knowing which review it belongs to.
export function isReviewGuideAgentId(agentId: string): boolean {
  return agentId.startsWith(REVIEW_GUIDE_AGENT_ID_PREFIX)
}

export interface ResolvedGuideTerminal {
  workspaceId: string
  agentId: string
  // The terminal session to attach the tab to. Absent only on a handle reported
  // by a main process that predates per-spawn session ids.
  sessionId?: string
  // The CLI the guide runs under, when something has reported it. Absent when
  // neither the handle nor a live session names one; the agent record keeps
  // whatever CLI it was spawned with, and guessing one here would relabel a
  // running terminal.
  cli?: string
}

// Resolve the guide terminal for a review. The live session wins — it is the
// terminal that actually exists — and a handle reported by the main process
// fills in for a session snapshot that has not arrived yet. Null when neither
// names a terminal: there is nothing to focus, and the caller must withhold the
// link rather than open an empty tab.
export function resolveGuideTerminal({
  reviewId,
  guide,
  sessions,
}: {
  reviewId: string | null
  guide: ReviewGuideTerminal | null
  sessions: readonly TerminalSessionSnapshot[]
}): ResolvedGuideTerminal | null {
  const agentId = reviewId ? reviewGuideAgentId(reviewId) : guide?.agentId ?? null
  const session = agentId
    ? sessions.find((candidate) => candidate.kind === 'agent' && candidate.agentId === agentId)
    : undefined
  if (session) {
    return {
      workspaceId: session.workspaceId ?? guide?.workspaceId ?? '',
      agentId: session.agentId ?? agentId ?? '',
      sessionId: session.sessionId,
      ...(session.cli ?? guide?.cli ? { cli: session.cli ?? guide?.cli } : {}),
    }
  }
  if (!guide) return null
  return {
    workspaceId: guide.workspaceId,
    agentId: guide.agentId,
    ...(guide.sessionId ? { sessionId: guide.sessionId } : {}),
    ...(guide.cli ? { cli: guide.cli } : {}),
  }
}
