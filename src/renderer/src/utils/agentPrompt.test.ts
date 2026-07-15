import assert from 'node:assert/strict'
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

// MC-1593b: roles are user config, not architect-picked ceremony. The architect
// boundary is a single pool-shaped constraint on every dispatch — the run's
// configuredRoles plus raise-needs_input-instead-of-inventing — and the old
// "Your Run's Team — You Pick It" / roster.configure block is gone from every path.

run('architect boundary states the run roles and forbids inventing new ones', () => {
  const prompt = buildSprintEngineStartupPrompt('architect', 'architect', 'Ship checkout', {
    commandMode: 'init',
    configuredRoles: ['architect', 'developer', 'tester'],
  })
  assert.ok(prompt.includes("Your run's roles are: architect, developer, tester"))
  assert.ok(prompt.includes('raise needs_input to the user rather than adding the role'))
  // No architect-picks-the-team ceremony survives.
  assert.ok(!prompt.includes('sprintengine.roster.configure'))
  assert.ok(!prompt.includes('You Pick It'))
  // Autonomous-payload invariant: no statePath/workspaceRoot in the composed text.
  assert.ok(!prompt.includes('statePath'))
  assert.ok(!prompt.includes('workspaceRoot'))
})

run('the same boundary rides an architect wake (join), not just init', () => {
  const wake = buildSprintEngineStartupPrompt('architect', 'architect', 'Ship checkout', {
    commandMode: 'join',
    configuredRoles: ['architect', 'developer'],
  })
  assert.ok(wake.includes("Your run's roles are: architect, developer"))
  assert.ok(!wake.includes('sprintengine.roster.configure'))
})

run('a non-architect worker never receives the run-roles boundary', () => {
  const worker = buildSprintEngineStartupPrompt('developer', 'developer-1', 'Ship checkout', {
    commandMode: 'join',
    configuredRoles: ['architect', 'developer'],
  })
  assert.ok(!worker.includes("Your run's roles are:"))
})

run('architect boundary is omitted when the run has no configured roles', () => {
  const prompt = buildSprintEngineStartupPrompt('architect', 'architect', 'Ship checkout', {
    commandMode: 'init',
  })
  assert.ok(!prompt.includes("Your run's roles are:"))
})

console.log('all agentPrompt boundary tests passed')
