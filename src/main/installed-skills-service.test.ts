import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import type { PluginRegistryListEntry } from '../shared/plugin-manifest'
import { createInstalledSkillsService } from './installed-skills-service'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'installed-skills-')))
  temporary.push(base)
  const home = join(base, 'home')
  const project = join(base, 'project')
  await mkdir(home)
  await mkdir(project)
  const plugins = ['codex', 'claude', 'grok'].map((id) => ({
    id,
    displayName: id,
    skillIntegration: {
      support: 'native',
      harnessId: id,
      installTargets: [
        {
          scope: 'workspace',
          path: `{{workspaceRoot}}/.${id}/skills/{{skillId}}`,
          format: 'agent-skills-v1',
          restartRequired: false,
        },
      ],
    },
  })) as PluginRegistryListEntry[]
  const trashed: string[] = []
  const service = createInstalledSkillsService({
    homeDir: home,
    env: {},
    listPlugins: () => plugins,
    trashItem: async (path) => {
      trashed.push(path)
      await rename(path, join(base, `trash-${trashed.length}`))
    },
  })
  const input = { workspaceRoot: project, pluginId: 'codex' }
  async function skill(path: string, name = 'example') {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: A test skill.\n---\nInstructions.\n`)
    return path
  }
  return { base, home, project, service, input, skill, trashed }
}

test('inventory keeps project/global duplicates and filters other CLI installations', async () => {
  const f = await fixture()
  await f.skill(join(f.project, '.codex/skills/example'))
  await f.skill(join(f.home, '.codex/skills/example'))
  await f.skill(join(f.project, '.agents/skills/shared'), 'shared')
  await f.skill(join(f.home, '.claude/skills/other'), 'other')
  await mkdir(join(f.home, '.codex/skills/empty'), { recursive: true })
  const result = await f.service.list(f.input)
  assert.ok(result.ok)
  assert.equal(result.skills.length, 3)
  assert.equal(result.skills.filter((skill) => skill.name === 'example').length, 2)
  assert.equal(new Set(result.skills.map((skill) => skill.id)).size, 3)
  assert.equal(result.skills.filter((skill) => skill.scope === 'global').length, 1)
  const global = await f.service.list({ ...f.input, workspaceRoot: null })
  assert.ok(global.ok)
  assert.equal(global.skills.length, 1)
})

test('removal trashes only the selected copy and rejects replay or a different CLI', async () => {
  const f = await fixture()
  const projectCopy = await f.skill(join(f.project, '.codex/skills/example'))
  const globalCopy = await f.skill(join(f.home, '.codex/skills/example'))
  const otherCliCopy = await f.skill(join(f.project, '.claude/skills/example'))
  const result = await f.service.list(f.input)
  assert.ok(result.ok)
  const installationId = result.skills.find((skill) => skill.scope === 'global')!.id
  assert.equal((await f.service.remove({ ...f.input, pluginId: 'claude', installationId })).ok, false)
  assert.deepEqual(await f.service.remove({ ...f.input, installationId }), { ok: true })
  assert.deepEqual(f.trashed, [globalCopy])
  await readFile(join(projectCopy, 'SKILL.md'))
  await readFile(join(otherCliCopy, 'SKILL.md'))
  assert.equal((await f.service.remove({ ...f.input, installationId })).ok, false)
})

test('removing a leaf symlink preserves its target and protects linked parent folders', async () => {
  const f = await fixture()
  const source = await f.skill(join(f.base, 'source'))
  const skillsDir = join(f.project, '.codex/skills')
  await mkdir(skillsDir, { recursive: true })
  const link = join(skillsDir, 'linked')
  await symlink(source, link)
  const result = await f.service.list(f.input)
  assert.ok(result.ok)
  assert.equal(result.skills[0].linked, true)
  assert.deepEqual(await f.service.remove({ ...f.input, installationId: result.skills[0].id }), { ok: true })
  await readFile(join(source, 'SKILL.md'))
  await rm(skillsDir, { recursive: true })
  await symlink(f.base, skillsDir)
  const shared = await f.service.list(f.input)
  assert.ok(shared.ok)
  const sourceRow = shared.skills.find((skill) => skill.name === 'example')!
  assert.equal(sourceRow.removable, false)
  assert.equal((await f.service.remove({ ...f.input, installationId: sourceRow.id })).ok, false)
})

test('stale or fabricated removal identities cannot delete a changed installation', async () => {
  const f = await fixture()
  const path = await f.skill(join(f.project, '.codex/skills/example'))
  const result = await f.service.list(f.input)
  assert.ok(result.ok)
  await writeFile(join(path, 'SKILL.md'), 'Changed instructions')
  assert.equal((await f.service.remove({ ...f.input, installationId: result.skills[0].id })).ok, false)
  assert.equal((await f.service.remove({ ...f.input, installationId: path })).ok, false)
  assert.deepEqual(f.trashed, [])
})

test('unreadable locations report diagnostics while other locations still list', async () => {
  const f = await fixture()
  await mkdir(join(f.project, '.codex'), { recursive: true })
  await writeFile(join(f.project, '.codex/skills'), 'not a directory')
  await f.skill(join(f.home, '.codex/skills/example'))
  const result = await f.service.list(f.input)
  assert.ok(result.ok)
  assert.equal(result.skills.length, 1)
  assert.equal(result.diagnostics.length, 1)
})

test('system and configured plugin skills appear as managed; cache-only skills do not', async () => {
  const f = await fixture()
  await f.skill(join(f.home, '.codex/skills/.system/creator'), 'creator')
  const pluginPath = join(f.home, '.codex/plugins/cache/acme/tools/1.0.0')
  await f.skill(join(pluginPath, 'skills/review'), 'review')
  await mkdir(join(pluginPath, '.codex-plugin'))
  await writeFile(join(pluginPath, '.codex-plugin/plugin.json'), JSON.stringify({ skills: './skills' }))
  await f.skill(join(f.home, '.codex/plugins/cache/acme/uninstalled/1.0.0/skills/hidden'), 'hidden')
  await writeFile(join(f.home, '.codex/config.toml'), '[plugins."tools@acme"]\nenabled = true\n')
  const result = await f.service.list(f.input)
  assert.ok(result.ok)
  assert.deepEqual(result.skills.map((skill) => skill.name).sort(), ['creator', 'review'])
  assert.ok(result.skills.every((skill) => !skill.removable))
  assert.equal((await f.service.remove({ ...f.input, installationId: result.skills[0].id })).ok, false)
})

test('Claude plugin receipts respect project scope', async () => {
  const f = await fixture()
  const path = join(f.home, '.claude/plugins')
  const pluginPath = await f.skill(join(f.base, 'plugin/skills/example'))
  await mkdir(path, { recursive: true })
  await writeFile(
    join(path, 'installed_plugins.json'),
    JSON.stringify({
      plugins: {
        'tools@acme': [{ scope: 'project', projectPath: f.project, installPath: join(f.base, 'plugin') }],
        'other@acme': [{ scope: 'project', projectPath: '/other/project', installPath: join(f.base, 'plugin') }],
      },
    }),
  )
  const result = await f.service.list({ ...f.input, pluginId: 'claude' })
  assert.ok(result.ok)
  assert.equal(result.skills.length, 1)
  assert.equal(result.skills[0].path, pluginPath)
  assert.equal(result.skills[0].scope, 'project')
})

test('subfolder discovery stops at the current checkout and includes inherited project skills', async () => {
  const f = await fixture()
  await mkdir(join(f.project, '.git'))
  const nested = join(f.project, 'packages/app')
  await mkdir(nested, { recursive: true })
  await f.skill(join(f.project, '.agents/skills/inherited'), 'inherited')
  await f.skill(join(nested, '.codex/skills/local'), 'local')
  await f.skill(join(f.base, '.agents/skills/outside'), 'outside')
  const result = await f.service.list({ ...f.input, workspaceRoot: nested })
  assert.ok(result.ok)
  assert.deepEqual(result.skills.map((skill) => skill.name).sort(), ['inherited', 'local'])
})

test('Grok lists native, compatible, configured and plugin skills without making plugins removable', async () => {
  const f = await fixture()
  await f.skill(join(f.home, '.grok/skills/native'), 'native')
  await f.skill(join(f.home, '.claude/skills/compatible'), 'compatible')
  await f.skill(join(f.home, '.grok/plugins/tools/skills/plugin'), 'plugin')
  const extra = join(f.base, 'extra')
  await f.skill(join(extra, 'configured'), 'configured')
  await writeFile(join(f.home, '.grok/config.toml'), `[skills]\npaths = [${JSON.stringify(extra)}]\n`)
  const result = await f.service.list({ ...f.input, pluginId: 'grok' })
  assert.ok(result.ok)
  assert.deepEqual(result.skills.map((skill) => skill.name).sort(), ['compatible', 'configured', 'native', 'plugin'])
  assert.equal(result.skills.find((skill) => skill.name === 'plugin')!.removable, false)
})
