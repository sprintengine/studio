import type {
  ConversationCommand,
  ConversationCreateRequest,
  ConversationThread,
  ConversationWirePermissionPreset,
  StudioAuth,
  StudioClientInfo,
  StudioCreatedConversation,
  StudioGrant,
} from '../../../packages/studio-protocol/src/public'
import type {
  ConversationKey,
  ConversationPageResult,
  ConversationSessionFrame,
  ConversationToolDetailResult,
  ConversationTurnDiffResult,
} from '../../shared/conversation-runtime'

// What the Studio RPC needs from the rest of Studio, as interfaces, so the
// router and the connection import nothing from Electron or from main: the
// conversations it serves, and who may connect.

/** How a command ended, as the conversation host words it. */
export type StudioCommandOutcome = { ok: boolean; code?: string; message?: string; notice?: string }

/**
 * The conversations the RPC serves. Main implements it over the same
 * conversation host the tailnet lane wraps, the launch service and the
 * runtime, so a chat behaves the same whichever way it is reached.
 */
export type StudioConversationBackend = {
  list(): Promise<ConversationThread[]>
  /** The conversation's place on disk, or null when its workspace is not here. */
  resolveKey(workspaceId: string, agentId: string): ConversationKey | null
  /** Follow one conversation from a cursor: snapshot or catch-up, a fence, then live events. */
  follow(
    key: ConversationKey,
    cursor: { afterSeq?: number; generation?: string; turnLimit?: number },
    listener: (frame: ConversationSessionFrame) => void,
  ): { dispose(): void; ready: Promise<void> }
  loadEarlier(key: ConversationKey, beforeCursor: number, turnLimit?: number): Promise<ConversationPageResult>
  toolDetail(key: ConversationKey, toolUseId: string): Promise<ConversationToolDetailResult>
  turnDiff(key: ConversationKey, turnSeq: number, path?: string): Promise<ConversationTurnDiffResult>
  /**
   * Carry out one command under an id already namespaced to its client. The
   * runtime's durable receipts answer a retry of the same id with the first
   * attempt's result.
   */
  command(
    key: ConversationKey,
    clientId: string,
    commandId: string,
    command: ConversationCommand,
  ): Promise<StudioCommandOutcome>
  /**
   * End the conversation's live session, if it has one, under the command id
   * already namespaced to its client: the receipt answers a resend with the
   * first result rather than stopping a session started since.
   */
  stop(key: ConversationKey, commandId: string): Promise<{ ok: true } | { ok: false; message: string }>
  /** The preset the conversation runs on now, or resumes on. */
  permissionOf(key: ConversationKey): ConversationWirePermissionPreset
  /** The conversation an earlier create under this namespaced id started, if it still exists. */
  findCreated(launchCommandId: string): StudioCreatedConversation | null
  /** Start a conversation. `request` has already been held to the client's ceiling. */
  create(
    request: ConversationCreateRequest,
    launchCommandId: string,
  ): Promise<{ ok: true; conversation: StudioCreatedConversation } | { ok: false; code: string; message: string }>
  /**
   * What a client is shown of anything read from a conversation — an event, a
   * page, a tool's detail, a turn's diff: secret-shaped members redacted, as
   * the tailnet lane redacts them. Returns a copy.
   */
  redact<T>(value: T): T
}

export type StudioAuthOutcome = { ok: true; grant: StudioGrant; pairingToken?: string } | { ok: false; message: string }

/** Who may connect, and what each may do now. */
export type StudioAuthenticator = {
  /** Check a hello's credential; a pairing code is redeemed here, once. */
  authenticate(auth: StudioAuth, client: StudioClientInfo): StudioAuthOutcome
  /** The client's grant as it stands now, or null once it is revoked. Read on every request. */
  grantFor(clientId: string): StudioGrant | null
  onRevoked(listener: (clientId: string) => void): () => void
  onGrantChanged(listener: (clientId: string) => void): () => void
  recordSeen?(clientId: string): void
}

/** One mutation, or one refusal at the door, as the audit records it. Never a message's text. */
export type StudioAuditEntry = {
  clientId: string | null
  clientName: string
  /** The method (`conversation.send`), or `studio.auth_refused` / `studio.paired`. */
  tool: string
  workspaceId?: string
  agentId?: string
  commandId?: string
  ok: boolean
  code?: string
  durationMs: number
}
