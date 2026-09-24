import { createHash } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeImage, shell } from 'electron'

import { locateClaudeTranscript } from './locate'
import { createConversationPeekService } from './service'
import type { ConversationPeekDependencies, ConversationPeekService } from './service'
import { peekImageThumbnail } from './thumbnail'
import { readTranscriptPeek } from './transcript'
import type { PeekImagePayload } from './transcript'

/**
 * The filesystem/Electron half of the conversation peek, kept apart from
 * `service.ts` so the assembly and degradation rules stay unit-testable without
 * a runtime — the same split `project-logo-io.ts` makes against `project-logo.ts`.
 */

/** Where an opened attachment image is materialised. Cleared by the OS, not by us. */
const PEEK_IMAGE_DIR = 'sprintengine-conversation-peek'

export function createConversationPeek(
  readSessionState: ConversationPeekDependencies['readSessionState'],
): ConversationPeekService {
  return createConversationPeekService({
    readSessionState,
    readTranscript: (transcriptPath) => readTranscriptPeek(transcriptPath, { home: homedir() }),
    locateTranscript: (input) => locateClaudeTranscript(input),
    renderThumbnail: peekImageThumbnail,
    openImage: openPeekImage,
    revealFile: revealPeekFile,
  })
}

/**
 * Put a pasted image in front of the person in their own image viewer.
 *
 * The image exists only as base64 inside a transcript, so it has to become a
 * file first — and the file we write is always a PNG we re-encoded ourselves,
 * never the transcript's bytes under the transcript's own media type. That is
 * the point: the transcript is written by another process, and handing
 * `shell.openPath` a file whose contents and extension both came from there is
 * handing it a chance to name something the OS would execute. Round-tripping
 * through `nativeImage` means whatever we open decoded as an image first.
 */
async function openPeekImage(image: PeekImagePayload): Promise<void> {
  const decoded = nativeImage.createFromBuffer(Buffer.from(image.data, 'base64'))
  if (decoded.isEmpty()) return
  const png = decoded.toPNG()
  if (png.byteLength === 0) return

  const directory = join(tmpdir(), PEEK_IMAGE_DIR)
  // Content-addressed, so opening the same attachment twice reuses one file
  // rather than filling the temp directory with copies of a screenshot.
  const name = `${createHash('sha1').update(png).digest('hex')}.png`
  const target = join(directory, name)
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(target, png, { mode: 0o600 })
  } catch {
    return
  }
  await shell.openPath(target)
}

/**
 * Show a file the person referenced in the OS file manager.
 *
 * REVEAL, not open. The path was parsed out of a transcript written by another
 * process, so `shell.openPath` on it would let that file decide what runs — a
 * `.command`, a `.app`, a document with a handler of its own — off a single
 * click on a hover card. Revealing puts the person in front of the file with
 * their own file manager's affordances and no handler dispatch.
 *
 * Re-checked here even though the reader only emits paths that existed when it
 * ran: a peek can be minutes old by the time it is clicked, and
 * `showItemInFolder` on a path that has since gone opens the file manager on
 * nothing at all, which reads as the app misfiring. Throwing instead lets the
 * caller surface it; a chip for a file that never resolved is already inert and
 * never reaches this.
 */
async function revealPeekFile(filePath: string): Promise<void> {
  await access(filePath)
  shell.showItemInFolder(filePath)
}
