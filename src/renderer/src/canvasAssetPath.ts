// Where the canvas editor looks for its own runtime assets.
//
// `@excalidraw/excalidraw` loads the hand-drawn scene fonts at runtime through
// the FontFace API, resolving each `./fonts/<Family>/<file>.woff2` against
// `window.EXCALIDRAW_ASSET_PATH`, and it ALWAYS appends a public CDN as the
// last candidate. A desktop app is expected to draw offline, so the local base
// has to be right rather than merely usually right — a wrong one degrades to a
// network fetch that fails silently and leaves the board in a fallback face.
//
// The base must be an ABSOLUTE url. A value starting with `./` or `/` is
// re-resolved by the library against `window.location.origin`, and the packaged
// renderer runs from `file://`, where `origin` is the string "null" — the
// resulting `new URL(path, 'null')` throws `Invalid URL` and the editor never
// mounts. `new URL('.', location.href)` is the directory the document was
// loaded from under `file://` and under the dev server alike, which is exactly
// where the build emits `fonts/` (see the scene-fonts plugin in
// electron.vite.config.ts).
//
// Both values are read while the editor's module graph evaluates — the export
// source is captured into a module constant — so this has to be assigned
// before that chunk is imported. Hence a module of its own with no dependency
// of its own: every renderer entry imports it on its first line, which costs
// the eager bundle these two statements and nothing else.

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
    EXCALIDRAW_EXPORT_SOURCE?: string
  }
}

window.EXCALIDRAW_ASSET_PATH = new URL('.', window.location.href).href
// Stamped into the `source` field of every scene and clipboard payload the
// editor writes. Left unset it would be `location.origin`, i.e. "null" in a
// packaged build — this says which app produced the file instead.
window.EXCALIDRAW_EXPORT_SOURCE = 'sprintengine-studio'

export {}
