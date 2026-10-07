import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  escapeExecArgument,
  isOwnUrlHandlerEntry,
  registerLinuxUrlHandler,
  renderUrlHandlerEntry,
  type ExecResult,
  type LinuxUrlHandlerDeps,
} from './linux-url-handler'

const HOME = '/home/dev'
const APPS = '/home/dev/.local/share/applications'
const ENTRY = `${APPS}/sprintengine-url-handler.desktop`
const APPIMAGE = '/home/dev/Applications/SprintEngine-Studio.AppImage'
const MIME = 'x-scheme-handler/sprintengine'

type Options = {
  platform?: NodeJS.Platform
  isPackaged?: boolean
  env?: NodeJS.ProcessEnv
  files?: Record<string, string>
  /** What `xdg-mime query default` prints. */
  currentDefault?: string
  /** Programs that are not installed. */
  missing?: string[]
  /** Programs that run and fail. */
  failing?: string[]
  unwritable?: boolean
}

function harness(options: Options = {}) {
  const files = new Map(Object.entries(options.files ?? {}))
  const writes: string[] = []
  const commands: string[] = []
  const logs: string[] = []
  const recorded: string[] = []
  const deps: LinuxUrlHandlerDeps = {
    platform: options.platform ?? 'linux',
    isPackaged: options.isPackaged ?? true,
    env: options.env ?? { APPIMAGE },
    homeDir: HOME,
    readFile: async (path) => {
      const text = files.get(path)
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return text
    },
    writeFile: async (path, content) => {
      if (options.unwritable) throw new Error(`EACCES: ${path}`)
      writes.push(path)
      files.set(path, content)
    },
    mkdir: async () => undefined,
    exec: async (file, args): Promise<ExecResult> => {
      commands.push([file, ...args].join(' '))
      if (options.missing?.includes(file)) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })
      if (options.failing?.includes(file)) return { code: 1, stdout: '' }
      if (file === 'xdg-mime' && args[0] === 'query') return { code: 0, stdout: `${options.currentDefault ?? ''}\n` }
      return { code: 0, stdout: '' }
    },
    log: (level, message) => void logs.push(`${level}: ${message}`),
    record: (path, scheme) => void recorded.push(`${scheme} ${path}`),
  }
  return {
    run: () => registerLinuxUrlHandler(deps, ['sprintengine']),
    files,
    writes,
    commands,
    logs,
    recorded,
  }
}

test('nothing happens off Linux, in a build that is not packaged, or outside an AppImage', async () => {
  for (const options of [
    { platform: 'darwin' as const },
    { platform: 'win32' as const },
    { isPackaged: false },
    { env: {} },
    { env: { APPIMAGE: 'relative/SprintEngine-Studio.AppImage' } },
  ]) {
    const h = harness(options)
    await h.run()
    assert.deepEqual(h.writes, [], JSON.stringify(options))
    assert.deepEqual(h.commands, [], JSON.stringify(options))
    assert.deepEqual(h.recorded, [], JSON.stringify(options))
  }
})

test('a missing entry is written, the MIME cache refreshed, and it is made the default', async () => {
  const h = harness()
  await h.run()
  assert.deepEqual(h.writes, [ENTRY])
  const text = h.files.get(ENTRY) ?? ''
  assert.match(text, /^\[Desktop Entry\]\n/u)
  assert.ok(text.includes(`Exec="${APPIMAGE}" %U\n`))
  assert.ok(text.includes('NoDisplay=true\n'))
  assert.ok(text.includes(`MimeType=${MIME};\n`))
  assert.ok(isOwnUrlHandlerEntry(text))
  assert.deepEqual(h.commands, [
    `update-desktop-database ${APPS}`,
    `xdg-mime default sprintengine-url-handler.desktop ${MIME}`,
  ])
  assert.deepEqual(h.recorded, [`sprintengine ${ENTRY}`])
})

test('XDG_DATA_HOME, when it is an absolute path, is where the entry goes', async () => {
  const h = harness({ env: { APPIMAGE, XDG_DATA_HOME: '/home/dev/.data' } })
  await h.run()
  assert.deepEqual(h.writes, ['/home/dev/.data/applications/sprintengine-url-handler.desktop'])
  const relative = harness({ env: { APPIMAGE, XDG_DATA_HOME: 'data' } })
  await relative.run()
  assert.deepEqual(relative.writes, [ENTRY], 'a relative XDG_DATA_HOME is ignored')
})

