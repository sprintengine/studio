import { ATTACHABLE_IMAGE_TYPES } from '../../../shared/conversation-attachments'

// DataTransfer plumbing shared by every surface that takes an image from a
// paste or a drop — the chat composer (AgentChatView) and the new-chat launch
// surface (NewAgentPanel). Extracted from AgentChatView so the lazily-loaded
// launch surface does not have to import the whole chat panel for two helpers.

/**
 * Whether a drag/drop payload carries files at all. Mid-drag the payload itself
 * is unreadable — only the item kinds are — so this is what the drop target and
 * the preventDefault gate can key off. A drag of selected text reports no files
 * and is left entirely to the textarea's native handling.
 */
export function dataTransferHasFiles(data: DataTransfer | null): boolean {
  if (!data) return false
  if (Array.from(data.types ?? []).includes('Files')) return true
  return Array.from(data.items ?? []).some((item) => item.kind === 'file')
}

/**
 * Every file in a paste or drop, whatever its type. `DataTransfer.files` is
 * empty for a screenshot pasted from the clipboard, where the image only exists
 * as an `item` — both shapes have to be read or paste silently does nothing.
 */
export function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return []
  const files: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  if (files.length === 0) {
    for (const file of Array.from(data.files ?? [])) files.push(file)
  }
  return files
}

/** The image files in a paste or drop, filtered to the types agents accept. */
export function imageFilesFromDataTransfer(data: DataTransfer | null): File[] {
  return filesFromDataTransfer(data).filter((file) =>
    (ATTACHABLE_IMAGE_TYPES as readonly string[]).includes(file.type)
  )
}

/** One file's bytes as base64, with the media type the browser reports. */
export function readFileAsBase64(file: File): Promise<{ mediaType: string; dataBase64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(result)
      if (!match) {
        reject(new Error(`Could not read ${file.name || 'the image'}.`))
        return
      }
      resolve({ mediaType: match[1], dataBase64: match[2] })
    }
    reader.onerror = () => reject(new Error(`Could not read ${file.name || 'the image'}.`))
    reader.readAsDataURL(file)
  })
}
