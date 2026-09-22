// The words on the Settings › Agent CLIs models line: where one CLI's model
// list came from. Pure: the panel hands in the stored catalog, the last probe
// error and the clock, this hands back the sentence and the test holds the
// table. Plain words only; the probe's source names never reach the screen.
import type { DiscoveredCliModelCatalog } from '../../../../shared/cli-model-catalog'
import { formatRelativeMsAgo } from '../../utils/relativeTime'

export function modelDiscoveryLine(input: {
  /** The CLI's display name, "Claude Code". */
  name: string
  catalog: DiscoveredCliModelCatalog | null | undefined
  /** Why the last probe failed, when it did. */
  error?: string | null
  now: number
}): string {
  // A failed probe changes nothing in the picker — the last good list stays —
  // but the line says so, because that list is now older than it looks.
  const error = input.error?.trim()
  if (error) return `Could not read ${input.name}'s models: ${error}`
  const catalog = input.catalog
  // An empty answer is shown as the manifest seed (mergeModelCatalog), so it
  // reads as this build's list here too.
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) return 'Models from this build'
  const version = catalog.cliVersion?.trim()
  const from = version ? `${input.name} ${version}` : input.name
  const when = formatRelativeMsAgo(Date.parse(catalog.fetchedAt), input.now)
  return when ? `Models from ${from}, checked ${when}` : `Models from ${from}`
}
