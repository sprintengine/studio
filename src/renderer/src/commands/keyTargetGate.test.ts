// @vitest-environment jsdom
import { beforeEach, expect, test } from 'vitest'

import { isCodeSurfaceTarget, shellTakesChordFrom } from './keyTargetGate'

let composer: HTMLTextAreaElement
let monaco: HTMLTextAreaElement
let terminal: HTMLTextAreaElement
let plain: HTMLDivElement

beforeEach(() => {
  document.body.innerHTML = `
    <textarea id="composer"></textarea>
    <div class="monaco-editor"><textarea id="monaco"></textarea></div>
    <div data-terminal-surface><div class="xterm"><textarea id="terminal"></textarea></div></div>
    <div id="plain" tabindex="0"></div>
  `
  composer = document.getElementById('composer') as HTMLTextAreaElement
  monaco = document.getElementById('monaco') as HTMLTextAreaElement
  terminal = document.getElementById('terminal') as HTMLTextAreaElement
  plain = document.getElementById('plain') as HTMLDivElement
})

test('an editor and a terminal are code surfaces; the composer is not', () => {
  expect(isCodeSurfaceTarget(monaco)).toBe(true)
  expect(isCodeSurfaceTarget(terminal)).toBe(true)
  expect(isCodeSurfaceTarget(composer)).toBe(false)
  expect(isCodeSurfaceTarget(null)).toBe(false)
})

test('the settle chord is taken from the composer and the page, never from an editor or a terminal', () => {
  for (const platform of ['darwin', 'windows', 'linux'] as const) {
    expect(shellTakesChordFrom('chat.settle', composer, platform)).toBe(true)
    expect(shellTakesChordFrom('chat.settle', plain, platform)).toBe(true)
    expect(shellTakesChordFrom('chat.settle', monaco, platform)).toBe(false)
    expect(shellTakesChordFrom('chat.settle', terminal, platform)).toBe(false)
  }
})

test('any other command is left to the dispatcher', () => {
  expect(shellTakesChordFrom('chat.nextWaiting', monaco, 'darwin')).toBe(true)
})
