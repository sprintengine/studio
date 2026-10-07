// The IPC contract for the subscription usage limits: the renderer asks for the
// latest reading per provider, and main pushes every change afterwards to each
// window that asked. The readings are kept in main (src/main/usage-limits).
export const USAGE_LIMITS_GET_CHANNEL = 'usage-limits:get'
export const USAGE_LIMITS_CHANGED_CHANNEL = 'usage-limits:changed'
