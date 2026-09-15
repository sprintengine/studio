// The sixteen workflow roles, read the way both readers will load them.
//
// The harness (Claude Code, Codex, Cursor and the rest) routes on `name` and
// `description` via the same frontmatter parser the Skills surface uses. The
// engine will keep a skill as a role only when `metadata.sprintengine-role` and
// `metadata.role-label` are present. A missing file, a collapsed id, or a
// description that still talks about staffing is a pack that cannot ship.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { parseSkillFrontmatter, SKILL_ENTRY_FILE } from '../../shared/skills'

// Bundled into node_modules/.cache before it runs, so `__dirname` says nothing
// about where the source lives; `npm run` sets the cwd to the package root.
const REPO_ROOT = resolve(process.cwd())
const PLUGIN_ROOT = join(REPO_ROOT, 'resources', 'studio-plugin', 'workflow-roles')
const SKILLS_ROOT = join(PLUGIN_ROOT, 'skills')
const MARKETPLACE_PATH = join(REPO_ROOT, 'resources', 'studio-plugin', '.claude-plugin', 'marketplace.json')

const EXPECTED_ROLES = [
  { dir: 'architect', id: 'architect' },
  { dir: 'blog-writer', id: 'blog_writer' },
  { dir: 'creative', id: 'creative' },
  { dir: 'cross-platform', id: 'cross_platform' },
  { dir: 'developer', id: 'developer' },
  { dir: 'devops', id: 'devops' },
  { dir: 'frontend', id: 'frontend' },
  { dir: 'nuclear-reviewer', id: 'nuclear_reviewer' },
  { dir: 'performance', id: 'performance' },
  { dir: 'presentation', id: 'presentation' },
  { dir: 'product', id: 'product' },
  { dir: 'production-readiness-reviewer', id: 'production_readiness_reviewer' },
  { dir: 'security', id: 'security' },
  { dir: 'spec-reviewer', id: 'spec_reviewer' },
  { dir: 'tester', id: 'tester' },
  { dir: 'ui-ux-reviewer', id: 'ui_ux_reviewer' },
] as const

function kebabFormOfRoleId(roleId: string): string {
  return roleId.replaceAll('_', '-')
}

function engineBody(raw: string): string | null {
  // Same split sprintengine_core/role_registry.py::_load_skill_document uses:
  // opening fence, YAML, closing fence, remainder is the body.
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  return match ? match[2] : null
}

async function main(): Promise<void> {
  assert.equal(
    existsSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')),
    true,
    'workflow-roles must ship a Claude-format plugin manifest'
  )
  const pluginManifest = JSON.parse(await readFile(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as {
    name?: string
  }
  assert.equal(pluginManifest.name, 'workflow-roles')

  const marketplace = JSON.parse(await readFile(MARKETPLACE_PATH, 'utf8')) as {
    plugins: { name: string; source: string }[]
  }
  const listed = marketplace.plugins.filter((entry) => entry.name === 'workflow-roles')
  assert.equal(listed.length, 1, 'the marketplace must list workflow-roles exactly once')
  assert.equal(listed[0]?.source, './workflow-roles')

  const packageJson = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    build?: { extraResources?: Array<{ from?: string; to?: string; filter?: string[] }> }
  }
  const studioPlugin = (packageJson.build?.extraResources ?? []).find((entry) => entry.from === 'resources/studio-plugin')
  assert.ok(studioPlugin, 'a packaged app copies resources/studio-plugin, which now holds workflow-roles')
  assert.equal(studioPlugin.filter?.includes('**/*'), true, 'the copy is the whole tree, including workflow-roles/skills')
  assert.equal(
    (packageJson.build?.extraResources ?? []).some((entry) => entry.from === 'resources/specialist-pack'),
    false,
    'the retired pack must not still be an extraResources entry'
  )
  assert.equal(existsSync(join(REPO_ROOT, 'resources', 'specialist-pack')), false, 'resources/specialist-pack is gone')
  assert.equal(
    existsSync(join(REPO_ROOT, 'resources', 'sprintengine', 'role-manifest.schema.json')),
    false,
    'role-manifest.schema.json is gone'
  )
  assert.equal(
    existsSync(join(SKILLS_ROOT, 'architect', SKILL_ENTRY_FILE)),
    true,
    'a packaged app contains resources/studio-plugin/workflow-roles/skills/architect/SKILL.md'
  )

  const entries = await readdir(SKILLS_ROOT, { withFileTypes: true })
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()

  assert.deepEqual(
    dirs,
    EXPECTED_ROLES.map((role) => role.dir).slice().sort(),
    'the plugin must ship exactly the sixteen role skills'
  )

  const roleIds: string[] = []
  for (const role of EXPECTED_ROLES) {
    const path = join(SKILLS_ROOT, role.dir, SKILL_ENTRY_FILE)
    const raw = await readFile(path, 'utf8')
    const parsed = parseSkillFrontmatter(raw)
    const body = engineBody(raw)

    assert.match(raw, /^---\r?\n[\s\S]*?\r?\n---\r?\n/, `${role.dir}: frontmatter is not a terminated --- block`)
    assert.notEqual(body, null, `${role.dir}: the engine split must find a body`)
    assert.notEqual(body?.trim(), '', `${role.dir}: the engine split must not yield an empty body`)

    assert.notEqual(parsed.name, '', `${role.dir}: a skill with no name is never loaded`)
    assert.notEqual(parsed.description, '', `${role.dir}: a skill with no description is never loaded`)
    assert.equal(parsed.name, role.dir, `${role.dir}: name must equal its directory`)
    assert.equal(
      kebabFormOfRoleId(role.id),
      parsed.name,
      `${role.dir}: name must be the kebab form of its role id`
    )

    const roleId = parsed.metadata['sprintengine-role'] ?? ''
    const roleLabel = parsed.metadata['role-label'] ?? ''
    assert.notEqual(roleId, '', `${role.dir}: metadata.sprintengine-role is what makes a skill a role`)
    assert.notEqual(roleLabel, '', `${role.dir}: metadata.role-label is what a picker renders`)
    assert.equal(roleId, role.id, `${role.dir}: sprintengine-role must be the snake_case manifest id`)
    assert.equal(kebabFormOfRoleId(roleId), parsed.name, `${role.dir}: name is the kebab form of sprintengine-role`)
    roleIds.push(roleId)

    assert.match(parsed.description, /Use when/, `${role.dir}: the description must say WHEN to use the skill`)
    assert.equal(parsed.description.includes('Staff this role'), false, `${role.dir}: staffing copy belongs to the retired manifests`)

    const descriptionLine = raw.split(/\r?\n/).find((line) => line.startsWith('description:')) ?? ''
    assert.equal(
      descriptionLine.slice('description:'.length).trim().length > 0,
      true,
      `${role.dir}: "description" must be an inline scalar, not a folded block`
    )
  }

  assert.equal(roleIds.length, 16)
  assert.equal(new Set(roleIds).size, 16, 'sixteen files, sixteen distinct role ids')

  console.log(`workflow-roles: ok (${dirs.length})`)
}

void main()
