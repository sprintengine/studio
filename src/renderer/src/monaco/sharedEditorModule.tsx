// What a third-party module gets when it imports '@monaco-editor/react'
// (see LAZY_SHARED_MODULE_LOADERS in ../modules/third-party-loader.ts).
//
// The import map is filled the first time any third-party entry loads, whether
// or not that module ever shows an editor. Handing it ./editor directly would
// load and parse all of Monaco at that moment. So the components here are
// stand-ins that load ./editor, and with it the bundled Monaco, when one first
// renders, and the loader and hook wait for the same load before they touch
// Monaco, which keeps the wrapper's CDN fallback out of reach for modules too.
// `loader` offers `init` only: a module allowed to re-`config` the shared
// loader could point every editor in the app back at a CDN.
import type { DiffEditorProps, EditorProps } from '@monaco-editor/react'
import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactElement } from 'react'

type EditorModule = typeof import('./editor')
type Monaco = typeof import('monaco-editor')

let editorModule: Promise<EditorModule> | null = null
function loadEditorModule(): Promise<EditorModule> {
  editorModule ??= import('./editor')
  return editorModule
}

function deferred<P extends object>(pick: (module: EditorModule) => ComponentType<P>): ComponentType<P> {
  const Lazy = lazy(async () => ({ default: pick(await loadEditorModule()) }))
  return function DeferredEditor(props: P): ReactElement {
    return (
      <Suspense fallback={null}>
        <Lazy {...props} />
      </Suspense>
    )
  }
}

export const Editor = deferred<EditorProps>((module) => module.Editor)
export const DiffEditor = deferred<DiffEditorProps>((module) => module.DiffEditor)
export default Editor

export const loader = {
  init: async (): Promise<Monaco> => (await loadEditorModule()).loader.init(),
}

export function useMonaco(): Monaco | null {
  const [monaco, setMonaco] = useState<Monaco | null>(null)
  useEffect(() => {
    let live = true
    void loader.init().then((instance) => {
      if (live) setMonaco(instance)
    })
    return () => {
      live = false
    }
  }, [])
  return monaco
}
