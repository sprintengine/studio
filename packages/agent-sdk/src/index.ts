// `@sprintengine/agent-sdk`: drive SprintEngine Studio's agents from your own
// code. This entry is the transport-agnostic client and runs in Node and in a
// browser; `@sprintengine/agent-sdk/node` adds the owner socket on this
// machine, discovery and token keeping.
//
// The protocol is re-exported whole, so the frames, events and validators a
// client reads come from the same package that connects it.
export * from './protocol.js'
export { StudioError, TERMINAL_CODES } from './errors.js'
export type { StudioTransport, StudioTransportFactory } from './transport.js'
export {
  connect,
  type ConnectOptions,
  type StudioClient,
  type StudioClientState,
  type StudioConversationService,
} from './client.js'
export {
  agentConversations,
  approvalRequestOf,
  conversationHandle,
  type AgentConversations,
  type ApprovalRequest,
  type CommandOptions,
  type Conversation,
  type ConversationEventStream,
  type ConversationFollowFrame,
  type ConversationFollowOptions,
  type ConversationListing,
  type ConversationRef,
  type ConversationResult,
  type ConversationService,
  type CreateConversationInput,
  type EventStreamOptions,
} from './conversations.js'
export { fromModuleConversationService, type ModuleConversationServiceLike } from './module.js'