test('a current entry that is already the default is left alone', async () => {
  const h = harness({
    files: { [ENTRY]: renderUrlHandlerEntry('sprintengine', APPIMAGE) },
    currentDefault: 'sprintengine-url-handler.desktop',
  })
  await h.run()
  assert.deepEqual(h.writes, [])
  assert.deepEqual(h.commands, [`xdg-mime query default ${MIME}`])
  assert.deepEqual(h.recorded, [`sprintengine ${ENTRY}`], 'listed in the ledger even when nothing was written')
})

test('a current entry another app took the scheme from is made the default again, and not rewritten', async () => {
  const h = harness({
    files: { [ENTRY]: renderUrlHandlerEntry('sprintengine', APPIMAGE) },
    currentDefault: 'other-app.desktop',
  })
  await h.run()
  assert.deepEqual(h.writes, [])
  assert.deepEqual(h.commands, [
    `xdg-mime query default ${MIME}`,
    `xdg-mime default sprintengine-url-handler.desktop ${MIME}`,
  ])
})

test('an entry written for an AppImage that has moved is rewritten and registered again', async () => {
  const h = harness({
    files: { [ENTRY]: renderUrlHandlerEntry('sprintengine', '/home/dev/Downloads/SprintEngine-Studio.AppImage') },
    currentDefault: 'sprintengine-url-handler.desktop',
  })
  await h.run()
  assert.deepEqual(h.writes, [ENTRY])
  assert.ok(h.files.get(ENTRY)?.includes(`Exec="${APPIMAGE}" %U`))
  assert.deepEqual(h.commands, [
    `update-desktop-database ${APPS}`,
    `xdg-mime default sprintengine-url-handler.desktop ${MIME}`,
  ])
})

test('the AppImage path is quoted and escaped by the desktop-entry Exec rules', () => {
  assert.equal(escapeExecArgument('/home/dev/My Apps/Studio.AppImage'), '"/home/dev/My Apps/Studio.AppImage"')
  // Quote, backtick and dollar get a backslash inside the quotes, which the
  // file's string escaping then doubles, so a backslash ends up as four; a
  // percent sign is doubled so it is not read as a field code. Each `\\` in
  // the expected strings is one backslash in the file.
  assert.equal(
    escapeExecArgument('/home/dev/"q"/a`b`/$HOME/100%.AppImage'),
    '"/home/dev/\\\\"q\\\\"/a\\\\`b\\\\`/\\\\$HOME/100%%.AppImage"',
  )
  assert.equal(escapeExecArgument('/home/dev/back\\slash'), '"/home/dev/back\\\\\\\\slash"')
  assert.equal(escapeExecArgument('/home/dev/tab\there'), '"/home/dev/tab\\there"')
  const text = renderUrlHandlerEntry('sprintengine', '/home/dev/My Apps/50% off.AppImage')
  assert.ok(text.includes('Exec="/home/dev/My Apps/50%% off.AppImage" %U\n'))
})

test('a missing xdg-mime or update-desktop-database is logged and swallowed', async () => {
  const h = harness({ missing: ['update-desktop-database', 'xdg-mime'] })
  await h.run()
  assert.deepEqual(h.writes, [ENTRY], 'the entry is still written')
  assert.deepEqual(h.logs, ['warning: update-desktop-database could not be run', 'warning: xdg-mime could not be run'])
})

test('a command that fails is logged, and the default is still set when only the cache refresh failed', async () => {
  const h = harness({ failing: ['update-desktop-database'] })
  await h.run()
  assert.ok(h.commands.includes(`xdg-mime default sprintengine-url-handler.desktop ${MIME}`))
  assert.deepEqual(h.logs, ['warning: update-desktop-database did not succeed', 'info: Registered the link handler'])

  const current = harness({
    files: { [ENTRY]: renderUrlHandlerEntry('sprintengine', APPIMAGE) },
    failing: ['xdg-mime'],
  })
  await current.run()
  assert.deepEqual(current.commands, [`xdg-mime query default ${MIME}`], 'an unanswered query changes nothing')
  assert.deepEqual(current.logs, ['warning: xdg-mime did not succeed'])
})

test('a home that cannot be written is logged, and nothing is recorded or registered', async () => {
  const h = harness({ unwritable: true })
  await h.run()
  assert.deepEqual(h.commands, [])
  assert.deepEqual(h.recorded, [])
  assert.deepEqual(h.logs, ['warning: The link handler could not be registered'])
})
