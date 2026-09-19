import type { WorkspaceSkill } from '../../../../../shared/electron-api'
import type { ConversationImageAttachment } from '../../../../../shared/conversation-runtime'
import type { AgentCli } from '../../../types/workspace'
import type { AgentComposerConnector, AgentComposerSelection } from './useAgentComposer'

// The New chat door's parked draft (new-chat-survives-back-and-forward,
// 2026-09-04). The panel is component state, and it unmounts whenever the
// person steps off it — Back, a sidebar click, a door — so everything typed
// and pasted into it died with it. This is the draft's home outside the
// panel: per window, in renderer memory only (never persisted — a draft is a
// thing you are in the middle of, not a thing you keep), written through by
// the panel as it changes and read back when the door reopens.
//
// What clears it: starting the chat, or closing the panel on purpose (× /
// Escape). Navigation never does — that is the whole point.

/** A pasted or dropped image, as the panel holds it: the attachment plus the temp path the agent opens. */
export type NewChatDraftImage = ConversationImageAttachment & { path: string }

/**
 * The engine a draft opens on, when the pick that made the draft happened
 * somewhere the remembered defaults were deliberately not written.
 *
 * That is exactly one caller today: a card's `Go` picker (item 2473, ruling
 * R4b). Choosing how to run ONE card must not move the engine of the person's
 * next unrelated New chat, so the picker writes nothing — and then the row it
 * chose has nowhere else to live on the paths that land in the composer instead
 * of spawning. It rides here, is applied as the composer's opening engine, and
 * is dropped the moment the person picks a row of their own.
 */
type NewChatDraftEngine = { cli: AgentCli; model: string | null; reasoning: string | null }

export type NewChatDraft = {
  /** The project the draft was scoped to; null for "no project picked". */
  folderPath: string | null
  prompt: string
  images: NewChatDraftImage[]
  /** The engine row picked, or null to fall back to the host's remembered choice. */
  selection: AgentComposerSelection | null
  /** The cli/model/effort that row runs on, when the picker stored none. */
  engine: NewChatDraftEngine | null
  skills: WorkspaceSkill[]
  mcpServers: AgentComposerConnector[]
}

const EMPTY_DRAFT: NewChatDraft = {
  folderPath: null,
  prompt: '',
  images: [],
  selection: null,
  engine: null,
  skills: [],
  mcpServers: [],
}

const drafts = new Map<string, NewChatDraft>()

/** The parked draft for a window, or null when nothing is parked. */
export function readNewChatDraft(key: string): NewChatDraft | null {
  return drafts.get(key) ?? null
}

/** Merge a change into the window's draft, creating it from empty on first write. */
export function writeNewChatDraft(key: string, patch: Partial<NewChatDraft>): NewChatDraft {
  const next = { ...(drafts.get(key) ?? EMPTY_DRAFT), ...patch }
  drafts.set(key, next)
  return next
}

/** Forget the draft: the chat started, or the person closed the panel on purpose. */
export function clearNewChatDraft(key: string): void {
  drafts.delete(key)
}

/**
 * Move a parked draft onto another project. Skills and MCP picks were installed
 * and synced into ONE project; carried into another they would launch the agent
 * somewhere they are not, so a change of project drops them (the same rule the
 * panel applies live). The prompt and images travel — they are the person's
 * words, not a project's configuration. A draft already on that project is
 * untouched, and no draft is minted for a window that has none.
 */
export function rescopeNewChatDraft(key: string, folderPath: string | null): NewChatDraft | null {
  const draft = drafts.get(key)
  if (!draft) return null
  if (sameFolder(draft.folderPath, folderPath)) return draft
  return writeNewChatDraft(key, { folderPath, skills: [], mcpServers: [] })
}

/**
 * Whether the draft holds anything a person would miss: typed words, attached
 * images, or skills / MCP servers they picked. The engine row and the project
 * are not content — both default, and a draft that is nothing but defaults
 * must not pin them onto every New chat after it. The parked ENGINE is the same
 * kind of thing: it says how a chat would start, not that there is one to start.
 */
export function newChatDraftHasContent(draft: NewChatDraft | null): boolean {
  if (!draft) return false
  return (
    draft.prompt.trim().length > 0 || draft.images.length > 0 || draft.skills.length > 0 || draft.mcpServers.length > 0
  )
}

/**
 * The connectors a reopened panel starts with: an explicit attachment (a
 * connector's own "New chat") leads, and the draft's picks follow, deduplicated
 * by id — reopening onto a connector never doubles a chip already parked.
 */
export function mergeDraftConnectors(
  explicit: AgentComposerConnector[] | null | undefined,
  parked: AgentComposerConnector[] | undefined,
): AgentComposerConnector[] {
  const merged: AgentComposerConnector[] = []
  const seen = new Set<string>()
  for (const connector of [...(explicit ?? []), ...(parked ?? [])]) {
    if (seen.has(connector.id)) continue
    seen.add(connector.id)
    merged.push(connector)
  }
  return merged
}

function sameFolder(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  return normalizeFolder(a) === normalizeFolder(b)
}

function normalizeFolder(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

/** Test seam: forget every window's draft. */
export function resetNewChatDraftsForTests(): void {
  drafts.clear()
}
