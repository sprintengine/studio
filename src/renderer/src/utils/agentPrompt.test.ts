import assert from 'node:assert/strict'
import type { SprintEngineModelCatalogEntry } from '../types/workspace'
import { buildSprintEngineStartupPrompt } from './agentPrompt'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function catalogEntry(overrides: Partial<SprintEngineModelCatalogEntry>): SprintEngineModelCatalogEntry {
  return {
    cli: 'claude-code',
    model: 'claude-fable-5',
    offeredByDefault: true,
    intelligence: 9,
    frontendDesign: 8,
    mobile: 6,
    speed: 4,
    cost: 10,
    ...overrides,
  }
}

// The sprint palette the architect may assign from, joined to catalog scores.
const CATALOG: SprintEngineModelCatalogEntry[] = [
  catalogEntry({ cli: 'claude-code', model: 'claude-fable-5', intelligence: 9, cost: 10, note: 'strongest reasoning and design' }),
  catalogEntry({ cli: 'zai', model: null, intelligence: 5, frontendDesign: 4, mobile: 3, speed: 8, cost: 1 }),
  // An entry NOT ticked for this run — must never leak into the prompt.
  catalogEntry({ cli: 'claude-code', model: 'claude-haiku-4-5', intelligence: 4, cost: 1 }),
]

run('architect-roster prompt lists exactly the ticked palette with catalog scores', () => {
  const prompt = buildSprintEngineStartupPrompt('architect', 'architect', 'Ship checkout', {
    commandMode: 'init',
    rosterSource: 'architect',
    allowedRuntimes: [
      { cli: 'claude-code', model: 'claude-fable-5' },
      { cli: 'zai', model: null },
    ],
    modelCatalog: CATALOG,
    architectGuidance: 'Quality matters — don’t skimp on reviews.',
  })

  // One line per ticked entry, with the joined catalog scores + note verbatim.
  assert.ok(prompt.includes('- claude-code / claude-fable-5 — intelligence 9 · frontend design 8 · mobile 6 · speed 4 · cost 10x — strongest reasoning and design'))
  // model: null renders as the CLI default, still scored.
  assert.ok(prompt.includes('- zai / (CLI default) — intelligence 5 · frontend design 4 · mobile 3 · speed 8 · cost 1x'))
  // The unticked catalog entry never appears.
  assert.ok(!prompt.includes('claude-haiku-4-5'))
  // Guidance line quoted verbatim.
  assert.ok(prompt.includes('The user\'s guidance for this sprint: "Quality matters — don’t skimp on reviews."'))
  // Configure-then-plan instruction present; the fixed-roster boundary is replaced.
  assert.ok(prompt.includes('sprintengine.roster.configure'))
  assert.ok(!prompt.includes("Your run's roles are:"))
  // Autonomous-payload invariant: no statePath/workspaceRoot in the composed text.
  assert.ok(!prompt.includes('statePath'))
  assert.ok(!prompt.includes('workspaceRoot'))
})

run('guidance line omitted when unset', () => {
  const prompt = buildSprintEngineStartupPrompt('architect', 'architect', 'Ship checkout', {
    commandMode: 'init',
    rosterSource: 'architect',
    allowedRuntimes: [{ cli: 'claude-code', model: 'claude-fable-5' }],
    modelCatalog: CATALOG,
  })
  assert.ok(!prompt.includes('The user\'s guidance for this sprint'))
  assert.ok(prompt.includes('claude-fable-5'))
})

run('ticked entry with no catalog match degrades to a scoreless line, not a drop', () => {
  const prompt = buildSprintEngineStartupPrompt('architect', 'architect', 'Ship checkout', {
    commandMode: 'init',
    rosterSource: 'architect',
    allowedRuntimes: [{ cli: 'opencode', model: 'qwen3-coder' }],
    modelCatalog: CATALOG,
  })
  assert.ok(prompt.includes('- opencode / qwen3-coder — scores not in your model catalog'))
})

run('user-mode prompt is unaffected by architect-roster fields (regression)', () => {
  const userOpts = {
    commandMode: 'init' as const,
    configuredRoles: ['architect', 'developer', 'tester'] as Array<'architect' | 'developer' | 'tester'>,
  }
  const baseline = buildSprintEngineStartupPrompt('architect', 'architect', 'Ship checkout', userOpts)
  // Passing the architect-roster payload while rosterSource stays 'user' (or
  // absent) must produce byte-identical output — the branch is gated on
  // rosterSource === 'architect' only.
  const withNoiseUser = buildSprintEngineStartupPrompt('architect', 'architect', 'Ship checkout', {
    ...userOpts,
    rosterSource: 'user',
    allowedRuntimes: [{ cli: 'claude-code', model: 'claude-fable-5' }],
    modelCatalog: CATALOG,
    architectGuidance: 'ignored in user mode',
  })
  const withNoiseAbsent = buildSprintEngineStartupPrompt('architect', 'architect', 'Ship checkout', {
    ...userOpts,
    allowedRuntimes: [{ cli: 'claude-code', model: 'claude-fable-5' }],
    modelCatalog: CATALOG,
    architectGuidance: 'ignored in user mode',
  })
  assert.equal(withNoiseUser, baseline)
  assert.equal(withNoiseAbsent, baseline)
  // And it keeps the fixed-roster boundary line.
  assert.ok(baseline.includes("Your run's roles are: architect, developer, tester"))
  assert.ok(!baseline.includes('sprintengine.roster.configure'))
})

console.log('all agentPrompt architect-roster tests passed')
