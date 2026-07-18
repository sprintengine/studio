import type {
  BacklogItem,
  BacklogItemLink,
  BacklogItemLinkStatus,
  BacklogItemStatus,
  BacklogResolvedLink,
} from './backlog'
import type { BacklogLinkProvider, BacklogLinkProviderInput } from '../modules/renderer-host'

export function unknownBacklogResolvedLink(link: BacklogItemLink): BacklogResolvedLink {
  return {
    ...link,
    status: 'unknown',
    unavailableReason: `No enabled provider for ${link.target.kind}.`,
    canOpen: false,
  }
}

export function providerForBacklogLink(
  providers: ReadonlyArray<BacklogLinkProvider>,
  link: BacklogItemLink,
): BacklogLinkProvider | null {
  return providers.find((provider) => provider.targetKinds.includes(link.target.kind)) ?? null
}

export async function resolveBacklogLink(
  input: BacklogLinkProviderInput & { providers: ReadonlyArray<BacklogLinkProvider> },
): Promise<BacklogResolvedLink> {
  const provider = providerForBacklogLink(input.providers, input.link)
  if (!provider) return unknownBacklogResolvedLink(input.link)
  return provider.resolveLinkStatus(input)
}

export async function resolveBacklogLinks(input: {
  workspaceId: string
  workspaceRoot: string
  item: BacklogItem
  providers: ReadonlyArray<BacklogLinkProvider>
}): Promise<BacklogResolvedLink[]> {
  const resolved: BacklogResolvedLink[] = []
  for (const link of input.item.links) {
    resolved.push(await resolveBacklogLink({ ...input, link }))
  }
  return resolved
}

export async function openBacklogLink(
  input: BacklogLinkProviderInput & { providers: ReadonlyArray<BacklogLinkProvider> },
): Promise<boolean> {
  const provider = providerForBacklogLink(input.providers, input.link)
  if (!provider?.openLink) return false
  return (await provider.openLink(input)) !== false
}

// Epic roll-up precedence: the status an epic reflects is the highest-precedence
// one any child holds. `needs_input` (a child is blocked on a human) outranks
// active work, which outranks the not-yet-started working states, which outrank
// `completed`. `archived` is the floor — an archived child neither blocks nor
// advances the roll-up, and only contributes to the "every child terminal"
// auto-complete test. Corrected 2026-07-15 after external review: `idea`/`ready`
// are NOT "active", so an untouched epic whose children are all `ready` reflects
// `ready`, not `in_progress` (backlog/2026-07-15-backlog-epic-status-derives-
// from-children.md).
const EPIC_STATUS_PRECEDENCE: Record<BacklogItemStatus, number> = {
  needs_input: 5,
  in_progress: 4,
  ready: 3,
  idea: 2,
  completed: 1,
  archived: 0,
}

function highestPrecedenceStatus(statuses: ReadonlyArray<BacklogItemStatus>): BacklogItemStatus {
  return statuses.reduce((best, status) =>
    EPIC_STATUS_PRECEDENCE[status] > EPIC_STATUS_PRECEDENCE[best] ? status : best,
  )
}

// The only shape the derivation reads off a link: its lifecycle type and (when
// known) its live status. Both a stored BacklogItemLink and a resolved link
// satisfy it, so a caller can derive from stored links without a resolve round
// trip (the override-dialog guard) or from freshly resolved ones (the sync tick).
type StatusDrivingLink = Pick<BacklogItemLink, 'type' | 'status'>

// The status an item should carry given its execution links and — for an epic —
// its children. Two derivation modes:
//
//  - Leaf items (and a childless epic used as a plain item): status follows the
//    execution links — any active link → in_progress, all completed → completed.
//  - Epics WITH children: the status is derived UP from the children, never from
//    the epic's own run link. An epic launched as a sprint carries that run's
//    execution link itself, so the type-blind link rule below auto-completed the
//    whole epic the moment its run finished, even with children still open (live
//    incident 2026-07-15, backlog/2026-07-15-backlog-epic-status-derives-from-
//    children.md). Instead the epic reflects the highest-precedence status any
//    child holds (EPIC_STATUS_PRECEDENCE), with the epic's own still-active run
//    counting as one extra `in_progress` vote; it auto-completes only when every
//    child — and the own run — is terminal (completed/archived). This is the
//    symmetric partner of the run START, which fans in_progress DOWN to the
//    children (recordSprintEngineExecutionLink).
//
// `archived` is never demoted, and an unknown link status never drives a change.
export function nextBacklogItemStatusFromLinks(
  currentStatus: BacklogItemStatus,
  links: ReadonlyArray<StatusDrivingLink>,
  epicChildStatuses?: ReadonlyArray<BacklogItemStatus>,
): BacklogItemStatus {
  if (currentStatus === 'archived') return currentStatus
  const executionLinks = links.filter((link) => link.type === 'execution')

  // Epic with children: reflect the highest-precedence child status. The epic's
  // own active run adds an `in_progress` vote but never a completion trigger, so
  // a finished run cannot complete an epic while a child is still open.
  if (epicChildStatuses && epicChildStatuses.length > 0) {
    const anyOwnRunActive = executionLinks.some((link) => link.status === 'active')
    const votes = anyOwnRunActive ? [...epicChildStatuses, 'in_progress' as const] : epicChildStatuses
    // Auto-complete only when nothing is still open — every child terminal and no
    // active own run. Otherwise the highest-precedence working vote wins (it always
    // outranks the completed/archived votes it is mixed with).
    if (votes.every((status) => status === 'completed' || status === 'archived')) return 'completed'
    return highestPrecedenceStatus(votes)
  }

  if (executionLinks.length === 0) return currentStatus
  if (executionLinks.some((link) => link.status === 'active')) return 'in_progress'
  if (executionLinks.every((link) => link.status === 'completed')) return 'completed'
  return currentStatus
}

