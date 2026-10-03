// `@sprintengine/conversation-view`: a SprintEngine Studio conversation,
// read-only, as a React component another app renders over its own Studio
// connection (phase 9 spec, 5.1 to 5.3). Its rows come from
// `@sprintengine/conversation-timeline`.
export { ConversationView, type ConversationViewProps } from './ConversationView.js'
export {
  CONVERSATION_VIEW_CSS,
  SE_DEFAULTS,
  SE_TOKENS,
  themeStyle,
  type ConversationViewTheme,
  type SeToken,
} from './theme.js'
export type { ConversationAddress, ConversationFollowSource } from './timeline.js'
