import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BUILTIN_AUTOMATIONS,
  builtinAutomationById,
  builtinAutomationPayload,
} from './builtin'
import { SCHEDULE_TRIGGER_KIND, SPAWN_AGENT_ACTION_KIND } from './contracts'
import { automationScheduleWords } from './scheduleWords'

// The five that ship inside the app (Extensions drawer ruling, 2026-09-05, frame
// 4). What is pinned here is what the rest of the feature stands on: that there
// are five, that each has the stable id a project's copy records as its
// provenance, and that the payload handed to the write path is a definition the
// parse will accept. A sixth added without its id, or an id typo, would break
// "already added" silently — the copy would be written a second time and nobody
// would see an error.

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

run('five automations ship, in schedule order, each marked built in', () => {
  assert.equal(BUILTIN_AUTOMATIONS.length, 5)
  assert.deepEqual(
    BUILTIN_AUTOMATIONS.map((entry) => entry.name),
    ['Dead code sweep', 'Duplication review', 'Unit test coverage', 'UI & UX review', 'Merged-PR seam review'],
  )
  for (const entry of BUILTIN_AUTOMATIONS) {
    assert.equal(entry.builtin, true, `${entry.name} carries the built-in marker`)
  }
})

// The id is the identity a project's copy records as `sourceCatalogueId`, and it
// is deliberately the marketplace plugin id these five were published under, so a
// project that added one from the old Plugins shelf is recognised rather than
// gaining a duplicate. Changing one of these strings orphans every copy already
// on disk, which is why they are written out here rather than derived.
run('every id is the stable one a project records, and no two are alike', () => {
  const ids = BUILTIN_AUTOMATIONS.map((entry) => entry.id)
  assert.deepEqual(ids, [
    'dead-code-sweep-automation',
    'duplication-review-automation',
    'unit-test-coverage-automation',
    'ui-ux-review-automation',
    'merged-pr-seam-review-automation',
  ])
  assert.equal(new Set(ids).size, ids.length)
})

run('each is a schedule trigger and an agent action with a real prompt', () => {
  for (const entry of BUILTIN_AUTOMATIONS) {
    assert.equal(entry.trigger.kind, SCHEDULE_TRIGGER_KIND, `${entry.name} is scheduled`)
    assert.equal(entry.trigger.config.kind, SCHEDULE_TRIGGER_KIND)
    assert.equal(entry.action.kind, SPAWN_AGENT_ACTION_KIND, `${entry.name} runs an agent`)
    assert.ok(entry.action.config.prompt.trim().length > 200, `${entry.name} carries its full prompt`)
    assert.ok(entry.description.trim().length > 40, `${entry.name} has a description to lead the card with`)
    assert.equal(entry.status, 'enabled')
    // Absent, not `true`: `absent ⇒ true` is the single place that answer lives
    // (AutomationDefinition), and stamping it here would be a second one.
    assert.equal(entry.runInWorktree, undefined, `${entry.name} leaves the worktree default where it lives`)
  }
})

run('the schedules read as the words the rail shows', () => {
  assert.deepEqual(
    BUILTIN_AUTOMATIONS.map((entry) => automationScheduleWords(entry.trigger)),
    ['Nightly 02:00', 'Nightly 02:30', 'Nightly 03:00', 'Nightly 03:30', 'Daily 18:00'],
  )
})

// The payload is what reaches `installFromCatalogue`, and that path owns the
// rest: it drops `status`/`runInWorktree`, localises the schedule, and stamps the
// provenance. So the payload must carry the definition and NOTHING else — an id
// smuggled through here would become the automation's id and collide across
// projects.
run('the install payload is the definition, and carries no id', () => {
  for (const entry of BUILTIN_AUTOMATIONS) {
    const payload = builtinAutomationPayload(entry) as Record<string, unknown>
    assert.deepEqual(Object.keys(payload).sort(), ['action', 'name', 'status', 'trigger'])
    assert.equal(payload.name, entry.name)
    assert.equal((payload as { id?: unknown }).id, undefined)
  }
})

run('a built-in is found by its id, and an unknown id is null, not a guess', () => {
  assert.equal(builtinAutomationById('dead-code-sweep-automation')?.name, 'Dead code sweep')
  assert.equal(builtinAutomationById('nothing-like-this'), null)
  assert.equal(builtinAutomationById(''), null)
})

// These records were generated from the marketplace payloads and must stay their
// equal: the module is the copy that ships, and a drift between the two is a
// prompt the app runs that nobody reviewed. When the marketplace copies are
// finally removed this test goes with them — until then it is the guard.
run('each record still matches the marketplace payload it was generated from', () => {
  // From the cwd, not from `__dirname`: the bundled test file lives under
  // node_modules/.cache, which in a git worktree resolves back into the main
  // checkout — this must read the marketplace copies of the checkout it is
  // testing.
  const plugins = join(process.cwd(), 'resources', 'marketplace', 'plugins')
  for (const entry of BUILTIN_AUTOMATIONS) {
    const source = JSON.parse(
      readFileSync(join(plugins, entry.id, 'automation', 'automation.json'), 'utf8'),
    ) as { name: string; status: string; trigger: unknown; action: { config: { prompt: string } } }
    assert.equal(entry.name, source.name, `${entry.id} name`)
    assert.equal(entry.status, source.status, `${entry.id} status`)
    assert.deepEqual(entry.trigger, source.trigger, `${entry.id} trigger`)
    assert.equal(entry.action.config.prompt, source.action.config.prompt, `${entry.id} prompt`)
  }
})

console.log('all built-in automation catalogue tests passed')
