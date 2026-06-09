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

export function nextBacklogItemStatusFromLinks(
  currentStatus: BacklogItemStatus,
  links: ReadonlyArray<BacklogResolvedLink>,
): BacklogItemStatus {
  if (currentStatus === 'archived') return currentStatus
  const executionLinks = links.filter((link) => link.type === 'execution')
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
  const itemStatus = nextBacklogItemStatusFromLinks(input.item.status, links)
  const statusChanged = itemStatus !== input.item.status

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
