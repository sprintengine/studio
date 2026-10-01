// The pieces around the removal: what the Windows uninstaller runs (and, on an
// update, does not), and what the command line reports.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'vitest'

import { removalExitCode, summarizeRemoval } from '../../shared/integration-removal'
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
  const clean = summarizeRemoval([
    { id: 'a', group: 'launcher', label: 'Studio launcher', path: '/p', status: 'removed' },
  ])
  assert.equal(removalExitCode(clean), 0)
  const failed = summarizeRemoval([
    { id: 'a', group: 'tailnet', label: 'Tailnet share', path: 'x', status: 'failed', reason: 'no' },
  ])
  assert.equal(removalExitCode(failed), 2)
  assert.equal(removalExitCode(null), 3)
  assert.deepEqual(formatRemovalReport(failed), [
    'failed\tTailnet share\tx\tno',
    'summary\tremoved=0 skipped=0 failed=1',
  ])
})
