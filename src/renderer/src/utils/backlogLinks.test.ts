import assert from 'node:assert/strict'

import { createRendererHost, type BacklogLinkProvider } from '../modules/renderer-host'
import type { BacklogItem, BacklogItemLink, BacklogResolvedLink } from './backlog'
import {
  backlogLinkControlModel,
  nextBacklogItemStatusFromLinks,
  openBacklogLink,
  providerForBacklogLink,
  resolveBacklogLink,
  resolveBacklogLinks,
  syncBacklogItemLinks,
  unknownBacklogResolvedLink,
} from './backlogLinks'

const baseItem: BacklogItem = {
  id: 'backlog/run.md',
  objectId: 'backlog_run',
  path: '/repo/backlog/run.md',
  relativePath: 'backlog/run.md',
  title: 'Run',
  kind: 'unknown',
  status: 'idea',
  metadata: {},
  links: [],
  excerpt: '',
  modifiedAt: 1,
  size: 1,
  sourceContent: '# Run',
}

const sprintRunLink: BacklogItemLink = {
  id: 'sprint-engine:run',
  moduleId: 'sprint-engine',
  type: 'execution',
  label: 'Sprint Engine run',
  target: { kind: 'sprintengine.run', id: 'run', path: '.multi-code/sprintengine/run/run.yaml' },
  status: 'active',
}

const sprintArtifactLink: BacklogItemLink = {
  id: 'sprint-engine:artifact',
  moduleId: 'sprint-engine',
  type: 'external',
  label: 'Sprint Engine artifact',
  target: { kind: 'sprintengine.artifact', id: 'artifact', path: '.multi-code/sprintengine/artifacts/a.md' },
  status: 'unknown',
}

function provider(moduleId: string, targetKinds: string[], status: BacklogResolvedLink['status']): BacklogLinkProvider {
  return {
    moduleId,
    targetKinds,
    async resolveLinkStatus({ link }) {
      return { ...link, status, canOpen: status !== 'unknown' }
    },
    async openLink() {},
  }
}

