// Getting the scene fonts into the document before the worker says it is ready.
//
// Text is measured with a canvas, and a canvas measures whatever face the
// browser has. The hand-drawn families are woff2 files the editor fetches for
// itself through the FontFace API — and it only does so from a mounted editor
// or from an export, never on import. A worker that started answering before
// they arrived would measure every label in the fallback face, size every box
// around those numbers and write them to the file, and the board would be
// visibly wrong the moment the real face landed.
//
// So one editor instance is mounted, off-screen but laid out, with a scene
// holding one text element per family the agent format can ask for. That makes
// them the scene's fonts, which is the one thing that makes the editor fetch
// them. Then we wait for the document to agree it has them.

import { createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Excalidraw } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import '@excalidraw/excalidraw/index.css'
import type { CanvasWorkerReport } from '../../../shared/canvas/worker-protocol'
import { CANVAS_DEFAULT_BACKGROUND } from '../../../shared/canvas/scene-file'
import { CANVAS_DEFAULT_FONT_SIZE, CANVAS_FONT_FAMILY_ID, CANVAS_FONT_FAMILY_NAME } from './skeletonMap'

/** How long to wait for the faces before answering in a fallback face anyway. */
const FONT_DEADLINE_MS = 15000

/** How often to ask the document whether the faces have landed. */
const FONT_POLL_MS = 50

/**
 * Characters the bootstrap scene names, so the subset covering them is fetched.
 *
 * The families ship split by unicode range and the browser only fetches the
 * ranges a document asks for, so a bootstrap of one word would leave the digits
 * and the punctuation of every later label to the fallback face.
 */
const FONT_WARMUP_TEXT =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 .,:;!?()[]{}<>/\\|-_=+*&%$#@"\'`~^'

/** The shared shape, because this is what the readiness handshake carries. */
export type BootstrapReport = CanvasWorkerReport

/**
 * Mount the hidden editor and wait for its fonts.
 *
 * Never rejects: a worker that cannot load a face is degraded, not broken, and
 * refusing to come up would cost every canvas call a twenty-second deadline
 * instead of a warning in the console.
 */
export async function bootstrapCanvasWorker(host: HTMLElement): Promise<BootstrapReport> {
  const report: BootstrapReport = { loaded: [], missing: [], errors: [] }
  try {
    mountEditor(host)
  } catch (error) {
    report.errors.push(`The hidden editor did not mount: ${message(error)}`)
  }
  await waitForFonts(report)
  return report
}

function mountEditor(host: HTMLElement): void {
  createRoot(host).render(editorElement())
}

function editorElement(): ReactElement {
  return createElement(Excalidraw, {
    initialData: {
      elements: warmupScene(),
      appState: { viewBackgroundColor: CANVAS_DEFAULT_BACKGROUND },
      scrollToContent: false,
    },
    // Nobody looks at this instance; it exists so that the scene's fonts become
    // the document's fonts. View mode keeps it from taking a keystroke or
    // starting a gesture if the window ever does get focus.
    viewModeEnabled: true,
    zenModeEnabled: true,
  })
}

/** One text element per family, off in the far corner, carrying the warm-up text. */
function warmupScene(): ExcalidrawElement[] {
  return Object.values(CANVAS_FONT_FAMILY_ID).map((fontFamily, at) => ({
    id: `canvas-worker-font-${fontFamily}`,
    type: 'text',
    x: -100000,
    y: -100000 + at * 40,
    width: 10,
    height: 25,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    text: FONT_WARMUP_TEXT,
    originalText: FONT_WARMUP_TEXT,
    fontSize: CANVAS_DEFAULT_FONT_SIZE,
    fontFamily,
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    autoResize: true,
    lineHeight: 1.25,
  })) as unknown as ExcalidrawElement[]
}

async function waitForFonts(report: BootstrapReport): Promise<void> {
  const families = Object.values(CANVAS_FONT_FAMILY_ID).map((id) => CANVAS_FONT_FAMILY_NAME[id])
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  if (!fonts) {
    report.missing.push(...families)
    report.errors.push('This document has no font set, so text will be measured in whatever face is available.')
    return
  }

  const deadline = Date.now() + FONT_DEADLINE_MS
  const pending = new Set(families)
  while (pending.size > 0 && Date.now() < deadline) {
    for (const family of [...pending]) {
      if (!isRegistered(fonts, family)) continue
      const spec = fontSpec(family)
      if (fontCheck(fonts, spec)) {
        pending.delete(family)
        continue
      }
      // Asking as well as waiting: the faces are registered by the editor, and
      // once they are, this is what pulls in the subsets the warm-up text needs.
      try {
        await fonts.load(spec, FONT_WARMUP_TEXT)
      } catch {
        // A face that will not load is reported as missing below, once.
      }
    }
    if (pending.size === 0) break
    await delay(FONT_POLL_MS)
  }

  try {
    await fonts.ready
  } catch {
    // `ready` rejecting says nothing the per-family check has not already said.
  }

  for (const family of families) {
    if (isLoaded(fonts, family)) report.loaded.push(family)
    else report.missing.push(family)
  }
  if (report.missing.length > 0) {
    report.errors.push(
      `These scene fonts did not load, so text set in them is measured in a fallback face: ${report.missing.join(', ')}.`,
    )
  }
}

/**
 * Whether the document has a face for this family at all.
 *
 * `FontFaceSet.check` answers "is anything still to be downloaded", so for a
 * family the set has never heard of it answers true — the browser will happily
 * substitute. Asking the set what it holds is the half of the question that
 * `check` does not answer.
 *
 * The names are unquoted first: a `FontFace` built from a family with a space
 * in it reports `family` as the CSS string it was given, quotes and all, so
 * `Comic Shanns` and `"Comic Shanns"` are the same family spelled two ways.
 */
function isRegistered(fonts: FontFaceSet, family: string): boolean {
  const wanted = unquote(family)
  let found = false
  fonts.forEach((face) => {
    if (unquote(face.family) === wanted) found = true
  })
  return found
}

function unquote(family: string): string {
  return family.replace(/^["']|["']$/g, '')
}

function isLoaded(fonts: FontFaceSet, family: string): boolean {
  return isRegistered(fonts, family) && fontCheck(fonts, fontSpec(family))
}

/** The family alone, quoted — not the editor's full stack, whose last entry is
 *  a system emoji face that would make the check pass without the real one. */
function fontSpec(family: string): string {
  return `${CANVAS_DEFAULT_FONT_SIZE}px "${family}"`
}

function fontCheck(fonts: FontFaceSet, spec: string): boolean {
  try {
    return fonts.check(spec, FONT_WARMUP_TEXT)
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
