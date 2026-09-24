// Points @monaco-editor/react at the Monaco this build bundles.
//
// Left unconfigured, the wrapper's loader injects a <script> for Monaco's AMD
// build from a public CDN the first time an editor mounts. That made every
// editor surface depend on the network — offline, the file editor, the diff
// viewer and the conflict resolver never got past their loading state — and it
// ran a different Monaco from the one the types in node_modules describe.
// Handing the loader a module instance skips the script injection entirely.
//
// Importing this module loads all of Monaco, so it must only ever be reached
// from a lazy chunk. The editor surfaces import it through ./editor, and the
// bundle-budget ratchet fails the build if Monaco shows up in the boot graph.
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
/* oxlint-disable import/default -- Vite synthesises the default export of a ?worker import */
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
/* oxlint-enable import/default */

// Monaco asks for a worker by the label of the language service that wants
// one; everything without its own service (tokenising, diffing, links) runs on
// the base editor worker. The labels are Monaco's, from its language
// contributions.
function workerFor(label: string): Worker {
  switch (label) {
    case 'json':
      return new JsonWorker()
    case 'css':
    case 'scss':
    case 'less':
      return new CssWorker()
    case 'html':
    case 'handlebars':
    case 'razor':
      return new HtmlWorker()
    case 'typescript':
    case 'javascript':
      return new TsWorker()
    default:
      return new EditorWorker()
  }
}

self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) => workerFor(label),
}

loader.config({ monaco })

export { monaco }
