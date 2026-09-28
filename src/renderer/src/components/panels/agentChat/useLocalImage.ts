import { useEffect, useState } from 'react'
import { resolveTerminalFileReferencePath } from '../../../utils/terminalFileLinks'
import { useConversationLinkContext } from './conversationLinks'
import { useConversationTransport } from './conversationTransport'

// The image formats main will hand back as a data URL (filesystem-image.ts).
const PREVIEWABLE_IMAGE = /\.(apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/iu
export function isPreviewableImagePath(path: string): boolean {
  return PREVIEWABLE_IMAGE.test(path.trim())
}

export type LocalImage = {
  /**
   * Where the image is on this disk. Null when it cannot be here at all: the
   * conversation runs on another machine, whose paths name files over there, or
   * a relative path has no folder to resolve against.
   */
  resolved: string | null
  src?: string
  failed?: boolean
}

// An image path the agent wrote — a screenshot it read, a picture its reply
// shows — read from this machine's disk as a data URL. Relative paths resolve
// against the conversation's folder the way a file link in the same transcript
// does, so the picture and the link beside it always name the same file.
export function useLocalImage(path: string | null | undefined): LocalImage {
  const context = useConversationLinkContext()
  const localFiles = useConversationTransport().capabilities.localFiles
  const resolved =
    path && localFiles
      ? resolveTerminalFileReferencePath(path, { executionRoot: context?.cwd, workspaceRoot: context?.workspaceRoot })
      : null
  const [image, setImage] = useState<{ path: string; src?: string; failed?: boolean }>()
  useEffect(() => {
    if (!resolved) return
    let cancelled = false
    window.api.readImageDataUrl(resolved).then(
      (src) => {
        if (!cancelled) setImage({ path: resolved, src })
      },
      () => {
        if (!cancelled) setImage({ path: resolved, failed: true })
      },
    )
    return () => {
      cancelled = true
    }
  }, [resolved])
  const current = image?.path === resolved ? image : undefined
  return { resolved, src: current?.src, failed: current?.failed }
}
