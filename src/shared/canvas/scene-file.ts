// Reading and writing the `.excalidraw` document that is a board's source of
// truth. The file is the person's, committed alongside their code, so both
// directions are conservative: a parse repairs what it safely can rather than
// refusing a scene someone can still see, and a serialize reproduces the same
// bytes for the same scene so the watcher's content hash means something.

import type { CanvasElement, CanvasResult, CanvasSceneFile } from './types'
import { canvasFail, canvasOk } from './types'
import { isRecord } from '../records'

/** The file format's own `type` marker. A technical identifier, not a product. */
export const CANVAS_SCENE_TYPE = 'excalidraw'

/** Scene schema version. v2 is the format every current reader speaks. */
export const CANVAS_SCENE_VERSION = 2

/** Stamped into every file we write, so a reader knows which app authored it. */
export const CANVAS_SCENE_SOURCE = 'sprintengine-studio'

export const CANVAS_DEFAULT_BACKGROUND = '#ffffff'

/**
 * The appState keys a board keeps. Everything else the editor holds in appState
 * is per-viewer state (scroll, zoom, the current tool, the selection) and does
 * not belong in a file two people share — committing it means every save is a
 * diff and every pull moves someone's viewport.
 */
export type CanvasPersistedAppState = {
  viewBackgroundColor: string
  gridSize: number
  gridStep: number
  gridModeEnabled: boolean
}

const DEFAULT_APP_STATE: CanvasPersistedAppState = {
  viewBackgroundColor: CANVAS_DEFAULT_BACKGROUND,
  gridSize: 20,
  gridStep: 5,
  gridModeEnabled: false,
}

export function emptyScene(): CanvasSceneFile {
  return {
    type: CANVAS_SCENE_TYPE,
    version: CANVAS_SCENE_VERSION,
    source: CANVAS_SCENE_SOURCE,
    elements: [],
    appState: { ...DEFAULT_APP_STATE },
    files: {},
  }
}

/**
 * Parse a board file. Tolerant of a missing or truncated `elements`/`files`
 * array and of an absent `appState`, because a half-written file still holds
 * the person's drawing; strict about the document being an object of this
 * format, because silently treating some other JSON as a scene would overwrite
 * it on the next save.
 */
export function parseSceneFile(text: string): CanvasResult<CanvasSceneFile> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return canvasFail('invalid_scene', `The board file is not valid JSON: ${message}`)
  }
  if (!isRecord(parsed)) {
    return canvasFail('invalid_scene', 'The board file must contain a JSON object.')
  }
  const declaredType = parsed.type
  if (declaredType !== undefined && declaredType !== CANVAS_SCENE_TYPE) {
    return canvasFail('invalid_scene', `The board file declares type ${String(declaredType)}, not a scene.`)
  }
  const elements: CanvasElement[] = []
  if (Array.isArray(parsed.elements)) {
    for (const candidate of parsed.elements) {
      // A non-object in the array is not repairable into an element, and
      // keeping it would break every id lookup downstream.
      if (isRecord(candidate) && typeof candidate.id === 'string') elements.push(candidate as CanvasElement)
    }
  }
  const version = typeof parsed.version === 'number' && Number.isFinite(parsed.version)
    ? parsed.version
    : CANVAS_SCENE_VERSION
  return canvasOk({
    type: CANVAS_SCENE_TYPE,
    version,
    source: typeof parsed.source === 'string' ? parsed.source : CANVAS_SCENE_SOURCE,
    elements,
    appState: isRecord(parsed.appState) ? parsed.appState : {},
    files: isRecord(parsed.files) ? parsed.files : {},
  })
}

/** The persisted subset of an appState, with our defaults for anything absent. */
export function reduceAppState(appState: Record<string, unknown> | undefined | null): CanvasPersistedAppState {
  const source = isRecord(appState) ? appState : {}
  return {
    viewBackgroundColor:
      typeof source.viewBackgroundColor === 'string'
        ? source.viewBackgroundColor
        : DEFAULT_APP_STATE.viewBackgroundColor,
    gridSize:
      typeof source.gridSize === 'number' && Number.isFinite(source.gridSize)
        ? source.gridSize
        : DEFAULT_APP_STATE.gridSize,
    gridStep:
      typeof source.gridStep === 'number' && Number.isFinite(source.gridStep)
        ? source.gridStep
        : DEFAULT_APP_STATE.gridStep,
    gridModeEnabled:
      typeof source.gridModeEnabled === 'boolean'
        ? source.gridModeEnabled
        : DEFAULT_APP_STATE.gridModeEnabled,
  }
}

/**
 * Serialize a board file: two-space JSON with a trailing newline, so a git diff
 * of a drawing reads a line per change rather than one enormous line. Key order
 * is fixed, and the appState is reduced, so the same scene always produces the
 * same bytes — the watcher decides "did someone else write this?" by hashing
 * them.
 */
export function serializeSceneFile(scene: CanvasSceneFile): string {
  const document = {
    type: CANVAS_SCENE_TYPE,
    version: typeof scene.version === 'number' && Number.isFinite(scene.version) ? scene.version : CANVAS_SCENE_VERSION,
    source: CANVAS_SCENE_SOURCE,
    elements: scene.elements ?? [],
    appState: reduceAppState(scene.appState),
    files: scene.files ?? {},
  }
  return `${JSON.stringify(document, null, 2)}\n`
}
