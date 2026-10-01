// The door's two questions to main: what is at <project>/<name> as the name is
// typed, and make the project there — always a new folder, never written over.
//
// The templates are the SDK's real ones and the scaffold is the real
// scaffolder, writing into a temporary folder.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, test, vi } from 'vitest'

vi.mock('electron', () => import('../../../tests/stubs/electron'))

import {
  createExtensionScaffoldHandlers,
  EXTENSION_SCAFFOLD_CREATE_CHANNEL,
  EXTENSION_SCAFFOLD_TARGET_CHANNEL,
  registerExtensionScaffoldIpc,
  resolveScaffoldRoots,
  SCAFFOLD_SDK_VERSION,
} from './extension-scaffold-ipc'

const SDK = join(process.cwd(), 'packages', 'module-sdk')
const ROOTS = { templatesRoot: join(SDK, 'templates'), skillsRoot: join(SDK, 'skills') }

let parent = ''

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'extension-scaffold-ipc-'))
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

function handlers() {
  return createExtensionScaffoldHandlers({ roots: () => ROOTS })
}

describe('extensions:scaffold:target', () => {
  test('says whether the name is free, an extension to carry on, or taken', async () => {
    const h = handlers()
    assert.deepEqual(h.target({ parentDir: parent, id: 'pr-radar' }), {
      state: 'free',
      folder: join(parent, 'pr-radar'),
    })

    mkdirSync(join(parent, 'empty'))
    assert.equal(h.target({ parentDir: parent, id: 'empty' })?.state, 'free', 'an empty folder is filled')

    mkdirSync(join(parent, 'notes'))
    writeFileSync(join(parent, 'notes', 'README.md'), 'mine')
    assert.equal(h.target({ parentDir: parent, id: 'notes' })?.state, 'taken')

    mkdirSync(join(parent, 'focus-timer', 'module'), { recursive: true })
    writeFileSync(join(parent, 'focus-timer', 'module', 'manifest.json'), '{}')
    assert.equal(h.target({ parentDir: parent, id: 'focus-timer' })?.state, 'extension')

    assert.equal(h.target({ parentDir: join(parent, 'gone'), id: 'pr-radar' })?.state, 'no_parent')
  })

  test('a name that is not an id yet has no answer', () => {
    const h = handlers()
    assert.equal(h.target({ parentDir: parent, id: '' }), null)
    assert.equal(h.target({ parentDir: parent, id: '../escape' }), null)
    assert.equal(h.target({ parentDir: parent, id: 'pr-' }), null)
  })
})

describe('extensions:scaffold:create', () => {
  test('writes a new project into <project>/<name>, on this build’s SDK version, with the brief', async () => {
    const result = await handlers().create({
      parentDir: parent,
      id: 'pr-radar',
      ideaMarkdown: '# Pr radar\n\nA count of the PRs waiting on me.',
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.equal(result.folder, join(parent, 'pr-radar'))
    assert.equal(result.existing, false)
    const manifest = JSON.parse(readFileSync(join(result.folder, 'module', 'manifest.json'), 'utf8'))
    assert.equal(manifest.id, 'pr-radar')
    assert.equal(manifest.displayName, 'Pr radar', 'the display name comes from the id')
    const pkg = JSON.parse(readFileSync(join(result.folder, 'package.json'), 'utf8'))
    assert.equal(pkg.devDependencies['@sprintengine/module-sdk'], `^${SCAFFOLD_SDK_VERSION}`)
    assert.equal(
      readFileSync(join(result.folder, 'IDEA.md'), 'utf8'),
      '# Pr radar\n\nA count of the PRs waiting on me.\n',
    )
    assert.equal(existsSync(join(result.folder, '.claude/skills/sprintengine-extension-builder/SKILL.md')), true)
  })

  test('an extension already there is handed back as it is, with nothing written', async () => {
    const h = handlers()
    const first = await h.create({ parentDir: parent, id: 'pr-radar', ideaMarkdown: 'first' })
    assert.equal(first.ok, true)
    const again = await h.create({ parentDir: parent, id: 'pr-radar', ideaMarkdown: 'second' })
    assert.deepEqual(again, { ok: true, folder: join(parent, 'pr-radar'), existing: true })
    assert.equal(readFileSync(join(parent, 'pr-radar', 'IDEA.md'), 'utf8'), 'first\n')
  })

  test('a folder with other things in it is refused, not written into', async () => {
    mkdirSync(join(parent, 'notes'))
    writeFileSync(join(parent, 'notes', 'README.md'), 'mine')
    const clash = await handlers().create({ parentDir: parent, id: 'notes' })
    assert.equal(clash.ok, false)
    if (!clash.ok) assert.equal(clash.code, 'dir_not_empty')
    assert.equal(readFileSync(join(parent, 'notes', 'README.md'), 'utf8'), 'mine')
    assert.equal(existsSync(join(parent, 'notes', 'package.json')), false)
  })

  test('checks the name and the project before anything is written', async () => {
    const h = handlers()
    for (const id of ['../escape', 'pr/radar', 'backlog', '']) {
      const refused = await h.create({ parentDir: parent, id })
      assert.equal(refused.ok, false, id)
      if (!refused.ok) assert.equal(refused.code, 'invalid_id', id)
    }
    const gone = await h.create({ parentDir: join(parent, 'gone'), id: 'pr-radar' })
    assert.equal(gone.ok, false)
    if (!gone.ok) assert.equal(gone.code, 'no_parent')
    assert.equal(existsSync(join(parent, 'gone')), false)
  })
})

test('reads the shipped copies when packaged and the SDK package in a checkout', () => {
  assert.deepEqual(resolveScaffoldRoots({ isPackaged: true, resourcesPath: '/App/Resources', appPath: '/x' }), {
    templatesRoot: join('/App/Resources', 'sdk-templates'),
    skillsRoot: join('/App/Resources', 'sdk-skills'),
  })
  assert.deepEqual(resolveScaffoldRoots({ isPackaged: false, resourcesPath: '/x', appPath: '/repo' }), {
    templatesRoot: join('/repo', 'packages', 'module-sdk', 'templates'),
    skillsRoot: join('/repo', 'packages', 'module-sdk', 'skills'),
  })
})

describe('registerExtensionScaffoldIpc', () => {
  test('writing the project answers only the app’s own window', async () => {
    type Handler = (event: unknown, ...args: unknown[]) => unknown
    const registered = new Map<string, Handler>()
    const ipcMain = { handle: (channel: string, handler: Handler) => registered.set(channel, handler) }
    registerExtensionScaffoldIpc(ipcMain as unknown as Parameters<typeof registerExtensionScaffoldIpc>[0], handlers())

    const appEvent = {
      sender: {},
      senderFrame: { parent: null, url: pathToFileURL('/Applications/Studio.app/out/renderer/index.html').href },
    }
    const subframe = { ...appEvent, senderFrame: { ...appEvent.senderFrame, parent: {} } }

    const create = registered.get(EXTENSION_SCAFFOLD_CREATE_CHANNEL)!
    await assert.rejects(
      async () => create(subframe, { parentDir: parent, id: 'x' }),
      /did not come from a SprintEngine Studio window/,
    )
    assert.equal(existsSync(join(parent, 'x')), false)
    const target = registered.get(EXTENSION_SCAFFOLD_TARGET_CHANNEL)!
    assert.equal(((await target(appEvent, { parentDir: parent, id: 'x' })) as { state: string }).state, 'free')
  })
})
