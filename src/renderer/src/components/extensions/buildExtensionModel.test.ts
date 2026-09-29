import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import type { ExtensionScaffoldCheck } from '../../../../shared/extension-scaffold'
import { extensionIdFromName, extensionIdProblem } from '../../../../shared/extension-scaffold'
import {
  buildExtensionBlocker,
  buildExtensionIdeaMarkdown,
  buildExtensionPrompt,
  ideaLine,
} from './buildExtensionModel'
import { BUILD_EXTENSION_PALETTE_ROW_ID, createBuildExtensionPaletteProvider } from './buildExtensionPaletteProvider'
import { takeBuildExtensionFlowRequest } from './buildExtensionHost'

const PANEL = {
  title: 'Panel',
  summary: 'A notes panel in a workspace of its own, saved in module app state.',
  permissions: ['storage'],
}

describe('the build flow’s words', () => {
  test('the first message sends the agent to the skill, the brief and the dev loop, and never reads as a flag', () => {
    const prompt = buildExtensionPrompt({
      name: 'Focus "notes"',
      idea: '  A scratchpad\nper workspace ',
      template: PANEL,
    })
    assert.equal(
      prompt,
      'Use the sprintengine-extension-builder skill. We\'re building "Focus notes" (A scratchpad per workspace); ' +
        'the brief is in IDEA.md. First run npm install and npm run check, then ask me up to three questions ' +
        'about what I want before changing code. Keep permissions minimal, build, and side-load it with ' +
        'npm run dev:install so I can try it.',
    )
    assert.equal(prompt.startsWith('-'), false)
  })

  test('with no idea of their own the template’s summary stands in, and a long idea is cut in the prompt only', () => {
    assert.equal(ideaLine('', PANEL), 'A notes panel in a workspace of its own, saved in module app state')
    const long = 'word '.repeat(80)
    const line = ideaLine(long, PANEL)
    assert.equal(line.length, 160)
    assert.equal(line.endsWith('…'), true)
    assert.match(buildExtensionIdeaMarkdown({ name: 'X', idea: long, template: PANEL }), new RegExp(long.trim()))
  })

  test('IDEA.md is the template’s brief with the idea and what the template already asks for', () => {
    const markdown = buildExtensionIdeaMarkdown({ name: 'Focus notes', idea: 'A scratchpad.', template: PANEL })
    assert.match(markdown, /^# Focus notes\n\nStarted from the \*\*Panel\*\* template: A notes panel/)
    assert.match(markdown, /## What it does\n\nA scratchpad\.\n/)
    assert.match(markdown, /The template starts with `storage`\. Keep only what the idea needs\./)
    assert.match(
      buildExtensionIdeaMarkdown({ name: 'Blank', idea: '', template: { ...PANEL, permissions: [] } }),
      /starts with no permissions/,
    )
  })

  test('Create waits for a name, a usable id, a folder, an agent and a machine that can build it — in that order', () => {
    const ok: ExtensionScaffoldCheck = { id: 'node', label: 'Node.js', status: 'ok', required: true, detail: '24.1.0' }
    const ready = { name: 'Focus notes', id: 'focus-notes', folderChosen: true, agentChosen: true, checks: [ok] }
    assert.equal(buildExtensionBlocker(ready), null)
    assert.equal(buildExtensionBlocker({ ...ready, name: ' " ' }), 'Name the extension.')
    assert.match(buildExtensionBlocker({ ...ready, id: 'Focus Notes' }) ?? '', /lowercase letters/)
    assert.match(buildExtensionBlocker({ ...ready, id: 'backlog' }) ?? '', /belongs to a part of the studio/)
    assert.equal(buildExtensionBlocker({ ...ready, folderChosen: false }), 'Choose where the project goes.')
    assert.equal(buildExtensionBlocker({ ...ready, agentChosen: false }), 'Choose the agent that builds it with you.')
    assert.equal(buildExtensionBlocker({ ...ready, checks: null }), 'Checking this machine…')
    const old: ExtensionScaffoldCheck = { ...ok, status: 'outdated', detail: 'Found 20.1.0.' }
    assert.equal(buildExtensionBlocker({ ...ready, checks: [old] }), 'Node.js: Found 20.1.0.')
    const noGit: ExtensionScaffoldCheck = { id: 'git', label: 'git', status: 'missing', required: false, detail: '…' }
    const unsure: ExtensionScaffoldCheck = { ...ok, status: 'unknown' }
    assert.equal(buildExtensionBlocker({ ...ready, checks: [unsure, noGit] }), null, 'optional and unknown never block')
  })

  test('an id is made from the name the way the manifest wants one', () => {
    assert.equal(extensionIdFromName('  Focus Notes! '), 'focus-notes')
    assert.equal(extensionIdFromName('Café — timer'), 'cafe-timer')
    assert.equal(extensionIdFromName('***'), '')
    assert.equal(extensionIdFromName('a'.repeat(70)).length, 63)
    assert.equal(extensionIdProblem('focus-notes'), null)
    assert.equal(extensionIdProblem(''), 'Give the extension an id.')
  })
})

describe('the palette row', () => {
  test('is found by what a person types for it, and opens the home with the flow requested', () => {
    const opened: string[] = []
    const closed: string[] = []
    const provider = createBuildExtensionPaletteProvider({ openExtensionsHome: () => opened.push('home') })
    const context = { workspaceRoot: null, workspaceId: null, scope: 'all' as const, close: () => closed.push('x') }
    for (const query of ['build', 'your own ext', 'new extension', 'sdk', 'module']) {
      const rows = provider.load(query, context) as { id: string }[]
      assert.deepEqual(
        rows.map((row) => row.id),
        [BUILD_EXTENSION_PALETTE_ROW_ID],
        `"${query}" finds it`,
      )
    }
    assert.deepEqual(provider.load('zebra crossing', context), [])

    const [row] = provider.load('build', context) as { run: () => void }[]
    takeBuildExtensionFlowRequest()
    row!.run()
    assert.deepEqual(closed, ['x'])
    assert.deepEqual(opened, ['home'])
    assert.equal(takeBuildExtensionFlowRequest(), true, 'the request is latched for the home to take')
    assert.equal(takeBuildExtensionFlowRequest(), false, 'and taken once')
  })
})
