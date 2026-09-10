import assert from 'node:assert/strict'
import {
  commandMatchesQuery,
  comparePaletteMatches,
  groupInScope,
  orderPaletteCommands,
  PALETTE_GROUP_ORDER,
  PALETTE_SCORE,
  paletteGroupRank,
  scoreCommandMatch,
  workspaceKeywordsFromDefinition,
  type PaletteCommandGroup,
  type PaletteRankable,
} from './commandPaletteSearch'
import { createRendererHost } from '../modules/renderer-host'
import { registerAutomationsWorkspaceTypes } from '../modules/automations-workspace-types'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

run('workspaceKeywordsFromDefinition joins label + curated search terms', () => {
  assert.equal(
    workspaceKeywordsFromDefinition({ label: 'Sprint Engine', searchTerms: ['roster', 'kanban'] }, 'sprintengine'),
    'Sprint Engine roster kanban',
  )
})

run('workspaceKeywordsFromDefinition tolerates a definition with no search terms', () => {
  assert.equal(workspaceKeywordsFromDefinition({ label: 'Standard' }, 'standard'), 'Standard')
})

run('workspaceKeywordsFromDefinition falls back to the raw mode id when unregistered', () => {
  assert.equal(workspaceKeywordsFromDefinition(null, 'future-plugin-mode'), 'future-plugin-mode')
  assert.equal(workspaceKeywordsFromDefinition(undefined, 'shell-mode'), 'shell-mode')
})

// The switch row's keyword field is where a workspace's mode terms live, so
// these assert the C2/C3 regression fix: typing a mode term surfaces the row
// even though neither the name (label) nor folder path (description) contains it.
const kanbanRow = {
  label: 'Switch to: API cleanup',
  description: '/Users/dev/work/acme-platform',
  keywords: workspaceKeywordsFromDefinition({ label: 'Sprint Engine', searchTerms: ['roster', 'kanban', 'inbox'] }, 'sprintengine'),
}

run('commandMatchesQuery matches a mode search term carried in keywords', () => {
  assert.equal(commandMatchesQuery(kanbanRow, 'kanban'), true)
  assert.equal(commandMatchesQuery(kanbanRow, 'inbox'), true)
  assert.equal(commandMatchesQuery(kanbanRow, 'sprint engine'), true)
})

run('commandMatchesQuery matches on the visible name and folder path too', () => {
  assert.equal(commandMatchesQuery(kanbanRow, 'api cleanup'), true)
  assert.equal(commandMatchesQuery(kanbanRow, 'acme-platform'), true)
})

run('commandMatchesQuery is case-insensitive and trims the query', () => {
  assert.equal(commandMatchesQuery(kanbanRow, '  KANBAN  '), true)
})

run('commandMatchesQuery returns false when nothing matches', () => {
  assert.equal(commandMatchesQuery(kanbanRow, 'nonexistent-term'), false)
})

run('commandMatchesQuery treats an empty query as matching every command', () => {
  assert.equal(commandMatchesQuery({ label: 'anything' }, ''), true)
  assert.equal(commandMatchesQuery({ label: 'anything' }, '   '), true)
})

run('commandMatchesQuery tolerates a command with no description or keywords', () => {
  assert.equal(commandMatchesQuery({ label: 'New Chat' }, 'chat'), true)
  assert.equal(commandMatchesQuery({ label: 'New Chat' }, 'kanban'), false)
})

// MC-1533: search modes are registry-derived — a module's REAL registered
// workspace type carries the terms the old hardcoded palette entries provided,
// so behavior for the existing modes is identical with the arrays gone.
run('workspace mode search terms derive from the live registry registration', () => {
  const kernel = createRendererHost()
  registerAutomationsWorkspaceTypes(kernel.hostFor('automations'))
  const keywords = workspaceKeywordsFromDefinition(kernel.getWorkspaceType('automations-host'), 'automations-host')
  const row = { label: 'Switch to: Ops automations', keywords }
  assert.equal(commandMatchesQuery(row, 'cron'), true)
  assert.equal(commandMatchesQuery(row, 'automations'), true)
  assert.equal(commandMatchesQuery(row, 'trigger'), true)
})

// The ⌘⇧F scope. `all` and `files` are one list filtered two ways, so the
// predicate is the whole difference between the launcher and Find-in-Path —
// and a group silently falling out of `all` would make ⌘K lose a source.
const ALL_GROUPS: PaletteCommandGroup[] = [
  'agents',
  'skills',
  'extensions',
  'commands',
  'actions',
  'files',
  'content',
]

run('the all scope admits every group, so ⌘K stays the full launcher', () => {
  ALL_GROUPS.forEach((group) => {
    assert.equal(groupInScope(group, 'all'), true, `${group} must be visible under the all scope`)
  })
})

run('the files scope admits exactly the two disk-backed groups', () => {
  assert.deepEqual(
    ALL_GROUPS.filter((group) => groupInScope(group, 'files')),
    ['files', 'content'],
  )
})

run('the files scope hides the launcher groups a code snippet would compete with', () => {
  assert.equal(groupInScope('commands', 'files'), false)
  assert.equal(groupInScope('actions', 'files'), false)
  assert.equal(groupInScope('agents', 'files'), false)
  assert.equal(groupInScope('skills', 'files'), false)
  assert.equal(groupInScope('extensions', 'files'), false)
})

