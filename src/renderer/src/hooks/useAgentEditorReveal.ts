import { useEffect, useRef } from 'react'

import type {
  EditorRevealFileTarget,
  EditorRevealRequest,
  EditorRevealShown,
  EditorWindowState,
} from '../../../shared/editor-reveal'
import { useWorkspaceStore } from '../store/workspaceStore'
import {
  activeEditorView,
  getAgentRevealNotice,
  isOwnerTyping,
  setAgentRevealNotice,
  setPendingRevealWorkspaces,
  trackWindowKeystrokes,
} from '../utils/agentEditorReveal'
import { hasEditorBuffer } from '../utils/editorBuffers'
import { openFileSurface } from '../utils/openFileSurface'
import { openGitDiff } from '../utils/openGitDiff'
import { isWindowVisible } from '../utils/windowActivity'

// The window's half of an agent's editor reveal (editor.open / open_diff).
//
// Main asks every workspace window; only the one whose ACTIVE workspace it is
// acts, the same rule the browser and Canvas reveals follow, so a window that
// merely retains the workspace off screen never grows a tab nobody sees. The
// answer says what the person could see:
//
//   foreground  — opened on top, in the surface they prefer (the editor tab,
//                 or the pop-out editor / diff window when that is their
//                 choice), never taking the keyboard or raising a window;
//   background  — they were typing in the editor, so it opened behind their
//                 tab rather than swapping the file under their cursor;
//   not_visible — this window is minimized or hidden: it is open for when they
//                 come back.
//
// A workspace no window shows is main's to remember. The first window that
// shows it claims the reveal and opens it then (latest wins), and the sidebar
// row pulses until someone does.

export type RevealMode = 'foreground' | 'background'

/** How a window that shows the workspace answers, from what it can observe. */
export function revealShownFor(input: { windowVisible: boolean; ownerTyping: boolean }): {
  mode: RevealMode
  shown: EditorRevealShown
} {
  const mode: RevealMode = input.ownerTyping ? 'background' : 'foreground'
  return { mode, shown: input.windowVisible ? mode : 'not_visible' }
}

async function openRevealedFile(
  workspaceId: string,
  file: EditorRevealFileTarget,
  options: { background: boolean },
): Promise<void> {
  const isOpen = (): boolean => {
    const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)
    return Boolean(
      workspace?.editorState?.openFiles.some((open) => open.path === file.path) ||
      hasEditorBuffer(workspaceId, file.path),
    )
  }
  const store = useWorkspaceStore.getState()
  // Seed the buffer only for a file that is not open: `openFile` on an open
  // one resets it, and that would drop the person's unsaved edits. A file
  // outside the workspace folder has to be seeded — the editor restores only
  // files under it on its own.
  let content: string | undefined
  if (!isOpen() && !store.openFilesInExternalWindow) {
    try {
      content = await window.api.readfile(file.path)
    } catch {
      content = undefined
    }
    // Asked again after the read: the person may have opened it and started
    // typing while it was in flight.
    if (isOpen()) content = undefined
  }
  // `openFile` makes the file the store's active one. Behind the person's tab
  // it must not be: the explorer follows the active file, and so does what
  // editor.state reports they are looking at.
  const previousActive =
    useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)?.editorState
      ?.activeFilePath ?? null
  openFileSurface({
    workspaceId,
    path: file.path,
    name: file.name,
    ...(content !== undefined ? { content } : {}),
    ...(file.range ? { range: file.range } : {}),
    takeFocus: false,
    background: options.background,
  })
  if (options.background && previousActive && previousActive !== file.path) {
    useWorkspaceStore.getState().setActiveFile(workspaceId, previousActive)
  }
}

