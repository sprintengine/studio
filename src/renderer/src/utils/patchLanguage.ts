import type * as Monaco from 'monaco-editor'

export const PATCH_LANGUAGE_ID = 'patch'

const PATCH_LANGUAGE: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenizer: {
    root: [
      [/^diff --git .*$/, 'keyword'],
      [
        /^(?:index|new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index)\b.*$/,
        'keyword',
      ],
      [/^(?:rename|copy) (?:from|to) .*$/, 'keyword'],
      [/^(?:Binary files .* differ|GIT binary patch)$/, 'keyword'],
      [/^@@ .* @@.*$/, 'type'],
      [/^(?:---|\+\+\+) .*$/, 'keyword'],
      [/^\+.*/, 'comment'],
      [/^-.*/, 'invalid'],
      [/^\\ No newline at end of file$/, 'annotation'],
    ],
  },
}

type DiagnosticsDefaults = {
  setDiagnosticsOptions: (options: { noSemanticValidation?: boolean; noSyntaxValidation?: boolean }) => void
}

/**
 * The editors open one file at a time, with no tsconfig, no node_modules and
 * none of the project's path mapping, so TypeScript's SEMANTIC checks can only
 * be wrong: every import reads as unresolvable, and a real file opens looking
 * full of errors it does not have. Syntax errors are still reported — those
 * the file alone can answer.
 *
 * Monaco moved the TypeScript defaults from `languages.typescript` to a
 * top-level `typescript` namespace; both are tried, and a runtime with neither
 * is left alone.
 */
export function quietTypeScriptSemanticDiagnostics(monaco: typeof Monaco): void {
  const runtime = monaco as unknown as {
    typescript?: { typescriptDefaults?: DiagnosticsDefaults; javascriptDefaults?: DiagnosticsDefaults }
    languages?: {
      typescript?: { typescriptDefaults?: DiagnosticsDefaults; javascriptDefaults?: DiagnosticsDefaults }
    }
  }
  const namespace = runtime.typescript?.typescriptDefaults ? runtime.typescript : runtime.languages?.typescript
  for (const defaults of [namespace?.typescriptDefaults, namespace?.javascriptDefaults]) {
    if (typeof defaults?.setDiagnosticsOptions !== 'function') continue
    defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
  }
}

/** Register unified-diff highlighting once for every Monaco runtime. */
export function configureMonacoLanguages(monaco: typeof Monaco): void {
  quietTypeScriptSemanticDiagnostics(monaco)
  if (monaco.languages.getLanguages().some((language) => language.id === PATCH_LANGUAGE_ID)) return

  monaco.languages.register({
    id: PATCH_LANGUAGE_ID,
    aliases: ['Patch', 'Diff'],
    extensions: ['.patch', '.diff'],
  })
  monaco.languages.setMonarchTokensProvider(PATCH_LANGUAGE_ID, PATCH_LANGUAGE)
}
