// The build flow's three questions to main: which templates, can this machine
// build one, and make it — the last only under a folder main's own dialog
// handed out.
//
// The templates are the SDK's real ones and the scaffold is the real
// scaffolder, writing into a temporary folder; only the dialog and the probes
// are stand-ins.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, test, vi } from 'vitest'

vi.mock('electron', () => import('../../../tests/stubs/electron'))

import type { BinaryVersionProbe } from '../cli-runtime-install'
import {
  createExtensionScaffoldHandlers,
  EXTENSION_SCAFFOLD_CREATE_CHANNEL,
  EXTENSION_SCAFFOLD_PICK_FOLDER_CHANNEL,
  registerExtensionScaffoldIpc,
  resolveScaffoldRoots,
  SCAFFOLD_SDK_VERSION,
  type ExtensionScaffoldDeps,
} from './extension-scaffold-ipc'

const SDK = join(process.cwd(), 'packages', 'module-sdk')
const ROOTS = { templatesRoot: join(SDK, 'templates'), skillsRoot: join(SDK, 'skills') }
const event = {} as Parameters<ExtensionScaffoldDeps['showFolderDialog']>[0]

let parent = ''

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'extension-scaffold-ipc-'))
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

function resolved(version: string): BinaryVersionProbe {
  return { outcome: 'resolved', version, resolvedPath: '/usr/local/bin/tool' }
}

function handlers(overrides: Partial<ExtensionScaffoldDeps> = {}) {
  return createExtensionScaffoldHandlers({
    roots: () => ROOTS,
    showFolderDialog: async () => parent,
    probe: async (binary) =>
      resolved(binary === 'node' ? 'v24.1.0' : binary === 'npm' ? '11.2.0' : 'git version 2.50.1'),
    agent: async (cli) => (cli === 'claude-code' ? { label: 'Claude Code', installed: true } : null),
    ...overrides,
  })
}

describe('extensions:scaffold:templates', () => {
  test('lists the SDK templates in picker order, each with what it asks for', () => {
    const templates = handlers().templates()
    assert.equal(templates[0]?.id, 'blank')
    const panel = templates.find((template) => template.id === 'panel')
    assert.ok(panel)
    assert.equal(panel.title, 'Panel')
    assert.deepEqual(panel.permissions, ['storage'])
    assert.ok(templates.length >= 11)
  })

  test('reads the shipped copies when packaged and the SDK package in a checkout', () => {
    assert.deepEqual(resolveScaffoldRoots({ isPackaged: true, resourcesPath: '/App/Resources', appPath: '/x' }), {
      templatesRoot: '/App/Resources/sdk-templates',
      skillsRoot: '/App/Resources/sdk-skills',
    })
    assert.deepEqual(resolveScaffoldRoots({ isPackaged: false, resourcesPath: '/r', appPath: '/Users/dev/studio' }), {
      templatesRoot: '/Users/dev/studio/packages/module-sdk/templates',
      skillsRoot: '/Users/dev/studio/packages/module-sdk/skills',
    })
  })
})

