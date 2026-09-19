// What picture goes beside a scanned plugin's or skill's name, decided once.
//
// Every surface that lists what a source holds — the Plugins tab, the Skills
// tab, the detail panes, and the search-everywhere palette — was drawing the
// same grey two-letter chip for every row, because a scanned plugin had no
// artwork field at all. It has two now (`icon`, a glyph; `logo`, an https
// picture), and the account that publishes the repository has a third that
// needs no field: its GitHub avatar.
//
// So there is a ladder, and it is one function rather than one per surface:
//
//   1. the plugin's own GLYPH — the publisher's answer, needing no network;
//   2. its LOGO — the publisher's picture, one fetch;
//   3. the GitHub OWNER's avatar — not the plugin's own mark, but the right
//      account's face, and it makes an Anthropic row read as Anthropic;
//   4. the MONOGRAM — two letters, which is what a row wears when nothing
//      above it answered.
//
// Pure, and component-free: the palette (a different component graph) and the
// door render the same answer, and the ladder is testable without a DOM.

import {
  pluginIconGlyph,
  pluginLogoUrl,
  type ScannedPlugin,
  type ScannedSkill,
  type SkillSource,
} from '../../../../../../../shared/skills'
import { mcpMonogram } from '../../../../ui/mcpMonogram'
import { sourceAvatarUrl } from './SourceAvatar'

/**
 * A rung of the ladder, in the form the slot draws.
 *
 * `monogram` carries its letters rather than the name they came from: a caller
 * that renders its own chip must not have to know which of `mcpMonogram`'s
 * rules produced them.
 */
export type ExtensionArtwork =
  { kind: 'glyph'; glyph: string } | { kind: 'image'; url: string } | { kind: 'monogram'; text: string }

/** What the ladder needs of a plugin: its name, where it came from, its artwork. */
export type PluginArtworkSubject = Pick<ScannedPlugin, 'name' | 'origin' | 'icon' | 'logo'>

/** What it needs of a source: enough to name the GitHub account behind it. */
export type ArtworkSource = Pick<SkillSource, 'kind' | 'repo'>

/**
 * The plugin's mark. `size` is the CSS size of the slot it will be drawn in —
 * the avatar URL asks GitHub for twice that, so it is sharp on a 2× display.
 *
 * The owner is read from the PLUGIN's repository when the entry links to one:
 * a marketplace lists other people's plugins, and `anthropics` beside a plugin
 * that lives in someone else's repository is the wrong face. Only an in-tree
 * or registry plugin borrows the source's owner, because for those it is the
 * same account.
 */
export function pluginArtwork(
  plugin: PluginArtworkSubject,
  source: ArtworkSource | undefined,
  size: number,
): ExtensionArtwork {
  // Validated AGAIN here, not only in the scanner: a scan is cached to disk
  // and read back for as long as the source is not rescanned, so a glyph a
  // stricter scanner would refuse today can still arrive from a cache an older
  // one wrote. The rules are one function, so re-asking costs nothing to keep.
  const glyph = pluginIconGlyph(plugin.icon)
  if (glyph !== '') return { kind: 'glyph', glyph }
  const logo = pluginLogoUrl(plugin.logo)
  if (logo !== '') return { kind: 'image', url: logo }
  const owner =
    plugin.origin.kind === 'linked' && plugin.origin.repo !== ''
      ? sourceAvatarUrl({ kind: 'github', repo: plugin.origin.repo }, size)
      : source
        ? sourceAvatarUrl(source, size)
        : null
  if (owner) return { kind: 'image', url: owner }
  return { kind: 'monogram', text: mcpMonogram(plugin.name) }
}

/**
 * A skill's mark: its plugin's, when it ships inside one and that plugin has
 * artwork of its own, and the source's owner otherwise.
 *
 * A `ScannedSkill` does not know its plugin — the scan files a skill by its
 * source-relative directory, and `skillPluginFolder()` is what reads the
 * plugin's folder back out of it — so the plugin is passed in. Only the rungs
 * ABOVE the monogram are borrowed: a plugin's two letters are the plugin's
 * name, and printing `AC` beside a skill called `telegram` would be worse than
 * printing nothing.
 */
export function skillArtwork(
  skill: Pick<ScannedSkill, 'name'>,
  source: ArtworkSource | undefined,
  size: number,
  plugin?: PluginArtworkSubject | null,
): ExtensionArtwork {
  if (plugin) {
    const artwork = pluginArtwork(plugin, source, size)
    if (artwork.kind !== 'monogram') return artwork
  }
  return sourceArtwork(source, skill.name, size)
}

/**
 * The bottom two rungs on their own, for a row that has no plugin behind it —
 * an MCP server declared at a repository's root, the plugin this app ships
 * itself. The owner's avatar is still a truer answer than two grey letters.
 */
export function sourceArtwork(source: ArtworkSource | undefined, name: string, size: number): ExtensionArtwork {
  const owner = source ? sourceAvatarUrl(source, size) : null
  return owner ? { kind: 'image', url: owner } : { kind: 'monogram', text: mcpMonogram(name) }
}

/**
 * The ladder's answer as `ExtensionIcon`'s props. The monogram rung passes
 * nothing: the slot already has the name, and computing the letters twice is
 * two places for them to disagree.
 *
 * `iconPlated` says the picture brings its own ground — an avatar and a logo
 * both do — so it fills the slot instead of sitting inset in the neutral chip.
 */
export function extensionIconProps(artwork: ExtensionArtwork | undefined): {
  glyph?: string
  icon?: string
  iconPlated?: boolean
} {
  if (!artwork) return {}
  if (artwork.kind === 'glyph') return { glyph: artwork.glyph }
  if (artwork.kind === 'image') return { icon: artwork.url, iconPlated: true }
  return {}
}

/**
 * Scanned plugins by every name a skill's directory could name them with: the
 * plugin's id, and the last segment of its in-tree directory. They are usually
 * the same string and are not required to be — a marketplace names the entry,
 * the repository names the folder — and a lookup that only knew one of them
 * would silently give half the plugin's skills the plain owner avatar.
 */
export function pluginsByFolder<T extends Pick<ScannedPlugin, 'id' | 'origin'>>(plugins: readonly T[]): Map<string, T> {
  const byFolder = new Map<string, T>()
  for (const plugin of plugins) {
    if (plugin.origin.kind === 'in-tree' && plugin.origin.path !== '') {
      const path = plugin.origin.path
      byFolder.set(path.slice(path.lastIndexOf('/') + 1), plugin)
    }
    // The id last, so it wins a collision: it is the name the marketplace and
    // every install receipt use.
    if (plugin.id !== '') byFolder.set(plugin.id, plugin)
  }
  return byFolder
}
