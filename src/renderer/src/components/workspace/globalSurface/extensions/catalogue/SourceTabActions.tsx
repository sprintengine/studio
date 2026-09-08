// What you can do to the source whose tab is open: sync it, check it for
// updates, look at it, or take it out of the list.
//
// Sync, Open and Remove lived on the Sources rail's source page. With the rail
// gone (source-tabs ruling, 2026-09-05) they sit on the head line under the tab
// row, in one overflow rather than three controls: a tab is navigation, and
// hanging destructive actions inside a navigation is how a click meant for
// "look at this source" removes it. Sync stays outside the menu — it is the
// one a person does repeatedly, and it reports its own progress.
//
// "Check for updates" joined the overflow with the cadence ruling (MC-2519,
// 2026-09-08). Without a GitHub token the scheduled check runs once a day per
// source, which is long enough that a person needs a way to ask now — but the
// manual check counts against the same window rather than being a way around
// it, so when it declines it says when the source was last asked and why. It is
// not Sync: it asks GitHub for the head and copies nothing.

import React, { useState } from 'react'

import type { McpServerConfig, SkillSourceUpdateCheck } from '../../../../../../../shared/electron-api'
import {
  isBundledSkillSource,
  sourceHasUpdate,
  type ScanResult,
  type SkillSource,
} from '../../../../../../../shared/skills'
import { serversUnchangedDuringSync } from '../../../../../../../shared/mcp/server-from-scanned'
import { useWorkspaceStore } from '../../../../../store/workspaceStore'
import { OutlineButton, OverflowMenu } from '../../../../ui'
import { skillSourceCommitsUrl } from '../skills/skillsSurfaceModel'

/**
 * Whether the overflow offers "Remove source" for this source.
 *
 * Every source is a folder or a repository (`SkillSourceKind` is
 * `'github' | 'local'`), so every one of them re-reads on demand — but since
 * the official-plugins ruling (2026-09-06) two of them ship with the app and
 * the store refuses to remove them. Offering Remove there would be an action
 * that can only report a failure the person could not have avoided.
 *
 * Exported so the rule has a test: `OverflowMenu` builds its items only once a
 * person opens it, which puts this decision out of a render assertion's reach.
 */
export function sourceOffersRemove(source: Pick<SkillSource, 'id'>): boolean {
  return !isBundledSkillSource(source.id)
}

export type SourceSyncResult = {
  added: number
  removed: number
  refreshed: number
  failures: readonly { skillId: string; message: string }[]
  scan: ScanResult
  /** Source-installed MCP servers whose declaration moved, and ones the source dropped. */
  mcpChanged: number
  mcpMissing: number
}

/** The MCP settings as they stand right now — never a value captured at render. */
function mcpServersNow(): McpServerConfig[] {
  return Object.values(useWorkspaceStore.getState().appSettings.mcp?.servers ?? {})
}

/**
 * What to tell a person who pressed "Check for updates", from the check's own
 * result. A skipped source is the interesting case: the check deliberately did
 * nothing, and the reason has to reach them or the button reads as broken.
 *
 * Exported for its test: the menu builds its items only when opened, which puts
 * this out of a render assertion's reach.
 */
export function sourceUpdateCheckLine(check: SkillSourceUpdateCheck, sourceId: string): string {
  const skipped = check.skipped.find((entry) => entry.sourceId === sourceId)
  if (skipped) return skipped.message
  const failure = check.failures.find((entry) => entry.sourceId === sourceId)
  if (failure) return failure.message
  const entry = check.sources.find((row) => row.sourceId === sourceId)
  if (!entry) return 'This source is not one the studio checks for updates.'
  return entry.changed ? 'An update is available — press Sync to take it.' : 'No updates; this source is up to date.'
}

