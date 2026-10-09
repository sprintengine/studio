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

test('the pane "+" chord is taken from the composer on macOS only, and never from an editor or a terminal', () => {
  expect(shellTakesChordFrom('pane.add', composer, 'darwin')).toBe(true)
  expect(shellTakesChordFrom('pane.add', composer, 'windows')).toBe(false)
  expect(shellTakesChordFrom('pane.add', composer, 'linux')).toBe(false)
  for (const platform of ['darwin', 'windows', 'linux'] as const) {
    expect(shellTakesChordFrom('pane.add', plain, platform)).toBe(true)
    expect(shellTakesChordFrom('pane.add', monaco, platform)).toBe(false)
    expect(shellTakesChordFrom('pane.add', terminal, platform)).toBe(false)
  }
})

test('the find chord is taken inside a chat, and left to everything else', () => {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div data-chat-pane>
      <div id="transcript" tabindex="0"><p id="reply">words</p></div>
      <div id="chat-composer" contenteditable="true"></div>
      <div class="monaco-editor"><textarea id="chat-monaco"></textarea></div>
    </div>`,
  )
  for (const platform of ['darwin', 'windows', 'linux'] as const) {
    for (const id of ['transcript', 'reply', 'chat-composer'])
      expect(shellTakesChordFrom('chat.find', document.getElementById(id), platform)).toBe(true)
    // An editor drawn inside a chat keeps its own find.
    expect(shellTakesChordFrom('chat.find', document.getElementById('chat-monaco'), platform)).toBe(false)
    // Outside a chat: an editor, a terminal, the page, and a text field that
    // is not a chat's.
    for (const target of [monaco, terminal, plain, document.body, composer, null])
      expect(shellTakesChordFrom('chat.find', target, platform)).toBe(false)
  }
})

test('any other command is left to the dispatcher', () => {
  expect(shellTakesChordFrom('chat.nextWaiting', monaco, 'darwin')).toBe(true)
})
