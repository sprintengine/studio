#!/usr/bin/env node
// The card seed gate (test:card-feed), the twin of check-model-feed-seed.mjs.
//
// A card in the bundled seed is the first thing a fresh install shows, and its
// Go runs without asking (epic ruling R4). So the seed may only name things this
// repository actually ships: an unresolvable id is not a card that fails
// politely, it is a Go that reports an error to somebody who pressed a button on
// a poster. The commit this gate was written for shipped seven cards, six of
// which named ids that resolve to nothing — `install.mcp "playwright"` and
// `"telegram"` against a catalogue that has neither, `source: "builtin"` against
// a source id that was retired, a plugin `typescript-language-server` nobody
// publishes, and a clone of `sprintengine/street-apocalypse-starter`, which is a
// 404. Nothing failed, because nothing checked.
//
// What this asserts:
//   - resources/cards-feed.json parses under the shipped parser with ZERO rows
//     dropped (a dropped seed row is a card the installer wrote and this build
//     cannot read — always a mistake here, whatever it is in the hosted file);
//   - exactly one hero, and at least one card;
//   - every id every action names resolves against a file in this repository.
//
// The parser is the real one, built out of src/shared/hosted-card-feed.ts with
// esbuild rather than re-implemented here: a second copy of the schema would
// drift from the first, and this gate exists to catch drift.
//
// NOT asserted yet: that `art` names an artwork the app ships. No build ships
// card artwork — the renderer that draws it is item 2467 — so there is nothing
// to resolve against. Add it here the day the artwork lands.
import { build } from 'esbuild'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const seedPath = join(root, 'resources', 'cards-feed.json')
const errors = []

// The two always-present sources, as src/shared/skills.ts mints their ids. Both
// are GitHub repositories read live, so only the one this repo mirrors under
// resources/studio-plugin can be resolved offline — which is the point: a seed
// card may only name what this build carries.
const STUDIO_SOURCE_ID = 'github:sprintengine/studio-releases'
// Where resources/studio-plugin mirrors that repository's root.
const STUDIO_MIRROR = join(root, 'resources', 'studio-plugin')
const SURFACE_VIEWS = new Set(['home', 'plugins', 'skills', 'agent-clis'])
// The only owner a bundled card may clone from. A card can name any public
// repository once the feed is hosted; the seed we ship is vouched for by us.
const CLONE_OWNER = 'sprintengine'

