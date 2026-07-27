// Image-attachment limits for a conversation turn, declared once for both ends
// of the send-turn boundary: the composer stages against them
// (src/renderer/src/components/panels/AgentChatView.tsx) and
// `parseImageAttachments` rejects against them
// (src/main/ipc/conversation-ipc.ts). They were independently declared on each
// side; drift showed up as the composer staging an image the boundary then
// refused mid-send, or trimming to a cap main had already raised (1810).
//
// Node-free on purpose — this module is imported from the renderer and main.
// Composer resampling policy (longest kept edge, JPEG re-encode quality) is not
// here: it is how the renderer gets an image under these limits, not a limit
// the boundary enforces.

// The base64 image media types the Claude Agent SDK (and the Anthropic API)
// accept. Offering anything else in the composer would only buy the user a
// rejection one layer down.
export const ATTACHABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

// Per-image decoded-byte ceiling, matching the Anthropic API's ~5 MB image
// limit. The composer downscales toward it and only refuses what still will not
// fit; the boundary rejects the rest so nothing silently truncates.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

// Per-turn attachment cap: generous enough that no realistic manual attach
// count reaches it, low enough that a runaway paste cannot push an unbounded
// payload through IPC.
export const MAX_ATTACHMENTS_PER_TURN = 16
