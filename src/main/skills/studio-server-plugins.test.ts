// The MCP servers we ship as plugins, held to the three rules the item states
// (backlog/2026-09-06-shipped-mcp-servers-are-plugins.md).
//
//   1. Nothing we list lacks a skill. "A bad manual is worse than none" is the
//      reason a server waits for its skill rather than shipping without one,
//      and a listing that quietly grew an entry with no `skills/` would be the
//      first way that rule stops being true.
//   2. A `.mcp.json` names env VARIABLES, never values. This tree is published
//      to a public repository, so a literal in an `env` or `headers` value is a
//      leaked secret, and the `${NAME}` form is also the only spelling the
//      scanner reads an env var name out of.
//   3. A server's id is the id the connector catalogue used for the same
//      server. Surfaces key installed servers by id — so a plugin that renamed
//      its server would put the same product on screen twice, and an install
//      made under the old id would be orphaned. The catalogue itself is gone
//      (MC-2519, 2026-09-08), which is why the id is pinned here rather than
//      read out of a row: the merge still has to work for a server installed
//      under that id before the catalogue left.
//
// The skills themselves are read with the app's own frontmatter parser, the
// same way `studio-plugin-skills.test.ts` reads ours: a skill whose name does
// not match its directory, or whose description says WHAT instead of WHEN, is
// a skill no harness ever loads.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { parseSkillFrontmatter, SKILL_ENTRY_FILE } from '../../shared/skills'
import { parseMcpServers } from './scan-plugins'
import { STUDIO_PLUGIN_ID, STUDIO_SKILLS_PLUGIN_ID } from './studio-plugin'

// Bundled into node_modules/.cache before it runs, so `__dirname` says nothing
// about where the source lives; `npm run` sets the cwd to the package root.
const ROOT = resolve(process.cwd(), 'resources', 'studio-plugin')

/**
 * The connector-catalogue id each shipped server plugin takes over, pinned so
 * the catalogue's own row for it can retire (frozen-snapshots retirement,
 * 2026-09-06). Renaming one of these is the duplicate-row bug rule 3 exists to
 * catch, and that is what is asserted below. The companion assertion — that the
 * id is not ALSO a catalogue row, the two-routes bug — went with the catalogue
 * itself (MC-2519, 2026-09-08): there is no second route left to collide with.
 *
 * EMPTY since 2026-09-08: the studio stopped shipping third-party MCP servers
 * (owner), so the three ids that used to be pinned here — brave-search,
 * io-github-containers-kubernetes-mcp-server, io-snyk-mcp — went with their
 * plugins. The set stays as the tripwire: a server plugin added without pinning
 * its catalogue id fails the assertion below rather than shipping a second row.
 */
const CONVERTED_CATALOG_IDS = new Set<string>([])

/** The Agent Skills specification's ceiling on a description. */
const MAX_DESCRIPTION_LENGTH = 1024
/** The specification's guidance on how long a body may run before it splits. */
const MAX_BODY_LINES = 500

type Entry = { name: string; source: string }

/**
 * Plugins that are not servers. Everything else the marketplace lists is one
 * of ours packaging somebody else's MCP server, and gets the server rules
 * below as well as the skill rule.
 */
const NOT_SERVERS = new Set<string>([STUDIO_PLUGIN_ID, STUDIO_SKILLS_PLUGIN_ID])

async function skillDirsOf(pluginDir: string): Promise<string[]> {
  const entries = await readdir(join(pluginDir, 'skills'), { withFileTypes: true }).catch(() => null)
  if (entries === null) return []
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
}