export function linkStatusChanged(link: BacklogItemLink, resolved: BacklogResolvedLink): boolean {
  return link.status !== resolved.status
}

// Visible, non-color-only status word for a resolved Backlog link. The detail
// pane shows this beside every link so status never depends on color alone.
export const BACKLOG_LINK_STATUS_TEXT: Record<BacklogItemLinkStatus, string> = {
  active: 'Active',
  completed: 'Completed',
  canceled: 'Canceled',
  failed: 'Failed',
  unknown: 'Unavailable',
}

export type BacklogLinkControl = {
  label: string
  statusText: string
  // True only when an enabled provider can actually open the target. Unknown or
  // unavailable links render as non-actionable metadata instead of a button.
  canOpen: boolean
  // Hover/focus detail: the unavailable reason when the link cannot resolve,
  // otherwise the concrete target the control points at.
  detail: string
}

// Pure render decision for one resolved link, so the Backlog detail pane never
// embeds link-status branching inline and the choices stay unit-testable.
export function backlogLinkControlModel(link: BacklogResolvedLink): BacklogLinkControl {
  const detail =
    link.unavailableReason
    ?? link.target.path
    ?? link.target.url
    ?? link.target.id
  return {
    label: link.label,
    statusText: BACKLOG_LINK_STATUS_TEXT[link.status],
    canOpen: link.canOpen === true,
    detail,
  }
}

// Strip the resolve-only fields back to a persistable link carrying the freshly
// resolved status.
function toStoredBacklogLink(resolved: BacklogResolvedLink): BacklogItemLink {
  return {
    id: resolved.id,
    moduleId: resolved.moduleId,
    type: resolved.type,
    label: resolved.label,
    target: resolved.target,
    status: resolved.status,
    updatedAt: resolved.updatedAt,
  }
}

// Resolve an item's provider-backed links through enabled providers, then write
// any changed live status back through the Backlog service so the store stays in
// sync with the run projection. `unknown` resolutions are rendered but never
// persisted, so a transient unreadable run cannot clobber a previously known
// status. Returns the resolved links for rendering, the derived item status, and
// the first persist error so the UI can surface a non-silent warning.
export async function syncBacklogItemLinks(input: {
  workspaceId: string
  workspaceRoot: string
  item: BacklogItem
  // For an epic, the current status of every child (frontmatter `epic:` members),
  // so the returned `itemStatus` derives UP from the children rather than from the
  // epic's own run link. Omit (or pass empty) for leaf items and childless epics.
  // The derived status is returned for read-time display but, for an epic, is never
  // persisted to frontmatter (see the `statusChanged` gate below).
  epicChildStatuses?: ReadonlyArray<BacklogItemStatus>
  providers: ReadonlyArray<BacklogLinkProvider>
  persistLink(args: {
    workspaceRoot: string
    relativePath: string
    link: BacklogItemLink
    status?: BacklogItemStatus
  }): Promise<{ ok: boolean; message?: string }>
}): Promise<{ links: BacklogResolvedLink[]; itemStatus: BacklogItemStatus; persistError: string | null }> {
  const links = await resolveBacklogLinks({
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    item: input.item,
    providers: input.providers,
  })
  const itemStatus = nextBacklogItemStatusFromLinks(input.item.status, links, input.epicChildStatuses)
  // An epic's status is derived from its children at READ time and is never
  // written back to frontmatter — its stored `status:` stays meaningful only for
  // archival (backlog/2026-07-15-backlog-epic-status-derives-from-children.md). So
  // the sync tick refreshes an epic's link-status chip but never carries a status
  // to the item. Leaf items keep persisting their link-driven status as before.
  const statusChanged = !input.item.isEpic && itemStatus !== input.item.status

  let persistError: string | null = null
  let statusPersisted = false
  for (const link of links) {
    // Never overwrite a stored status with an unavailable resolution.
    if (link.status === 'unknown') continue
    const stored = input.item.links.find((candidate) => candidate.id === link.id)
    const linkChanged = stored?.status !== link.status
    const carryStatus = statusChanged && !statusPersisted && link.type === 'execution'
    if (!linkChanged && !carryStatus) continue
    const result = await input.persistLink({
      workspaceRoot: input.workspaceRoot,
      relativePath: input.item.relativePath,
      link: toStoredBacklogLink(link),
      status: carryStatus ? itemStatus : undefined,
    })
    if (result.ok) {
      if (carryStatus) statusPersisted = true
    } else if (!persistError) {
      persistError = result.message ?? 'Could not persist Backlog link status.'
    }
  }

  return { links, itemStatus, persistError }
}
