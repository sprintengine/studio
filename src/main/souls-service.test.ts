import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readMultiloopPrompt, readSpecialistSoul } from './souls-service'

async function main(): Promise<void> {
  await testUnknownSpecialistIdReturnsStructuredFailure()
  await testKnownSpecialistRendersFromRegistry()
  await testAliasedSpecialistResolvesThroughRegistry()
  await testRegistryFailureSurfacesStructuredMessage()
  await testMultiloopPromptInstructsCliFetch()
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
  assert.equal(result.ok, true, `architect Soul should render: ${result.ok ? '' : result.message}`)
  if (!result.ok) return
  assert.equal(typeof result.prompt, 'string')
  assert.ok(result.prompt.length > 200, 'rendered prompt should not be trivially short')
  assert.match(result.path, /resources\/sprintengine\/roles\/architect\.json$/)
  assert.doesNotMatch(result.prompt, /# Collaboration Norms/, 'standalone Souls should not include retired collaboration_norms')
  assert.doesNotMatch(result.prompt, /Ask only when a wrong assumption/, 'standalone Souls should not carry ask-vs-act policy')
  assert.match(result.prompt, /collaborative discovery/, 'architect Soul should encourage collaborative discovery')
  // Registry render adds composed skill content; legacy file path must not appear in evidence.
  assert.doesNotMatch(result.path, /souls\/prompts\/architect\.md$/)
}

async function testAliasedSpecialistResolvesThroughRegistry(): Promise<void> {
  // qa-test → tester is the alias path declared in souls/registry.py and the migrated registry manifests.
  const result = await readSpecialistSoul('qa-test')
  assert.equal(result.ok, true, `qa-test alias should render: ${result.ok ? '' : result.message}`)
  if (!result.ok) return
  assert.match(result.path, /resources\/sprintengine\/roles\/tester\.json$/)
  assert.ok(result.prompt.length > 200)
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

async function testMultiloopPromptInstructsCliFetch(): Promise<void> {
  const coordinator = await readMultiloopPrompt('coordinator')
  assert.equal(coordinator.ok, true)
  if (!coordinator.ok) return
  assert.match(coordinator.prompt, /scripts\/multiloop/)

  const architect = await readMultiloopPrompt('architect')
  assert.equal(architect.ok, true)
  if (!architect.ok) return
  assert.match(architect.prompt, /--role architect/)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
