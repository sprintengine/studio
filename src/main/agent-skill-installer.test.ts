import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentCliAvailabilityMap, AgentSkillTarget } from '../shared/electron-api'
import type { PluginRegistryListEntry } from '../shared/plugin-manifest'
import { hashSkillDirectory } from './builtin-skills'
import { createPluginRegistry, type PluginRegistry } from './plugin-registry'
import { createAppPluginRegistryOptions } from './plugin-registry-instance'
import { createAgentSkillInstaller, createFsSkillCopyIo, type SkillCopyIo } from './agent-skill-installer'

function bundledRegistry(): PluginRegistry {
  const registry = createPluginRegistry(
    createAppPluginRegistryOptions(
      join(process.cwd(), 'node_modules', '.cache', 'multicode'),
      join(process.cwd(), 'resources', 'plugins'),
      join(process.cwd(), 'node_modules', '.cache', 'multicode', 'plugins-none'),
    ),
  )
  registry.loadSync()
  return registry
}

/** Every bundled CLI probes as installed, which is the full-install case. */
function allInstalled(plugins: readonly PluginRegistryListEntry[]): AgentCliAvailabilityMap {
  const map: AgentCliAvailabilityMap = {}
  for (const plugin of plugins) {
    map[plugin.id] = { cli: plugin.id, installed: true, resolvedPath: `/usr/local/bin/${plugin.id}`, version: '1.0.0' }
  }
  return map
}

async function writeSkillSource(dir: string, body: string): Promise<void> {
  await mkdir(join(dir, 'reference'), { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), body, 'utf-8')
  await writeFile(join(dir, 'reference', 'notes.md'), 'notes\n', 'utf-8')
}

function byPath(targets: readonly AgentSkillTarget[]): Map<string, AgentSkillTarget> {
  return new Map(targets.map((target) => [target.path, target]))
}

