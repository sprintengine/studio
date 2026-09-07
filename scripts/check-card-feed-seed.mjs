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
//   - every id every action names resolves against a file in this repository;
//   - every card's `art` names artwork the renderer actually holds. A card
//     whose artwork this build does not have is not rendered at all (the
//     owner's 2026-09-06 ruling, enforced in renderableCards.ts), so a seed
//     card with a misspelt `art` is not a card that looks wrong — it is a card
//     nobody ever sees, and a fresh install quietly opens on a shorter page.
//   - no card installs a plugin that declares HOOKS. This one is not about
//     resolving an id, and it is the gate that stands in place of a dialog.
//
// About that last one, because it is the load-bearing half of an owner ruling
// (R4a, 2026-09-06): **there is never a permission prompt for installing a
// skill, an MCP server or a plugin.** Go goes. But a plugin's hooks are
// arbitrary shell commands that this machine then runs on every session event,
// and a card is a JSON file fetched from the internet — so `installPluginNow`
// (src/main/skills/index.ts) refuses a plugin declaring hooks unless
// `acknowledgedHooks` is true, and the card executor never passes it. Those two
// facts together mean a card installing a hooked plugin is a card whose Go can
// only ever fail.
//
// The ruling's consequence is that the answer is not to add the acknowledgement
// to the card flow — that would BE the prompt — and not to acknowledge on the
// person's behalf either. It is that such a card must never be published. This
// check is where that happens: the gate moves to CI, in front of the author,
// where a hooked plugin is a build failure with the commands named, rather than
// to a dialog in front of somebody who pressed a button on a poster. A card
// that wants a hooked plugin's skills should name the skills.
//
// Both lists are the real ones, built out of the renderer's own modules with
// esbuild rather than re-typed here: the parser from src/shared/hosted-card-feed
// .ts, and the artwork names from the registry's cardArtNames.ts. A second copy
// of either would drift from the first the day somebody edited it, and drift is
// the thing this gate exists to catch.
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

// Bundle a renderer/shared module and import it, so this gate reads the real
// thing rather than a copy of it.
async function shipped(relative, name) {
  const outfile = join(root, 'node_modules', '.cache', 'multicode', `check-card-feed-seed.${name}.mjs`)
  await build({
    entryPoints: [join(root, ...relative)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  })
  return import(pathToFileURL(outfile).href)
}

const { parseHostedCardFeed } = await shipped(['src', 'shared', 'hosted-card-feed.ts'], 'parser')
// The artwork the renderer ships, from the registry's own list. It is a plain
// .ts holding nothing but names precisely so this script can read it — the
// plates themselves are JSX and could not be bundled for node.
const { CARD_ART_NAMES } = await shipped(
  ['src', 'renderer', 'src', 'components', 'workspace', 'globalSurface', 'extensions', 'home', 'cardArtNames.ts'],
  'card-art-names',
)
const artNames = new Set(CARD_ART_NAMES)
// The scanner's own hooks reader, for the same reason: `parseHooks` accepts both
// shapes Claude Code does (`{ hooks: { Event: [...] } }` and the bare map), and
// a second reading of that here would disagree with the installer's the day
// either moved. What the installer counts as a hook is what this gate counts.
const { parseHooks } = await shipped(['src', 'main', 'skills', 'scan-plugins.ts'], 'scan-plugins')

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
// marketplace manifest — name to the directory the entry points at, because the
// hooks check below has to open the plugin and not merely recognise its name.
// `source` is a repo-relative path (`./sprintengine-studio`) for an in-tree
// entry and something else entirely for a linked one; only the first kind can
// be read offline, and only a plugin we can read is one a seed card may name.
const studioPluginDirs = new Map()
try {
  const manifest = JSON.parse(readFileSync(join(STUDIO_MIRROR, '.claude-plugin', 'marketplace.json'), 'utf8'))
  for (const plugin of manifest.plugins ?? []) {
    if (typeof plugin?.name !== 'string') continue
    studioPluginDirs.set(plugin.name, inTreePluginDir(plugin.source))
  }
} catch (error) {
  errors.push(`resources/studio-plugin/.claude-plugin/marketplace.json could not be read: ${error.message}`)
}

// The directory a marketplace `source` names inside the mirror, or null when it
// names anything else. A traversal is refused rather than followed, and so is an
// absolute path: this resolves a path out of a manifest, and the fact that the
// manifest is ours is a reason to keep it honest rather than a reason not to.
function inTreePluginDir(source) {
  if (typeof source !== 'string' || source === '' || source.startsWith('/')) return null
  const segments = source.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) return null
  return join(STUDIO_MIRROR, ...segments)
}

/**
 * The hook commands a plugin declares, read the way the scanner reads them: the
 * `hooks/hooks.json` beside the plugin, plus an inline `hooks` block in its
 * `.claude-plugin/plugin.json`. Returns null when the plugin could not be read
 * at all, which the caller treats as "unknown", not as "none" — the same
 * distinction `componentsKnown` draws in the scanner, and for the same reason.
 */
function pluginHooks(dir) {
  if (!dir || !existsSync(dir)) return null
  const hooks = []
  for (const [relative, inline] of [[['hooks', 'hooks.json'], false], [['.claude-plugin', 'plugin.json'], true]]) {
    const path = join(dir, ...relative)
    if (!existsSync(path)) continue
    let parsed
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return null
    }
    hooks.push(...parseHooks(inline ? parsed?.hooks : parsed))
  }
  return hooks
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
  if (!artNames.has(card.art)) {
    errors.push(`${where}: art "${card.art}" is not artwork this build ships; the card would not render at all (one of: ${[...artNames].join(', ')})`)
  }
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
      case 'install.plugin': {
        if (action.source !== STUDIO_SOURCE_ID) {
          errors.push(`${at}: source "${action.source}" is not one this repository mirrors, so its ids cannot be checked; a seed card may only name ${STUDIO_SOURCE_ID}`)
          break
        }
        if (!studioPluginDirs.has(action.id)) {
          errors.push(`${at}: "${action.id}" is not a plugin in resources/studio-plugin/.claude-plugin/marketplace.json`)
          break
        }
        // And the hooks rule (R4a). See the head of this file for why this is a
        // build failure and not a dialog: a hooked plugin cannot install without
        // an acknowledgement, the card flow deliberately never gives one, and
        // the ruling says the answer is that the card is never published.
        const hooks = pluginHooks(studioPluginDirs.get(action.id))
        if (hooks === null) {
          errors.push(`${at}: "${action.id}" could not be read from resources/studio-plugin, so whether it declares hooks is unknown; a seed card may only install a plugin this repository carries whole`)
        } else if (hooks.length > 0) {
          const commands = [...new Set(hooks.map((hook) => hook.command))]
          errors.push(
            `${at}: "${action.id}" declares ${hooks.length} hook${hooks.length === 1 ? '' : 's'} (${commands.join(', ')}), and a plugin with hooks cannot install without an acknowledgement no card ever gives — name its skills instead, or publish it without hooks`,
          )
        }
        break
      }
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
console.log(`card feed seed ok: ${cards.length} cards, ${actions} actions, every id and every plate resolves, updated ${parsed.feed.updatedAt}`)
