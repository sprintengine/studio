/**
 * Whether a chat that finishes, or stops to ask, while no Studio window has
 * focus says so with an OS notification: not at all, with a banner, or with a
 * banner and the system's notification sound. Settings → General.
 */
export type AgentNotificationMode = 'off' | 'banner' | 'banner-sound'

export const AGENT_NOTIFICATION_MODES: readonly AgentNotificationMode[] = ['off', 'banner', 'banner-sound']

/** A banner and no sound: the dock bounce already makes a noise of its own kind. */
export const DEFAULT_AGENT_NOTIFICATION_MODE: AgentNotificationMode = 'banner'

export function isAgentNotificationMode(value: unknown): value is AgentNotificationMode {
  return typeof value === 'string' && (AGENT_NOTIFICATION_MODES as readonly string[]).includes(value)
}
