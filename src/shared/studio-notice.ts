import { STUDIO_PRODUCT_NAME } from './product-identity'

// How a message Studio sends an agent itself opens: a launched agent's news
// (main/agent-launch-notices.ts), a resume after a usage limit
// (main/usage-limits/resume.ts).
//
// The agent receives the message as a plain user turn: neither a CLI's prompt
// nor its SDK has a field for who is speaking, and a terminal agent reads
// whatever is typed at its prompt. Without a name in the words it would take
// Studio's notice for the person's instruction, so the text keeps a short one.
// Who reads the chat does not need it: the chat's own record marks the
// message (`origin` on its `user_message`), and the chat view draws it as
// Studio's row under Studio's name, so the row leaves the prefix out.
export const STUDIO_NOTICE_PREFIX = `[${STUDIO_PRODUCT_NAME}]`

/** The notice's words without the name it opens with, for a row that already says it is Studio's. */
export function withoutStudioNoticePrefix(text: string): string {
  const trimmed = text.trimStart()
  return trimmed.startsWith(STUDIO_NOTICE_PREFIX) ? trimmed.slice(STUDIO_NOTICE_PREFIX.length).trimStart() : text
}
