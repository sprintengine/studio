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
  sourceHasUpdate,
  type ScanResult,
  type SkillSource,
} from '../../../../../../../shared/skills'
import { OutlineButton, OverflowMenu } from '../../../../ui'
import { skillSourceCommitsUrl } from '../skills/skillsSurfaceModel'

export type SourceSyncResult = {
  added: number
  removed: number
  refreshed: number
  failures: readonly { skillId: string; message: string }[]
  scan: ScanResult
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
  // The two bundled sources ship with the app and refresh with it; a folder or
  // a repository is the person's, and can be re-read and removed.
  const canSync = source.kind === 'github' || source.kind === 'local'
  const canRemove = source.kind === 'github' || source.kind === 'local'
  const commitsUrl = skillSourceCommitsUrl(source)
  if (!canSync && !canRemove && !commitsUrl) return null

  const sync = async (): Promise<void> => {
    if (typeof window.api.skillsSyncSource !== 'function' || syncing) return
    setSyncing(true)
    try {
      const result = await window.api.skillsSyncSource({ sourceId: source.id, workspaceRoot })
      if (!result.ok) {
        onSyncFailed(source, result.message)
        return
      }
      onSynced(result.source, {
        added: result.added,
        removed: result.removed,
        refreshed: result.refreshed,
        failures: result.failures,
        scan: result.scan,
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
