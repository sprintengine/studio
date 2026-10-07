// Retention policy tuning. Kept beside the policy function so tests can guard
// the production values without importing the WorkspaceManager React module.
//
// Memory tradeoff is deliberate: idle layouts stay mounted (hidden) for the
// idle window, and up to the busy cap of busy layouts stay mounted regardless
// of age. The idle cap stays at 4 until memory measurements on realistic
// terminal-heavy workspaces show a higher cap is acceptable.
export const WORKSPACE_LAYOUT_IDLE_UNLOAD_MS = 60 * 60_000
export const WORKSPACE_LAYOUT_RETAINED_INACTIVE_LIMIT = 4
export const WORKSPACE_LAYOUT_BUSY_RETAINED_LIMIT = 10

// How many hidden (retained-but-inactive) layouts stay "warm" — i.e. fully
// rendered/composited behind the active layer so switching to them is instant.
// Layers retained beyond this warm set stay mounted (DOM + JS + xterm buffers
// preserved) but render with `content-visibility: hidden`, so the compositor
// skips their layout/paint/composite work every frame. That removes the
// per-frame compositor cost of the deep retained layers (the scroll-jank
// driver) while the most-recently-used layers you are likely to switch back to
// stay sharp. Cold layers pay a cheap one-time render on reveal, after which
// the existing WORKSPACE_LAYER_REVEAL_EVENT re-fits their terminals.
export const WORKSPACE_LAYOUT_WARM_HIDDEN_LIMIT = 3

export type WorkspaceLayoutRetentionReason = 'active' | 'busy' | 'recent-inactive'

type WorkspaceLayoutRetentionDecision = {
  workspaceId: string
  reason: WorkspaceLayoutRetentionReason
  busy: boolean
  lastFocusedAt: number
}

type WorkspaceLayoutEvictionDecision = {
  workspaceId: string
  reason: 'not-visible' | 'inactive-limit' | 'busy-limit' | 'expired'
  busy: boolean
  lastFocusedAt: number
}

export type WorkspaceLayoutRetentionResult = {
  retainedWorkspaceIds: string[]
  retained: WorkspaceLayoutRetentionDecision[]
  evicted: WorkspaceLayoutEvictionDecision[]
}

export type WorkspaceLayoutRetentionInput = {
  visibleWorkspaceIds: string[]
  activeWorkspaceId: string | null
  mountedWorkspaceIds: string[]
  busyWorkspaceIds: Set<string>
  lastFocusedAtByWorkspaceId: Record<string, number>
  now: number
  idleUnloadMs: number
  inactiveLimit: number
  busyLimit: number
}

type Candidate = {
  workspaceId: string
  busy: boolean
  lastFocusedAt: number
  mountedIndex: number
}

function sortByRecentFocus(first: Candidate, second: Candidate): number {
  if (second.lastFocusedAt !== first.lastFocusedAt) return second.lastFocusedAt - first.lastFocusedAt
  return first.mountedIndex - second.mountedIndex
}

function candidateFor(workspaceId: string, mountedIndex: number, input: WorkspaceLayoutRetentionInput): Candidate {
  return {
    workspaceId,
    busy: input.busyWorkspaceIds.has(workspaceId),
    lastFocusedAt: input.lastFocusedAtByWorkspaceId[workspaceId] ?? 0,
    mountedIndex,
  }
}

