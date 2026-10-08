/**
 * ConversationImportService — the conversations a person already had in an
 * agent CLI's own terminal, brought in as chats.
 *
 * Claude Code and Codex each save every session they run as a transcript
 * under their home folder and resume one by its id. The scan lists those a
 * person typed into, grouped by the folder each ran in; an import makes each
 * picked session a chat of its own in that folder, holding the session's
 * history and ending in its id as the resume cursor, so the chat's next
 * message continues the same session in the CLI, with everything it
 * remembers. Nothing under the CLI's home is written: the history is copied,
 * and the CLI reads its own session back when the chat resumes it.
 *
 * Each chat is dated by its session, so the sidebar files an import of weeks
 * of history beneath the chats of today, oldest lowest.
 */
import { homedir } from 'node:os'
import { basename } from 'node:path'

import { newAgentIdSuffix } from '../../shared/agent-ids'
import { defaultAgent, type AgentState } from '../../shared/agent-state'
import { CONVERSATION_DEFAULT_MODEL_ID, conversationProviderForCli } from '../../shared/conversation-harness'
import type {
  ConversationImportTranscriptInput,
  ConversationImportTranscriptResult,
} from '../../shared/conversation-runtime'
import type {
  ConversationImportFolder,
  ConversationImportInput,
  ConversationImportResult,
  ConversationImportScanResult,
  ConversationImportSource,
} from '../../shared/ipc/conversation-import'
import { SOLO_CHAT_TEMPLATE_AGENT_ID, SOLO_CHAT_TEMPLATE_ID } from '../../shared/layouts/templates'
import {
  effectiveAgentLaunchSettings,
  resolveAgentSpawnPermission,
  type AgentLaunchSettings,
} from '../../shared/launch-settings'
import { deriveWorkspaceTitle } from '../../shared/workspace-title'
import type { WorkspaceCreateRequest } from '../workspace-registry-service'
import { claudeCodeProjectsDir, readClaudeCodeSession, scanClaudeCodeSessions } from './claude-code-sessions'
import { codexHomeDir, readCodexSession, scanCodexSessions } from './codex-sessions'
import type { ImportedConversation } from './imported-transcript'
import { isFolder, type ScannedSession } from './session-files'

/** A workspace as the import needs to see it: its folder, and the sessions its agents carry. */
export type ConversationImportWorkspace = {
  id: string
  agents?: Record<string, Pick<AgentState, 'cliSessionId' | 'harnessSessionId' | 'importedFrom'> | undefined>
}

export type ConversationImportServiceDeps = {
  listWorkspaces: () => ConversationImportWorkspace[]
  createWorkspace: (
    request: WorkspaceCreateRequest,
  ) => { ok: true; workspaceId: string } | { ok: false; message: string }
  removeWorkspace: (workspaceId: string) => void
  importTranscript: (input: ConversationImportTranscriptInput) => Promise<ConversationImportTranscriptResult>
  getLaunchSettings: () => AgentLaunchSettings
  /** The home the CLIs keep their state under. Injected so tests read a fixture. */
  homeDir?: () => string
  env?: () => NodeJS.ProcessEnv
  now?: () => number
  newAgentSuffix?: () => string
}

export type ConversationImportService = {
  scan: () => Promise<ConversationImportScanResult>
  importSessions: (input: ConversationImportInput) => Promise<ConversationImportResult>
}

const SOURCE_CLI: Record<ConversationImportSource, string> = { 'claude-code': 'claude-code', codex: 'codex' }
const SOURCE_NAME: Record<ConversationImportSource, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

