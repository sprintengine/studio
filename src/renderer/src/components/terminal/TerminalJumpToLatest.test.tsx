import assert from 'node:assert/strict'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'vitest'

import { TERMINAL_CHROME_ATTRIBUTE } from '../../utils/keyboard'
import { TerminalJumpToLatest } from './TerminalJumpToLatest'

test('nothing is drawn while the terminal follows its output', () => {
  assert.equal(renderToStaticMarkup(<TerminalJumpToLatest visible={false} onJump={() => {}} />), '')
})

test('the control is a labelled button inside the pane chrome', () => {
  const html = renderToStaticMarkup(<TerminalJumpToLatest visible onJump={() => {}} />)
  // Marked as chrome, so the pane's native pointer and clipboard listeners
  // step aside instead of reading a press here as a press on the terminal.
  assert.match(html, new RegExp(`^<div[^>]*${TERMINAL_CHROME_ATTRIBUTE}=""`))
  assert.match(html, /<button type="button"[^>]*>.*Jump to latest<\/button>/)
})