/** Open everything a reveal carries. Pure routing: the checks were main's. */
export async function performEditorReveal(request: EditorRevealRequest, mode: RevealMode): Promise<void> {
  const { workspaceId } = request
  // Latest wins for the note: the strip says what the newest reveal is about,
  // and one with no note clears the last one's. An Open / Dismiss question the
  // person has not answered yet stays until they do, or until a newer reveal
  // asks its own.
  const previous = getAgentRevealNotice(workspaceId)
  setAgentRevealNotice(workspaceId, {
    requestId: request.requestId,
    agentName: request.agentName,
    note: request.note,
    awaiting: request.awaiting.length > 0 ? request.awaiting : (previous?.awaiting ?? []),
  })

  // The first file ends up in front: the rest open behind it first, then it.
  const [first, ...rest] = request.files
  for (const file of rest) await openRevealedFile(workspaceId, file, { background: true })
  if (first) await openRevealedFile(workspaceId, first, { background: mode === 'background' })

  const diff = request.diff
  if (diff && diff.focusPath) {
    openGitDiff({
      workspaceId,
      repoRoot: diff.repoRoot,
      focusPath: diff.focusPath,
      scope: diff.focusKind ?? diff.scope ?? 'unstaged',
      ...(diff.changelistId ? { changelistId: diff.changelistId } : {}),
      reveal: {
        key: request.requestId,
        ...(diff.paths ? { paths: diff.paths } : {}),
        ...(diff.step ? { step: diff.step } : {}),
        ...(diff.focusRange ? { range: diff.focusRange } : {}),
        side: diff.focusSide,
      },
      takeFocus: false,
      background: mode === 'background',
    })
  }
}

/** The person said Open to files outside the workspace. */
export async function openAwaitingFiles(workspaceId: string): Promise<void> {
  const notice = getAgentRevealNotice(workspaceId)
  if (!notice) return
  setAgentRevealNotice(workspaceId, { ...notice, awaiting: [] })
  const [first, ...rest] = notice.awaiting
  for (const file of rest) await openRevealedFile(workspaceId, file, { background: true })
  if (first) await openRevealedFile(workspaceId, first, { background: false })
}

function windowStateFor(workspaceId: string): EditorWindowState {
  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((candidate) => candidate.id === workspaceId)
  const editorState = workspace?.editorState
  return {
    fileSurface: store.openFilesInExternalWindow ? 'popout' : 'app',
    windowVisible: isWindowVisible(),
    active: activeEditorView(workspaceId, editorState?.activeFilePath ?? null),
    openFiles: (editorState?.openFiles ?? []).map((file) => file.path),
    awaitingOwner: getAgentRevealNotice(workspaceId)?.awaiting.length ?? 0,
  }
}

/** Mounted once per workspace window, with the workspace it shows. */
export function useAgentEditorReveal(activeWorkspaceId: string | null): void {
  const activeRef = useRef(activeWorkspaceId)
  activeRef.current = activeWorkspaceId

  useEffect(() => {
    if (typeof window.api?.onEditorRevealRequest !== 'function') return
    const stopRequests = window.api.onEditorRevealRequest((request) => {
      if (request.workspaceId !== activeRef.current) {
        window.api.ackEditorReveal({ requestId: request.requestId, outcome: 'declined' })
        return
      }
      const { mode, shown } = revealShownFor({
        windowVisible: isWindowVisible(),
        ownerTyping: isOwnerTyping(request.workspaceId),
      })
      // Answer first: what the person can see is decided now, and the opens
      // that follow read files, which the tool should not wait on.
      window.api.ackEditorReveal({ requestId: request.requestId, outcome: 'opened', shown })
      void performEditorReveal(request, mode)
    })
    const stopState = window.api.onEditorStateQuery((query) => {
      if (query.workspaceId !== activeRef.current) {
        window.api.replyEditorState({ requestId: query.requestId, outcome: 'declined' })
        return
      }
      window.api.replyEditorState({
        requestId: query.requestId,
        outcome: 'answered',
        state: windowStateFor(query.workspaceId),
      })
    })
    const stopPending = window.api.onEditorRevealPending(({ workspaceIds }) => {
      setPendingRevealWorkspaces(workspaceIds)
      // A reveal queued in the instant this window switched to its workspace.
      const active = activeRef.current
      if (active && workspaceIds.includes(active)) void claim(active)
    })
    const stopKeys = trackWindowKeystrokes(window)
    void window.api
      .editorRevealListPending()
      .then(setPendingRevealWorkspaces)
      .catch(() => undefined)
    return () => {
      stopRequests()
      stopState()
      stopPending()
      stopKeys()
    }
  }, [])

  // The person came to a workspace something was waiting for.
  useEffect(() => {
    if (activeWorkspaceId) void claim(activeWorkspaceId)
  }, [activeWorkspaceId])
}

async function claim(workspaceId: string): Promise<void> {
  if (typeof window.api?.editorRevealClaim !== 'function') return
  const request = await window.api.editorRevealClaim(workspaceId).catch(() => null)
  if (!request) return
  const mode: RevealMode = isOwnerTyping(workspaceId) ? 'background' : 'foreground'
  await performEditorReveal(request, mode)
}
