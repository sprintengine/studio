// What you can do to the source whose tab is open: sync it, look at it, or
// take it out of the list.
//
// These three lived on the Sources rail's source page. With the rail gone
// (source-tabs ruling, 2026-09-05) they sit on the head line under the tab
// row, in one overflow rather than three controls: a tab is navigation, and
// hanging destructive actions inside a navigation is how a click meant for
// "look at this source" removes it. Sync stays outside the menu — it is the
// one of the three a person does repeatedly, and it reports its own progress.

import React, { useState } from 'react'

import {
  isBundledSkillSource,
  sourceHasUpdate,
  type ScanResult,
  type SkillSource,
} from '../../../../../../../shared/skills'
import { useWorkspaceStore } from '../../../../../store/workspaceStore'
import { OutlineButton, OverflowMenu } from '../../../../ui'
import { skillSourceCommitsUrl } from '../skills/skillsSurfaceModel'

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

export function SourceTabActions({
  source,
  workspaceRoot,
  onSynced,
  onSyncFailed,
  onRemoved,
}: {
  source: SkillSource
  workspaceRoot: string | null
  onSynced: (source: SkillSource, result: SourceSyncResult) => void
  onSyncFailed: (source: SkillSource, message: string) => void
  onRemoved: (sourceId: string) => void
}): JSX.Element | null {
  const [syncing, setSyncing] = useState(false)
  // The MCP servers this machine has configured, read here rather than passed
  // in: a source is synced from whichever catalogue the person happens to be
  // looking at, and the servers it installed must be refreshed by all three of
  // them (backlog/2026-09-06-mcp-installs-carry-source-provenance.md). MCP
  // settings are app-level, so there is one right answer to read.
  const mcpServers = useWorkspaceStore((state) => state.appSettings.mcp?.servers)
  const upsertMcpServer = useWorkspaceStore((state) => state.upsertMcpServer)
  // The two bundled sources ship with the app and refresh with it; a folder or
  // a repository is the person's, and can be re-read and removed.
  const canSync = source.kind === 'github' || source.kind === 'local'
  // …with one exception since the official-plugins ruling (2026-09-06): the
  // official marketplace IS a repository, so it syncs like one, but it is
  // always present and the store refuses to remove it. Offering Remove there
  // would be an action that can only report a failure the person could not
  // have avoided.
  const canRemove = (source.kind === 'github' || source.kind === 'local') && !isBundledSkillSource(source.id)
  const commitsUrl = skillSourceCommitsUrl(source)
  if (!canSync && !canRemove && !commitsUrl) return null

  const sync = async (): Promise<void> => {
    if (typeof window.api.skillsSyncSource !== 'function' || syncing) return
    setSyncing(true)
    try {
      // The servers ride the call because MCP settings live in this store, not
      // on disk in main; what comes back is written straight back into it.
      const result = await window.api.skillsSyncSource({
        sourceId: source.id,
        workspaceRoot,
        mcpServers: Object.values(mcpServers ?? {}),
      })
      if (!result.ok) {
        onSyncFailed(source, result.message)
        return
      }
      // The servers this source installed, as the sync left them: fresh
      // configs, and the ones it could no longer find marked rather than
      // dropped. Written back through the store so they survive a restart.
      const mcp = result.mcpServers
      for (const server of mcp.updated) upsertMcpServer(server)
      onSynced(result.source, {
        added: result.added,
        removed: result.removed,
        refreshed: result.refreshed,
        failures: result.failures,
        scan: result.scan,
        mcpChanged: mcp.changed.length,
        mcpMissing: mcp.missing.length,
      })
    } catch (error) {
      onSyncFailed(source, error instanceof Error ? error.message : String(error))
    } finally {
      setSyncing(false)
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
      {canSync ? (
        <OutlineButton size="sm" onClick={() => void sync()} disabled={syncing}>
          {syncing ? 'Syncing…' : sourceHasUpdate(source) ? 'Sync — update available' : 'Sync'}
        </OutlineButton>
      ) : null}
      <OverflowMenu
        ariaLabel={`More actions for ${source.repo || source.name}`}
        triggerTooltip="More actions"
        items={[
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