async function main(): Promise<void> {
  const registry = bundledRegistry()
  const plugins = registry.list()
  const temp = await mkdtemp(join(tmpdir(), 'multicode-agent-skill-installer-'))
  const builtinRoot = join(temp, 'builtin-skills')
  await writeSkillSource(
    join(builtinRoot, 'backlog'),
    '---\nname: Backlog\ndescription: Work an item.\n---\n\n# Backlog\n',
  )

  const installer = (
    overrides: {
      availability?: AgentCliAvailabilityMap
      io?: SkillCopyIo
      invalidate?: (root: string, harnessId: string) => void
    } = {},
  ) =>
    createAgentSkillInstaller({
      listPlugins: () => plugins,
      detectAvailability: async () => overrides.availability ?? allInstalled(plugins),
      builtinSourceRoot: () => builtinRoot,
      ...(overrides.io ? { io: overrides.io } : {}),
      ...(overrides.invalidate ? { invalidate: overrides.invalidate } : {}),
    })

  // ---------------------------------------------------------------------
  // A full install: four directories, six CLIs, one invalidation per harness.
  // ---------------------------------------------------------------------
  const fullRoot = join(temp, 'full')
  await mkdir(fullRoot, { recursive: true })
  const invalidated: string[] = []
  const full = await installer({
    invalidate: (root, harnessId) => invalidated.push(`${root}::${harnessId}`),
  }).attach({ workspaceRoot: fullRoot, skillId: 'backlog' })

  assert.ok(full.ok)
  assert.deepEqual(
    full.targets.map((target) => target.path).sort(),
    ['.claude/skills/backlog', '.codex/skills/backlog', '.grok/skills/backlog', '.opencode/skills/backlog'],
    'the twelve bundled manifests resolve to exactly four skill directories',
  )
  assert.ok(full.targets.every((target) => target.status === 'written'))
  const claudeTarget = byPath(full.targets).get('.claude/skills/backlog')
  assert.deepEqual(
    [...(claudeTarget?.pluginIds ?? [])].sort(),
    ['claude-code', 'kimi-claude', 'zai'],
    'the three CLIs sharing .claude are all attributed to the one directory',
  )
  // The bytes really landed, subdirectories included, with the managed marker
  // the built-in status reader keys off.
  const installedEntry = await readFile(join(fullRoot, '.codex', 'skills', 'backlog', 'reference', 'notes.md'), 'utf-8')
  assert.equal(installedEntry, 'notes\n')
  const marker = JSON.parse(
    await readFile(join(fullRoot, '.claude', 'skills', 'backlog', '.multicode-skill.json'), 'utf-8'),
  ) as { source?: string; id?: string; sourceHash?: string }
  assert.equal(marker.source, 'multicode-builtin')
  assert.equal(marker.id, 'backlog')
  // The interop that makes this one install path rather than two: the marker an
  // attach writes is the one the built-in status reader verifies, so a copy
  // attached here reads as `installed` rather than as somebody else's directory.
  assert.equal(
    marker.sourceHash,
    await hashSkillDirectory(join(builtinRoot, 'backlog')),
    'the attach marker carries the hash the built-in manager computes',
  )
  assert.deepEqual(
    invalidated.sort(),
    [`${fullRoot}::claude`, `${fullRoot}::codex`, `${fullRoot}::grok`, `${fullRoot}::opencode`],
    'each written harness is invalidated once; nothing pushes a new list',
  )

  // Re-attaching the same bytes writes nothing and invalidates nothing.
  const again = await installer({
    invalidate: () => assert.fail('an unchanged attach must not invalidate'),
  }).attach({ workspaceRoot: fullRoot, skillId: 'backlog' })
  assert.ok(again.ok)
  assert.ok(again.targets.every((target) => target.status === 'unchanged'))

  // Restart truth rides the outcome, from the manifest rather than a constant.
  assert.equal(byPath(again.targets).get('.claude/skills/backlog')?.restartRequired, false)
  assert.equal(byPath(again.targets).get('.opencode/skills/backlog')?.restartRequired, true)

  // ---------------------------------------------------------------------
  // A CLI that is not installed gets no directory.
  // ---------------------------------------------------------------------
  const partialRoot = join(temp, 'claude-only')
  await mkdir(partialRoot, { recursive: true })
  const claudeOnly = await installer({
    availability: { 'claude-code': { cli: 'claude-code', installed: true, resolvedPath: '/bin/claude', version: '1' } },
  }).attach({ workspaceRoot: partialRoot, skillId: 'backlog' })
  assert.ok(claudeOnly.ok)
  assert.deepEqual(
    claudeOnly.targets.map((target) => target.path),
    ['.claude/skills/backlog'],
  )
  assert.deepEqual(claudeOnly.targets[0].pluginIds, ['claude-code'])
  assert.deepEqual(await readdir(partialRoot), ['.claude'], 'no .opencode in a workspace without OpenCode')

  // No installed CLI reads skills at all: a stated reason, not a silent success.
  const noneRoot = join(temp, 'none')
  await mkdir(noneRoot, { recursive: true })
  const none = await installer({ availability: {} }).attach({
    workspaceRoot: noneRoot,
    skillId: 'backlog',
  })
  assert.equal(none.ok, false)

  // ---------------------------------------------------------------------
  // Partial failure: the successes stand and the failure names itself.
  // ---------------------------------------------------------------------
  const flakyRoot = join(temp, 'flaky')
  await mkdir(flakyRoot, { recursive: true })
  const realIo = createFsSkillCopyIo()
  const flakyIo: SkillCopyIo = {
    inspect: (dir) => realIo.inspect(dir),
    remove: (dir) => realIo.remove(dir),
    write: async (input) => {
      if (input.destinationDir.includes('.grok')) throw new Error('EACCES: permission denied')
      await realIo.write(input)
    },
  }
  const flaky = await installer({ io: flakyIo }).attach({
    workspaceRoot: flakyRoot,
    skillId: 'backlog',
  })
  assert.ok(flaky.ok, 'one failed directory is not a failed attach')
  const flakyByPath = byPath(flaky.targets)
  assert.equal(flakyByPath.get('.grok/skills/backlog')?.status, 'failed')
  assert.match(flakyByPath.get('.grok/skills/backlog')?.message ?? '', /permission denied/)
  assert.equal(flakyByPath.get('.claude/skills/backlog')?.status, 'written')
  assert.equal(flakyByPath.get('.opencode/skills/backlog')?.status, 'written')
  await readFile(join(flakyRoot, '.claude', 'skills', 'backlog', 'SKILL.md'), 'utf-8')
  // A write that died part-way must not leave a marker-less directory behind:
  // the next attach would read it as the user's and refuse it forever.
  await assert.rejects(readdir(join(flakyRoot, '.grok', 'skills', 'backlog')))
  const retry = await installer().attach({ workspaceRoot: flakyRoot, skillId: 'backlog' })
  assert.ok(retry.ok)
  assert.equal(byPath(retry.targets).get('.grok/skills/backlog')?.status, 'written', 'a failed target retries clean')

  // ---------------------------------------------------------------------
  // A skill nobody ships: copied from the harness that already holds it, and
  // the hand-authored original is never overwritten or removed.
  // ---------------------------------------------------------------------
  const handRoot = join(temp, 'hand-made')
  const handWritten = join(handRoot, '.claude', 'skills', 'mine')
  await writeSkillSource(handWritten, '---\nname: mine\ndescription: Mine.\n---\n\n# Mine\n')
  const handAttach = await installer().attach({ workspaceRoot: handRoot, skillId: 'mine' })
  assert.ok(handAttach.ok)
  assert.equal(byPath(handAttach.targets).get('.claude/skills/mine')?.status, 'unchanged')
  assert.equal(byPath(handAttach.targets).get('.codex/skills/mine')?.status, 'written')
  assert.equal(
    JSON.parse(await readFile(join(handRoot, '.codex', 'skills', 'mine', '.multicode-skill.json'), 'utf-8')).copiedFrom,
    '.claude/skills/mine',
  )
  await assert.rejects(readFile(join(handWritten, '.multicode-skill.json'), 'utf-8'))

  const handRemove = await installer().remove({ workspaceRoot: handRoot, skillId: 'mine' })
  assert.ok(handRemove.ok)
  const handRemoveByPath = byPath(handRemove.targets)
  assert.equal(handRemoveByPath.get('.claude/skills/mine')?.status, 'skipped')
  assert.equal(handRemoveByPath.get('.claude/skills/mine')?.reason, 'not-ours')
  assert.equal(handRemoveByPath.get('.codex/skills/mine')?.status, 'removed')
  assert.equal(handRemoveByPath.get('.grok/skills/mine')?.status, 'removed')
  await readFile(join(handWritten, 'SKILL.md'), 'utf-8')
  await assert.rejects(readFile(join(handRoot, '.codex', 'skills', 'mine', 'SKILL.md'), 'utf-8'))

  // Removing what was never there is every target saying so, not an error.
  const removeNothing = await installer().remove({ workspaceRoot: handRoot, skillId: 'backlog' })
  assert.ok(removeNothing.ok)
  assert.ok(removeNothing.targets.every((target) => target.status === 'skipped' && target.reason === 'absent'))

  // The only copy sits in the harness of a CLI the user has since uninstalled.
  // It is still the bytes to spread — the read side is every declared harness,
  // even though the write side is only the installed ones.
  const strandedRoot = join(temp, 'stranded')
  await writeSkillSource(join(strandedRoot, '.grok', 'skills', 'stranded'), '---\nname: stranded\n---\n\n# Stranded\n')
  const stranded = await installer({
    availability: { 'claude-code': { cli: 'claude-code', installed: true, resolvedPath: '/bin/claude', version: '1' } },
  }).attach({ workspaceRoot: strandedRoot, skillId: 'stranded' })
  assert.ok(stranded.ok)
  assert.deepEqual(
    stranded.targets.map((target) => target.path),
    ['.claude/skills/stranded'],
  )
  assert.equal(stranded.targets[0].status, 'written')
  await readFile(join(strandedRoot, '.claude', 'skills', 'stranded', 'SKILL.md'), 'utf-8')

  // A directory the user wrote where a built-in would go is reported, not
  // replaced, while its neighbours still receive the skill.
  const collisionRoot = join(temp, 'collision')
  await writeSkillSource(join(collisionRoot, '.codex', 'skills', 'backlog'), '# mine, not yours\n')
  const collision = await installer().attach({
    workspaceRoot: collisionRoot,
    skillId: 'backlog',
  })
  assert.ok(collision.ok)
  assert.equal(byPath(collision.targets).get('.codex/skills/backlog')?.reason, 'not-ours')
  assert.equal(byPath(collision.targets).get('.claude/skills/backlog')?.status, 'written')
  assert.equal(
    await readFile(join(collisionRoot, '.codex', 'skills', 'backlog', 'SKILL.md'), 'utf-8'),
    '# mine, not yours\n',
  )

  // ---------------------------------------------------------------------
  // Manifest-driven: a thirteenth CLI declaring a new harness receives its
  // copy with no code change here.
  // ---------------------------------------------------------------------
  const fixtureRoot = join(temp, 'fixture-harness')
  await mkdir(fixtureRoot, { recursive: true })
  const withFixture: PluginRegistryListEntry[] = [
    ...plugins,
    {
      ...plugins[0],
      id: 'fictional-cli',
      displayName: 'Fictional CLI',
      skillIntegration: {
        support: 'native',
        harnessId: 'fictional',
        installTargets: [
          {
            scope: 'workspace',
            path: '{{workspaceRoot}}/.fictional/skills/{{skillId}}',
            format: 'agent-skills-v1',
            restartRequired: true,
          },
        ],
      },
    },
  ]
  const fixture = await createAgentSkillInstaller({
    listPlugins: () => withFixture,
    detectAvailability: async () => allInstalled(withFixture),
    builtinSourceRoot: () => builtinRoot,
  }).attach({ workspaceRoot: fixtureRoot, skillId: 'backlog' })
  assert.ok(fixture.ok)
  assert.equal(byPath(fixture.targets).get('.fictional/skills/backlog')?.status, 'written')
  await readFile(join(fixtureRoot, '.fictional', 'skills', 'backlog', 'SKILL.md'), 'utf-8')

  // ---------------------------------------------------------------------
  // Requests that cannot be attempted at all.
  // ---------------------------------------------------------------------
  const traversal = await installer().attach({ workspaceRoot: fullRoot, skillId: '../escape' })
  assert.equal(traversal.ok, false)
  const missingWorkspace = await installer().attach({
    workspaceRoot: join(temp, 'not-a-workspace'),
    skillId: 'backlog',
  })
  assert.equal(missingWorkspace.ok, false)
  const nothingToCopy = await installer().attach({ workspaceRoot: fullRoot, skillId: 'never-heard-of-it' })
  assert.equal(nothingToCopy.ok, false)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
