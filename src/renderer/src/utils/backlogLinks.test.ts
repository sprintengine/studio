import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  isEpic: false,
  metadata: {},
  links: [],
  excerpt: '',
  modifiedAt: 1,
  createdAtMs: 1,
  size: 1,
  sourceContent: '# Run',
}

// A capability module's two link shapes: an EXECUTION link, which drives the
// item's status, and an EXTERNAL one, which never does.
const executionLink: BacklogItemLink = {
  id: 'atlas:run',
  moduleId: 'atlas',
  type: 'execution',
  label: 'Atlas run',
  target: { kind: 'atlas.run', id: 'run', path: '.atlas/run/run.yaml' },
  status: 'active',
}

const externalLink: BacklogItemLink = {
  id: 'atlas:chart',
  moduleId: 'atlas',
  type: 'external',
  label: 'Atlas chart',
  target: { kind: 'atlas.chart', id: 'chart', path: '.atlas/charts/a.md' },
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
  host.hostFor('atlas').registerBacklogLinkProvider(provider('atlas', ['atlas.run'], 'completed'))
  host.hostFor('atlas').registerBacklogLinkProvider(provider('atlas', ['atlas.chart'], 'active'))
  assert.throws(
    () => host.hostFor('other').registerBacklogLinkProvider(provider('other', ['atlas.run'], 'active')),
    /already owned by module "atlas"/,
    'duplicate target kind ownership fails clearly',
  )
  assert.throws(
    () => host.hostFor('atlas').registerBacklogLinkProvider(provider('wrong-owner', ['other.target'], 'active')),
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
    host.getBacklogLinkProviders((moduleId) => moduleId !== 'atlas'),
    [],
    'disabled modules do not return providers',
  )
  const enabledProviders = host.getBacklogLinkProviders((moduleId) => moduleId === 'atlas')
  assert.equal(enabledProviders.length, 2, 'same-module providers for different target kinds are preserved')
  assert.equal(providerForBacklogLink(enabledProviders, executionLink)?.moduleId, 'atlas')
  assert.equal(providerForBacklogLink(enabledProviders, externalLink)?.moduleId, 'atlas')
  assert.equal(
    await openBacklogLink({
      workspaceId: 'ws',
      workspaceRoot: '/repo',
      item: baseItem,
      link: executionLink,
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
      link: executionLink,
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
      link: externalLink,
      providers: enabledProviders,
    }),
    true,
    'enabled modules can open links from a second same-module provider',
  )

  const unknown = unknownBacklogResolvedLink({
    ...executionLink,
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

  const itemWithLinks = { ...baseItem, links: [executionLink] }
  const resolved = await resolveBacklogLinks({
    workspaceId: 'ws',
    workspaceRoot: '/repo',
    item: { ...itemWithLinks, links: [executionLink, externalLink] },
    providers: enabledProviders,
  })
  assert.equal(resolved[0]?.status, 'completed')
  assert.equal(resolved[1]?.status, 'active')

  assert.equal(nextBacklogItemStatusFromLinks('idea', resolved), 'completed')
  assert.equal(
    nextBacklogItemStatusFromLinks('idea', [{ ...executionLink, status: 'active' }]),
    'in_progress',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('ready', [{ ...executionLink, status: 'unknown' }]),
    'ready',
    'unknown execution status leaves item status unchanged',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('ready', [{ ...executionLink, type: 'external', status: 'completed' }]),
    'ready',
    'non-execution link status does not complete the item',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('archived', [{ ...executionLink, status: 'active' }]),
    'archived',
    'link refresh does not unarchive items',
  )

  // Epic derivation: the status is the highest-precedence status a child holds
  // (needs_input > in_progress > ready > idea > completed), never the epic's own
  // run link. The live incident — a completed run link on an epic with open
  // children — reads in_progress, healing the wrongly-completed epic.
  const completedRun = { ...executionLink, status: 'completed' as const }
  assert.equal(
    nextBacklogItemStatusFromLinks('completed', [completedRun], ['ready', 'completed', 'in_progress']),
    'in_progress',
    'a completed run link never completes an epic while a child is still active',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('in_progress', [completedRun], ['completed', 'archived', 'completed']),
    'completed',
    'an epic auto-completes only when every child is completed or archived',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('in_progress', [{ ...executionLink, status: 'active' }], ['completed']),
    'in_progress',
    "the epic's own still-active run keeps it in_progress even with all children done",
  )
  // Corrected precedence (MC-1617): an untouched epic whose children are all `ready`
  // reflects `ready`, NOT `in_progress` — no work has started. The pre-correction
  // rule treated `ready`/`idea` as "active" and wrongly promoted it.
  assert.equal(
    nextBacklogItemStatusFromLinks('idea', [], ['ready', 'ready']),
    'ready',
    'an untouched epic with all-ready children reflects ready, not in_progress',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('idea', [], ['idea', 'idea']),
    'idea',
    'an epic whose children are all idea reflects idea',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('idea', [], ['idea', 'completed', 'ready']),
    'ready',
    'the highest-precedence working child wins over lower ones and completed',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('idea', [], ['completed', 'needs_input', 'in_progress']),
    'needs_input',
    'a child blocked on a human (needs_input) outranks active work',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('idea', [], ['completed', 'archived', 'idea']),
    'idea',
    'archived children do not block the roll-up, but a still-open child keeps it open',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('idea', [], ['ready']),
    'ready',
    'a grouping epic with no links reflects its single ready child',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('idea', [], ['completed', 'completed']),
    'completed',
    'a grouping epic with no links completes when all children are completed',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('idea', [], ['completed', 'archived']),
    'completed',
    'an epic auto-completes when every child is completed or archived',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('archived', [], ['ready', 'in_progress']),
    'archived',
    'an archived epic is never demoted by active children',
  )
  // A childless epic (empty children) falls back to the leaf link rule, byte for
  // byte — so an epic used as a plain item behaves exactly as before.
  assert.equal(
    nextBacklogItemStatusFromLinks('idea', [completedRun], []),
    'completed',
    'a childless epic uses the link rule (completed run → completed)',
  )
  assert.equal(
    nextBacklogItemStatusFromLinks('ready', [], []),
    'ready',
    'a childless epic with no links leaves the status unchanged, like a leaf',
  )
  // Leaf behaviour is byte-identical whether epicChildStatuses is omitted or empty.
  assert.equal(nextBacklogItemStatusFromLinks('idea', [completedRun]), 'completed')
  assert.equal(nextBacklogItemStatusFromLinks('idea', [completedRun], undefined), 'completed')

  // backlogLinkControlModel: an openable resolved link becomes an actionable
  // control with a visible status word and target detail.
  const openableControl = backlogLinkControlModel({ ...executionLink, status: 'completed', canOpen: true })
  assert.equal(openableControl.canOpen, true)
  assert.equal(openableControl.statusText, 'Completed')
  assert.equal(openableControl.detail, executionLink.target.path)

  // An unavailable resolved link is non-actionable, reads "Unavailable", and
  // surfaces the unavailable reason as its detail.
  const unavailableControl = backlogLinkControlModel(
    unknownBacklogResolvedLink({ ...executionLink, target: { kind: 'missing.kind', id: 'm' } }),
  )
  assert.equal(unavailableControl.canOpen, false)
  assert.equal(unavailableControl.statusText, 'Unavailable')
  assert.match(unavailableControl.detail, /No enabled provider/)

  // syncBacklogItemLinks: a run that resolves active persists the changed link
  // status and drives the item to in_progress in one write.
  const syncHost = createRendererHost()
  syncHost.hostFor('atlas').registerBacklogLinkProvider(provider('atlas', ['atlas.run'], 'active'))
  const activeProviders = syncHost.getBacklogLinkProviders(() => true)
  const persistedActive: Array<{ status?: string; linkStatus?: string }> = []
  const activeSync = await syncBacklogItemLinks({
    workspaceId: 'ws',
    workspaceRoot: '/repo',
    item: { ...baseItem, status: 'ready', links: [{ ...executionLink, status: 'unknown' }] },
    providers: activeProviders,
    persistLink: async (args) => {
      persistedActive.push({ status: args.status, linkStatus: args.link.status })
      return { ok: true }
    },
  })
  assert.equal(activeSync.itemStatus, 'in_progress', 'an active run drives the item to in_progress')
  assert.equal(activeSync.persistError, null)
  assert.deepEqual(persistedActive, [{ status: 'in_progress', linkStatus: 'active' }])

  // A `pending` execution link is work that is recorded but not started. It
  // refreshes the stored chip and is as lifecycle-neutral as an `unknown` one —
  // the item is left alone.
  const pendingHost = createRendererHost()
  pendingHost.hostFor('atlas').registerBacklogLinkProvider(
    provider('atlas', ['atlas.run'], 'pending'),
  )
  const persistedPending: BacklogItemLink[] = []
  const pendingSync = await syncBacklogItemLinks({
    workspaceId: 'ws',
    workspaceRoot: '/repo',
    item: {
      ...baseItem,
      status: 'ready',
      links: [{ ...executionLink, status: 'active' }],
    },
    providers: pendingHost.getBacklogLinkProviders(() => true),
    persistLink: async (args) => {
      persistedPending.push(args.link)
      assert.equal(args.status, undefined, 'a pending link never carries an item status')
      return { ok: true }
    },
  })
  assert.equal(pendingSync.itemStatus, 'ready', 'a pending execution link leaves the item exactly where it was')
  assert.deepEqual(
    persistedPending.map((link) => link.status),
    ['pending'],
    'the chip refreshes',
  )

  // An unavailable resolution renders but is never persisted, so a transient
  // unreadable run cannot clobber a stored status.
  const unknownProviders = syncHost.getBacklogLinkProviders(() => false)
  let unknownPersistCalls = 0
  const unknownSync = await syncBacklogItemLinks({
    workspaceId: 'ws',
    workspaceRoot: '/repo',
    item: { ...baseItem, status: 'in_progress', links: [{ ...executionLink, status: 'active' }] },
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
  completedHost.hostFor('atlas').registerBacklogLinkProvider(provider('atlas', ['atlas.run'], 'completed'))
  let unchangedPersistCalls = 0
  await syncBacklogItemLinks({
    workspaceId: 'ws',
    workspaceRoot: '/repo',
    item: { ...baseItem, status: 'completed', links: [{ ...executionLink, status: 'completed' }] },
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
    item: { ...baseItem, status: 'ready', links: [{ ...executionLink, status: 'unknown' }] },
    providers: activeProviders,
    persistLink: async () => ({ ok: false, message: 'disk full' }),
  })
  assert.match(failSync.persistError ?? '', /disk full/, 'persist failures surface to the caller')

  // syncBacklogItemLinks for an epic: the derived status is RETURNED for read-time
  // display (in_progress, healing the wrongly-completed epic) but is never written
  // back to frontmatter — an epic's stored status is derived at read time, so the
  // sync tick refreshes the link chip only. Here the stored link is already
  // `completed`, so nothing persists at all.
  const epicHealHost = createRendererHost()
  epicHealHost.hostFor('atlas').registerBacklogLinkProvider(provider('atlas', ['atlas.run'], 'completed'))
  const persistedEpic: Array<{ status?: string; linkStatus?: string }> = []
  const epicSync = await syncBacklogItemLinks({
    workspaceId: 'ws',
    workspaceRoot: '/repo',
    item: {
      ...baseItem,
      isEpic: true,
      relativePath: 'backlog/epics/relay.md',
      status: 'completed',
      links: [{ ...executionLink, status: 'completed' }],
    },
    epicChildStatuses: ['in_progress', 'completed'],
    providers: epicHealHost.getBacklogLinkProviders(() => true),
    persistLink: async (args) => {
      persistedEpic.push({ status: args.status, linkStatus: args.link.status })
      return { ok: true }
    },
  })
  assert.equal(epicSync.itemStatus, 'in_progress', 'an epic with an open child derives in_progress off a completed run link')
  assert.deepEqual(persistedEpic, [], 'an epic status is never written back to frontmatter by the sync tick')

  // An epic whose run-link chip is stale still refreshes the chip (link status
  // changes) but persists NO item status — the write carries `status: undefined`.
  const epicChipHost = createRendererHost()
  epicChipHost.hostFor('atlas').registerBacklogLinkProvider(provider('atlas', ['atlas.run'], 'completed'))
  const persistedEpicChip: Array<{ status?: string; linkStatus?: string }> = []
  await syncBacklogItemLinks({
    workspaceId: 'ws',
    workspaceRoot: '/repo',
    item: {
      ...baseItem,
      isEpic: true,
      relativePath: 'backlog/epics/relay.md',
      status: 'in_progress',
      links: [{ ...executionLink, status: 'active' }],
    },
    epicChildStatuses: ['completed', 'completed'],
    providers: epicChipHost.getBacklogLinkProviders(() => true),
    persistLink: async (args) => {
      persistedEpicChip.push({ status: args.status, linkStatus: args.link.status })
      return { ok: true }
    },
  })
  assert.deepEqual(
    persistedEpicChip,
    [{ status: undefined, linkStatus: 'completed' }],
    'a stale epic link chip refreshes to the run status without carrying an item status',
  )

  runSourceContracts()
}

// Source contracts, in the spirit of BacklogRow.test.tsx: the epic-aware wiring in
// the panel and the store-only projection tick that a pure unit test cannot reach.
function runSourceContracts(): void {
  const backlogLinksSource = readFileSync(join(process.cwd(), 'src/renderer/src/utils/backlogLinks.ts'), 'utf8')
  assert.match(
    backlogLinksSource,
    /if \(epicChildStatuses && epicChildStatuses\.length > 0\) \{/,
    'the derivation has a dedicated epic-with-children branch',
  )
  assert.match(
    backlogLinksSource,
    /const EPIC_STATUS_PRECEDENCE: Record<BacklogItemStatus, number> = \{/,
    'the epic roll-up ranks child statuses by an explicit precedence table',
  )
  assert.match(
    backlogLinksSource,
    /if \(votes\.every\(\(status\) => status === 'completed' \|\| status === 'archived'\)\) return 'completed'/,
    'an epic auto-completes only when every vote (children + own run) is terminal',
  )
  assert.match(
    backlogLinksSource,
    /const statusChanged = !input\.item\.isEpic && itemStatus !== input\.item\.status/,
    'the sync tick never carries an epic status back to frontmatter',
  )

  const panelSource = readFileSync(join(process.cwd(), 'src/renderer/src/components/panels/BacklogPanel.tsx'), 'utf8')
  assert.match(
    panelSource,
    /const needsUnlink = executionLinks\.length > 0 && !childDriven && status !== derivedStatus/,
    'the sever dialog only fires for a genuinely contradictory set on a link-driven item',
  )
  assert.match(
    panelSource,
    /epicChildStatuses=\{isEpic \? epicChildren\.map\(\(child\) => child\.status\) : undefined\}/,
    'the epic children reach the links section so its sync tick can derive up',
  )
  assert.match(
    panelSource,
    /const derived = nextBacklogItemStatusFromLinks\(\s*item\.status,\s*item\.links,\s*childStatusesBySlug\.get\(epicSlug\(item\)\) \?\? \[\],\s*\)/,
    'the panel derives every epic status at read time over the full scan',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
