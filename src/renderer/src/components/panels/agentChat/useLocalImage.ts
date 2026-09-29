import { useEffect, useState } from 'react'
import { resolveTerminalFileReferencePath } from '../../../utils/terminalFileLinks'
import { useConversationLinkContext } from './conversationLinks'
import {
  useConversationTransport,
  type ConversationToolImageResult,
  type ConversationTransport,
} from './conversationTransport'

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

// Pictures read off this disk, by path and the file's size and modification
// time, so a row the virtual list re-mounts draws what it already read instead
// of reading and encoding the file again, while a file rewritten under the same
// name is read afresh. Few entries: each is a data URL, often megabytes.
const LOCAL_IMAGE_CACHE_ENTRIES = 8
const localImages = new Map<string, Promise<string>>()

async function readLocalImage(path: string): Promise<string> {
  if (typeof window.api.statPath !== 'function') return window.api.readImageDataUrl(path)
  const stat = await window.api.statPath(path).catch(() => null)
  if (!stat || typeof stat.modifiedAtMs !== 'number') return window.api.readImageDataUrl(path)
  const key = `${stat.modifiedAtMs}:${stat.sizeBytes}:${path}`
  const cached = localImages.get(key)
  if (cached) {
    localImages.delete(key)
    localImages.set(key, cached)
    return cached
  }
  const read = window.api.readImageDataUrl(path)
  localImages.set(key, read)
  while (localImages.size > LOCAL_IMAGE_CACHE_ENTRIES) localImages.delete(localImages.keys().next().value!)
  // A failed read is not kept: the next look asks again.
  read.catch(() => {
    if (localImages.get(key) === read) localImages.delete(key)
  })
  return read
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
    readLocalImage(resolved).then(
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

// A remote chat's pictures, per transport (one per followed conversation), so a
// row that scrolls away and back, or opens after showing collapsed, draws what
// was already fetched instead of asking the other machine again. A failure is
// not kept, since the picture may be there on the next look; a machine that
// does not serve pictures is, since it will not start to mid-conversation. Few
// entries, since each can be megabytes of data URL.
const TOOL_IMAGE_CACHE_ENTRIES = 12
const toolImageCache = new WeakMap<ConversationTransport, Map<string, Promise<ConversationToolImageResult>>>()

function fetchToolImage(
  transport: ConversationTransport,
  toolImage: NonNullable<ConversationTransport['toolImage']>,
  toolUseId: string,
): Promise<ConversationToolImageResult> {
  let cache = toolImageCache.get(transport)
  if (!cache) {
    cache = new Map()
    toolImageCache.set(transport, cache)
  }
  const cached = cache.get(toolUseId)
  if (cached) {
    // The most recently shown stays longest.
    cache.delete(toolUseId)
    cache.set(toolUseId, cached)
    return cached
  }
  const asked = toolImage({ toolUseId }).catch((error: unknown): ConversationToolImageResult => ({
    ok: false,
    unsupported: false,
    message: error instanceof Error ? error.message : String(error),
  }))
  cache.set(toolUseId, asked)
  while (cache.size > TOOL_IMAGE_CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
  void asked.then((answer) => {
    if (!answer.ok && !answer.unsupported && cache.get(toolUseId) === asked) cache.delete(toolUseId)
  })
  return asked
}

/**
 * The picture a step made or looked at. On this machine, read off the disk as
 * `useLocalImage` does. In a chat on a paired machine, asked of that machine by
 * the step's id — never by path, which names a file over there — and `remote`
 * says so, since there is no file here to reveal. Unresolved where that
 * machine does not serve pictures: the picture is on the other machine.
 */
export function useToolImage(toolUseId: string, path: string | null | undefined): LocalImage & { remote?: boolean } {
  const local = useLocalImage(path)
  const transport = useConversationTransport()
  const remote = Boolean(path) && !transport.capabilities.localFiles && transport.toolImage !== undefined
  const [image, setImage] = useState<{ id: string; answer: ConversationToolImageResult }>()
  useEffect(() => {
    if (!remote || !transport.toolImage) return
    let cancelled = false
    void fetchToolImage(transport, transport.toolImage, toolUseId).then((answer) => {
      if (!cancelled) setImage({ id: toolUseId, answer })
    })
    return () => {
      cancelled = true
    }
  }, [remote, transport, toolUseId])
  if (!remote) return local
  const answer = image?.id === toolUseId ? image.answer : undefined
  if (answer && !answer.ok && answer.unsupported) return { resolved: null }
  return {
    resolved: path ?? null,
    src: answer?.ok ? answer.src : undefined,
    failed: answer ? !answer.ok : undefined,
    remote: true,
  }
}
