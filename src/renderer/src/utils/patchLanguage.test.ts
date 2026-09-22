import assert from 'node:assert/strict'
import { test } from 'vitest'
import type * as Monaco from 'monaco-editor'
import { configureMonacoLanguages, PATCH_LANGUAGE_ID } from './patchLanguage'

test('configureMonacoLanguages registers patch and diff files with a tokenizer', () => {
  const registrations: Monaco.languages.ILanguageExtensionPoint[] = []
  const tokenizers: Array<{ languageId: string; language: Monaco.languages.IMonarchLanguage }> = []
  const monaco = {
    languages: {
      getLanguages: () => registrations,
      register: (language: Monaco.languages.ILanguageExtensionPoint) => registrations.push(language),
      setMonarchTokensProvider: (languageId: string, language: Monaco.languages.IMonarchLanguage) => {
        tokenizers.push({ languageId, language })
        return { dispose: () => {} }
      },
    },
  } as unknown as typeof Monaco

  configureMonacoLanguages(monaco)
  configureMonacoLanguages(monaco)

  assert.equal(registrations.length, 1, 'the language is registered once')
  assert.equal(registrations[0]?.id, PATCH_LANGUAGE_ID)
  assert.deepEqual(registrations[0]?.extensions, ['.patch', '.diff'])
  assert.equal(tokenizers.length, 1, 'the tokenizer is installed once')
  assert.equal(tokenizers[0]?.languageId, PATCH_LANGUAGE_ID)

  const rules = tokenizers[0]?.language.tokenizer.root as Array<[RegExp, string]>
  const tokenFor = (line: string): string | undefined => {
    for (const [pattern, token] of rules) {
      pattern.lastIndex = 0
      if (pattern.test(line)) return token
    }
    return undefined
  }

  assert.equal(tokenFor('diff --git a/app.ts b/app.ts'), 'keyword')
  assert.equal(tokenFor('@@ -1,2 +1,3 @@ function run()'), 'type')
  assert.equal(tokenFor('+++ b/app.ts'), 'keyword', 'file headers take precedence over added lines')
  assert.equal(tokenFor('+const added = true'), 'comment')
  assert.equal(tokenFor('-const removed = true'), 'invalid')
  assert.equal(tokenFor(' unchanged context'), undefined)
})
