// The pieces around the removal: what the Windows uninstaller runs (and, on an
// update, does not), what the renderer may ask for, and the deferred deletion
// of the app's own data.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'vitest'

import { removalExitCode, summarizeRemoval } from '../../shared/integration-removal'
import { sanitizeRemovalOptions } from '../ipc/integrations-ipc'
import { appDataDeletionCommand, isDeletableAppDataPath } from './app-data-deletion'
import { formatRemovalReport, headlessTimeoutMs } from './remove-integrations-cli'

async function uninstallMacro(): Promise<string> {
  const text = await readFile(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')
  const start = text.indexOf('!macro customUnInstall')
  assert.ok(start > 0, 'the uninstaller defines customUnInstall')
  return text.slice(start, text.indexOf('!macroend', start))
}

test('an update never runs the clean-up: every step sits under ${IfNot} ${isUpdated}', async () => {
  const macro = await uninstallMacro()
  const body = macro.split('\n').filter((line) => line.trim() && !line.trim().startsWith(';'))
  assert.equal(body[1]?.trim(), '${IfNot} ${isUpdated}', 'the first instruction is the update guard')
  assert.equal(body.at(-1)?.trim(), '${EndIf}', 'and it closes the whole body')
  // The guard is the one electron-updater's reinstall passes: the new
  // installer runs the old uninstaller with --updated.
  const stock = await readFile(
    join(process.cwd(), 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include', 'installUtil.nsh'),
    'utf8',
  )
  assert.match(stock, /StrCpy \$0 "\$0 --updated"/u)
})

test('the uninstaller runs the removal bounded, removes the link handler, and asks about data only when a person started it', async () => {
  const macro = await uninstallMacro()
  const run = macro.split('\n').find((line) => line.includes('nsExec::ExecToLog')) ?? ''
  assert.match(run, /'\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}' -ArgumentList '--remove-integrations','--timeout=\d+'/u)
  assert.match(run, /WaitForExit\(\d+\)\) \{ \$\$p\.Kill\(\)/u, 'the wait is bounded, whatever the app does')
  assert.ok(!macro.includes('ExecWait'), 'no unbounded wait')
  assert.match(macro, /DeleteRegKey HKCU "Software\\Classes\\sprintengine"/u)
  assert.match(macro, /ReadRegStr \$R3 HKCU "Software\\Classes\\sprintengine\\shell\\open\\command"/u)
  assert.match(macro, /\$\{GetOptions\} \$R0 "\/S" \$R1/u)
  assert.ok(macro.indexOf('MessageBox') < macro.indexOf('nsExec'), 'the question comes before the work')
  assert.ok(!/Abort|Quit/u.test(macro), 'nothing in it can stop the uninstall')
})

test('the headless run is always bounded', () => {
  assert.equal(headlessTimeoutMs(['--remove-integrations']), 60_000)
  assert.equal(headlessTimeoutMs(['--timeout=5000']), 5_000)
  assert.equal(headlessTimeoutMs(['--timeout=1']), 60_000, 'a nonsense limit is not a limit')
  assert.equal(headlessTimeoutMs(['--timeout=99999999']), 600_000)
})

test('exit codes and the report lines', () => {
  const clean = summarizeRemoval(
    [{ id: 'a', group: 'launcher', label: 'Studio launcher', path: '/p', status: 'removed' }],
    false,
  )
  assert.equal(removalExitCode(clean), 0)
  const failed = summarizeRemoval(
    [{ id: 'a', group: 'tailnet', label: 'Tailnet share', path: 'x', status: 'failed', reason: 'no' }],
    false,
  )
  assert.equal(removalExitCode(failed), 2)
  assert.equal(removalExitCode(null), 3)
  assert.deepEqual(formatRemovalReport(failed), [
    'failed\tTailnet share\tx\tno',
    'summary\tremoved=0 skipped=0 failed=1',
  ])
})

test('the renderer can only ask for the known options', () => {
  assert.deepEqual(sanitizeRemovalOptions({ deleteAppData: true, removeWorktrees: 'yes', extra: 1 }), {
    deleteAppData: true,
  })
  assert.deepEqual(sanitizeRemovalOptions({ hostId: 'wsl:Ubuntu-24.04' }), { hostId: 'wsl:Ubuntu-24.04' })
  assert.deepEqual(sanitizeRemovalOptions({ hostId: 'wsl:../../x' }), {})
  assert.deepEqual(sanitizeRemovalOptions(null), {})
})

test('the app-data deletion refuses the home folder, anything above it, and shallow paths', () => {
  assert.equal(isDeletableAppDataPath('/Users/dev/Library/Application Support/SprintEngine Studio', '/Users/dev'), true)
  assert.equal(isDeletableAppDataPath('/Users/dev', '/Users/dev'), false)
  assert.equal(isDeletableAppDataPath('/Users', '/Users/dev'), false)
  assert.equal(isDeletableAppDataPath('/', '/Users/dev'), false)
  assert.equal(isDeletableAppDataPath('/tmp/x', '/Users/dev'), false, 'two levels is too shallow to be sure')
  assert.equal(isDeletableAppDataPath('relative/a/b/c', '/Users/dev'), false)
})

test("the app's data is deleted by a process that waits for the app to exit, with paths never in the script text", () => {
  const posix = appDataDeletionCommand(4242, ["/Users/dev/Library/Application Support/it's"], 'darwin')
  assert.equal(posix.command, '/bin/sh')
  assert.ok(posix.args[1].startsWith('while kill -0 4242'))
  assert.ok(!posix.args[1].includes('Application Support'))
  assert.equal(posix.args.at(-1), "/Users/dev/Library/Application Support/it's")
  const windows = appDataDeletionCommand(7, ["C:\\Users\\dev\\AppData\\Roaming\\it's"], 'win32')
  assert.equal(windows.command, 'powershell.exe')
  assert.ok(windows.args.at(-1)?.includes("'C:\\Users\\dev\\AppData\\Roaming\\it''s'"))
  assert.ok(windows.args.at(-1)?.startsWith('Wait-Process -Id 7'))
})
