// A file attached by path, as the card the composer and a sent message show it
// as: what it is (the system's thumbnail, or its type glyph until one arrives),
// and a click that opens it in the app the system picks — or, for any file not
// of a kind a click may open, shows it in its folder instead (attached-files.ts in
// main holds that line, this only labels it). Its own module, imported by the
// composer strip and the sent bubble alike, so the lazily-loaded launch surface
// pulls in the card and not the chat panel.

import { memo, useEffect, useState } from 'react'

import { opensInDefaultApp, type AttachedFilePreview } from '../../../../../shared/attached-files'
import { clientSupports, hostPlatform } from '../../../clientCapabilities'
import { showToast } from '../../../store/toastStore'
import { attachedFileName, attachedFileType, middleTruncateFileName } from '../../../utils/attachedFiles'
import { revealLabel } from '../../../utils/revealLabel'
import { AttachmentFileCard } from '../../ui/AttachmentChip'
import { ContextMenu, MenuItem } from '../../ui/ContextMenu'
import { FileTypeGlyph, FolderGlyph } from '../../ui/FileTypeGlyph'

// What main said about each path, kept for the window's life so a card that
// re-mounts (every chat switch, the transcript's virtual list) draws at once
// rather than flashing its glyph. Main is the authority on whether the file
// changed — it keys its thumbnails by path, size and modification time — so a
// kept answer older than a few seconds is drawn and asked again, and a file
// edited since shows its new picture. A path that was missing is asked again
// next time, in case it has come back. Bounded, oldest out.
const MAX_PREVIEWS = 200
const PREVIEW_FRESH_MS = 5_000
const previews = new Map<string, { preview: AttachedFilePreview; at: number }>()
const asking = new Map<string, Promise<AttachedFilePreview | null>>()

function askPreview(path: string): Promise<AttachedFilePreview | null> {
  const pending = asking.get(path)
  if (pending) return pending
  // Asked inside the promise, so a shell that cannot answer (a browser tab)
  // settles on the glyph rather than throwing out of a render's effect.
  const next = Promise.resolve()
    .then(() => window.api.previewAttachedFile(path))
    .catch(() => null)
    .then((preview) => {
      asking.delete(path)
      previews.delete(path)
      if (preview && preview.kind !== 'missing') {
        previews.set(path, { preview, at: Date.now() })
        while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value as string)
      }
      return preview
    })
  asking.set(path, next)
  return next
}

/** Test seam: forget every preview. */
export function resetAttachedFilePreviewsForTests(): void {
  previews.clear()
  asking.clear()
}

/** Main's answer about a path, null until it arrives — the card draws its glyph meanwhile. */
function useAttachedFilePreview(path: string): AttachedFilePreview | null {
  const [answer, setAnswer] = useState<{ path: string; preview: AttachedFilePreview | null } | null>(null)
  useEffect(() => {
    const kept = previews.get(path)
    if (kept && Date.now() - kept.at < PREVIEW_FRESH_MS) return
    let live = true
    void askPreview(path).then((preview) => {
      if (live) setAnswer({ path, preview })
    })
    return () => {
      live = false
    }
  }, [path])
  if (answer?.path === path) return answer.preview
  return previews.get(path)?.preview ?? null
}

// The click's action: main's answer once it has one, and until then (or for a
// file that has gone, whose open says so) the name's — only a kind a click
// may open is opened, and anything else is shown in its folder.
function revealsOnly(path: string, preview: AttachedFilePreview | null): boolean {
  if (preview?.kind === 'folder' || preview?.kind === 'unknown') return true
  if (preview?.kind === 'file') return !preview.openable
  return !opensInDefaultApp(path, hostPlatform())
}

async function revealAttachedFile(path: string): Promise<void> {
  try {
    await window.api.showItemInFolder(path)
  } catch (error) {
    showToast({
      tone: 'error',
      title: `Could not show ${attachedFileName(path)}`,
      description: error instanceof Error ? error.message : String(error),
    })
  }
}

// Opens the file where main lets it, and says why when it does not: nothing
// else on screen would change to show the click did nothing.
async function openAttachedFile(path: string): Promise<void> {
  try {
    await window.api.openAttachedFile(path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showToast({
      tone: 'error',
      title: `Could not open ${attachedFileName(path)}`,
      description: message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''),
    })
  }
}

const NAME_CHARS = 24

export const ComposerFileChip = memo(function ComposerFileChip({
  path,
  onRemove,
}: {
  path: string
  /** Present while the file is staged on a composer; a sent message's card has none. */
  onRemove?: (path: string) => void
}) {
  const preview = useAttachedFilePreview(path)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const name = attachedFileName(path)
  const folder = preview?.kind === 'folder'
  const type = attachedFileType(name)
  const revealOnly = revealsOnly(path, preview)
  const canReveal = clientSupports('reveal-in-folder')
  const reveal = revealLabel(hostPlatform())
  const glyphClass = 'icon-lg shrink-0'
  return (
    <>
      <AttachmentFileCard
        preview={
          preview?.thumbnailDataUrl ? (
            <img src={preview.thumbnailDataUrl} alt="" className="h-full w-full object-cover" />
          ) : folder ? (
            <FolderGlyph className={glyphClass} />
          ) : (
            <FileTypeGlyph kind={type.kind} tone="kind" className={glyphClass} />
          )
        }
        name={middleTruncateFileName(name, NAME_CHARS)}
        fullName={name}
        typeLabel={folder ? 'Folder' : type.label}
        actionLabel={revealOnly ? `${reveal}: ${name}` : `Open ${name}`}
        onOpen={() => void (revealOnly ? revealAttachedFile(path) : openAttachedFile(path))}
        onContextMenu={(event) => {
          if (revealOnly && !canReveal && !onRemove) return
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
        removeLabel={`Remove ${name}`}
        onRemove={onRemove ? () => onRemove(path) : undefined}
      />
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} ariaLabel={name} onClose={() => setMenu(null)}>
          {revealOnly ? null : (
            <MenuItem
              onClick={() => {
                setMenu(null)
                void openAttachedFile(path)
              }}
            >
              Open
            </MenuItem>
          )}
          {canReveal ? (
            <MenuItem
              onClick={() => {
                setMenu(null)
                void revealAttachedFile(path)
              }}
            >
              {reveal}
            </MenuItem>
          ) : null}
          {onRemove ? (
            <MenuItem
              onClick={() => {
                setMenu(null)
                onRemove(path)
              }}
            >
              Remove
            </MenuItem>
          ) : null}
        </ContextMenu>
      ) : null}
    </>
  )
})
