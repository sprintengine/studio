// The one Monaco the renderer runs: the `monaco-editor` package this app ships,
// evaluated as the renderer boots and handed to `@monaco-editor/react` before any
// editor can mount.
//
// Left alone, `@monaco-editor/react` fetches Monaco from a public CDN the first
// time an editor opens — a pinned version that is not the one in package.json,
// third-party code executed at runtime, and an editor that never appears
// offline. Monaco must not be loaded from a content delivery network at runtime
// (owner ruling 2026-09-27). `loader.config({ monaco })` hands the wrapper this
// bundle's instance instead, and from then on `loader.init()` resolves with it
// and injects no script at all.
//
// It is loaded while the launch plate is up rather than on the first editor
// (owner ruling 2026-09-27): `main.tsx` imports this module ahead of the app and
// waits on `monacoReady` before it renders, so every window that can hold an
// editor — the workspace shell, the diff and file windows, a third-party
// module's editor through the shared import map — finds Monaco already here.
//
// The workers are this build's too. Monaco runs its language services in web
// workers and asks `MonacoEnvironment.getWorker` for one per language label;
// each `?worker` import below is bundled by Vite into a file beside the
// renderer's own assets. Every language the editors can open keeps the service
// it had before: TypeScript and JavaScript (the diagnostics patchLanguage.ts
// tunes), JSON, CSS and its dialects, and HTML and its templating dialects.
// Everything else — every Monarch tokenizer, the unified-diff language
// patchLanguage.ts registers — runs on the main thread and needs only the base
// editor worker.

import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/languages/features/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker?worker'
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker'
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker'

type WorkerConstructor = new (options?: { name?: string }) => Worker

// Keyed by the label Monaco passes: the language id a language service was
// registered under. A label missing here is served by the base editor worker,
// which is what Monaco itself asks for everything that has no service.
const LANGUAGE_WORKERS: Record<string, WorkerConstructor> = {
  json: JsonWorker,
  css: CssWorker,
  scss: CssWorker,
  less: CssWorker,
  html: HtmlWorker,
  handlebars: HtmlWorker,
  razor: HtmlWorker,
  typescript: TsWorker,
  javascript: TsWorker,
}

export function monacoWorkerFor(label: string): WorkerConstructor {
  return Object.hasOwn(LANGUAGE_WORKERS, label) ? LANGUAGE_WORKERS[label]! : EditorWorker
}

globalThis.MonacoEnvironment = {
  getWorker(_workerId, label) {
    const Worker = monacoWorkerFor(label)
    return new Worker({ name: label })
  },
}

loader.config({ monaco })

// Settles with the configured instance on the next microtask. `main.tsx` holds
// the first render on it, so "Monaco is ready" is a fact the app starts from
// rather than something each editor discovers.
export const monacoReady: Promise<typeof monaco> = loader.init()