// The terminal star's scope. It asks one question — "is there a skill or a
// plugin for this" — so it admits exactly the two groups that answer it and
// nothing a workspace name or a line of source could win.
run('the extensions scope admits exactly the skill and plugin groups', () => {
  assert.deepEqual(
    ALL_GROUPS.filter((group) => groupInScope(group, 'extensions')),
    ['skills', 'extensions'],
  )
})

run('every group is in the canonical order exactly once', () => {
  assert.deepEqual([...PALETTE_GROUP_ORDER].sort(), [...ALL_GROUPS].sort())
  assert.equal(new Set(PALETTE_GROUP_ORDER).size, PALETTE_GROUP_ORDER.length)
  assert.ok(paletteGroupRank('skills') < paletteGroupRank('content'))
})

// ── The scorer ───────────────────────────────────────────────────────────────
// The palette used to order by group alone, so an exact skill-name match sat
// wherever its group happened to fall, under a workspace whose folder path
// merely contained the letters. These are the four tiers that fixed it.

const scored = (fields: { label: string; description?: string; keywords?: string }, query: string) =>
  scoreCommandMatch(fields, query)

run('an exact name beats a prefix beats a word start beats a buried match', () => {
  assert.equal(scored({ label: 'backlog' }, 'backlog'), PALETTE_SCORE.labelExact)
  assert.equal(scored({ label: 'backlog triage' }, 'backlog'), PALETTE_SCORE.labelPrefix)
  assert.equal(scored({ label: 'Sprint backlog' }, 'backlog'), PALETTE_SCORE.labelWord)
  assert.equal(scored({ label: 'nobacklogging' }, 'backlog'), PALETTE_SCORE.labelSubstring)
})

run('a word start is a match after a separator, not one inside a word', () => {
  // "git" after a slash and after a dash starts a word; inside "digit" it does not.
  assert.equal(scored({ label: 'repo/git' }, 'git'), PALETTE_SCORE.labelWord)
  assert.equal(scored({ label: 'super-git' }, 'git'), PALETTE_SCORE.labelWord)
  assert.equal(scored({ label: 'digit' }, 'git'), PALETTE_SCORE.labelSubstring)
})

run('the visible name outranks every hidden field', () => {
  const inName = { label: 'Deploy notes' }
  const inDetail = { label: 'Something else', description: 'deploy notes for the release' }
  assert.ok(scored(inName, 'deploy') > scored(inDetail, 'deploy'))
  assert.equal(scored(inDetail, 'deploy'), PALETTE_SCORE.detailPrefix)
  assert.equal(scored({ label: 'x', keywords: 'kanban roster' }, 'roster'), PALETTE_SCORE.detailWord)
})

run('no match scores zero, and that is exactly what the matcher reads', () => {
  assert.equal(scored({ label: 'New Chat' }, 'kanban'), PALETTE_SCORE.none)
  assert.equal(commandMatchesQuery({ label: 'New Chat' }, 'kanban'), false)
  assert.equal(commandMatchesQuery({ label: 'New Chat' }, 'chat'), true)
})

run('an empty query scores every row the same, so the preview stays in group order', () => {
  assert.equal(scored({ label: 'anything' }, ''), PALETTE_SCORE.empty)
  assert.equal(scored({ label: 'other' }, '   '), PALETTE_SCORE.empty)
})

// ── Ordering ─────────────────────────────────────────────────────────────────

const row = (
  label: string,
  group: PaletteCommandGroup,
  extra: Partial<PaletteRankable> = {},
): PaletteRankable & { label: string } => ({ label, group, ...extra })

run('score wins over group order', () => {
  const exactSkill = row('telegram', 'skills')
  const commandWithItBuried = row('Open telegraph settings', 'commands')
  assert.deepEqual(
    orderPaletteCommands([commandWithItBuried, exactSkill], 'telegram').map((entry) => entry.label),
    ['telegram', 'Open telegraph settings'],
  )
})

run('what you already have comes before what you would have to install', () => {
  const available = row('review', 'skills', { installed: false })
  const installed = row('review', 'skills', { installed: true })
  assert.deepEqual(
    orderPaletteCommands([available, installed], 'review').map((entry) => entry.installed),
    [true, false],
  )
})

run('a row with no notion of installed is not ranked as though it were missing', () => {
  const command = row('review', 'commands')
  const installedSkill = row('review', 'skills', { installed: true })
  // Same score, neither sinks: the group order decides, and skills come first.
  assert.deepEqual(
    orderPaletteCommands([command, installedSkill], 'review').map((entry) => entry.group),
    ['skills', 'commands'],
  )
})

run('an available skill sinks below installed skills, not below the whole palette', () => {
  const available = row('review', 'skills', { installed: false })
  const plugin = row('review', 'extensions')
  // Both score the same; the plugin declares nothing about installation, so the
  // canonical group order decides and Skills still comes first.
  assert.deepEqual(
    orderPaletteCommands([plugin, available], 'review').map((entry) => entry.group),
    ['skills', 'extensions'],
  )
})

run('group order is the last tie-break, not the first', () => {
  const a = row('same', 'content')
  const b = row('same', 'agents')
  assert.equal(comparePaletteMatches(a, b, 'same') > 0, true, 'content sorts after agents on a tie')
  assert.equal(comparePaletteMatches(b, a, 'same') < 0, true)
})

run('ordering is stable, so a provider\'s own order survives a tie', () => {
  const rows = ['one', 'two', 'three'].map((label) => row(label, 'skills'))
  assert.deepEqual(orderPaletteCommands(rows, '').map((entry) => entry.label), ['one', 'two', 'three'])
})

console.log('commandPaletteSearch: all assertions passed')
