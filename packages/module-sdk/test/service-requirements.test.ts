// MODULE_SERVICE_REQUIREMENTS is the one place a module's permissions and
// dependencies are checked against what it resolves: the scaffold's smoke test
// reads it, and so do the `/testing` fakes. A smoke test with its own table went
// stale once (it kept checking a removed automations service and never checked
// the workspace context), so this reads the keys straight out of the SDK's
// source and fails when one has no row.
//
// The other direction — every row is a service the host lets a third-party
// module resolve — is the drift guard's (`npm run test:sdk:drift`), which can
// load the host's allow-list.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import { KNOWN_CAPABILITY_PERMISSIONS } from '../src/index.js'
import { dependsOnReaches, MODULE_SERVICE_REQUIREMENTS, moduleServiceRequirement } from '../src/services.js'

const SRC = join(process.cwd(), 'packages', 'module-sdk', 'src')

// Every service key the SDK resolves: a `createServiceToken('…')` or a
// `{ key: '…' }` token literal, in any source file but the table itself and
// the testing fakes keyed by it.
function resolvedKeys(): string[] {
  const keys = new Set<string>()
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith('.ts') || file === 'services.ts' || file.startsWith('testing')) continue
    const source = readFileSync(join(SRC, file), 'utf8')
    for (const match of source.matchAll(
      /createServiceToken<[^>]*>\(\s*['"]([^'"]+)['"]\s*\)|\{\s*key:\s*['"]([^'"]+)['"],?\s*\}/g,
    )) {
      keys.add((match[1] ?? match[2])!)
    }
  }
  return [...keys].sort()
}

test('every service key the SDK resolves has a row in MODULE_SERVICE_REQUIREMENTS', () => {
  const keys = resolvedKeys()
  assert.ok(keys.length >= 8, `found only ${keys.length} service keys in the SDK source; is the scan broken?`)
  const rows = MODULE_SERVICE_REQUIREMENTS.map((requirement) => requirement.key).sort()
  assert.deepEqual(rows, keys, 'add a row for each new service (and drop the row of a removed one)')
})

test('every row names permissions the SDK knows, and a provider a dependsOn can name', () => {
  for (const requirement of MODULE_SERVICE_REQUIREMENTS) {
    assert.ok(requirement.permissions.length > 0, `${requirement.key} needs at least one permission`)
    for (const permission of requirement.permissions) {
      assert.ok(
        KNOWN_CAPABILITY_PERMISSIONS.includes(permission),
        `${requirement.key}: unknown permission ${permission}`,
      )
    }
    assert.ok(dependsOnReaches([requirement.providedBy], requirement.providedBy))
  }
})

test('the rows the scaffold used to get wrong', () => {
  assert.deepEqual(moduleServiceRequirement('scheduled-agents.module-service'), {
    key: 'scheduled-agents.module-service',
    via: 'getScheduledAgentsService',
    permissions: ['scheduled-agents.manage'],
    providedBy: 'scheduled-agents',
    checked: false,
  })
  assert.deepEqual(moduleServiceRequirement('core.workspace-context')?.permissions, ['ipc:workspace-read'])
  assert.equal(moduleServiceRequirement('automations.module-service'), undefined, 'automations is gone')
  assert.equal(
    dependsOnReaches(['scheduled-agents'], 'agent-runtime'),
    true,
    'scheduled-agents loads after agent-runtime',
  )
  assert.equal(dependsOnReaches(['agent-runtime'], 'scheduled-agents'), false)
  assert.equal(dependsOnReaches(undefined, 'agent-runtime'), false)
})
