import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { TERMINAL_CELL_GEOMETRY_OPTIONS, TERMINAL_UNICODE_VERSION, terminalRenderContract } from './terminal-options'
import { test } from 'vitest'

test('terminal-options', async () => {
  // What a REMOTE renderer is told about how this process measures a cell.
  //
  // The two local renderers (the pane's `@xterm/xterm` and main's
  // `@xterm/headless`) import the constants above and therefore cannot disagree.
  // A phone attached over the tailnet ships its own xterm on its own cadence and
  // paints the same PTY bytes into its own buffer, so the only thing that ever
  // kept it in step was somebody mirroring a constant by hand — and when the live
  // panes moved to Unicode 11, nobody did. These assertions are what stop the
  // advertisement being dropped or quietly diverging from what we actually render
  // under.

  // --- the contract says what we render under ------------------------------------
  const contract = terminalRenderContract()
  assert.equal(contract.unicodeVersion, TERMINAL_UNICODE_VERSION, 'the wire must state the version we actually select')
  assert.equal(contract.tabStopWidth, TERMINAL_CELL_GEOMETRY_OPTIONS.tabStopWidth)
  assert.equal(contract.convertEol, TERMINAL_CELL_GEOMETRY_OPTIONS.convertEol)

  // Every value has to be settable on a LIVE terminal, because that is what lets
  // a client adopt the contract instead of refusing the attach. `allowProposedApi`
  // is deliberately absent: it is a construction option, and a renderer that lacks
  // the proposed API cannot honour a unicode version anyway.
  assert.equal('allowProposedApi' in contract, false, 'a construction-only option is not a remote renderer’s to adopt')

  // --- the xterm version is diagnostics, and optional -----------------------------
  assert.equal(contract.xtermVersion, undefined, 'omitted rather than sent empty when nobody passed one')
  assert.equal(terminalRenderContract('6.1.0-beta.303').xtermVersion, '6.1.0-beta.303')

  // --- it is JSON, because it rides a JSON frame ----------------------------------
  assert.deepEqual(JSON.parse(JSON.stringify(contract)), contract, 'the contract must survive the wire unchanged')

  // --- the stream actually sends it -----------------------------------------------
  // A unit test on the builder proves nothing if the `attached` frame stops
  // carrying it, and that frame is assembled inline rather than through a typed
  // factory, so the source is what there is to assert against.
  const streamSource = readFileSync(
    join(process.cwd(), 'src/main/automation/tailnet/tailnet-terminal-stream.ts'),
    'utf8',
  )
  const attachedFrame = streamSource.slice(streamSource.indexOf("type: 'attached'"))
  assert.ok(
    /render: terminalRenderContract\(\)/.test(attachedFrame.slice(0, 400)),
    'the attached frame must advertise the render contract — a remote renderer has no other way to learn it',
  )

  // The ordering the client depends on: the replay is sent BEFORE `attached`, so a
  // client that adopts a different width table has already painted the scrollback
  // and must repaint it. If this ever flips, the client's repaint becomes dead
  // code and this comment becomes a lie, so pin it.
  assert.ok(
    streamSource.indexOf('Sent AFTER the attach replay') < streamSource.indexOf("type: 'attached'"),
    'the attached frame still follows the replay',
  )

  console.log('terminal-options.test.ts: all assertions passed')
})
