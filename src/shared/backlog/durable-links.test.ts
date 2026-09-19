import assert from 'node:assert/strict'

import {
  durableBacklogLinkFields,
  durableBacklogLinksFromFrontmatter,
  isDurableBacklogLink,
  mergeBacklogLinks,
} from './durable-links'
import type { BacklogItemLink } from './scan'
import { test } from 'vitest'

test('durable-links', async () => {
  // The move off items.json is only safe if the scalars reproduce the links they
  // replaced. Round-trip is therefore the central property: links -> fields ->
  // links must be a fixed point for everything this module claims as durable.
  function roundTrip(links: BacklogItemLink[]): BacklogItemLink[] {
    const fields = durableBacklogLinkFields(links)
    const asFrontmatter: Record<string, string> = {}
    for (const [key, value] of Object.entries(fields)) {
      if (value !== null) asFrontmatter[key] = value
    }
    return durableBacklogLinksFromFrontmatter(asFrontmatter)
  }

  function main(): void {
    // --- A pull request link: the one durable link the Backlog itself owns.
    const pr: BacklogItemLink = {
      id: 'backlog:pull-request',
      moduleId: 'backlog',
      type: 'external',
      label: 'Pull request',
      target: {
        kind: 'backlog.pullRequest',
        id: 'https://github.com/sprintengine/studio/pull/91',
        url: 'https://github.com/sprintengine/studio/pull/91',
      },
    }
    assert.deepEqual(roundTrip([pr]), [pr], 'a PR link survives the scalar round trip')
    assert.equal(isDurableBacklogLink(pr), true)

    // --- Volatile links are refused, so they can never be written to a tracked
    // file. An agent terminal id is meaningless after a restart.
    const agent: BacklogItemLink = {
      id: 'agent-runtime:working-agent',
      moduleId: 'agent-runtime',
      type: 'agent',
      label: 'Agent: Lir Lynch',
      target: { kind: 'agent.terminal', id: 'Qe0egohSVXTFIuUo2fddr/agent-N7GROJ' },
    }
    assert.equal(isDurableBacklogLink(agent), false, 'an agent terminal link is not durable')
    assert.deepEqual(durableBacklogLinkFields([agent]), { pr: null })
    assert.deepEqual(roundTrip([agent]), [], 'a volatile link contributes no frontmatter')

    // --- Status never reaches frontmatter, even when the caller hands one over.
    // It is re-resolved from the world, and persisting it is what used to churn a
    // tracked file on every tick.
    const resolved: BacklogItemLink = { ...pr, status: 'active', updatedAt: '2026-09-07T00:00:00.000Z' }
    const fields = durableBacklogLinkFields([resolved])
    assert.doesNotMatch(fields.pr ?? '', /active/, 'no status leaks into the scalar')
    assert.deepEqual(roundTrip([resolved]), [pr], 'the round trip drops volatile status and timestamp')

    // --- Clearing. A removed link must remove its line, not leave a stale one.
    assert.deepEqual(durableBacklogLinkFields([]), { pr: null })

    // --- An item spanning projects carries one PR per project. The
    // primary keeps the bare link id it has always had; a sibling is addressed by
    // its repo id.
    const multi = durableBacklogLinksFromFrontmatter({ pr: 'https://x.test/pull/1,web=https://x.test/pull/2' })
    assert.equal(multi.length, 2)
    assert.deepEqual(
      multi.map((link) => link.id),
      ['backlog:pull-request', 'backlog:pull-request:web'],
    )
    assert.equal(multi[1].label, 'Pull request (web)', 'a sibling PR names its project')
    // And back again, so a multi-project item survives the round trip intact.
    assert.equal(durableBacklogLinkFields(multi).pr, 'https://x.test/pull/1,web=https://x.test/pull/2')

    // --- Tolerance for hand-edited frontmatter: blanks, padding, trailing commas.
    assert.deepEqual(
      durableBacklogLinksFromFrontmatter({ pr: '  , https://x.test/pull/3 ,, ' }).map((l) => l.target.id),
      ['https://x.test/pull/3'],
    )
    assert.deepEqual(durableBacklogLinksFromFrontmatter({}), [], 'no keys means no links')
    assert.deepEqual(durableBacklogLinksFromFrontmatter({ pr: '' }), [], 'empty scalars mean no links')
    assert.deepEqual(durableBacklogLinksFromFrontmatter({ pr: 'web=' }), [], 'a repo id with no url is not a link')

    // --- Duplicates collapse rather than producing two identical scalars.
    assert.equal(durableBacklogLinkFields([pr, pr]).pr, pr.target.url)

    // --- Recombining the halves. The durable link keeps its identity and takes
    // only its volatile fields from the cache.
    const cachedPr: BacklogItemLink = {
      ...pr,
      label: 'ignored — the durable half owns the label',
      status: 'completed',
      updatedAt: '2026-09-07T10:00:00.000Z',
    }
    const merged = mergeBacklogLinks([pr], [cachedPr, agent])
    assert.equal(merged.length, 2, 'the cache-only agent link is appended')
    assert.equal(merged[0].label, 'Pull request', 'the durable half wins on identity fields')
    assert.equal(merged[0].status, 'completed', 'and takes the resolved status from cache')
    assert.equal(merged[0].updatedAt, '2026-09-07T10:00:00.000Z')
    assert.equal(merged[1].id, 'agent-runtime:working-agent')

    // A durable link with nothing cached carries no status: unresolved, which is
    // what it is. Losing the cache costs a lookup, never data.
    assert.deepEqual(mergeBacklogLinks([pr], []), [pr])
    assert.equal(mergeBacklogLinks([pr], [])[0].status, undefined)

    console.log('durable-links: ok')
  }

  main()
})