export function createConversationImportService(deps: ConversationImportServiceDeps): ConversationImportService {
  const home = () => deps.homeDir?.() ?? homedir()
  const env = () => deps.env?.() ?? process.env
  const now = deps.now ?? Date.now
  const newAgentSuffix = deps.newAgentSuffix ?? newAgentIdSuffix
  // The sessions an import is making into chats right now, by `source:id`.
  // A chat is only on record once its history is read, so without this two
  // imports racing would each read the session and each make a chat of it.
  const importing = new Set<string>()

  const sources: Array<{
    source: ConversationImportSource
    root: () => string
    scan: (root: string) => Promise<ScannedSession[]>
    read: (path: string, fallbackAt: number) => Promise<ImportedConversation>
  }> = [
    {
      source: 'claude-code',
      root: () => claudeCodeProjectsDir(home(), env()),
      scan: scanClaudeCodeSessions,
      read: readClaudeCodeSession,
    },
    { source: 'codex', root: () => codexHomeDir(home(), env()), scan: scanCodexSessions, read: readCodexSession },
  ]

  /** The sessions some chat here carries already, by `source:id`, and every session id an agent here resumes. */
  function knownSessions(): { imported: Set<string>; resumed: Set<string> } {
    const imported = new Set<string>()
    const resumed = new Set<string>()
    for (const workspace of deps.listWorkspaces())
      for (const agent of Object.values(workspace.agents ?? {})) {
        if (agent?.importedFrom) imported.add(`${agent.importedFrom.source}:${agent.importedFrom.sessionId}`)
        if (agent?.cliSessionId) resumed.add(agent.cliSessionId)
        if (agent?.harnessSessionId) resumed.add(agent.harnessSessionId)
      }
    return { imported, resumed }
  }

  /**
   * Every session a person ran, minus those a terminal agent here runs
   * already (that agent is the session's home in the app), in folders that
   * still exist. A session seen twice (a copied home) is listed once.
   */
  async function scanAll(): Promise<{ sessions: ScannedSession[]; found: ConversationImportSource[] }> {
    const { resumed } = knownSessions()
    const found: ConversationImportSource[] = []
    const sessions: ScannedSession[] = []
    const seen = new Set<string>()
    const folders = new Map<string, Promise<boolean>>()
    const unreadable: string[] = []
    for (const entry of sources) {
      const root = entry.root()
      if (!(await isFolder(root))) continue
      found.push(entry.source)
      const scanned = await entry.scan(root).catch((error: unknown) => {
        unreadable.push(
          `${SOURCE_NAME[entry.source]}'s sessions in ${root} (${error instanceof Error ? error.message : String(error)})`,
        )
        return []
      })
      for (const session of scanned) {
        const key = `${session.source}:${session.sessionId}`
        if (seen.has(key) || resumed.has(session.sessionId)) continue
        seen.add(key)
        if (!folders.has(session.folderPath)) folders.set(session.folderPath, isFolder(session.folderPath))
        if (await folders.get(session.folderPath)) sessions.push(session)
      }
    }
    // Nothing found because a CLI's home could not be read is not "no
    // sessions": the person may have many, behind a permission.
    if (sessions.length === 0 && unreadable.length > 0) throw new Error(`no access to ${unreadable.join('; ')}`)
    return { sessions, found }
  }

  async function scan(): Promise<ConversationImportScanResult> {
    try {
      const { sessions, found } = await scanAll()
      const { imported } = knownSessions()
      const byFolder = new Map<string, ConversationImportFolder>()
      for (const session of sessions.sort((a, b) => b.updatedAt - a.updatedAt)) {
        let folder = byFolder.get(session.folderPath)
        if (!folder) {
          folder = {
            folderPath: session.folderPath,
            name: basename(session.folderPath) || session.folderPath,
            lastActiveAt: session.updatedAt,
            sessions: [],
          }
          byFolder.set(session.folderPath, folder)
        }
        folder.sessions.push({
          source: session.source,
          sessionId: session.sessionId,
          title: titleOf(session.title, session.firstPrompt),
          folderPath: session.folderPath,
          startedAt: session.startedAt,
          updatedAt: session.updatedAt,
          imported: imported.has(`${session.source}:${session.sessionId}`),
        })
      }
      return { ok: true, folders: [...byFolder.values()], sources: found }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Saved sessions could not be read.' }
    }
  }

  async function importSessions(input: ConversationImportInput): Promise<ConversationImportResult> {
    const asked = Array.isArray(input?.sessions) ? input.sessions : []
    if (asked.length === 0) return { ok: true, imported: [], skipped: 0, failed: [] }
    let scanned: ScannedSession[]
    try {
      scanned = (await scanAll()).sessions
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Saved sessions could not be read.' }
    }
    const byKey = new Map(scanned.map((session) => [`${session.source}:${session.sessionId}`, session]))
    const settings = effectiveAgentLaunchSettings(deps.getLaunchSettings())
    const result: Extract<ConversationImportResult, { ok: true }> = { ok: true, imported: [], skipped: 0, failed: [] }
    for (const { source, sessionId } of asked) {
      const key = `${source}:${sessionId}`
      // Read again for each session, so two imports racing, or a session
      // asked for twice, still make one chat.
      if (knownSessions().imported.has(key) || importing.has(key)) {
        result.skipped += 1
        continue
      }
      const session = byKey.get(key)
      if (!session) {
        result.failed.push({ source, sessionId, title: sessionId, message: 'The session is no longer on disk.' })
        continue
      }
      importing.add(key)
      let made: Awaited<ReturnType<typeof importOne>>
      try {
        made = await importOne(session, settings)
      } finally {
        importing.delete(key)
      }
      if (made.ok) result.imported.push({ source, sessionId, workspaceId: made.workspaceId, agentId: made.agentId })
      else
        result.failed.push({
          source,
          sessionId,
          title: titleOf(session.title, session.firstPrompt),
          message: made.message,
        })
    }
    return result
  }

  async function importOne(
    session: ScannedSession,
    settings: AgentLaunchSettings,
  ): Promise<{ ok: true; workspaceId: string; agentId: string } | { ok: false; message: string }> {
    const entry = sources.find((candidate) => candidate.source === session.source)
    const cli = SOURCE_CLI[session.source]
    const providerId = conversationProviderForCli(cli)
    if (!entry || !providerId) return { ok: false, message: `${session.source} sessions cannot be imported.` }
    let history: ImportedConversation
    try {
      history = await entry.read(session.path, session.updatedAt)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The session could not be read.' }
    }
    if (!history.events.length) return { ok: false, message: 'The session holds no messages to import.' }
    const title = titleOf(history.title ?? session.title, history.firstPrompt ?? session.firstPrompt)
    const agentId = `agent-${cli}-${newAgentSuffix()}`
    const modelId = CONVERSATION_DEFAULT_MODEL_ID
    // The preset a New chat on this CLI starts at, as the launcher would pick it.
    const permission = resolveAgentSpawnPermission(settings, cli, undefined)
    const agent: AgentState = {
      ...defaultAgent(agentId, title),
      runtimeKind: 'conversation',
      conversation: { providerId, modelId },
      cliPermissionPreset: permission.preset,
      ...(permission.mode ? { cliPermissionMode: permission.mode } : {}),
      importedFrom: { source: session.source, sessionId: session.sessionId },
    }
    // The history's own last time, which falls back to the scan's: a file's
    // modified time is moved by a copy or a backup, not only by the session.
    const lastActiveAt = Math.min(history.updatedAt, now())
    const created = deps.createWorkspace({
      name: title,
      folderPath: session.folderPath,
      templateId: SOLO_CHAT_TEMPLATE_ID,
      templateAgentIds: { [SOLO_CHAT_TEMPLATE_AGENT_ID]: agentId },
      agents: { [agentId]: agent },
      background: true,
      imported: { startedAt: Math.min(history.startedAt, lastActiveAt), lastActiveAt },
    })
    if (!created.ok) return created
    const written = await deps
      .importTranscript({
        key: { workspaceRoot: session.folderPath, workspaceId: created.workspaceId, agentId },
        providerId,
        modelId,
        providerSessionId: session.sessionId,
        title,
        importedFrom: { source: session.source, sessionId: session.sessionId },
        events: history.events,
      })
      .catch((error: unknown): ConversationImportTranscriptResult => ({
        ok: false,
        message: error instanceof Error ? error.message : 'The conversation could not be imported.',
      }))
    if (!written.ok) {
      deps.removeWorkspace(created.workspaceId)
      return written
    }
    return { ok: true, workspaceId: created.workspaceId, agentId }
  }

  return { scan, importSessions }
}

/** What a session is called: the title its CLI gave it, else a few words of its first message. */
function titleOf(title: string | null, firstPrompt: string | null): string {
  const given = title?.trim()
  if (given) return given.slice(0, 120)
  const derived = firstPrompt ? deriveWorkspaceTitle(firstPrompt) : null
  return derived ?? (firstPrompt?.trim().split('\n')[0]?.slice(0, 80) || 'Imported chat')
}