async function main(): Promise<void> {
  const host = createRendererHost()
  host.hostFor('sprint-engine').registerBacklogLinkProvider(provider('sprint-engine', ['sprintengine.run'], 'completed'))
  host.hostFor('sprint-engine').registerBacklogLinkProvider(provider('sprint-engine', ['sprintengine.artifact'], 'active'))
  assert.throws(
    () => host.hostFor('other').registerBacklogLinkProvider(provider('other', ['sprintengine.run'], 'active')),
    /already owned by module "sprint-engine"/,
    'duplicate target kind ownership fails clearly',
  )
  assert.throws(
    () => host.hostFor('sprint-engine').registerBacklogLinkProvider(provider('wrong-owner', ['other.target'], 'active')),
    /must be registered by its owning module/,
    'provider moduleId must match the scoped renderer host',
  )
  assert.throws(
    () => host.hostFor('empty').registerBacklogLinkProvider(provider('empty', [], 'active')),
    /at least one target kind/,
    'providers must own at least one target kind',
  )
  assert.throws(
    () => host.hostFor('dupe').registerBacklogLinkProvider(provider('dupe', ['dupe.kind', 'dupe.kind'], 'active')),
    /duplicate target kinds/,
    'providers cannot duplicate their own target kinds',
  )

  assert.deepEqual(
    host.getBacklogLinkProviders((moduleId) => moduleId !== 'sprint-engine'),
    [],
    'disabled modules do not return providers',
  )
  const enabledProviders = host.getBacklogLinkProviders((moduleId) => moduleId === 'sprint-engine')
  assert.equal(enabledProviders.length, 2, 'same-module providers for different target kinds are preserved')
  assert.equal(providerForBacklogLink(enabledProviders, sprintRunLink)?.moduleId, 'sprint-engine')
  assert.equal(providerForBacklogLink(enabledProviders, sprintArtifactLink)?.moduleId, 'sprint-engine')
  assert.equal(
    await openBacklogLink({
      workspaceId: 'ws',
      workspaceRoot: '/repo',
      item: baseItem,
      link: sprintRunLink,
      providers: host.getBacklogLinkProviders(() => false),
    }),
    false,
    'disabled modules do not open links',
  )
  assert.equal(
    await openBacklogLink({
      workspaceId: 'ws',
      workspaceRoot: '/repo',
      item: baseItem,
      link: sprintRunLink,
      providers: enabledProviders,
    }),
    true,
    'enabled providers can open owned links',
  )
  assert.equal(
    await openBacklogLink({
      workspaceId: 'ws',
      workspaceRoot: '/repo',
      item: baseItem,
      link: sprintArtifactLink,
      providers: enabledProviders,
    }),
    true,
    'enabled modules can open links from a second same-module provider',
  )

  const unknown = unknownBacklogResolvedLink({
    ...sprintRunLink,
    target: { kind: 'missing.kind', id: 'missing' },
  })
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.canOpen, false)
  assert.match(unknown.unavailableReason ?? '', /No enabled provider/)

  const resolvedUnknown = await resolveBacklogLink({
    workspaceId: 'ws',
    workspaceRoot: '/repo',
    item: baseItem,
    link: unknown,
    providers: enabledProviders,
  })
  assert.equal(resolvedUnknown.status, 'unknown', 'unknown target kinds resolve safely without throwing')

  const itemWithLinks = { ...baseItem, links: [sprintRunLink] }
  const resolved = await resolveBacklogLinks({
    workspaceId: 'ws',
    workspaceRoot: '/repo',
    item: { ...itemWithLinks, links: [sprintRunLink, sprintArtifactLink] },
    providers: enabledProviders,
  })
  assert.equal(resolved[0]?.status, 'completed')
  assert.equal(resolved[1]?.status, 'active')

  assert.equal(nextBacklogItemStatusFromLinks('idea', resolved), 'completed')
  assert.equal(
    nextBacklogItemStatusFromLinks('idea', [{ ...sprintRunLink, status: 'active' }]),
    'in_progress',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('ready', [{ ...sprintRunLink, status: 'unknown' }]),
    'ready',
    'unknown execution status leaves item status unchanged',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('ready', [{ ...sprintRunLink, type: 'external', status: 'completed' }]),
    'ready',
    'non-execution link status does not complete the item',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('archived', [{ ...sprintRunLink, status: 'active' }]),
    'archived',
    'link refresh does not unarchive items',
  )

  // backlogLinkControlModel: an openable resolved link becomes an actionable
  // control with a visible status word and target detail.
  const openableControl = backlogLinkControlModel({ ...sprintRunLink, status: 'completed', canOpen: true })
  assert.equal(openableControl.canOpen, true)
  assert.equal(openableControl.statusText, 'Completed')
  assert.equal(openableControl.detail, sprintRunLink.target.path)

  // An unavailable resolved link is non-actionable, reads "Unavailable", and
  // surfaces the unavailable reason as its detail.
  const unavailableControl = backlogLinkControlModel(
    unknownBacklogResolvedLink({ ...sprintRunLink, target: { kind: 'missing.kind', id: 'm' } }),
  )
  assert.equal(unavailableControl.canOpen, false)
  assert.equal(unavailableControl.statusText, 'Unavailable')
  assert.match(unavailableControl.detail, /No enabled provider/)

  // syncBacklogItemLinks: a run that resolves active persists the changed link
  // status and drives the item to in_progress in one write.
  const syncHost = createRendererHost()
  syncHost.hostFor('sprint-engine').registerBacklogLinkProvider(provider('sprint-engine', ['sprintengine.run'], 'active'))
  const activeProviders = syncHost.getBacklogLinkProviders(() => true)
  const persistedActive: Array<{ status?: string; linkStatus?: string }> = []
  const activeSync = await syncBacklogItemLinks({
    workspaceId: 'ws',
    workspaceRoot: '/repo',
    item: { ...baseItem, status: 'ready', links: [{ ...sprintRunLink, status: 'unknown' }] },
    providers: activeProviders,
    persistLink: async (args) => {
      persistedActive.push({ status: args.status, linkStatus: args.link.status })
      return { ok: true }
    },
  })
  assert.equal(activeSync.itemStatus, 'in_progress', 'an active run drives the item to in_progress')
  assert.equal(activeSync.persistError, null)
  assert.deepEqual(persistedActive, [{ status: 'in_progress', linkStatus: 'active' }])

  // An unavailable resolution renders but is never persisted, so a transient
  // unreadable run cannot clobber a stored status.
  const unknownProviders = syncHost.getBacklogLinkProviders(() => false)
  let unknownPersistCalls = 0
  const unknownSync = await syncBacklogItemLinks({
    workspaceId: 'ws',
    workspaceRoot: '/repo',
    item: { ...baseItem, status: 'in_progress', links: [{ ...sprintRunLink, status: 'active' }] },
    providers: unknownProviders,
    persistLink: async () => {
      unknownPersistCalls += 1
      return { ok: true }
    },
  })
  assert.equal(unknownSync.links[0]?.status, 'unknown', 'no enabled provider resolves the link as unavailable')
  assert.equal(unknownSync.itemStatus, 'in_progress', 'an unavailable run leaves the item status unchanged')
  assert.equal(unknownPersistCalls, 0, 'unavailable resolutions are never persisted')

  // An unchanged status skips persistence entirely.
  const completedHost = createRendererHost()
  completedHost.hostFor('sprint-engine').registerBacklogLinkProvider(provider('sprint-engine', ['sprintengine.run'], 'completed'))
  let unchangedPersistCalls = 0
  await syncBacklogItemLinks({
    workspaceId: 'ws',
    workspaceRoot: '/repo',
    item: { ...baseItem, status: 'completed', links: [{ ...sprintRunLink, status: 'completed' }] },
    providers: completedHost.getBacklogLinkProviders(() => true),
    persistLink: async () => {
      unchangedPersistCalls += 1
      return { ok: true }
    },
  })
  assert.equal(unchangedPersistCalls, 0, 'an unchanged link status is not re-persisted')

  // A persist failure is surfaced, not swallowed.
  const failSync = await syncBacklogItemLinks({
    workspaceId: 'ws',
    workspaceRoot: '/repo',
    item: { ...baseItem, status: 'ready', links: [{ ...sprintRunLink, status: 'unknown' }] },
    providers: activeProviders,
    persistLink: async () => ({ ok: false, message: 'disk full' }),
  })
  assert.match(failSync.persistError ?? '', /disk full/, 'persist failures surface to the caller')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
