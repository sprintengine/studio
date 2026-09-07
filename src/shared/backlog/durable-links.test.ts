import assert from 'node:assert/strict'

import {
  durableBacklogLinkFields,
  durableBacklogLinksFromFrontmatter,
  isDurableBacklogLink,
  mergeBacklogLinks,
  sprintRunPath,
} from './durable-links'
import type { BacklogItemLink } from './scan'

// The migration off items.json is only safe if the scalars reproduce the links
// they replaced. Round-trip is therefore the central property: links -> fields
// -> links must be a fixed point for everything this module claims as durable.
function roundTrip(links: BacklogItemLink[]): BacklogItemLink[] {
  const fields = durableBacklogLinkFields(links)
  const asFrontmatter: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null) asFrontmatter[key] = value
  }
  return durableBacklogLinksFromFrontmatter(asFrontmatter)
}

function main(): void {
  // --- A sprint run link, the commonest durable link (199 of them in the repo
  // this was migrated from).
  const run: BacklogItemLink = {
    id: 'sprint-engine:2026-08-04-sprint-worktree-mode-unreachable',
    moduleId: 'sprint-engine',
    type: 'execution',
    label: 'Sprint',
    target: {
      kind: 'sprintengine.run',
      id: '2026-08-04-sprint-worktree-mode-unreachable',
      path: sprintRunPath('2026-08-04-sprint-worktree-mode-unreachable'),
    },
  }
  assert.deepEqual(roundTrip([run]), [run], 'a run link survives the scalar round trip')

  // --- The task suffix an epic child carries (MC-2017).
  const child: BacklogItemLink = {
    ...run,
    target: { ...run.target, taskId: 'T3' },
  }
  assert.deepEqual(roundTrip([child]), [child], 'the owning task id survives')
  assert.equal(durableBacklogLinkFields([child]).sprints, '2026-08-04-sprint-worktree-mode-unreachable#T3')

  // --- A pull request link.
  const pr: BacklogItemLink = {
    id: 'sprint-engine:pull-request',
    moduleId: 'sprint-engine',
    type: 'external',
    label: 'Pull request',
    target: {
      kind: 'sprintengine.pullRequest',
      id: 'https://github.com/sprintengine/studio/pull/91',
      url: 'https://github.com/sprintengine/studio/pull/91',
    },
  }
  assert.deepEqual(roundTrip([pr]), [pr], 'a PR link survives the scalar round trip')

  // --- Several links on one item, the real shape of a worked item.
  assert.deepEqual(roundTrip([run, pr]), [run, pr], 'runs and PRs coexist and keep their order')

  // --- Volatile links are refused, so they can never be written to a tracked
  // file. An agent terminal id is meaningless after a restart.
  const agent: BacklogItemLink = {
    id: 'agent-runtime:working-agent',
    moduleId: 'agent-runtime',
    type: 'agent',
    label: 'Agent: Lir Lynch',
    target: { kind: 'agent.terminal', id: 'Qe0egohSVXTFIuUo2fddr/specialist-performance-N7GROJ' },
  }
  assert.equal(isDurableBacklogLink(agent), false, 'an agent terminal link is not durable')
  assert.deepEqual(durableBacklogLinkFields([agent]), { sprints: null, pr: null })
  assert.deepEqual(roundTrip([agent]), [], 'a volatile link contributes no frontmatter')

  // --- Status never reaches frontmatter, even when the caller hands one over.
  // It is re-resolved from the world, and persisting it is what used to churn a
  // tracked file on every tick.
  const resolved: BacklogItemLink = { ...run, status: 'active', updatedAt: '2026-09-07T00:00:00.000Z' }
  const fields = durableBacklogLinkFields([resolved])
  assert.doesNotMatch(fields.sprints ?? '', /active/, 'no status leaks into the scalar')
  assert.deepEqual(roundTrip([resolved]), [run], 'the round trip drops volatile status and timestamp')

  // --- Clearing. A removed link must remove its line, not leave a stale one.
  assert.deepEqual(durableBacklogLinkFields([]), { sprints: null, pr: null })

  // --- A run spanning projects opens one PR per project (MC-1612). The primary
  // keeps the bare link id it has always had; a sibling is addressed by its repo
  // id, matching sprintEnginePullRequestLinkId rather than a scheme of our own.
  const multi = durableBacklogLinksFromFrontmatter({ pr: 'https://x.test/pull/1,web=https://x.test/pull/2' })
  assert.equal(multi.length, 2)
  assert.deepEqual(multi.map((link) => link.id), ['sprint-engine:pull-request', 'sprint-engine:pull-request:web'])
  assert.equal(multi[1].label, 'Pull request (web)', 'a sibling PR names its project')
  // And back again, so a multi-project item survives the round trip intact.
  assert.equal(durableBacklogLinkFields(multi).pr, 'https://x.test/pull/1,web=https://x.test/pull/2')

  // --- Tolerance for hand-edited frontmatter: blanks, padding, trailing commas.
  assert.deepEqual(durableBacklogLinksFromFrontmatter({ sprints: '  , a-run ,, ' }).map((l) => l.target.id), ['a-run'])
  assert.deepEqual(durableBacklogLinksFromFrontmatter({}), [], 'no keys means no links')
  assert.deepEqual(durableBacklogLinksFromFrontmatter({ sprints: '', pr: '' }), [], 'empty scalars mean no links')
  assert.deepEqual(durableBacklogLinksFromFrontmatter({ sprints: '#T1' }), [], 'a task id with no run is not a link')

  // --- Duplicates collapse rather than producing two identical scalars.
  assert.equal(durableBacklogLinkFields([run, run]).sprints, run.target.id)

  // --- Recombining the halves. The durable link keeps its identity and takes
  // only its volatile fields from the cache.
  const cachedRun: BacklogItemLink = {
    ...run,
    label: 'ignored — the durable half owns the label',
    status: 'completed',
    priorStatus: 'ready',
    updatedAt: '2026-09-07T10:00:00.000Z',
  }
  const merged = mergeBacklogLinks([run], [cachedRun, agent])
  assert.equal(merged.length, 2, 'the cache-only agent link is appended')
  assert.equal(merged[0].label, 'Sprint', 'the durable half wins on identity fields')
  assert.equal(merged[0].status, 'completed', 'and takes the resolved status from cache')
  assert.equal(merged[0].priorStatus, 'ready')
  assert.equal(merged[0].updatedAt, '2026-09-07T10:00:00.000Z')
  assert.equal(merged[1].id, 'agent-runtime:working-agent')

  // A durable link with nothing cached carries no status: unresolved, which is
  // what it is. Losing the cache costs a lookup, never data.
  assert.deepEqual(mergeBacklogLinks([run], []), [run])
  assert.equal(mergeBacklogLinks([run], [])[0].status, undefined)

  console.log('durable-links: ok')
}

main()
