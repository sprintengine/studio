import { createHash, randomUUID } from 'crypto'
import { lstat, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { MAX_ATTACHMENT_BYTES } from '../shared/conversation-attachments'
import type {
  ConversationAttachmentResult,
  ConversationImageAttachment,
  ConversationKey,
  ConversationStoredImageAttachment,
} from '../shared/conversation-runtime'
import { ATTACHMENT_IMAGE_EXTENSIONS } from './attachment-image-file'

// The images a person sent with a turn, kept so the bubble still shows them
// after a restart. The transcript cannot hold them: it is replayed into the
// renderer and read line by line for search and the thread index, and a turn
// may carry sixteen five-megabyte images. So the bytes go here, in app data —
// not the workspace sidecar, where a repository could commit or delete them —
// and the `user_message` event records a reference to each.
//
// A reference is `<conversation>/<file>`, both halves names this store chose,
// so reading one back never resolves a path the renderer supplied: anything
// that is not exactly that shape is refused before the filesystem is touched.

const STORE_DIRECTORY = 'conversation-attachments'
const REF_PATTERN = /^([0-9a-f]{32})\/([0-9a-f-]{36})\.([a-z]+)$/u
const MEDIA_TYPE_BY_EXTENSION = new Map(
  Object.entries(ATTACHMENT_IMAGE_EXTENSIONS).map(([mediaType, extension]) => [extension, mediaType]),
)

export class ConversationAttachmentStore {
  /** Without a directory nothing is kept, and a replayed bubble shows no images — what tests construct. */
  constructor(private readonly userDataDir?: string) {}

  private get root(): string | null {
    return this.userDataDir ? join(this.userDataDir, STORE_DIRECTORY) : null
  }

  /**
   * One folder per conversation, named from its identity rather than a session
   * id: a session is replaced on every restart, the conversation is not, and
   * deleting the conversation has to find the same folder.
   */
  static folderFor(key: ConversationKey): string {
    return createHash('sha256')
      .update([key.workspaceRoot, key.workspaceId, key.agentId].join('\u0000'))
      .digest('hex')
      .slice(0, 32)
  }

  /** Writes each image and returns its reference; an image that cannot be written is left out, not fatal. */
  async save(
    key: ConversationKey,
    attachments: ConversationImageAttachment[],
  ): Promise<ConversationStoredImageAttachment[]> {
    const root = this.root
    if (!root || attachments.length === 0) return []
    const folder = ConversationAttachmentStore.folderFor(key)
    await mkdir(join(root, folder), { recursive: true })
    const stored: ConversationStoredImageAttachment[] = []
    for (const attachment of attachments) {
      const extension = ATTACHMENT_IMAGE_EXTENSIONS[attachment.mediaType]
      if (!extension) continue
      const bytes = Buffer.from(attachment.dataBase64, 'base64')
      if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) continue
      const file = `${randomUUID()}.${extension}`
      try {
        await writeFile(join(root, folder, file), bytes, { flag: 'wx' })
      } catch (error) {
        console.warn(
          '[conversation-attachments] could not keep an attached image:',
          error instanceof Error ? error.message : error,
        )
        continue
      }
      stored.push({
        id: attachment.id,
        mediaType: attachment.mediaType,
        ...(attachment.name ? { name: attachment.name } : {}),
        byteLength: bytes.length,
        ref: `${folder}/${file}`,
      })
    }
    return stored
  }

  async read(ref: unknown): Promise<ConversationAttachmentResult> {
    const root = this.root
    const match = typeof ref === 'string' ? REF_PATTERN.exec(ref) : null
    const mediaType = match ? MEDIA_TYPE_BY_EXTENSION.get(match[3]) : undefined
    if (!root || !match || !mediaType) return { ok: false, message: 'That attachment reference is not valid.' }
    const path = join(root, match[1], `${match[2]}.${match[3]}`)
    try {
      const info = await lstat(path)
      // The store only ever writes plain files; anything else was put there by
      // someone else and is not followed.
      if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES)
        return { ok: false, message: 'That attachment is not available.' }
      return { ok: true, mediaType, dataBase64: (await readFile(path)).toString('base64') }
    } catch (error) {
      return {
        ok: false,
        message:
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'That attachment is no longer on this machine.'
            : 'That attachment could not be read.',
      }
    }
  }

  /** Removes every image a conversation kept; called when the conversation itself is deleted. */
  async deleteConversation(key: ConversationKey): Promise<void> {
    const root = this.root
    if (!root) return
    await rm(join(root, ConversationAttachmentStore.folderFor(key)), { recursive: true, force: true })
  }
}
