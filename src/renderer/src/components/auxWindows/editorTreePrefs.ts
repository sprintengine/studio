// The editor window's file tree remembers two things about itself: whether it
// is showing, and how wide it is. They belong to that window, so they live in
// its own localStorage key — exactly as the window's placement does
// (auxWindowPlacement.ts) — and never in the shared settings envelope. An aux
// window writing the envelope would push the snapshot it opened with over
// every setting the workspace window has changed since (auxSettingsWrite.ts),
// and a column width is not worth that hazard.

export const EDITOR_TREE_DEFAULT_WIDTH = 260
export const EDITOR_TREE_MIN_WIDTH = 180
export const EDITOR_TREE_MAX_WIDTH = 480

export const EDITOR_TREE_PREFS_KEY = 'sprintengine.auxWindow.file.tree'

export type EditorTreePrefs = {
  visible: boolean
  width: number
}

export const DEFAULT_EDITOR_TREE_PREFS: EditorTreePrefs = {
  // Shown by default: the tree is how the window says where the file is.
  visible: true,
  width: EDITOR_TREE_DEFAULT_WIDTH,
}

export function clampEditorTreeWidth(width: number): number {
  if (!Number.isFinite(width)) return EDITOR_TREE_DEFAULT_WIDTH
  return Math.round(Math.min(EDITOR_TREE_MAX_WIDTH, Math.max(EDITOR_TREE_MIN_WIDTH, width)))
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    // A document with storage blocked throws on the accessor itself.
    return null
  }
}

export function readEditorTreePrefs(storage: StorageLike | null = defaultStorage()): EditorTreePrefs {
  try {
    const raw = storage?.getItem(EDITOR_TREE_PREFS_KEY)
    if (!raw) return DEFAULT_EDITOR_TREE_PREFS
    const parsed = JSON.parse(raw) as Partial<EditorTreePrefs> | null
    return {
      visible: typeof parsed?.visible === 'boolean' ? parsed.visible : DEFAULT_EDITOR_TREE_PREFS.visible,
      width: typeof parsed?.width === 'number' ? clampEditorTreeWidth(parsed.width) : EDITOR_TREE_DEFAULT_WIDTH,
    }
  } catch {
    return DEFAULT_EDITOR_TREE_PREFS
  }
}

export function writeEditorTreePrefs(prefs: EditorTreePrefs, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(
      EDITOR_TREE_PREFS_KEY,
      JSON.stringify({ visible: prefs.visible, width: clampEditorTreeWidth(prefs.width) }),
    )
  } catch {
    // Best-effort: a quota or serialization failure means the next window
    // opens with the defaults.
  }
}
