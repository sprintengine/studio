import { useCallback, useEffect, useState } from 'react'

import type { ConversationImportFolder } from '../../../../shared/electron-api'
import type { ConversationImportScan } from './useConversationImportScan'
import { showToast } from '../../store/toastStore'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import { Checkbox, GhostButton, Spinner } from '../ui'
import {
  IMPORT_SOURCE_LABEL,
  countNoun,
  defaultImportSelection,
  describeImportResult,
  folderCheckState,
  importableSessions,
  sessionKey,
  withFolder,
} from './conversationImport'

// The sessions a person ran in Claude Code and Codex, by the folder each ran
// in, to tick and bring in as chats. The onboarding card and the Settings
// dialog both show this list and differ only in the frame around it.

/** The ticked sessions, starting from the recent ones, and the import that brings them in. */
export function useConversationImportSelection(folders: readonly ConversationImportFolder[]) {
  const [selected, setSelected] = useState<Set<string>>(() => defaultImportSelection(folders, Date.now()))
  const [importing, setImporting] = useState(false)
  // The folders arrive after the first render; the recent ones are ticked then.
  useEffect(() => setSelected(defaultImportSelection(folders, Date.now())), [folders])
  const runImport = useCallback(async (): Promise<boolean> => {
    const sessions = folders
      .flatMap((folder) => folder.sessions)
      .filter((session) => selected.has(sessionKey(session)))
      .map(({ source, sessionId }) => ({ source, sessionId }))
    if (sessions.length === 0) return false
    setImporting(true)
    try {
      const result = await window.api.importConversations({ sessions })
      showToast(describeImportResult(result))
      return result.ok && result.imported.length > 0
    } catch (error) {
      showToast({ tone: 'error', title: `Could not import: ${error instanceof Error ? error.message : String(error)}` })
      return false
    } finally {
      setImporting(false)
    }
  }, [folders, selected])
  return { selected, setSelected, importing, runImport }
}

export function ConversationImportPicker({
  scan,
  selected,
  onSelectedChange,
  disabled,
}: {
  scan: ConversationImportScan
  selected: ReadonlySet<string>
  onSelectedChange: (next: Set<string>) => void
  disabled?: boolean
}) {
  const [openFolder, setOpenFolder] = useState<string | null>(null)
  const now = Date.now()
  if (scan.status === 'loading')
    return (
      <div className="flex items-center gap-2 py-6 text-meta text-[color:var(--text-muted)]">
        <Spinner className="icon-sm shrink-0" />
        Looking for saved sessions…
      </div>
    )
  if (scan.status === 'error')
    return <p className="py-6 text-meta text-[color:var(--text-muted)]">Couldn’t read saved sessions: {scan.message}</p>
  if (scan.folders.length === 0)
    return (
      <p className="py-6 text-meta text-[color:var(--text-muted)]">
        No Claude Code or Codex sessions on this machine to import.
      </p>
    )
  return (
    <ul className="space-y-1" aria-label="Folders with saved sessions">
      {scan.folders.map((folder) => {
        const offered = importableSessions(folder)
        const state = folderCheckState(folder, selected)
        const open = openFolder === folder.folderPath
        return (
          <li key={folder.folderPath}>
            <div className="flex min-h-control-sm items-center gap-2">
              <div className="min-w-0 flex-1">
                <Checkbox
                  checked={state === true}
                  indeterminate={state === 'mixed'}
                  disabled={disabled || offered.length === 0}
                  onChange={(next) => onSelectedChange(withFolder(selected, folder, next))}
                  size="body"
                  label={
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-[color:var(--text-strong)]" title={folder.folderPath}>
                        {folder.name}
                      </span>
                      <span className="shrink-0 text-meta text-[color:var(--text-muted)]">
                        {offered.length === 0 ? 'All imported' : countNoun(offered.length, 'session')}
                      </span>
                    </span>
                  }
                />
              </div>
              <span className="shrink-0 text-meta text-[color:var(--text-subtle)]">
                {formatRelativeMsAgo(folder.lastActiveAt, now)}
              </span>
              <GhostButton
                size="xs"
                aria-expanded={open}
                onClick={() => setOpenFolder(open ? null : folder.folderPath)}
              >
                {open ? 'Hide' : 'Choose'}
              </GhostButton>
            </div>
            {open ? (
              <ul className="mb-2 ml-6 space-y-0.5" aria-label={`Sessions in ${folder.name}`}>
                {folder.sessions.map((session) => {
                  const key = sessionKey(session)
                  return (
                    <li key={key} className="flex min-h-control-xs items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <Checkbox
                          checked={session.imported || selected.has(key)}
                          disabled={disabled || session.imported}
                          onChange={(next) => {
                            const updated = new Set(selected)
                            if (next) updated.add(key)
                            else updated.delete(key)
                            onSelectedChange(updated)
                          }}
                          label={<span className="block truncate">{session.title}</span>}
                        />
                      </div>
                      <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">
                        {session.imported
                          ? 'Imported'
                          : `${IMPORT_SOURCE_LABEL[session.source]} · ${formatRelativeMsAgo(session.updatedAt, now)}`}
                      </span>
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
