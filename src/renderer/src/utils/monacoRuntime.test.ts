import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test, vi } from 'vitest'

// Monaco itself needs a DOM, so the package is stood in for by a marker object:
// what is under test is which instance the wrapper is handed, not the editor.
const bundledMonaco = vi.hoisted(() => ({ editor: {}, languages: {}, bundled: true }))
vi.mock('monaco-editor', () => bundledMonaco)

// One recognisable class per worker file, so a test can say which file a label
// was served from.
const workers = vi.hoisted(() => {
  const make = (file: string) =>
    class {
      static readonly file = file
      readonly file = file
      constructor(readonly options?: { name?: string }) {}
    }
  return {
    editor: make('editor.worker'),
    css: make('css.worker'),
    html: make('html.worker'),
    json: make('json.worker'),
    ts: make('ts.worker'),
  }
})
vi.mock('monaco-editor/editor/editor.worker?worker', () => ({ default: workers.editor }))
vi.mock('monaco-editor/languages/features/css/css.worker?worker', () => ({ default: workers.css }))
vi.mock('monaco-editor/languages/features/html/html.worker?worker', () => ({ default: workers.html }))
vi.mock('monaco-editor/languages/features/json/json.worker?worker', () => ({ default: workers.json }))
vi.mock('monaco-editor/languages/features/typescript/ts.worker?worker', () => ({ default: workers.ts }))

// Unconfigured, the wrapper's loader builds a <script> for its CDN copy of
// Monaco. This document records every element anything asks it for, so "no
// script was ever created" is an observation rather than an assumption.
const createdElements: string[] = []
Object.assign(globalThis, {
  document: {
    createElement: (tag: string) => {
      createdElements.push(tag)
      return {}
    },
    body: { appendChild: (node: unknown) => node },
  },
})

const RENDERER_SRC = join(import.meta.dirname, '..')

test('the wrapper is handed the bundled Monaco and never builds a loader script', async () => {
  const { monacoReady } = await import('./monacoRuntime')
  const { loader } = await import('@monaco-editor/react')
  // The package's module namespace, which is what `import * as monaco` binds.
  const bundled = await import('monaco-editor')

  // Compared with `ok(===)` rather than `equal`: a failure message would try to
  // print a mocked namespace, which the mock cannot answer for.
  assert.ok((await monacoReady) === bundled, 'boot waits on the bundled instance')
  assert.ok((await loader.init()) === bundled, 'every editor mount resolves to the same instance')
  assert.ok(loader.__getMonacoInstance() === bundled)
  assert.equal((bundled as unknown as { bundled?: boolean }).bundled, true)
  assert.deepEqual(createdElements, [], 'no <script> was created, so nothing was fetched')
})

test('each language service runs in its own bundled worker, and everything else in the editor worker', async () => {
  const { monacoWorkerFor } = await import('./monacoRuntime')

  const expected: Record<string, string> = {
    typescript: 'ts.worker',
    javascript: 'ts.worker',
    json: 'json.worker',
    css: 'css.worker',
    scss: 'css.worker',
    less: 'css.worker',
    html: 'html.worker',
    handlebars: 'html.worker',
    razor: 'html.worker',
    // Monaco's own label for the base worker, a Monarch-only language, and the
    // unified-diff language patchLanguage.ts registers.
    editorWorkerService: 'editor.worker',
    python: 'editor.worker',
    patch: 'editor.worker',
    // Not a language: a label that happens to name an Object.prototype member
    // still gets the editor worker rather than whatever the prototype holds.
    constructor: 'editor.worker',
  }
  for (const [label, file] of Object.entries(expected)) {
    assert.equal((monacoWorkerFor(label) as unknown as { file: string }).file, file, `label ${label}`)
  }

  const environment = globalThis.MonacoEnvironment
  assert.ok(environment?.getWorker, 'MonacoEnvironment.getWorker is installed')
  const worker = (await environment.getWorker('workerMain.js', 'json')) as unknown as {
    file: string
    options?: { name?: string }
  }
  assert.equal(worker.file, 'json.worker')
  assert.equal(worker.options?.name, 'json', 'the worker is named for its label, so DevTools can tell them apart')
})

test('every window configures Monaco before it renders, and nowhere else configures it', () => {
  // Every renderer window — the workspace shell, the diff and file windows, the
  // diagnostics window — is `index.html` running `main.tsx`, so importing the
  // runtime there is what reaches all of them.
  const entry = readFileSync(join(RENDERER_SRC, 'main.tsx'), 'utf8')
  assert.match(entry, /^import \{ monacoReady \} from '\.\/utils\/monacoRuntime'$/m)
  assert.match(entry, /Promise\.all\(\[[^\]]*\bmonacoReady\b[^\]]*\]\)/, 'the workspace window waits on it')

  const configures: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        if (/\bloader\.config\(/.test(readFileSync(path, 'utf8'))) configures.push(relative(RENDERER_SRC, path))
      }
    }
  }
  walk(RENDERER_SRC)
  assert.deepEqual(configures, [join('utils', 'monacoRuntime.ts')], 'one place decides which Monaco runs')
})
