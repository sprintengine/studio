import assert from 'node:assert/strict'

import { afterEach, test, vi } from 'vitest'

import { remeasureWhenMonoFontLoads } from './fonts'

// A stand-in for `document.fonts`: `load` and `ready` settle when the test says
// so, and `loadingdone` is an ordinary event the test can fire.
function stubFontFaceSet() {
  let settle: () => void = () => undefined
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  const target = new EventTarget()
  const fonts = Object.assign(target, {
    load: vi.fn((_font: string) => settled.then(() => [])),
    ready: settled,
  })
  vi.stubGlobal('document', { fonts })
  return { fonts, settle, loadingDone: () => target.dispatchEvent(new Event('loadingdone')) }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.unstubAllGlobals()
})

test('re-measures once the mono face has loaded, not before', async () => {
  // The pop-out editor mounts before JetBrains Mono arrives; the widths it
  // cached then are the fallback's, so the re-measure has to wait for the face.
  const { fonts, settle } = stubFontFaceSet()
  const remeasure = vi.fn()
  remeasureWhenMonoFontLoads(remeasure)
  await flush()
  assert.equal(remeasure.mock.calls.length, 0)
  assert.match(String(fonts.load.mock.calls[0]?.[0]), /JetBrains Mono/)

  settle()
  await flush()
  assert.equal(remeasure.mock.calls.length, 1)
})

test('re-measures again whenever a later face finishes loading', async () => {
  const { settle, loadingDone } = stubFontFaceSet()
  const remeasure = vi.fn()
  remeasureWhenMonoFontLoads(remeasure)
  settle()
  await flush()
  loadingDone()
  assert.equal(remeasure.mock.calls.length, 2)
})

test('an editor disposed before the font arrives is never re-measured', async () => {
  // The unsubscribe goes to the editor's onDidDispose: a disposed editor's
  // Monaco may be gone, and a late font must not reach into it.
  const { settle, loadingDone } = stubFontFaceSet()
  const remeasure = vi.fn()
  const dispose = remeasureWhenMonoFontLoads(remeasure)
  dispose()
  settle()
  await flush()
  loadingDone()
  assert.equal(remeasure.mock.calls.length, 0)
})

test('is a no-op where there is no FontFaceSet', () => {
  vi.stubGlobal('document', {})
  const remeasure = vi.fn()
  const dispose = remeasureWhenMonoFontLoads(remeasure)
  dispose()
  assert.equal(remeasure.mock.calls.length, 0)
})
