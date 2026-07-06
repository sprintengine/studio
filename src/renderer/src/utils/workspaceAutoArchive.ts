import type { Workspace } from '../types/workspace'
import { deriveSprintEngineRunGlyph } from './sprintengine'
import { isSprintEngineWorkspace } from './sprintEnginesNav'
import { isStarred } from './highlight'
import { workspaceLastWorkedAt } from './workspaceRecency'
import { AUTOMATIONS_HOST_WORKSPACE_MODE } from '../types/workspace'
import type { LifecycleState } from '../components/ui/LifecycleGlyph'

// A workspace auto-archives once it has gone this long without being worked on
// (created or typed into). Archiving is presentation-level tidiness — the
// workspace stays on disk and in the store, findable in search, restorable
// from the Sprints panel's Archived lens, and revived automatically by typing
// into one of its terminals again.
export const WORKSPACE_AUTO_ARCHIVE_AFTER_MS = 5 * 24 * 60 * 60 * 1000 // 5 days

// Run states that must never auto-archive, no matter how old: anything still
// in flight or waiting on the user, including a finished branch that has not
// merged yet.
const PINNED_RUN_STATES: ReadonlySet<LifecycleState> = new Set([
  'in_progress',
  'needs_input',
  'paused',
  'failed',
  'changes_requested',
  'done_unmerged',
])

// Pure rule for the startup sweep. Deliberately conservative: starred rows,
// pending-work sprints, and the background Automations host never archive;
// the caller additionally excludes every window's active workspace.
export function shouldAutoArchiveWorkspace(workspace: Workspace, now: number): boolean {
  if (typeof workspace.archivedAt === 'number') return false
  if (isStarred(workspace.highlight)) return false
  if (workspace.mode === AUTOMATIONS_HOST_WORKSPACE_MODE) return false
  if (now - workspaceLastWorkedAt(workspace) < WORKSPACE_AUTO_ARCHIVE_AFTER_MS) return false
  if (isSprintEngineWorkspace(workspace)) {
    const glyph = deriveSprintEngineRunGlyph({
      sprintEngineState: workspace.sprintEngineState,
      autoState: workspace.sprintEngineAutoState,
    })
    if (glyph && PINNED_RUN_STATES.has(glyph.state)) return false
  }
  return true
}
