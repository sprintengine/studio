import type {
  ConversationImportFolder,
  ConversationImportResult,
  ConversationImportSession,
  ConversationImportSource,
} from '../../../../shared/electron-api'

// The import picker's model: which sessions are ticked, what a folder's box
// shows, and what the screen says about what it found and what it did. Pure,
// so the card and the dialog that both show the picker agree on every line.

export const IMPORT_SOURCE_LABEL: Record<ConversationImportSource, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

/**
 * How far back the picker reaches on its own. A session older than this is
 * listed and can be ticked, but is not ticked for the person: a first import
 * brings what they were working on, not every experiment they ever ran.
 */
export const RECENT_IMPORT_DAYS = 30

export function sessionKey(session: Pick<ConversationImportSession, 'source' | 'sessionId'>): string {
  return `${session.source}:${session.sessionId}`
}

/** The sessions ticked to begin with: every recent one that is not a chat here yet. */
export function defaultImportSelection(folders: readonly ConversationImportFolder[], now: number): Set<string> {
  const since = now - RECENT_IMPORT_DAYS * 24 * 60 * 60 * 1000
  const selected = new Set<string>()
  for (const folder of folders)
    for (const session of folder.sessions)
      if (!session.imported && session.updatedAt >= since) selected.add(sessionKey(session))
  return selected
}

/** The sessions a folder offers: the ones not imported already. */
export function importableSessions(folder: ConversationImportFolder): ConversationImportSession[] {
  return folder.sessions.filter((session) => !session.imported)
}

/** A folder's box: ticked when all it offers is, mixed when some is. */
export function folderCheckState(folder: ConversationImportFolder, selected: ReadonlySet<string>): boolean | 'mixed' {
  const offered = importableSessions(folder)
  const ticked = offered.filter((session) => selected.has(sessionKey(session))).length
  if (ticked === 0) return false
  return ticked === offered.length ? true : 'mixed'
}

/** Tick or untick every session a folder offers. */
export function withFolder(
  selected: ReadonlySet<string>,
  folder: ConversationImportFolder,
  checked: boolean,
): Set<string> {
  const next = new Set(selected)
  for (const session of importableSessions(folder))
    if (checked) next.add(sessionKey(session))
    else next.delete(sessionKey(session))
  return next
}

export function countNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** What the scan found, as the card's opening line says it: "143 from Claude Code and 18 from Codex". */
export function describeFound(folders: readonly ConversationImportFolder[]): string {
  const bySource = new Map<ConversationImportSource, number>()
  for (const folder of folders)
    for (const session of importableSessions(folder))
      bySource.set(session.source, (bySource.get(session.source) ?? 0) + 1)
  const parts = [...bySource.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => `${count} from ${IMPORT_SOURCE_LABEL[source]}`)
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '')
}

/** How many sessions the scan offers in all. */
export function importableCount(folders: readonly ConversationImportFolder[]): number {
  return folders.reduce((total, folder) => total + importableSessions(folder).length, 0)
}

/** The toast an import ends with: what it made, and what it could not. */
export function describeImportResult(result: ConversationImportResult): {
  tone: 'neutral' | 'error'
  title: string
  description?: string
} {
  if (!result.ok) return { tone: 'error', title: `Could not import: ${result.message}` }
  const made = result.imported.length
  const failed = result.failed.length
  if (made === 0 && failed === 0) return { tone: 'neutral', title: 'Those conversations are already chats here.' }
  const title =
    made > 0 ? `Imported ${countNoun(made, 'conversation')}.` : `Could not import ${countNoun(failed, 'conversation')}.`
  if (failed === 0) return { tone: 'neutral', title }
  const first = result.failed[0]!
  return {
    tone: made > 0 ? 'neutral' : 'error',
    title,
    description: `${made > 0 ? `${countNoun(failed, 'conversation')} could not be imported. ` : ''}${first.title}: ${first.message}`,
  }
}
