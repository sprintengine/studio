import { attachedFileName, type ConversationAttachedFile } from '../shared/conversation/attachedFiles'

/**
 * What the agent is told about the files a message attached by path: each by
 * name and where it is, after the person's words, so it reads them off the
 * disk itself (a PDF, a spreadsheet, a folder). Only the agent's copy of the
 * message carries this; the transcript keeps the words and the list apart.
 */
export function attachedFilesContext(files: readonly ConversationAttachedFile[] | undefined): string {
  if (!files?.length) return ''
  return files.map((file) => `Attached file ${JSON.stringify(attachedFileName(file.path))}: ${file.path}`).join('\n')
}
