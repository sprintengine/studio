import assert from 'node:assert/strict'
import type { BrowserWindow } from 'electron'
import { notifyRendererModulesChanged } from './notify-renderer-modules-changed'

const sent: string[] = []
function window(id: string, destroyed = false, fails = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string) => {
        if (fails) throw new Error('window closed during send')
        sent.push(`${id}:${channel}`)
      },
    },
  }
}
notifyRendererModulesChanged([
  window('closing', false, true), window('primary'), window('detached'), window('destroyed', true),
] as unknown as BrowserWindow[])
assert.deepEqual(sent, ['primary:modules:third-party:changed', 'detached:modules:third-party:changed'],
  'installation/trust changes reach every live window despite one closing')
console.log('renderer module change notification tests passed')
