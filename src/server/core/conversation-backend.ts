import type { ConversationRuntime } from '../../main/conversation-runtime'

// What everything that drives or reads chats calls: the session API both IPC
// and the network wrap, the tailnet conversation host, the module conversation
// service, scheduled agents, companion agents and the IPC handlers.
//
// Today the only implementation is the in-process `ConversationRuntime`. The
// seam exists so a later phase can answer the same calls from another server
// (the one inside a WSL distribution, or one reached over SSH) and pick between
// them per workspace, without any of those callers changing. So a caller takes
// a `ConversationBackend`, never the runtime class, and a member belongs here
// only if a remote server could answer it too.
//
// What stays off it is the owner's business, kept on the runtime the core
// constructs: when its idle sweep runs, flushing and shutting down, and the
// live child processes of this machine.

// `Pick` refuses a name the runtime does not have, so this list cannot drift
// from the class.
export type ConversationBackendMember =
  | 'onEvent'
  | 'listSessions'
  | 'getProviderCapabilities'
  | 'getNativeProviderModels'
  | 'startSession'
  | 'sendTurn'
  | 'respondToRequest'
  | 'setPermission'
  | 'setModel'
  | 'interrupt'
  | 'stopSession'
  | 'suspendSession'
  | 'terminalHandoffTarget'
  | 'stopForTerminalHandoff'
  | 'endTerminalHandoff'
  | 'noteTerminalHandoff'
  | 'getToolDetail'
  | 'findToolCall'
  | 'readAttachment'
  | 'planDocument'
  | 'listThreads'
  | 'searchThreads'
  | 'renameThread'
  | 'deleteTranscript'
  | 'readTranscript'
  | 'readPeekTranscript'
  | 'readConversationSync'
  | 'readConversationPage'
  | 'recoverTranscript'
  | 'getTurnDiff'
  | 'listApprovalRules'
  | 'revokeApprovalRule'
  | 'revertToTurn'
  | 'rewindToTurn'
  | 'forkAtTurn'

export type ConversationBackend = Pick<ConversationRuntime, ConversationBackendMember>

/**
 * The in-process backend: the runtime itself, seen only through the backend's
 * members. A view rather than a copy, so `this` inside each method is still the
 * runtime.
 */
export function localConversationBackend(runtime: ConversationRuntime): ConversationBackend {
  return runtime
}
