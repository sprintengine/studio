import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readSpecialistSoul } from './souls-service'

async function main(): Promise<void> {
  await testUnknownSpecialistIdReturnsStructuredFailure()
  await testKnownSpecialistRendersFromRegistry()
  await testAliasedSpecialistResolvesThroughRegistry()
  await testRegistryFailureSurfacesStructuredMessage()
  testPackagedBuildShipsRegistryResources()

  console.log('souls-service tests passed')
}

async function testUnknownSpecialistIdReturnsStructuredFailure(): Promise<void> {
  // A non-bundled id is treated as a registry role id (so dropped-in specialist
  // packs resolve). An id that matches no registry role surfaces the Souls CLI's
  // structured failure rather than rendering anything.
  const result = await readSpecialistSoul('definitely-not-a-real-specialist' as never)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.message, /definitely-not-a-real-specialist/)
  assert.equal(result.path, null)
}

async function testKnownSpecialistRendersFromRegistry(): Promise<void> {
  const result = await readSpecialistSoul('architect')
  assert.equal(result.ok, false, 'a checkout with no installed role pack does not substitute a bundled brief')
  if (result.ok) return
  assert.match(result.message, /no workflow roles are installed/)
  assert.match(result.message, /Add from folder/)
  assert.equal(result.path, null)
}

async function testAliasedSpecialistResolvesThroughRegistry(): Promise<void> {
  // qa-test is a dropped alias (a different name, not a hyphen respelling).
  // The missing-role state names the spelling that failed.
  const result = await readSpecialistSoul('qa-test')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.message, /qa-test/)
  assert.match(result.message, /no workflow roles are installed/)
  assert.equal(result.path, null)
}

async function testRegistryFailureSurfacesStructuredMessage(): Promise<void> {
  const previous = process.env['MULTICODE_SOULS_REPO_ROOT']
  process.env['MULTICODE_SOULS_REPO_ROOT'] = '/tmp/does-not-have-souls-module'
  const previousCwd = process.cwd()
  process.chdir('/')
  try {
    const result = await readSpecialistSoul('architect')
    assert.equal(result.ok, false, 'CLI should fail when repo root is unreachable')
    if (result.ok) return
    assert.equal(result.path, null)
    assert.ok(result.message.length > 0, 'failure message must be populated')
    assert.doesNotMatch(result.message, /souls\/prompts\//, 'failure must not point at legacy prompt files')
  } finally {
    process.chdir(previousCwd)
    if (previous === undefined) delete process.env['MULTICODE_SOULS_REPO_ROOT']
    else process.env['MULTICODE_SOULS_REPO_ROOT'] = previous
  }
}

function testPackagedBuildShipsRegistryResources(): void {
  // sprintengine_core/role_registry.py derives BUNDLED_REGISTRY_ROOT as
  // Path(__file__).resolve().parents[1] / 'resources' / 'sprintengine'.
  // In the packaged app, sprintengine_core lives at <resourcesPath>/sprintengine_core,
  // so the registry expects <resourcesPath>/resources/sprintengine/. Guard against
  // a future regression that omits that extraResources entry from package.json.
  const repoRoot = findRepoRootForPackageJson()
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
    build?: { extraResources?: Array<{ from?: string; to?: string }> }
  }
  const entries = packageJson.build?.extraResources ?? []
  const shipped = entries.find((entry) => entry.from === 'resources/sprintengine')
  assert.ok(
    shipped,
    'package.json build.extraResources must ship resources/sprintengine so the bundled registry roles/skills land in the packaged app.',
  )
  assert.equal(
    shipped.to,
    'resources/sprintengine',
    `extraResources entry for resources/sprintengine must map to resources/sprintengine so BUNDLED_REGISTRY_ROOT resolves under <resourcesPath>; got '${shipped.to}'.`,
  )
}

function findRepoRootForPackageJson(): string {
  // The bundled test runs from node_modules/.cache/multicode; walk up to find package.json.
  let current = __dirname
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      readFileSync(join(current, 'package.json'), 'utf-8')
      return current
    } catch {
      const parent = join(current, '..')
      if (parent === current) break
      current = parent
    }
  }
  throw new Error('Could not locate repository package.json from test context.')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
