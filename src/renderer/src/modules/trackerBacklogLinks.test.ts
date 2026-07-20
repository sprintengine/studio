import assert from 'node:assert/strict'

import type { BacklogItem, BacklogItemLink } from '../utils/backlog'
import { nextBacklogItemStatusFromLinks } from '../utils/backlogLinks'
import { createRendererHost } from './renderer-host'
import type {
  NormalizedIssue,
  TrackerError,
  TrackerFetchIssueInput,
  TrackerFetchIssueResult,
  TrackerProviderId,
} from '../../../shared/electron-api'
import {
  createTrackerIssueLinkProviders,
  openTrackerIssueLink,
  proxyConnectionIdForItem,
  resolveTrackerIssueLink,
  TRACKER_ISSUE_LINK_OWNER_MODULE_ID,
  TRACKER_ISSUE_TARGET_KIND,
} from './trackerBacklogLinks'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function proxyItem(overrides: {
  connectionId?: string | null
  link: BacklogItemLink
  extraLinks?: BacklogItemLink[]
  status?: BacklogItem['status']
}): BacklogItem {
  const frontmatter = overrides.connectionId === null
    ? '---\ntype: bug\n---\n'
    : `---\ntype: bug\nexternal_provider: jira\nexternal_connection: ${overrides.connectionId ?? 'conn-1'}\n---\n`
  return {
    id: 'backlog/PROJ-141.md',
    objectId: 'backlog_proj141',
    path: '/repo/backlog/PROJ-141.md',
    relativePath: 'backlog/PROJ-141.md',
    title: 'Relay ledger grows unbounded',
    kind: 'unknown',
    status: overrides.status ?? 'in_progress',
    isEpic: false,
    metadata: {},
    links: [overrides.link, ...(overrides.extraLinks ?? [])],
    excerpt: '',
    modifiedAt: 1,
    createdAtMs: 1,
    size: 1,
    sourceContent: `${frontmatter}# Relay ledger grows unbounded\n`,
  }
}

function issueLink(provider: TrackerProviderId, overrides: Partial<BacklogItemLink> = {}): BacklogItemLink {
  return {
    id: 'tracker:issue',
    moduleId: 'tracker',
    type: 'issue',
    label: 'PROJ-141',
    target: {
      kind: TRACKER_ISSUE_TARGET_KIND[provider],
      id: '10023',
      url: 'https://jira.acme-corp.net/browse/PROJ-141',
    },
    ...overrides,
  }
}

function normalizedIssue(category: 'open' | 'closed'): NormalizedIssue {
  return {
    provider: 'jira',
    connectionId: 'conn-1',
    externalId: '10023',
    nativeKey: 'PROJ-141',
    title: 'Relay ledger grows unbounded',
    bodyMarkdown: 'body',
    state: { category, nativeName: category === 'closed' ? 'Done' : 'To Do' },
    labels: [],
    url: 'https://jira.acme-corp.net/browse/PROJ-141',
    comments: [],
  }
}

function okResult(category: 'open' | 'closed'): TrackerFetchIssueResult {
  return { ok: true, issue: normalizedIssue(category) }
}

function errResult(error: TrackerError): TrackerFetchIssueResult {
  return { ok: false, error }
}

const NEVER_FETCH = async (): Promise<TrackerFetchIssueResult> => {
  throw new Error('fetchIssue should not be called')
}