export function computeRetainedWorkspaceLayoutIds(
  input: WorkspaceLayoutRetentionInput,
): WorkspaceLayoutRetentionResult {
  const visibleWorkspaceIds = new Set(input.visibleWorkspaceIds)
  const activeWorkspaceId =
    input.activeWorkspaceId && visibleWorkspaceIds.has(input.activeWorkspaceId) ? input.activeWorkspaceId : null
  const retained: WorkspaceLayoutRetentionDecision[] = []
  const evicted: WorkspaceLayoutEvictionDecision[] = []
  const retainedIds = new Set<string>()

  if (activeWorkspaceId) {
    retainedIds.add(activeWorkspaceId)
    retained.push({
      workspaceId: activeWorkspaceId,
      reason: 'active',
      busy: input.busyWorkspaceIds.has(activeWorkspaceId),
      lastFocusedAt: input.now,
    })
  }

  const mountedCandidates = input.mountedWorkspaceIds
    .filter((workspaceId) => workspaceId !== activeWorkspaceId)
    .map((workspaceId, mountedIndex) => candidateFor(workspaceId, mountedIndex, input))

  const visibleCandidates: Candidate[] = []
  for (const candidate of mountedCandidates) {
    if (!visibleWorkspaceIds.has(candidate.workspaceId)) {
      evicted.push({
        workspaceId: candidate.workspaceId,
        reason: 'not-visible',
        busy: candidate.busy,
        lastFocusedAt: candidate.lastFocusedAt,
      })
      continue
    }
    visibleCandidates.push(candidate)
  }

  const busyCandidates = visibleCandidates.filter((candidate) => candidate.busy).sort(sortByRecentFocus)
  const retainedBusy = busyCandidates.slice(0, Math.max(0, input.busyLimit))
  const retainedBusyIds = new Set(retainedBusy.map((candidate) => candidate.workspaceId))

  for (const candidate of retainedBusy) {
    retainedIds.add(candidate.workspaceId)
    retained.push({
      workspaceId: candidate.workspaceId,
      reason: 'busy',
      busy: true,
      lastFocusedAt: candidate.lastFocusedAt,
    })
  }
  for (const candidate of busyCandidates.slice(Math.max(0, input.busyLimit))) {
    evicted.push({
      workspaceId: candidate.workspaceId,
      reason: 'busy-limit',
      busy: true,
      lastFocusedAt: candidate.lastFocusedAt,
    })
  }

  const inactiveCandidates = visibleCandidates
    .filter((candidate) => !candidate.busy && !retainedBusyIds.has(candidate.workspaceId))
    .filter((candidate) => input.now - candidate.lastFocusedAt < input.idleUnloadMs)
    .sort(sortByRecentFocus)
  const retainedInactive = inactiveCandidates.slice(0, Math.max(0, input.inactiveLimit))
  const retainedInactiveIds = new Set(retainedInactive.map((candidate) => candidate.workspaceId))

  for (const candidate of retainedInactive) {
    retainedIds.add(candidate.workspaceId)
    retained.push({
      workspaceId: candidate.workspaceId,
      reason: 'recent-inactive',
      busy: false,
      lastFocusedAt: candidate.lastFocusedAt,
    })
  }
  for (const candidate of inactiveCandidates.slice(Math.max(0, input.inactiveLimit))) {
    evicted.push({
      workspaceId: candidate.workspaceId,
      reason: 'inactive-limit',
      busy: false,
      lastFocusedAt: candidate.lastFocusedAt,
    })
  }

  for (const candidate of visibleCandidates) {
    if (candidate.busy) continue
    if (retainedInactiveIds.has(candidate.workspaceId)) continue
    if (input.now - candidate.lastFocusedAt < input.idleUnloadMs) continue
    evicted.push({
      workspaceId: candidate.workspaceId,
      reason: 'expired',
      busy: false,
      lastFocusedAt: candidate.lastFocusedAt,
    })
  }

  return {
    retainedWorkspaceIds: input.visibleWorkspaceIds.filter((workspaceId) => retainedIds.has(workspaceId)),
    retained,
    evicted,
  }
}

/**
 * The workspace layers a window draws, and which of the hidden ones are warm.
 *
 * Drawn: the active layer, every retained one, and every chat starting in the
 * background (⌘⏎ from New chat, `newChatStay.ts`), which is never the active
 * layer and has to be mounted for the agent its view starts to start.
 *
 * Warm layers stay fully composited behind the active one so switching back
 * to a recently-used workspace is instant. Everything beyond the warm set is
 * kept mounted but rendered with `content-visibility: hidden`, so the
 * compositor skips its per-frame work (the scroll-jank fix). Warm = the
 * most-recently-focused inactive layers, ranked by the same last-focused clock
 * the retention policy uses, and on top of those every chat starting a
 * terminal agent in the background: laid out, so the agent measures the size
 * it starts at. A chat starting a conversation agent needs only to be mounted
 * (its view starts the agent) and is not warm, so ⌘⏎ pressed many times over
 * does not add as many composited layers.
 */
export function workspaceLayers(input: {
  visibleWorkspaceIds: readonly string[]
  activeWorkspaceId: string | null
  mountedWorkspaceIds: readonly string[]
  startingWorkspaceIds: readonly string[]
  /** Whether a chat starting in the background starts a terminal agent, which has to be laid out to size itself. */
  startsTerminalAgent: (workspaceId: string) => boolean
  lastFocusedAtByWorkspaceId: Readonly<Record<string, number>>
  warmLimit: number
}): { rendered: string[]; warm: Set<string> } {
  const rendered = input.visibleWorkspaceIds.filter(
    (workspaceId) =>
      workspaceId === input.activeWorkspaceId ||
      input.mountedWorkspaceIds.includes(workspaceId) ||
      input.startingWorkspaceIds.includes(workspaceId),
  )
  const hidden = rendered.filter((workspaceId) => workspaceId !== input.activeWorkspaceId)
  const lastFocusedAt = input.lastFocusedAtByWorkspaceId
  const recent = [...hidden]
    .sort((a, b) => (lastFocusedAt[b] ?? 0) - (lastFocusedAt[a] ?? 0))
    .slice(0, Math.max(0, input.warmLimit))
  const starting = hidden.filter(
    (workspaceId) => input.startingWorkspaceIds.includes(workspaceId) && input.startsTerminalAgent(workspaceId),
  )
  return { rendered, warm: new Set([...recent, ...starting]) }
}
