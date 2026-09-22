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

/** Register unified-diff highlighting once for every Monaco runtime. */
export function configureMonacoLanguages(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === PATCH_LANGUAGE_ID)) return

  monaco.languages.register({
    id: PATCH_LANGUAGE_ID,
    aliases: ['Patch', 'Diff'],
    extensions: ['.patch', '.diff'],
  })
  monaco.languages.setMonarchTokensProvider(PATCH_LANGUAGE_ID, PATCH_LANGUAGE)
}
