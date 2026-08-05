import { Fragment, useCallback } from 'react'
import { ContextMenu, MenuDivider, MenuItem } from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { focusOrAddFileTab, revealNavRailComponent } from '../../utils/modelRegistry'
import { openExternalFileWindow } from '../auxWindows/openFileWindow'
import { dispatchBacklogReveal } from '../../utils/backlogReveal'
import { dispatchFileReveal } from '../../utils/fileReveal'
import { dispatchEditorFocusEvent } from '../../utils/editorFocus'
import { basename } from '../../utils/paths'
import { isImageFile } from '../../utils/files'
import {
  backlogRelativePath,
  terminalLinkActions,
  type TerminalLinkAction,
  type TerminalLinkTarget,
} from '../../utils/terminalLinkActions'

// The chooser a terminal link click opens (MC-1899). Clicking a link used to fire
// one hard-wired action; now it asks. `terminalLinkActions` decides WHAT is on
// offer, this component owns WHAT EACH ONE DOES and nothing else.
//
// It is deliberately `ContextMenu` + `MenuItem` rather than a bespoke popover:
// that pair already carries role="menu", viewport clamping, Escape-restores-focus,
// outside-pointerdown close, and Up/Down/Home/End roving. No header, no captions,
// no icons — the labels are the whole UI. The clicked path rides in the menu's
// aria-label so a screen reader still hears which link it belongs to.

export type TerminalLinkMenuProps = {
  workspaceId: string
  target: TerminalLinkTarget
  /** Viewport coordinates of the click that opened the menu. */
  x: number
  y: number
  /** Line/column suffix parsed off the link (`file.ts:12:3`), for editor actions. */
  line?: number
  column?: number
  onClose: () => void
  /** Reports a failed action, anchored to the original click. */
  onError: (message: string) => void
}

// The caret hint, including its mount-tick retry, now lives in
// `utils/editorFocus.ts` — this file had the event name as a second string
// literal, so a grep for the constant did not find this sender at all. One
// definition, one dispatch helper, both senders on it.
function dispatchEditorFocus(workspaceId: string, filePath: string, line?: number, column?: number): void {
  dispatchEditorFocusEvent({ workspaceId, filePath, line, column })
}

function targetLabel(target: TerminalLinkTarget): string {
  return target.kind === 'url' ? target.url : target.resolvedPath
}

export function TerminalLinkMenu({
  workspaceId,
  target,
  x,
  y,
  line,
  column,
  onClose,
  onError,
}: TerminalLinkMenuProps) {
  const actions = terminalLinkActions(target)

  const run = useCallback(
    (action: TerminalLinkAction) => {
      // Close first: every branch below either navigates or awaits IPC, and a menu
      // still on screen while the app moves underneath it reads as a hang.
      onClose()
      void (async () => {
        try {
          switch (action.id) {
            case 'open-url': {
              if (target.kind !== 'url') return
              const result = await window.api.openExternal(target.url)
              if (!result.ok) onError(result.message)
              return
            }
            case 'copy-url': {
              if (target.kind !== 'url') return
              await window.api.clipboardWriteText(target.url)
              return
            }
            case 'copy-path': {
              if (target.kind !== 'file') return
              await window.api.clipboardWriteText(target.resolvedPath)
              return
            }
            case 'open-browser': {
              if (target.kind !== 'file') return
              await window.api.openHtmlFileInBrowser(target.resolvedPath)
              return
            }
            case 'open-backlog': {
              if (target.kind !== 'file') return
              const relativePath = backlogRelativePath(target.resolvedPath, target.workspaceRoot)
              if (!relativePath) return
              // Reveal the panel first, then latch the item, so it selects whether
              // the panel was already open or mounts on this very click.
              revealNavRailComponent(workspaceId, 'backlog', 'Backlog')
              dispatchBacklogReveal({ workspaceId, relativePath })
              return
            }
            case 'reveal-files': {
              if (target.kind !== 'file') return
              revealNavRailComponent(workspaceId, 'explorer', 'Files')
              dispatchFileReveal({ workspaceId, path: target.resolvedPath })
              return
            }
            case 'open-popout': {
              if (target.kind !== 'file') return
              await openExternalFileWindow({
                workspaceId,
                path: target.resolvedPath,
                name: basename(target.resolvedPath),
              })
              return
            }
            case 'open-editor': {
              if (target.kind !== 'file') return
              // Both editor rows bypass `openFileSurface` on purpose: the whole
              // point of the menu is that the destination is chosen per click, not
              // inherited from the sticky openFilesInExternalWindow preference.
              const name = basename(target.resolvedPath)
              const content = isImageFile(target.resolvedPath)
                ? ''
                : await window.api.readfile(target.resolvedPath)
              useWorkspaceStore.getState().openFile(workspaceId, target.resolvedPath, name, content)
              focusOrAddFileTab(workspaceId, target.resolvedPath, name)
              dispatchEditorFocus(workspaceId, target.resolvedPath, line, column)
              return
            }
          }
        } catch (error) {
          onError(error instanceof Error ? error.message : 'Could not open this link.')
        }
      })()
    },
    [column, line, onClose, onError, target, workspaceId],
  )

  return (
    <ContextMenu
      x={x}
      y={y}
      ariaLabel={`Open ${targetLabel(target)}`}
      onClose={onClose}
      surfaceClassName="min-w-[204px]"
    >
      {actions.map((action) => (
        // Fragment, not a wrapper element: the menu's children stay menuitem and
        // separator nodes directly under role="menu".
        <Fragment key={action.id}>
          {action.startsGroup ? <MenuDivider /> : null}
          <MenuItem onClick={() => run(action)}>{action.label}</MenuItem>
        </Fragment>
      ))}
    </ContextMenu>
  )
}
