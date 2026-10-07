import type { WorkspaceRegistryActor, WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import type { WorkspaceFieldsPatch, WorkspaceSyncCommandResult, WorkspaceSyncEvent } from '../../shared/workspace-sync'
import { isSettledWorkspace, settleWorkspacePatch, wakeWorkspacePatch } from '../../shared/workspace-lifecycle'

// A chat's rest and its two person-clocks, written for a paired device.
//
// The desktop is the one owner of whether a chat is resting, of when a person
// last wrote to it and of when one last looked at it: a phone or a second
// desktop asks, and the answer is written to the same registry record, with
// the same patches, that the desktop's own sidebar writes. Its windows learn
// the change from main's broadcast like any other, and the window showing a
// chat that was settled from elsewhere carries out the rest of a Settle there
// (WorkspaceSidebar's `settledElsewhere`).

export type ConversationLifecycleDeps = {
  getRecord(workspaceId: string): WorkspaceRegistryRecord | null
  updateWorkspaceFields(
    workspaceId: string,
    patch: WorkspaceFieldsPatch,
    actor: WorkspaceRegistryActor,
  ): WorkspaceSyncCommandResult
  /**
   * Whether an agent in the workspace's chats is working. Settling ends the
   * chat's agent processes, and the work with them, so it waits, as the row
   * menu's Settle does.
   */
  isWorking(workspaceId: string): boolean
  /**
   * When a chat in the workspace last finished a turn, by the chats main
   * holds now; undefined when none has. The record's own `lastTurnEndedAt`
   * (its terminal agents') is read beside it.
   */
  latestChatTurnEnd?(workspaceId: string): number | undefined
  now?: () => number
}

export type ConversationLifecycleFailure = {
  ok: false
  code: 'unknown_workspace' | 'working' | 'write_failed' | 'nothing_finished'
  message: string
}

export type ConversationSettleResult =
  { ok: true; workspaceId: string; settledAt: number | null } | ConversationLifecycleFailure
export type ConversationVisitResult =
  { ok: true; workspaceId: string; lastVisitedAt: number } | ConversationLifecycleFailure
export type ConversationMarkUnreadResult =
  { ok: true; workspaceId: string; lastVisitedAt: number } | ConversationLifecycleFailure

export type ConversationLifecycle = ReturnType<typeof createConversationLifecycle>

export function createConversationLifecycle(deps: ConversationLifecycleDeps) {
  const now = deps.now ?? Date.now
  const unknown = (workspaceId: string): ConversationLifecycleFailure => ({
    ok: false,
    code: 'unknown_workspace',
    message: `There is no chat "${workspaceId}" on this machine.`,
  })
  const write = (
    workspaceId: string,
    patch: WorkspaceFieldsPatch,
    actor: WorkspaceRegistryActor,
  ): ConversationLifecycleFailure | null => {
    const written = deps.updateWorkspaceFields(workspaceId, patch, actor)
    return written.ok ? null : { ok: false, code: 'write_failed', message: written.message }
  }

  /**
   * Settle a chat, or bring it back: the row menu's Settle and Un-settle,
   * patch for patch. Settling one already resting, or waking one that is
   * not, writes nothing and answers how it stands, so a retry is harmless.
   */
  function settle(workspaceId: string, settled: boolean, actor: WorkspaceRegistryActor): ConversationSettleResult {
    const record = deps.getRecord(workspaceId)
    if (!record) return unknown(workspaceId)
    if (settled === isSettledWorkspace(record))
      return { ok: true, workspaceId, settledAt: isSettledWorkspace(record) ? record.settledAt! : null }
    if (settled && deps.isWorking(workspaceId))
      return {
        ok: false,
        code: 'working',
        message: 'An agent in this chat is still working. Settle it once it has finished.',
      }
    const patch = settled ? settleWorkspacePatch(record, now(), 'settled') : wakeWorkspacePatch('active')
    const failed = write(workspaceId, patch, actor)
    if (failed) return failed
    return { ok: true, workspaceId, settledAt: typeof patch.settledAt === 'number' ? patch.settledAt : null }
  }

  /**
   * A person has the chat on screen. Only moves the visit clock forward, and
   * never to a time this machine has not reached yet, so a device whose clock
   * runs ahead cannot mark a later finish as seen. It is not activity: the
   * message clock and the chat's rest are left as they are.
   */
  function visit(
    workspaceId: string,
    visitedAt: number | undefined,
    actor: WorkspaceRegistryActor,
  ): ConversationVisitResult {
    const record = deps.getRecord(workspaceId)
    if (!record) return unknown(workspaceId)
    const at = Math.min(visitedAt ?? now(), now())
    const stored = typeof record.lastVisitedAt === 'number' ? record.lastVisitedAt : null
    if (stored !== null && stored >= at) return { ok: true, workspaceId, lastVisitedAt: stored }
    const failed = write(workspaceId, { lastVisitedAt: at }, actor)
    if (failed) return failed
    return { ok: true, workspaceId, lastVisitedAt: at }
  }

  /**
   * Mark unread, from any device: the visit clock goes back to just before
   * the chat's latest finish (that finish less a millisecond), so its
   * "finished, unseen" mark comes back everywhere and the next opening's
   * "New" divider sits above its latest reply. The one write that moves the
   * clock back, and it says so: `visitRewoundAt` is stamped beside it
   * (`visitRewindApplies`). A chat already unread from further back keeps its
   * clock, and one whose agent has finished nothing is refused.
   */
  function markUnread(workspaceId: string, actor: WorkspaceRegistryActor): ConversationMarkUnreadResult {
    const record = deps.getRecord(workspaceId)
    if (!record) return unknown(workspaceId)
    const recorded = typeof record.lastTurnEndedAt === 'number' ? record.lastTurnEndedAt : undefined
    const chats = deps.latestChatTurnEnd?.(workspaceId)
    const finishedAt = Math.max(recorded ?? Number.NEGATIVE_INFINITY, chats ?? Number.NEGATIVE_INFINITY)
    if (!Number.isFinite(finishedAt))
      return {
        ok: false,
        code: 'nothing_finished',
        message: 'No agent in this chat has finished anything yet, so there is nothing to mark unread.',
      }
    const stored = typeof record.lastVisitedAt === 'number' ? record.lastVisitedAt : null
    // Already unread from further back, the clock stays there; the stamp is
    // still written, which is what every device reads a Mark unread from.
    const at = stored !== null && stored < finishedAt - 1 ? stored : finishedAt - 1
    const failed = write(workspaceId, { lastVisitedAt: at, visitRewoundAt: now() }, actor)
    if (failed) return failed
    return { ok: true, workspaceId, lastVisitedAt: at }
  }

  /**
   * A person sent one of the workspace's chats a message from a paired
   * device. The same as a message typed here (`recordWorkspaceUserMessage`):
   * the clock moves forward, and a resting chat wakes, with any hand decision
   * about its rest spent.
   */
  function noteUserMessage(workspaceId: string, at: number, actor: WorkspaceRegistryActor): void {
    const record = deps.getRecord(workspaceId)
    if (!record) return
    if (typeof record.lastUserMessageAt === 'number' && record.lastUserMessageAt >= at) return
    const waking = isSettledWorkspace(record) || record.settledOverride != null
    write(workspaceId, { ...(waking ? wakeWorkspacePatch(null) : {}), lastUserMessageAt: at }, actor)
  }

  return { settle, visit, markUnread, noteUserMessage }
}

/**
 * Whether a registry change moves what a paired device's conversation list
 * says, so the change feed tells it to list again.
 *
 * The list reads the desktop's records now — whether a chat is resting, its
 * title, when it was last written to and looked at — so a change to one is a
 * change to the list, as a turn ending is. All but one are rare. A visit is
 * stamped every few seconds while a chat is on screen, and a phone re-listing
 * that often would be told nothing new: a visit only changes what a device
 * draws when it is the first since the chat's agent finished. So a visit
 * alone is passed on the first time this run sees one for the chat, and after
 * that only when a turn has ended since the last one (`turnEndOf`, read from
 * the chats main holds now).
 */
export function createConversationListChangeFilter(deps: {
  turnEndOf(workspaceId: string): number | undefined
}): (event: WorkspaceSyncEvent) => boolean {
  const lastVisit = new Map<string, number>()
  return (event) => {
    if (event.type === 'workspace.renamed' || event.type === 'workspace.removed' || event.type === 'workspace.created')
      return true
    if (event.type !== 'workspace.fields_updated') return false
    const { workspaceId, patch } = event.payload
    if (LIST_FIELDS.some((field) => patch[field] !== undefined)) return true
    if (typeof patch.lastVisitedAt !== 'number') return false
    const previous = lastVisit.get(workspaceId)
    // Mark unread moves the clock back, which every device has to hear.
    if (typeof patch.visitRewoundAt === 'number') {
      lastVisit.set(workspaceId, patch.lastVisitedAt)
      return true
    }
    lastVisit.set(workspaceId, Math.max(previous ?? 0, patch.lastVisitedAt))
    if (previous === undefined) return true
    const turnEnd = deps.turnEndOf(workspaceId)
    return turnEnd !== undefined && turnEnd > previous
  }
}

/** The record fields a listed chat reads, beside the visit clock. */
const LIST_FIELDS = ['settledAt', 'lastUserMessageAt'] as const satisfies ReadonlyArray<keyof WorkspaceFieldsPatch>
