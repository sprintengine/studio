import assert from 'node:assert/strict'

import type { PluginManifest } from '../shared/plugin-manifest'
import {
  chooseCliUpdateCommand,
  clearNpmLatestCache,
  deriveCliVersionStatus,
  fetchNpmLatestVersion,
  isHomebrewPath,
  outdatedClis,
  resolveCliVersionAdvisories,
} from './cli-version-advisory'

const manifest = (over: Partial<PluginManifest>): PluginManifest =>
  ({ id: 'codex', displayName: 'Codex', binary: 'codex', version: 1, ...over }) as PluginManifest

async function main(): Promise<void> {
  // Status: loose compare, unknown when either side has no version.
  assert.equal(deriveCliVersionStatus('codex-cli 0.153.2', '0.153.3'), 'behind_latest')
  assert.equal(deriveCliVersionStatus('2.1.261 (Claude Code)', '2.1.261'), 'current')
  assert.equal(deriveCliVersionStatus('2.1.262', '2.1.261'), 'current')
  assert.equal(deriveCliVersionStatus(null, '1.0.0'), 'unknown')
  assert.equal(deriveCliVersionStatus('1.0.0', null), 'unknown')
  assert.equal(deriveCliVersionStatus('grok 1.0.13 (5e9a58528b76) [stable]', '1.0.13'), 'current')

  // Homebrew detection by path.
  assert.equal(isHomebrewPath('/opt/homebrew/bin/codex'), true)
  assert.equal(isHomebrewPath('/opt/homebrew/Cellar/codex/0.153.2/bin/codex'), true)
  assert.equal(isHomebrewPath('/usr/local/Cellar/opencode/1.18.27/bin/opencode'), true)
  assert.equal(isHomebrewPath('/Users/me/.npm-global/bin/codex'), false)
  assert.equal(isHomebrewPath('/Users/me/.local/bin/claude'), false)
  assert.equal(isHomebrewPath(null), false)

  // The update command, in precedence order: the CLI's own updater, then
  // Homebrew, then npm.
  assert.deepEqual(
    chooseCliUpdateCommand({ manifest: manifest({ binary: 'claude', update: { args: ['update'] }, package: { npm: '@anthropic-ai/claude-code', brew: 'claude-code' } }), resolvedPath: '/opt/homebrew/bin/claude' }),
    { kind: 'cli-updater', command: 'claude update' },
    "the CLI's own updater wins even under Homebrew",
  )
  assert.deepEqual(
    chooseCliUpdateCommand({ manifest: manifest({ package: { npm: '@openai/codex', brew: 'codex' } }), resolvedPath: '/opt/homebrew/bin/codex' }),
    { kind: 'brew', command: 'brew upgrade codex' },
  )
  assert.deepEqual(
    chooseCliUpdateCommand({ manifest: manifest({ package: { npm: '@openai/codex', brew: 'codex' } }), resolvedPath: '/Users/me/.nvm/versions/node/v22/bin/codex' }),
    { kind: 'npm', command: 'npm install -g @openai/codex@latest' },
  )
  assert.deepEqual(
    chooseCliUpdateCommand({ manifest: manifest({ package: { brew: 'codex' } }), resolvedPath: '/usr/bin/codex' }),
    null,
    'a formula alone helps only when the binary is under Homebrew',
  )
  assert.equal(chooseCliUpdateCommand({ manifest: manifest({}), resolvedPath: '/usr/bin/codex' }), null)

  // npm latest: parsed, cached for an hour (misses too), force bypasses.
  clearNpmLatestCache()
  let calls = 0
  let clock = Date.parse('2026-09-04T12:00:00Z')
  const fetcher = async (url: string): Promise<Response> => {
    calls += 1
    assert.equal(url, 'https://registry.npmjs.org/%40openai%2Fcodex/latest')
    return new Response(JSON.stringify({ version: '0.153.3' }), { status: 200 })
  }
  const deps = { fetcher, now: () => clock }
  assert.equal(await fetchNpmLatestVersion('@openai/codex', deps), '0.153.3')
  assert.equal(await fetchNpmLatestVersion('@openai/codex', deps), '0.153.3')
  assert.equal(calls, 1, 'second read inside the hour is cached')
  clock += 61 * 60 * 1000
  await fetchNpmLatestVersion('@openai/codex', deps)
  assert.equal(calls, 2, 'after the hour it asks again')
  await fetchNpmLatestVersion('@openai/codex', { ...deps, force: true })
  assert.equal(calls, 3, 'force bypasses the cache')

  clearNpmLatestCache()
  let missCalls = 0
  const missing = async (): Promise<Response> => {
    missCalls += 1
    return new Response('{}', { status: 404 })
  }
  assert.equal(await fetchNpmLatestVersion('@xai/grok-cli', { fetcher: missing, now: () => clock }), null)
  assert.equal(await fetchNpmLatestVersion('@xai/grok-cli', { fetcher: missing, now: () => clock }), null)
  assert.equal(missCalls, 1, 'a miss is cached as well')
  const throwing = async (): Promise<Response> => {
    throw new Error('ENOTFOUND')
  }
  clearNpmLatestCache()
  assert.equal(await fetchNpmLatestVersion('@openai/codex', { fetcher: throwing, now: () => clock }), null, 'a network error is unknown, not a throw')

  // Advisories over an availability map.
  const manifests: Record<string, PluginManifest> = {
    codex: manifest({ package: { npm: '@openai/codex', brew: 'codex' } }),
    'claude-code': manifest({ id: 'claude-code', displayName: 'Claude Code', binary: 'claude', update: { args: ['update'] }, package: { npm: '@anthropic-ai/claude-code', brew: 'claude-code' } }),
    cursor: manifest({ id: 'cursor', displayName: 'Cursor', binary: 'cursor-agent' }),
  }
  const latest: Record<string, string | null> = { '@openai/codex': '0.153.3', '@anthropic-ai/claude-code': '2.1.261' }
  const asked: string[] = []
  const advisories = await resolveCliVersionAdvisories(
    {
      codex: { cli: 'codex', installed: true, resolvedPath: '/opt/homebrew/bin/codex', version: 'codex-cli 0.153.2' },
      'claude-code': { cli: 'claude-code', installed: true, resolvedPath: '/Users/me/.local/bin/claude', version: '2.1.261 (Claude Code)' },
      cursor: { cli: 'cursor', installed: true, resolvedPath: '/Users/me/.local/bin/cursor-agent', version: '2026.09.01' },
      grok: { cli: 'grok', installed: false, resolvedPath: null, version: null },
    },
    {
      getManifest: (cli) => manifests[cli] ?? null,
      fetchLatest: async (pkg) => {
        asked.push(pkg)
        return latest[pkg] ?? null
      },
      now: () => new Date('2026-09-04T12:00:00Z'),
    },
  )
  assert.deepEqual(asked.sort(), ['@anthropic-ai/claude-code', '@openai/codex'], 'only installed CLIs with an npm package are asked')
  assert.equal(advisories.codex?.status, 'behind_latest')
  assert.equal(advisories.codex?.latestVersion, '0.153.3')
  assert.deepEqual(advisories.codex?.updateCommand, { kind: 'brew', command: 'brew upgrade codex' })
  assert.equal(advisories['claude-code']?.status, 'current')
  assert.equal(advisories.cursor?.status, 'unknown')
  assert.equal(advisories.cursor?.updateCommand, null)
  assert.equal(advisories.grok?.status, 'unknown', 'a CLI that is not installed is never behind')
  assert.deepEqual(outdatedClis(advisories).map((entry) => entry.cli), ['codex'])

  console.log('cli-version-advisory: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
