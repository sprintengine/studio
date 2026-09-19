import assert from 'node:assert/strict'

import type { CanvasElement } from './types'
import { mergeElements } from './merge'
import {
  CANVAS_SCENE_SOURCE,
  CANVAS_SCENE_TYPE,
  emptyScene,
  parseSceneFile,
  reduceAppState,
  serializeSceneFile,
} from './scene-file'
import { test } from 'vitest'

test('scene-file', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  function parsed(text: string) {
    const result = parseSceneFile(text)
    assert.equal(result.ok, true, result.ok ? '' : result.error.message)
    if (!result.ok) throw new Error('unreachable')
    return result.value
  }

  run('emptyScene is a valid document of this format', () => {
    const scene = emptyScene()
    assert.equal(scene.type, CANVAS_SCENE_TYPE)
    assert.equal(scene.version, 2)
    assert.equal(scene.source, CANVAS_SCENE_SOURCE)
    assert.deepEqual(scene.elements, [])
    assert.deepEqual(scene.files, {})
  })

  run('serializeSceneFile writes two-space JSON with a trailing newline', () => {
    const text = serializeSceneFile(emptyScene())
    assert.ok(text.endsWith('\n'))
    assert.match(text, /^\{\n {2}"type": "excalidraw",\n {2}"version": 2,\n/)
  })

  run('serializeSceneFile is byte-stable for the same scene', () => {
    const scene = emptyScene()
    assert.equal(serializeSceneFile(scene), serializeSceneFile(emptyScene()))
  })

  run('serializeSceneFile keeps only the four shared appState keys', () => {
    const scene = emptyScene()
    scene.appState = {
      viewBackgroundColor: '#fafafa',
      gridSize: 40,
      gridStep: 2,
      gridModeEnabled: true,
      scrollX: 1200,
      zoom: { value: 3 },
      currentItemStrokeColor: '#ff0000',
    }
    const written = parsed(serializeSceneFile(scene))
    assert.deepEqual(written.appState, {
      viewBackgroundColor: '#fafafa',
      gridSize: 40,
      gridStep: 2,
      gridModeEnabled: true,
    })
  })

  run('reduceAppState fills the defaults for anything absent or mistyped', () => {
    assert.deepEqual(reduceAppState({ gridSize: 'wide' }), {
      viewBackgroundColor: '#ffffff',
      gridSize: 20,
      gridStep: 5,
      gridModeEnabled: false,
    })
    assert.deepEqual(reduceAppState(null).viewBackgroundColor, '#ffffff')
  })

  run('parseSceneFile repairs a missing elements/files/appState', () => {
    const scene = parsed('{"type":"excalidraw","version":2}')
    assert.deepEqual(scene.elements, [])
    assert.deepEqual(scene.files, {})
    assert.deepEqual(scene.appState, {})
  })

  run('parseSceneFile drops entries that cannot be elements', () => {
    const scene = parsed('{"elements":[null, 7, {"noId":true}, {"id":"a","type":"rectangle"}]}')
    assert.equal(scene.elements.length, 1)
    assert.equal(scene.elements[0].id, 'a')
  })

  run('parseSceneFile refuses what is not a scene', () => {
    for (const text of ['', 'not json', '[]', '"a string"', '{"type":"other"}']) {
      const result = parseSceneFile(text)
      assert.equal(result.ok, false, text)
      if (!result.ok) assert.equal(result.error.code, 'invalid_scene')
    }
  })

  run('an unknown element field survives parse, merge and serialize untouched', () => {
    const text = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'some-other-editor',
      elements: [
        {
          id: 'r1',
          type: 'rectangle',
          version: 4,
          versionNonce: 11,
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          // A field this build has never heard of: a later editor release, or a
          // sibling tool's annotation. Losing it silently corrupts the drawing.
          customData: { owner: 'planning', nested: [1, 2, { deep: true }] },
          futureField: 'keep me',
        },
      ],
      files: { 'file-1': { mimeType: 'image/png', dataURL: 'data:,' } },
    })

    const scene = parsed(text)
    const incoming: CanvasElement[] = [{ id: 'r2', type: 'ellipse', version: 1, versionNonce: 2 }]
    scene.elements = mergeElements(scene.elements, incoming)

    const roundTripped = parsed(serializeSceneFile(scene))
    const rectangle = roundTripped.elements.find((element) => element.id === 'r1')
    assert.ok(rectangle)
    assert.deepEqual(rectangle?.customData, { owner: 'planning', nested: [1, 2, { deep: true }] })
    assert.equal(rectangle?.futureField, 'keep me')
    assert.deepEqual(roundTripped.files, { 'file-1': { mimeType: 'image/png', dataURL: 'data:,' } })
    // Our own stamp replaces whoever wrote the file, since we wrote this copy.
    assert.equal(roundTripped.source, CANVAS_SCENE_SOURCE)
  })

  console.log('canvas scene-file tests passed')
})
