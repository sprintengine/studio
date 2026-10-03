// The conversation timeline lives in `@sprintengine/conversation-timeline`
// (phase 9 spec, 5.1): one implementation, which the app and other apps' views
// both read. This path keeps the app's imports as they were.
export * from '../../../../../../packages/conversation-timeline/src/conversationProjection'