export function SourceTabActions({
  source,
  workspaceRoot,
  onSynced,
  onSyncFailed,
  onRemoved,
  onCheckReport,
}: {
  source: SkillSource
  workspaceRoot: string | null
  onSynced: (source: SkillSource, result: SourceSyncResult) => void
  onSyncFailed: (source: SkillSource, message: string) => void
  onRemoved: (sourceId: string) => void
  /** What the manual update check found, said in one sentence. */
  onCheckReport: (source: SkillSource, message: string) => void
}): JSX.Element {
  const [syncing, setSyncing] = useState(false)
  // Sync is offered on every source: each one is a folder or a repository, and
  // the two the app ships with are repositories too. Remove is not — see
  // `sourceOffersRemove`.
  const canRemove = sourceOffersRemove(source)
  const commitsUrl = skillSourceCommitsUrl(source)

  const sync = async (): Promise<void> => {
    if (typeof window.api.skillsSyncSource !== 'function' || syncing) return
    setSyncing(true)
    try {
      // The servers ride the call because MCP settings live in this store, not
      // on disk in main. Read at click time, not at render: a settings object
      // captured when this control last rendered can be minutes old.
      const sent = mcpServersNow()
      const result = await window.api.skillsSyncSource({
        sourceId: source.id,
        workspaceRoot,
        mcpServers: sent,
      })
      if (!result.ok) {
        onSyncFailed(source, result.message)
        return
      }
      // The servers this source installed, as the sync left them: fresh
      // configs, and the ones it could no longer find marked rather than
      // dropped. Read the store again before writing, because the round trip
      // took seconds and an entry somebody edited in them is theirs, not the
      // sync's; skipped entries are counted out of what the line claims.
      const mcp = result.mcpServers
      const { write, skipped } = serversUnchangedDuringSync({
        sent,
        current: mcpServersNow(),
        updated: mcp.updated,
      })
      if (write.length > 0) useWorkspaceStore.getState().refreshMcpServersFromSource(write)
      const stale = new Set(skipped)
      onSynced(result.source, {
        added: result.added,
        removed: result.removed,
        refreshed: result.refreshed,
        failures: result.failures,
        scan: result.scan,
        mcpChanged: mcp.changed.filter((id) => !stale.has(id)).length,
        mcpMissing: mcp.missing.filter((id) => !stale.has(id)).length,
      })
    } catch (error) {
      onSyncFailed(source, error instanceof Error ? error.message : String(error))
    } finally {
      setSyncing(false)
    }
  }

  const checkForUpdates = async (): Promise<void> => {
    if (typeof window.api.skillsCheckSourceUpdates !== 'function') return
    try {
      onCheckReport(source, sourceUpdateCheckLine(await window.api.skillsCheckSourceUpdates(), source.id))
    } catch (error) {
      onSyncFailed(source, error instanceof Error ? error.message : String(error))
    }
  }

  const remove = async (): Promise<void> => {
    if (typeof window.api.skillsRemoveSource !== 'function') return
    const result = await window.api.skillsRemoveSource({ sourceId: source.id })
    if (!result.ok) {
      onSyncFailed(source, result.message)
      return
    }
    onRemoved(source.id)
  }

  return (
    <>
      <OutlineButton size="sm" onClick={() => void sync()} disabled={syncing}>
        {syncing ? 'Syncing…' : sourceHasUpdate(source) ? 'Sync — update available' : 'Sync'}
      </OutlineButton>
      <OverflowMenu
        ariaLabel={`More actions for ${source.repo || source.name}`}
        triggerTooltip="More actions"
        items={[
          {
            id: 'check',
            label: 'Check for updates',
            onSelect: () => void checkForUpdates(),
          },
          ...(commitsUrl
            ? [
                {
                  id: 'open',
                  label: 'Open on GitHub',
                  onSelect: () => void window.api.openExternal(commitsUrl),
                },
              ]
            : []),
          ...(canRemove
            ? [
                { kind: 'separator' as const, id: 'sep' },
                {
                  id: 'remove',
                  label: 'Remove source',
                  destructive: true,
                  onSelect: () => void remove(),
                },
              ]
            : []),
        ]}
      />
    </>
  )
}
