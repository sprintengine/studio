import assert from 'node:assert/strict'

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

  console.log('terminal-options.test.ts: all assertions passed')
})
