import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { test } from 'vitest'

import { controlTabContextItemOf, controlTabContextOf, cycleFocusedControlTabScope } from './controlTab'

test('contextual Control-Tab cycling', () => {
  const dom = new JSDOM(`
    <main data-control-tab-scope>
      <div role="tablist">
        <button role="tab" aria-selected="true">Files</button>
        <button role="tab" aria-selected="false">Git</button>
        <button role="tab" aria-selected="false" disabled>Unavailable</button>
      </div>
      <section><input aria-label="Filter files"></section>
    </main>
  `)
  const document = dom.window.document
  const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
  const filter = document.querySelector<HTMLInputElement>('input')!
  let clicked = ''
  tabs.forEach((tab) => tab.addEventListener('click', () => (clicked = tab.textContent ?? '')))

  assert.equal(cycleFocusedControlTabScope(filter, 1), true)
  assert.equal(clicked, 'Git')
  assert.equal(document.activeElement, tabs[1], 'the destination stays in the scope for another Control-Tab')

  tabs[0]!.setAttribute('aria-selected', 'false')
  tabs[1]!.setAttribute('aria-selected', 'true')
  assert.equal(cycleFocusedControlTabScope(tabs[1]!, 1), true)
  assert.equal(clicked, 'Files', 'forward cycling wraps and skips disabled destinations')

  assert.equal(cycleFocusedControlTabScope(tabs[0]!, -1), true)
  assert.equal(clicked, 'Git', 'reverse cycling wraps')

  document.body.innerHTML = `
    <nav data-control-tab-scope>
      <div data-control-tab-item><button aria-current="true">Design</button></div>
      <div data-control-tab-item><button>Plugins</button></div>
      <div data-control-tab-item><button>Skills</button></div>
    </nav>
  `
  const design = document.querySelector<HTMLElement>('button')!
  const plugins = document.querySelectorAll<HTMLElement>('button')[1]!
  clicked = ''
  plugins.addEventListener('click', () => (clicked = 'Plugins'))
  assert.equal(cycleFocusedControlTabScope(design, 1), true)
  assert.equal(clicked, 'Plugins', 'explicit drawer destinations cycle through their buttons')

  document.body.innerHTML = `
    <nav data-control-tab-scope role="tree">
      <div role="treeitem" data-row-key="chat-a" aria-current="true">Chat A</div>
      <div role="treeitem" data-row-key="chat-b">Chat B</div>
    </nav>
  `
  const chats = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')]
  chats[1]!.addEventListener('click', () => (clicked = 'Chat B'))
  assert.equal(cycleFocusedControlTabScope(chats[0]!, 1), true)
  assert.equal(clicked, 'Chat B', 'conversation rows form a contextual cycle')

  document.body.innerHTML = `
    <section data-control-tab-scope>
      <button role="tab" aria-selected="true">Outer A</button>
      <button role="tab">Outer B</button>
      <section data-control-tab-scope>
        <button role="tab" aria-selected="true">Inner A</button>
        <button role="tab">Inner B</button>
        <input>
      </section>
    </section>
  `
  const innerFocus = document.querySelector<HTMLInputElement>('input')!
  const innerB = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (tab) => tab.textContent === 'Inner B',
  )!
  innerB.addEventListener('click', () => (clicked = 'Inner B'))
  assert.equal(cycleFocusedControlTabScope(innerFocus, 1), true)
  assert.equal(clicked, 'Inner B', 'the nearest nested scope wins')

  assert.equal(
    cycleFocusedControlTabScope(document.body, 1),
    false,
    'outside a scope the layout fallback remains available',
  )

  document.body.innerHTML = '<section data-control-tab-context="extensions"><input></section>'
  assert.equal(controlTabContextOf(document.querySelector('input')), 'extensions')

  document.body.innerHTML = `
    <section data-control-tab-context="extensions">
      <div data-control-tab-context-item="skills"><button>Skills</button></div>
    </section>
  `
  assert.equal(controlTabContextItemOf(document.querySelector('button')), 'skills')

  document.body.innerHTML = '<section data-control-tab-scope><button role="tab">Only tab</button></section>'
  assert.equal(
    cycleFocusedControlTabScope(document.querySelector('button'), 1),
    true,
    'a one-item scope owns the gesture instead of falling through to another panel',
  )
})
