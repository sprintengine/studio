// The app's entry point for Monaco editor components. It is @monaco-editor/react
// with the loader already pointed at the bundled Monaco (./localMonaco), so no
// editor can mount before that configuration has run. Import editors from here,
// never from '@monaco-editor/react' directly: a direct import that mounts first
// would send the loader to its CDN default.
import './localMonaco'

export * from '@monaco-editor/react'
export { default } from '@monaco-editor/react'
