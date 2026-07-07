import assert from 'node:assert/strict'

import {
  MULTICODE_FILE_DROP_MIME as APP_MIME,
  hasFileDropData as appHas,
  readFileDropPayload as appRead,
  setFileDropData as appSet,
  type FileDropPayload as AppPayload,
} from '../../../src/renderer/src/utils/terminalDrop'
import {
  MULTICODE_FILE_DROP_MIME as SDK_MIME,
  hasFileDropData as sdkHas,
  readFileDropPayload as sdkRead,
  setFileDropData as sdkSet,
} from '../src/index'

// Behavior parity between the app's published file-drop parse/serialize and
// the SDK's self-contained mirror: identical inputs must produce identical
// outputs, so a terminalDrop.ts semantics change fails this gate instead of
// silently breaking installed modules.

type StoredData = Map<string, string>

function fakeDataTransfer(entries: Record<string, string> = {}): DataTransfer & { stored: StoredData } {
  const stored: StoredData = new Map(Object.entries(entries))
  return {
    stored,
    effectAllowed: 'none',
    getData: (type: string) => stored.get(type) ?? '',
    setData: (type: string, value: string) => {
      stored.set(type, value)
    },
    // Live, like a real DataTransfer: entries written via setData must appear.
    get types() {
      return [...stored.keys()]
    },
    files: [] as unknown as FileList,
  } as unknown as DataTransfer & { stored: StoredData }
}

const VALID: AppPayload = {
  version: 1,
  workspaceId: 'ws-1',
  rootPath: '/projects/demo',
  files: [{ path: '/projects/demo/backlog/item.md', name: 'item.md' }],
}

function payloadCases(): Array<[string, Record<string, string>]> {
  return [
    ['valid payload', { [APP_MIME]: JSON.stringify(VALID) }],
    ['null workspaceId', { [APP_MIME]: JSON.stringify({ ...VALID, workspaceId: null }) }],
    ['wrong version', { [APP_MIME]: JSON.stringify({ ...VALID, version: 2 }) }],
    ['garbage JSON', { [APP_MIME]: '{not json' }],
    ['missing entry', {}],
    ['empty files', { [APP_MIME]: JSON.stringify({ ...VALID, files: [] }) }],
    ['invalid file entries', { [APP_MIME]: JSON.stringify({ ...VALID, files: [{ path: '  ', name: 'x' }, null] }) }],
    ['non-boolean isDir', { [APP_MIME]: JSON.stringify({ ...VALID, files: [{ path: '/p/x.ts', name: 'x.ts', isDir: 'false' }] }) }],
    ['extra file props dropped', { [APP_MIME]: JSON.stringify({ ...VALID, files: [{ path: '/p/x.ts', name: 'x.ts', isDir: true, extra: 'no' }] }) }],
    ['non-string rootPath', { [APP_MIME]: JSON.stringify({ ...VALID, rootPath: 7 }) }],
  ]
}

function main(): void {
  assert.equal(SDK_MIME, APP_MIME, 'the MIME constant is one contract')

  for (const [label, entries] of payloadCases()) {
    const fromApp = appRead(fakeDataTransfer(entries))
    const fromSdk = sdkRead(fakeDataTransfer(entries))
    assert.deepEqual(fromSdk, fromApp, `parse parity for: ${label}`)
    assert.equal(
      sdkHas(fakeDataTransfer(entries)),
      appHas(fakeDataTransfer(entries)),
      `hasFileDropData parity for: ${label}`
    )
  }

  // Rebuilt entries: a non-boolean isDir is skipped, extra props are dropped.
  const rebuilt = appRead(fakeDataTransfer({
    [APP_MIME]: JSON.stringify({ ...VALID, files: [{ path: '/p/x.ts', name: 'x.ts', isDir: true, extra: 'no' }] }),
  }))
  assert.deepEqual(
    rebuilt?.files,
    [{ path: '/p/x.ts', name: 'x.ts', isDir: true }],
    'file entries are rebuilt without unknown properties'
  )

  // Serialize parity: both writers put identical entries on the transfer, and
  // each side's writer round-trips through the other side's reader.
  const viaApp = fakeDataTransfer()
  const viaSdk = fakeDataTransfer()
  appSet(viaApp, VALID)
  sdkSet(viaSdk, VALID)
  assert.deepEqual([...viaSdk.stored.entries()], [...viaApp.stored.entries()], 'serialize parity')
  assert.equal(viaSdk.effectAllowed, viaApp.effectAllowed, 'effectAllowed parity')
  assert.deepEqual(sdkRead(viaApp), VALID, 'an app-originated drag parses through the SDK reader')
  assert.deepEqual(appRead(viaSdk), VALID, 'an SDK-originated drag parses through the app reader')

  console.log('dnd contract parity tests passed')
}

main()