async function assertSkillLoadable(pluginName: string, skillsRoot: string, dirName: string): Promise<void> {
  const path = join(skillsRoot, dirName, SKILL_ENTRY_FILE)
  const raw = await readFile(path, 'utf8')
  const parsed = parseSkillFrontmatter(raw)
  const where = `${pluginName}/skills/${dirName}`
  assert.equal(parsed.name, dirName, `${where}: "name" must equal its directory, and reads "${parsed.name}"`)
  assert.notEqual(parsed.description, '', `${where}: a skill with no description is never loaded`)
  assert.equal(
    parsed.description.length <= MAX_DESCRIPTION_LENGTH,
    true,
    `${where}: description is ${parsed.description.length} characters, over the ${MAX_DESCRIPTION_LENGTH} limit`
  )
  assert.match(parsed.description, /\bUse when\b/, `${where}: the description must say WHEN to use the skill`)
  const lines = raw.split(/\r?\n/).length
  assert.equal(lines <= MAX_BODY_LINES, true, `${where}: ${lines} lines, over the ${MAX_BODY_LINES} limit`)
  assert.match(raw, /^---\r?\n[\s\S]*?\r?\n---\r?\n/, `${where}: frontmatter is not a terminated --- block`)
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8')) as {
    plugins: Entry[]
  }
  const inTree = manifest.plugins.filter((entry) => entry.source.startsWith('./'))
  assert.equal(inTree.length, manifest.plugins.length, 'every plugin in our own marketplace is in this tree')

  // Ours leads and the workflow skills follow it; the servers come after both.
  // Held here as well as in studio-plugin.test.ts because this is the file that
  // adds rows to that list, and the order is what the catalogues draw.
  assert.equal(manifest.plugins[0]?.name, STUDIO_PLUGIN_ID, 'ours leads the listing')
  assert.equal(manifest.plugins[1]?.name, STUDIO_SKILLS_PLUGIN_ID, 'the workflow skills come second')
  let serverPlugins = 0
  for (const entry of manifest.plugins) {
    const dir = entry.source.slice(2)
    assert.equal(dir, entry.name, `${entry.name} is listed at ./${dir}; a plugin's directory is its name`)
    const pluginDir = join(ROOT, dir)
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json')
    assert.equal(existsSync(manifestPath), true, `${entry.name} has no plugin manifest`)
    const plugin = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
    assert.equal(plugin.name, entry.name, `${entry.name}'s manifest names "${String(plugin.name)}"`)
    assert.equal(typeof plugin.version === 'string' && plugin.version !== '', true, `${entry.name} declares no version`)

    // Rule 1, for every entry including our own two.
    const skillDirs = await skillDirsOf(pluginDir)
    assert.equal(
      skillDirs.length > 0,
      true,
      `${entry.name} ships no skill; a server without one is not listed, because a bad manual is worse than none`
    )
    for (const dirName of skillDirs) await assertSkillLoadable(entry.name, join(pluginDir, 'skills'), dirName)

    if (NOT_SERVERS.has(entry.name)) continue
    serverPlugins += 1

    // Rules 2 and 3.
    const mcpPath = join(pluginDir, '.mcp.json')
    assert.equal(existsSync(mcpPath), true, `${entry.name} is a server plugin with no .mcp.json`)
    const raw = await readFile(mcpPath, 'utf8')
    const servers = parseMcpServers(JSON.parse(raw), `${dir}/.mcp.json`, entry.name)
    assert.equal(servers.length > 0, true, `${entry.name}'s .mcp.json declares no server the scanner can read`)
    for (const server of servers) {
      assert.equal(
        server.transport === 'stdio' ? server.command !== '' : server.url !== '',
        true,
        `${entry.name}: ${server.id} names neither a command nor a URL`
      )
      assert.equal(
        CONVERTED_CATALOG_IDS.has(server.id),
        true,
        `${entry.name}: server id "${server.id}" is not the connector catalogue id this server had, so an install made under the old id would appear as a second row`
      )
      for (const [name, value] of [...Object.entries(server.env), ...Object.entries(server.headers)]) {
        assert.match(
          value,
          /\$\{?[A-Z][A-Z0-9_]*/,
          `${entry.name}: ${server.id} sets ${name} to a literal; .mcp.json names env variables, never values`
        )
      }
    }
  }

  // The count is free to be zero. The studio stopped shipping third-party MCP
  // servers (owner, 2026-09-08), so this suite polices the three rules for
  // whatever the marketplace DOES carry rather than requiring it to carry a
  // server at all — a floor of one would have to be deleted the moment the last
  // one left, which is the same day it stopped being a rule.
  console.log(`studio server plugins: ok (${serverPlugins} of ${manifest.plugins.length} entries are servers)`)
}

void main()
