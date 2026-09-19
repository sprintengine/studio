import assert from 'node:assert/strict'

import { cropRect, descendantPids, fileStamp, parseListeningSockets } from './browser-manager'
import { applyGuestWebPreferences } from './guest-policy'
import { BROWSER_PARTITION } from '../../shared/browser'
import { parsePsTree } from '../terminal-subtree-probe'
import { test } from 'vitest'

test('browser-manager', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  // `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output for a vite server, a Next server
  // bound to a LAN address, and a database that is not a web server.
  const LSOF = [
    'p4242',
    'cnode',
    'n*:5173',
    'n[::1]:5173',
    'p4300',
    'cnext-server',
    'n192.168.1.20:3000',
    'p900',
    'cpostgres',
    'n127.0.0.1:5432',
    '',
  ].join('\n')

  run('listening sockets: loopback and wildcard binds, one row per socket, LAN binds skipped', () => {
    assert.deepEqual(parseListeningSockets(LSOF), [
      { pid: 4242, command: 'node', port: 5173 },
      { pid: 4242, command: 'node', port: 5173 },
      { pid: 900, command: 'postgres', port: 5432 },
    ])
    assert.deepEqual(parseListeningSockets(''), [])
  })

  // ps -axo pid=,ppid=,pcpu=,args=
  const PS = [
    '  100     1  0.0 /bin/zsh -l',
    '  200   100  0.0 npm run dev',
    '  4242  200 12.0 node vite',
    '  4300     1  0.0 node next',
    '  900     1  0.0 postgres',
  ].join('\n')

  run('descendant pids walk the pty shell subtree only', () => {
    const procs = parsePsTree(PS)
    assert.deepEqual(
      [...descendantPids(100, procs)].sort((a, b) => a - b),
      [200, 4242],
    )
    assert.deepEqual([...descendantPids(4300, procs)], [])
    assert.deepEqual([...descendantPids(999, procs)], [])
  })

  console.log('browser-manager tests passed')

  // The will-attach-webview policy: the epic's one security boundary.
  const PICKER = '/app/out/preload/browser-guest.js'

  run('guest policy: a foreign partition or a non-http src is refused outright', () => {
    assert.equal(
      applyGuestWebPreferences({}, { partition: 'persist:other', src: 'http://localhost:5173/' }, PICKER),
      false,
    )
    assert.equal(
      applyGuestWebPreferences({}, { partition: BROWSER_PARTITION, src: 'file:///etc/passwd' }, PICKER),
      false,
    )
    assert.equal(
      applyGuestWebPreferences({}, { partition: BROWSER_PARTITION, src: 'javascript:alert(1)' }, PICKER),
      false,
    )
    assert.equal(applyGuestWebPreferences({}, { partition: BROWSER_PARTITION, src: 'about:blank' }, PICKER), true)
    assert.equal(applyGuestWebPreferences({}, { partition: BROWSER_PARTITION }, PICKER), true)
  })

  run('guest policy: only the shipped picker preload survives, and it alone turns context isolation off', () => {
    const withPicker: Record<string, unknown> = {
      preload: '/app/out/preload/../preload/browser-guest.js',
      contextIsolation: true,
    }
    assert.equal(
      applyGuestWebPreferences(withPicker, { partition: BROWSER_PARTITION, src: 'http://localhost:5173/' }, PICKER),
      true,
    )
    assert.equal(withPicker.preload, PICKER)
    assert.equal(withPicker.contextIsolation, false)

    const foreign: Record<string, unknown> = { preload: '/tmp/evil.js', contextIsolation: false }
    assert.equal(
      applyGuestWebPreferences(foreign, { partition: BROWSER_PARTITION, src: 'http://localhost:5173/' }, PICKER),
      true,
    )
    assert.equal('preload' in foreign, false)
    assert.equal(foreign.contextIsolation, true)

    // No picker built: even the right path is dropped.
    const unbuilt: Record<string, unknown> = { preload: PICKER }
    applyGuestWebPreferences(unbuilt, { partition: BROWSER_PARTITION }, null)
    assert.equal('preload' in unbuilt, false)
    assert.equal(unbuilt.contextIsolation, true)
  })

  run('guest policy: sandbox on, Node off everywhere, web security on — whatever the tag asked for', () => {
    const prefs: Record<string, unknown> = {
      sandbox: false,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
    }
    applyGuestWebPreferences(prefs, { partition: BROWSER_PARTITION, src: 'https://example.com/' }, PICKER)
    assert.deepEqual(prefs, {
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      contextIsolation: true,
    })
  })

  run('cropRect: pads, scales CSS px by the zoom factor, clamps to the capture, and refuses nonsense', () => {
    // 150% zoom: a 100×50 element at (200,100) CSS px is at (300,150) in DIP.
    assert.deepEqual(cropRect({ x: 200, y: 100, width: 100, height: 50 }, 1.5, { width: 1200, height: 800 }), {
      x: 270,
      y: 120,
      width: 210,
      height: 135,
    })
    // Clamped at the origin and the far edge.
    assert.deepEqual(cropRect({ x: 5, y: 5, width: 1000, height: 1000 }, 1, { width: 400, height: 300 }), {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    })
    // Fully off-screen, absurd, or negative sizes: nothing to crop.
    assert.equal(cropRect({ x: 5000, y: 5000, width: 10, height: 10 }, 1, { width: 400, height: 300 }), null)
    assert.equal(cropRect({ x: 1e300, y: 0, width: 10, height: 10 }, 1, { width: 400, height: 300 }), null)
    assert.equal(cropRect({ x: 0, y: 0, width: -10, height: 10 }, 1, { width: 400, height: 300 }), null)
    assert.equal(cropRect({ x: Number.NaN, y: 0, width: 10, height: 10 }, 1, { width: 400, height: 300 }), null)
  })

  run('fileStamp is the local clock, not UTC', () => {
    assert.equal(fileStamp(new Date(2026, 8, 4, 8, 18, 2)), '2026-09-04_08-18-02')
  })
})
