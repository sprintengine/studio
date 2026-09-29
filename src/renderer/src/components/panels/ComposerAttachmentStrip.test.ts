import { expect, test } from 'vitest'

import type { ConversationImageAttachment } from '../../../../shared/conversation-runtime'
import { attachmentPreviewUrl } from './ComposerAttachmentStrip'

test("an attachment's preview URL is built once and handed back the same while the attachment lives", () => {
  const attachment: ConversationImageAttachment = {
    id: 'a',
    mediaType: 'image/png',
    dataBase64: 'Zm9v'.repeat(1024),
    byteLength: 3072,
  }
  const first = attachmentPreviewUrl(attachment)
  expect(first).toBe(`data:image/png;base64,${attachment.dataBase64}`)
  // Kept per attachment object rather than rebuilt: an attachment is never
  // edited in place, so a later read answers from what was built first.
  const built = attachment.dataBase64
  attachment.dataBase64 = 'changed'
  expect(attachmentPreviewUrl(attachment)).toBe(first)
  attachment.dataBase64 = built
  // Another attachment with the same picture has a URL of its own.
  const copy = { ...attachment, id: 'b', mediaType: 'image/webp' }
  expect(attachmentPreviewUrl(copy)).toBe(`data:image/webp;base64,${attachment.dataBase64}`)
})
