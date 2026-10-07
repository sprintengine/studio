// The IPC contract for resuming a chat a usage limit stopped: a window asks for
// the chats with a notice and the setting, changes either, and main pushes
// every change afterwards to each window that asked. Kept in main
// (src/main/usage-limits/resume.ts).
export const USAGE_LIMIT_RESUMES_GET_CHANNEL = 'usage-limit-resumes:get'
export const USAGE_LIMIT_RESUMES_UPDATE_CHANNEL = 'usage-limit-resumes:update'
export const USAGE_LIMIT_RESUMES_CHANGED_CHANNEL = 'usage-limit-resumes:changed'
