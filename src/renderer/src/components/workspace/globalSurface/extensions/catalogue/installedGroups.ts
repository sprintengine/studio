// The Installed tab, grouped by where each thing came from.
//
// Source-tabs ruling (2026-09-05): the Installed tab is today's inventory rows
// under a heading per SOURCE, so the tab reads as the mirror of the source
// tabs beside it — "these came from anthropics/skills, these from the folder
// you added, these were bundled".
//
// What a row can honestly be attributed to is the install receipt that names
// it. `InstalledPluginRecord` carries the skill directories and the MCP server
// ids one install wrote, so a row whose id is in that list came from that
// record's source and nowhere else. A row no receipt claims is not guessed at:
// it lands in a provenance group that says only what the inventory actually
// knows — bundled with the app, or added on this machine by hand.

import type { InstalledPluginRecord } from '../../../../../../../shared/electron-api'
import type { SkillSource } from '../../../../../../../shared/skills'
import type { InstalledExtension } from '../../../../settings/extensionsInstalled'
import { catalogueTabLabel, orderCatalogueSources } from './catalogueTabs'

export type InstalledSourceGroup = {
  key: string
  label: string
  items: InstalledExtension[]
}

/** Headings for the rows no install receipt claims. */
const PROVENANCE_LABEL: Record<string, string> = {
  Bundled: 'Bundled with the app',
  User: 'Added on this machine',
  Custom: 'Added on this machine',
}

function provenanceKey(row: InstalledExtension): string {
  return `provenance:${PROVENANCE_LABEL[row.source] ?? 'Added on this machine'}`
}

/**
 * Which source id installed this row — null when nothing says.
 *
 * A row that carries its own provenance is believed first: an MCP server
 * records the source it came from on its config (`sourceRef`), and a server
 * added from a source's own row has no plugin receipt to be found in. The
 * receipts answer for everything else: a skill row's id is its directory name,
 * which is exactly what the installer recorded, and a plugin install's receipt
 * lists the MCP server ids it added.
 */
export function installedRowSourceId(
  row: InstalledExtension,
  records: readonly InstalledPluginRecord[],
): string | null {
  if (row.sourceId) return row.sourceId
  for (const record of records) {
    if (row.kind === 'skill' && record.skillDirNames.includes(row.id)) return record.sourceId
    if (row.kind === 'mcp' && record.mcpServerIds.includes(row.id)) return record.sourceId
  }
  return null
}

/**
 * Rows in source order: the sources in the same order the tab row lists them,
 * then the provenance groups for everything no receipt claims. Empty groups
 * are dropped — an Installed tab is a list of what is there, and a heading
 * with nothing under it says a source is installed when it is not.
 */
export function groupInstalledBySource(input: {
  rows: readonly InstalledExtension[]
  sources: readonly SkillSource[]
  records: readonly InstalledPluginRecord[]
}): InstalledSourceGroup[] {
  const bySource = new Map<string, InstalledExtension[]>()
  const byProvenance = new Map<string, InstalledExtension[]>()
  for (const row of input.rows) {
    const sourceId = installedRowSourceId(row, input.records)
    const bucket = sourceId === null ? byProvenance : bySource
    const key = sourceId === null ? provenanceKey(row) : sourceId
    const existing = bucket.get(key)
    if (existing) existing.push(row)
    else bucket.set(key, [row])
  }

  const groups: InstalledSourceGroup[] = []
  for (const source of orderCatalogueSources(input.sources)) {
    const items = bySource.get(source.id)
    if (items && items.length > 0) {
      groups.push({ key: source.id, label: catalogueTabLabel(source), items })
    }
  }
  // A receipt can name a source that has since been removed; its rows are
  // still installed, so they keep a heading rather than vanishing.
  for (const [key, items] of bySource) {
    if (groups.some((group) => group.key === key)) continue
    groups.push({ key, label: 'From a source that is no longer in your list', items })
  }
  for (const [key, items] of byProvenance) {
    groups.push({ key, label: key.slice('provenance:'.length), items })
  }
  return groups
}
