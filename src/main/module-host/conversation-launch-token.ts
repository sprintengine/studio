import type { AppServices } from '../app-services'
import { createServiceToken } from './main-host'

// The host-internal chat tokens: the service that starts a chat in main (a
// module's `create`, an automation run's agent, a paired machine's New chat)
// and the conversation runtime those chats then run on. First-party only —
// neither key is on the third-party service list; a module reaches chats
// through the moduleId-scoped `conversation.module-service` instead.
//
// Kept apart from service-tokens.ts for now; the two belong together and are
// folded in when agent-runtime-module provides them itself.
export const ConversationLaunchServiceToken =
  createServiceToken<AppServices['conversationLaunchService']>('core.conversation-launch')
export const ConversationRuntimeToken =
  createServiceToken<AppServices['conversationRuntime']>('core.conversation-runtime')