describe('extensions:scaffold:check', () => {
  test('node, npm and git found, and a chat-capable agent installed: all ok', async () => {
    const checks = await handlers().check({ cli: 'claude-code' })
    assert.deepEqual(
      checks.map((check) => [check.id, check.status, check.required]),
      [
        ['node', 'ok', true],
        ['npm', 'ok', true],
        ['git', 'ok', false],
        ['agent', 'ok', true],
      ],
    )
    assert.equal(checks[0]?.detail, '24.1.0')
    assert.equal(checks[3]?.label, 'Claude Code')
  })

  test('an old Node.js is outdated, a missing one says where to get it, and git is only recommended', async () => {
    const old = await handlers({ probe: async (binary) => resolved(binary === 'node' ? 'v20.11.1' : '1.0.0') }).check(
      {},
    )
    assert.equal(old[0]?.status, 'outdated')
    assert.match(old[0]!.detail, /Found 20\.11\.1; the project's scripts need 22\.15 or later/)
    assert.equal(old.length, 3, 'no agent named, no agent check')

    const missing = await handlers({ probe: async () => ({ outcome: 'not_installed' }) }).check({})
    assert.equal(missing[0]?.status, 'missing')
    assert.match(missing[0]!.detail, /nodejs\.org/)
    assert.equal(missing[2]?.status, 'missing')
    assert.equal(missing[2]?.required, false)
    assert.match(missing[2]!.detail, /publishing it on GitHub needs git/)

    const unsure = await handlers({ probe: async () => ({ outcome: 'probe_failed' }) }).check({})
    assert.deepEqual(
      unsure.map((check) => check.status),
      ['unknown', 'unknown', 'unknown'],
    )
  })

  test('an agent that is not installed, or cannot run as a chat, says what to do', async () => {
    const notInstalled = await handlers({
      agent: async () => ({ label: 'Claude Code', installed: false }),
    }).check({ cli: 'claude-code' })
    assert.equal(notInstalled[3]?.status, 'missing')
    assert.match(notInstalled[3]!.detail, /Install it from Settings › Agents/)

    const notChat = await handlers({ agent: async () => ({ label: 'Gemini', installed: true }) }).check({
      cli: 'gemini',
    })
    assert.equal(notChat[3]?.status, 'missing')
    assert.match(notChat[3]!.detail, /cannot run as a chat agent here/)
  })
})

describe('extensions:scaffold:create', () => {
  const base = { templateId: 'panel', id: 'focus-notes', displayName: 'Focus notes' }

  test('writes the project into <picked folder>/<id>, on this build’s SDK version, with the brief', async () => {
    const h = handlers()
    const pick = await h.pickFolder(event)
    assert.ok(pick)
    const result = await h.create({
      ...base,
      parentDir: pick.path,
      parentDirToken: pick.token,
      ideaMarkdown: '# Focus notes\n\nA scratchpad per workspace.',
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.equal(result.folder, join(parent, 'focus-notes'))
    const manifest = JSON.parse(readFileSync(join(result.folder, 'module', 'manifest.json'), 'utf8'))
    assert.equal(manifest.id, 'focus-notes')
    const pkg = JSON.parse(readFileSync(join(result.folder, 'package.json'), 'utf8'))
    assert.equal(pkg.devDependencies['@sprintengine/module-sdk'], `^${SCAFFOLD_SDK_VERSION}`)
    assert.equal(readFileSync(join(result.folder, 'IDEA.md'), 'utf8'), '# Focus notes\n\nA scratchpad per workspace.\n')
    assert.equal(existsSync(join(result.folder, '.claude/skills/sprintengine-extension-builder/SKILL.md')), true)

    // The pick is spent by the create that used it.
    const again = await h.create({ ...base, id: 'second', parentDir: pick.path, parentDirToken: pick.token })
    assert.equal(again.ok, false)
    if (!again.ok) assert.equal(again.code, 'folder_not_picked')
  })

  test('refuses a folder main did not hand out, and a path that does not match its token', async () => {
    const h = handlers()
    const forged = await h.create({ ...base, parentDir: parent, parentDirToken: 'made-up' })
    assert.equal(forged.ok, false)
    if (!forged.ok) assert.equal(forged.code, 'folder_not_picked')

    const pick = await h.pickFolder(event)
    assert.ok(pick)
    const elsewhere = await h.create({ ...base, parentDir: tmpdir(), parentDirToken: pick.token })
    assert.equal(elsewhere.ok, false)
    if (!elsewhere.ok) assert.equal(elsewhere.code, 'folder_not_picked')
    assert.equal(existsSync(join(tmpdir(), 'focus-notes')), false)
  })

  test('a pick expires, and a cancelled dialog hands out nothing', async () => {
    let now = 1_000
    const h = handlers({ now: () => now })
    const pick = await h.pickFolder(event)
    assert.ok(pick)
    now += 31 * 60_000
    const late = await h.create({ ...base, parentDir: pick.path, parentDirToken: pick.token })
    assert.equal(late.ok, false)
    if (!late.ok) assert.equal(late.code, 'folder_not_picked')

    assert.equal(await handlers({ showFolderDialog: async () => null }).pickFolder(event), null)
  })

  test('checks the id and the name before anything is written, and keeps the pick through a refusal', async () => {
    const h = handlers()
    const pick = await h.pickFolder(event)
    assert.ok(pick)
    const folder = { parentDir: pick.path, parentDirToken: pick.token }

    const badId = await h.create({ ...base, ...folder, id: '../escape' })
    assert.equal(badId.ok, false)
    if (!badId.ok) assert.equal(badId.code, 'invalid_id')
    const reserved = await h.create({ ...base, ...folder, id: 'backlog' })
    assert.equal(reserved.ok, false)
    if (!reserved.ok) assert.equal(reserved.code, 'invalid_id')
    const noName = await h.create({ ...base, ...folder, displayName: '  ' })
    assert.equal(noName.ok, false)
    if (!noName.ok) assert.equal(noName.code, 'invalid_input')
    const unknown = await h.create({ ...base, ...folder, templateId: 'spreadsheet' })
    assert.equal(unknown.ok, false)
    if (!unknown.ok) assert.equal(unknown.code, 'unknown_template')

    const made = await h.create({ ...base, ...folder })
    assert.equal(made.ok, true)
  })

  test('a project folder that already has files in it is refused, not written over', async () => {
    const h = handlers()
    const first = await h.pickFolder(event)
    assert.ok(first)
    assert.equal((await h.create({ ...base, parentDir: first.path, parentDirToken: first.token })).ok, true)
    const second = await h.pickFolder(event)
    assert.ok(second)
    const clash = await h.create({ ...base, parentDir: second.path, parentDirToken: second.token })
    assert.equal(clash.ok, false)
    if (!clash.ok) assert.equal(clash.code, 'dir_not_empty')
  })
})

describe('registerExtensionScaffoldIpc', () => {
  test('the channels that choose where files go answer only the app’s own window', async () => {
    type Handler = (event: unknown, ...args: unknown[]) => unknown
    const registered = new Map<string, Handler>()
    const ipcMain = { handle: (channel: string, handler: Handler) => registered.set(channel, handler) }
    registerExtensionScaffoldIpc(ipcMain as unknown as Parameters<typeof registerExtensionScaffoldIpc>[0], handlers())

    const appEvent = {
      sender: {},
      senderFrame: { parent: null, url: pathToFileURL('/Applications/Studio.app/out/renderer/index.html').href },
    }
    const subframe = { ...appEvent, senderFrame: { ...appEvent.senderFrame, parent: {} } }

    const pick = registered.get(EXTENSION_SCAFFOLD_PICK_FOLDER_CHANNEL)!
    const create = registered.get(EXTENSION_SCAFFOLD_CREATE_CHANNEL)!
    await assert.rejects(async () => pick(subframe), /did not come from a SprintEngine Studio window/)
    await assert.rejects(async () => create({}, { ...base() }), /did not come from a SprintEngine Studio window/)
    const picked = (await pick(appEvent)) as { path: string; token: string }
    assert.equal(picked.path, parent)
  })
})

function base() {
  return { templateId: 'blank', id: 'x', displayName: 'X', parentDir: parent, parentDirToken: 't' }
}