const outfile = join(root, 'node_modules', '.cache', 'multicode', 'check-card-feed-seed.parser.mjs')
await build({
  entryPoints: [join(root, 'src', 'shared', 'hosted-card-feed.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent',
})
const { parseHostedCardFeed } = await import(pathToFileURL(outfile).href)

let body
try {
  body = readFileSync(seedPath, 'utf8')
} catch (error) {
  console.error(`resources/cards-feed.json is missing or unreadable: ${error.message}`)
  process.exit(1)
}

const parsed = parseHostedCardFeed(body)
if (!parsed.ok) {
  console.error(`resources/cards-feed.json is not a feed this build reads: ${parsed.message}`)
  process.exit(1)
}
for (const reason of parsed.dropReasons) errors.push(`dropped row — ${reason}`)

const cards = parsed.feed.cards
if (cards.length === 0) errors.push('the seed carries no cards; a home page with nothing on it is not a home page')
const heroes = cards.filter((card) => card.hero === true)
if (heroes.length !== 1) errors.push(`exactly one card must be the hero, found ${heroes.length}`)

// The bundled MCP catalogue: one file, no source dimension, reverse-DNS ids.
const mcpIds = new Set()
try {
  for (const server of JSON.parse(readFileSync(join(root, 'resources', 'mcps', 'catalog.json'), 'utf8')).servers ?? []) {
    if (typeof server?.id === 'string') mcpIds.add(server.id)
  }
} catch (error) {
  errors.push(`resources/mcps/catalog.json could not be read: ${error.message}`)
}

// The agent CLIs, which are plugins under resources/plugins.
const cliIds = new Set(
  readdirSync(join(root, 'resources', 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, 'resources', 'plugins', entry.name, 'plugin.json')))
    .map((entry) => entry.name),
)

// What our own marketplace publishes, from the bundled copy of its Claude
// marketplace manifest.
const studioPluginIds = new Set()
try {
  const manifest = JSON.parse(readFileSync(join(STUDIO_MIRROR, '.claude-plugin', 'marketplace.json'), 'utf8'))
  for (const plugin of manifest.plugins ?? []) if (typeof plugin?.name === 'string') studioPluginIds.add(plugin.name)
} catch (error) {
  errors.push(`resources/studio-plugin/.claude-plugin/marketplace.json could not be read: ${error.message}`)
}

// A skill id is its directory path within its source, so it resolves against
// the mirror by that same path. Rejects a traversal outright rather than
// following it.
function studioSkillDir(id) {
  if (id.startsWith('/') || id.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  return join(STUDIO_MIRROR, ...id.split('/'))
}

for (const card of cards) {
  const where = `"${card.slug}"`
  // Skills a card installs are named again by `open.chat`, by the directory
  // name they land under — the shape workspace-skills-service.ts gives a
  // WorkspaceSkill id.
  const installedSkillNames = new Set()
  for (const [index, action] of card.go.entries()) {
    const at = `${where} go[${index}] ${action.verb}`
    switch (action.verb) {
      case 'require.cli':
        if (!cliIds.has(action.cli)) errors.push(`${at}: "${action.cli}" is not a plugin under resources/plugins`)
        break
      case 'install.mcp':
        if (!mcpIds.has(action.id)) errors.push(`${at}: "${action.id}" is not a server in resources/mcps/catalog.json`)
        break
      case 'install.skill': {
        if (action.source !== STUDIO_SOURCE_ID) {
          errors.push(`${at}: source "${action.source}" is not one this repository mirrors, so its ids cannot be checked; a seed card may only name ${STUDIO_SOURCE_ID}`)
          break
        }
        const dir = studioSkillDir(action.id)
        if (!dir || !existsSync(join(dir, 'SKILL.md'))) {
          errors.push(`${at}: "${action.id}" is not a skill under resources/studio-plugin`)
          break
        }
        installedSkillNames.add(action.id.split('/').pop())
        break
      }
      case 'install.plugin':
        if (action.source !== STUDIO_SOURCE_ID) {
          errors.push(`${at}: source "${action.source}" is not one this repository mirrors, so its ids cannot be checked; a seed card may only name ${STUDIO_SOURCE_ID}`)
        } else if (!studioPluginIds.has(action.id)) {
          errors.push(`${at}: "${action.id}" is not a plugin in resources/studio-plugin/.claude-plugin/marketplace.json`)
        }
        break
      case 'open.chat':
        for (const skill of action.skills ?? []) {
          if (!installedSkillNames.has(skill)) {
            errors.push(`${at}: attaches skill "${skill}", which no earlier install.skill in this card installs`)
          }
        }
        for (const server of action.mcpServers ?? []) {
          if (!mcpIds.has(server)) errors.push(`${at}: attaches "${server}", which is not a server in resources/mcps/catalog.json`)
        }
        if (action.send !== true) errors.push(`${at}: Go goes (R4) — a seeded card sends its prompt`)
        break
      case 'open.surface':
        if (!SURFACE_VIEWS.has(action.view)) errors.push(`${at}: "${action.view}" is not an Extensions view`)
        break
      case 'clone.repo':
        if (!action.repo.startsWith(`${CLONE_OWNER}/`)) {
          errors.push(`${at}: "${action.repo}" is not under ${CLONE_OWNER}/, and a bundled card may only clone a repository we publish`)
        }
        break
      default:
        errors.push(`${at}: this gate does not know how to resolve ${action.verb}; teach it before seeding one`)
    }
  }
}

if (errors.length) {
  console.error(`card feed seed: ${errors.length} problem(s)`)
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
const actions = cards.reduce((n, card) => n + card.go.length, 0)
console.log(`card feed seed ok: ${cards.length} cards, ${actions} actions, every id resolves, updated ${parsed.feed.updatedAt}`)