async function run(): Promise<void> {
  // -- Registration & ownership --------------------------------------------
  {
    const providers = createTrackerIssueLinkProviders({
      fetchIssue: NEVER_FETCH,
      openExternal: async () => ({ ok: true }),
    })
    assert.equal(providers.length, 3, 'one provider per tracker')
    assert.deepEqual(
      providers.flatMap((p) => p.targetKinds).sort(),
      ['github.issue', 'jira.issue', 'linear.issue'],
      'exact target kinds the T6 writer stamps',
    )
    assert.ok(
      providers.every((p) => p.moduleId === TRACKER_ISSUE_LINK_OWNER_MODULE_ID),
      'every provider is owned by the Backlog module',
    )
    assert.ok(providers.every((p) => p.targetKinds.length === 1), 'each provider owns exactly one kind')

    // Registers cleanly on a real host, and each kind resolves back to a provider.
    const host = createRendererHost()
    const backlogHost = host.hostFor(TRACKER_ISSUE_LINK_OWNER_MODULE_ID)
    for (const provider of providers) backlogHost.registerBacklogLinkProvider(provider)
    const registered = host.getBacklogLinkProviders()
    for (const kind of Object.values(TRACKER_ISSUE_TARGET_KIND)) {
      assert.ok(
        registered.some((p) => p.targetKinds.includes(kind)),
        `kind ${kind} is registered`,
      )
    }

    // Duplicate target-kind registration is rejected by the host (ownership).
    assert.throws(
      () => backlogHost.registerBacklogLinkProvider(providers[0]!),
      /already owned/,
      'a second provider for the same kind is refused',
    )

    // A provider registered under the wrong module is refused.
    assert.throws(
      () => host.hostFor('sprint-engine').registerBacklogLinkProvider(providers[0]!),
      /must be registered by its owning module/,
    )
  }

  // -- Status mapping per provider -----------------------------------------
  for (const provider of ['github', 'jira', 'linear'] as const) {
    const item = proxyItem({ link: issueLink(provider) })

    const open = await resolveTrackerIssueLink({
      workspaceId: 'w', workspaceRoot: '/repo', item, link: item.links[0]!,
      fetchIssue: async () => okResult('open'),
    })
    assert.equal(open.status, 'active', `${provider}: open → active`)
    assert.equal(open.type, 'issue', `${provider}: resolved link stays issue-typed`)
    assert.equal(open.canOpen, true, `${provider}: openable by URL`)
    assert.equal(open.unavailableReason, undefined, `${provider}: no reason when readable`)

    const closed = await resolveTrackerIssueLink({
      workspaceId: 'w', workspaceRoot: '/repo', item, link: item.links[0]!,
      fetchIssue: async () => okResult('closed'),
    })
    assert.equal(closed.status, 'completed', `${provider}: closed → completed`)
  }

  // -- fetchIssue receives the frontmatter connection + link externalId -----
  {
    const item = proxyItem({ connectionId: 'conn-42', link: issueLink('jira', { target: {
      kind: 'jira.issue', id: 'ENG-9', url: 'https://x/ENG-9',
    } }) })
    let seen: TrackerFetchIssueInput | null = null
    await resolveTrackerIssueLink({
      workspaceId: 'w', workspaceRoot: '/repo', item, link: item.links[0]!,
      fetchIssue: async (input) => { seen = input; return okResult('open') },
    })
    assert.deepEqual(seen, { connectionId: 'conn-42', externalId: 'ENG-9' })
  }

  // -- Auth-missing / unreachable path — unknown WITH reason, still openable
  {
    const item = proxyItem({ link: issueLink('github') })
    const cases: Array<[TrackerError, string]> = [
      [{ kind: 'auth', message: '401' }, 'sign-in expired'],
      [{ kind: 'not_configured', message: 'no connection' }, 'connection removed'],
      [{ kind: 'not_found', message: 'gone' }, 'connection removed'],
      [{ kind: 'network', message: 'timeout' }, 'network unavailable'],
      [{ kind: 'rate_limit', message: '429' }, 'rate limited'],
    ]
    for (const [error, needle] of cases) {
      const resolved = await resolveTrackerIssueLink({
        workspaceId: 'w', workspaceRoot: '/repo', item, link: item.links[0]!,
        fetchIssue: async () => errResult(error),
      })
      assert.equal(resolved.status, 'unknown', `${error.kind} → unknown`)
      assert.equal(resolved.canOpen, true, `${error.kind}: still openable by URL — never fake success`)
      assert.ok(
        resolved.unavailableReason?.includes(needle),
        `${error.kind}: visible reason mentions "${needle}", got "${resolved.unavailableReason}"`,
      )
    }

    // A thrown IPC rejection also degrades to unknown, not a crash.
    const thrown = await resolveTrackerIssueLink({
      workspaceId: 'w', workspaceRoot: '/repo', item, link: item.links[0]!,
      fetchIssue: async () => { throw new Error('bridge gone') },
    })
    assert.equal(thrown.status, 'unknown')
    assert.ok(thrown.unavailableReason?.includes('bridge gone'))
  }

  // -- Missing connection / id: unknown without ever querying the tracker ---
  {
    const noConn = proxyItem({ connectionId: null, link: issueLink('linear') })
    const resolved = await resolveTrackerIssueLink({
      workspaceId: 'w', workspaceRoot: '/repo', item: noConn, link: noConn.links[0]!,
      fetchIssue: NEVER_FETCH,
    })
    assert.equal(resolved.status, 'unknown')
    assert.ok(resolved.unavailableReason?.includes('no saved connection'))
    assert.equal(proxyConnectionIdForItem(noConn), null)

    // An unknown link with no URL is not openable — no fabricated affordance.
    const noUrl = proxyItem({ connectionId: null, link: issueLink('linear', { target: {
      kind: 'linear.issue', id: 'ENG-1', url: undefined,
    } }) })
    const resolvedNoUrl = await resolveTrackerIssueLink({
      workspaceId: 'w', workspaceRoot: '/repo', item: noUrl, link: noUrl.links[0]!,
      fetchIssue: NEVER_FETCH,
    })
    assert.equal(resolvedNoUrl.canOpen, false)
  }

  // -- Lifecycle neutrality: a closed issue never moves item status ---------
  {
    // Proxy item on a live run: an execution run link (active) + a closed issue
    // link. The issue resolving to completed must NOT complete the item — only the
    // execution link drives status, so the item stays in_progress.
    const runLink: BacklogItemLink = {
      id: 'sprint-engine:run', moduleId: 'sprint-engine', type: 'execution',
      label: 'Sprint Engine run', target: { kind: 'sprintengine.run', id: 'run', path: 'run.yaml' },
      status: 'active',
    }
    const item = proxyItem({ link: issueLink('jira'), extraLinks: [runLink], status: 'in_progress' })
    const resolvedIssue = await resolveTrackerIssueLink({
      workspaceId: 'w', workspaceRoot: '/repo', item, link: item.links[0]!,
      fetchIssue: async () => okResult('closed'),
    })
    assert.equal(resolvedIssue.status, 'completed')
    // Derive item status from BOTH resolved links: the completed issue link and
    // the active run link. Execution-only derivation keeps it in_progress.
    const next = nextBacklogItemStatusFromLinks('in_progress', [resolvedIssue, runLink])
    assert.equal(next, 'in_progress', 'a closed ticket does not complete the item')

    // Even with ONLY a completed issue link (no run link), status is untouched:
    // there is no execution link to move it.
    const issueOnly = nextBacklogItemStatusFromLinks('in_progress', [resolvedIssue])
    assert.equal(issueOnly, 'in_progress', 'an issue link alone never drives status')
  }

  // -- openLink opens the tracker URL --------------------------------------
  {
    const item = proxyItem({ link: issueLink('jira') })
    let opened: string | null = null
    const ok = await openTrackerIssueLink({
      workspaceId: 'w', workspaceRoot: '/repo', item, link: item.links[0]!,
      openExternal: async (url) => { opened = url; return { ok: true } },
    })
    assert.equal(ok, true)
    assert.equal(opened, 'https://jira.acme-corp.net/browse/PROJ-141')

    // No URL → nothing to open.
    const noUrl = proxyItem({ link: issueLink('jira', { target: { kind: 'jira.issue', id: '1', url: undefined } }) })
    const noneOpened = await openTrackerIssueLink({
      workspaceId: 'w', workspaceRoot: '/repo', item: noUrl, link: noUrl.links[0]!,
      openExternal: async () => { throw new Error('should not open') },
    })
    assert.equal(noneOpened, false)

    // A failed open is reported, not swallowed as success.
    const failedOpen = await openTrackerIssueLink({
      workspaceId: 'w', workspaceRoot: '/repo', item, link: item.links[0]!,
      openExternal: async () => ({ ok: false }),
    })
    assert.equal(failedOpen, false)
  }

  // -- Coalescing: concurrent resolves of one issue hit IPC once ------------
  {
    let calls = 0
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { release = resolve })
    const providers = createTrackerIssueLinkProviders({
      fetchIssue: async () => { calls += 1; await gate; return okResult('open') },
      openExternal: async () => ({ ok: true }),
    })
    const jira = providers.find((p) => p.targetKinds.includes('jira.issue'))!
    const item = proxyItem({ link: issueLink('jira') })
    const input = { workspaceId: 'w', workspaceRoot: '/repo', item, link: item.links[0]! }
    const a = jira.resolveLinkStatus(input)
    const b = jira.resolveLinkStatus(input)
    release!()
    const [ra, rb] = await Promise.all([a, b])
    assert.equal(calls, 1, 'two concurrent resolves share one IPC round-trip')
    assert.equal(ra.status, 'active')
    assert.equal(rb.status, 'active')

    // After settling, a fresh resolve re-reads (no stale cache across passes).
    await jira.resolveLinkStatus(input)
    assert.equal(calls, 2, 'a later pass re-queries live state')
  }

  console.log('trackerBacklogLinks.test.ts: all assertions passed')
}

void run()
