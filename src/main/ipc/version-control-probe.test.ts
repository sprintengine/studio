import assert from 'node:assert/strict'

import type { BinaryVersionProbe } from '../cli-runtime-install'
import { parseGhAuthLogin, probeVersionControlProviders, type VersionControlProbeDeps } from './version-control-probe'
import { test } from 'vitest'

test('version-control-probe', async () => {
  // Version strings here are synthetic fixtures for the mapping under test; the
  // product never carries a version literal — real ones come from probeBinaryVersion.
  const GIT_VERSION_FIXTURE = 'git version 0.0.0-fixture'
  const GH_VERSION_FIXTURE = 'gh version 0.0.0-fixture'

  function deps(input: {
    probes: Record<string, BinaryVersionProbe>
    login?: string | null
    onLoginRead?: () => void
  }): VersionControlProbeDeps {
    return {
      probeVersion: async (binary) => input.probes[binary],
      readGhLogin: async () => {
        input.onLoginRead?.()
        return input.login ?? null
      },
    }
  }

  async function main(): Promise<void> {
    // Resolved with auth: gh carries the login its own auth resolves to.
    const withAuth = await probeVersionControlProviders(
      deps({
        probes: {
          git: { outcome: 'resolved', version: GIT_VERSION_FIXTURE, resolvedPath: '/usr/bin/git' },
          gh: { outcome: 'resolved', version: GH_VERSION_FIXTURE, resolvedPath: '/opt/homebrew/bin/gh' },
        },
        login: 'octocat',
      }),
    )
    assert.deepEqual(withAuth, [
      { id: 'git', resolved: true, version: GIT_VERSION_FIXTURE },
      { id: 'gh', resolved: true, version: GH_VERSION_FIXTURE, auth: { login: 'octocat' } },
    ])
    // Exactly the providers the product integrates — no row for anything else.
    assert.deepEqual(
      withAuth.map((provider) => provider.id),
      ['git', 'gh'],
    )

    // Resolved without auth: an installed but unauthenticated gh omits `auth`
    // rather than carrying an empty login.
    let loginReads = 0
    const withoutAuth = await probeVersionControlProviders(
      deps({
        probes: {
          git: { outcome: 'resolved', version: GIT_VERSION_FIXTURE, resolvedPath: '/usr/bin/git' },
          gh: { outcome: 'resolved', version: GH_VERSION_FIXTURE, resolvedPath: '/opt/homebrew/bin/gh' },
        },
        login: null,
        onLoginRead: () => {
          loginReads += 1
        },
      }),
    )
    assert.deepEqual(withoutAuth, [
      { id: 'git', resolved: true, version: GIT_VERSION_FIXTURE },
      { id: 'gh', resolved: true, version: GH_VERSION_FIXTURE },
    ])
    assert.equal(loginReads, 1, 'auth is read only for the provider that has auth')

    // Not installed: a definitive verdict, per provider, with no version field.
    const notInstalled = await probeVersionControlProviders(
      deps({
        probes: {
          git: { outcome: 'resolved', version: GIT_VERSION_FIXTURE, resolvedPath: '/usr/bin/git' },
          gh: { outcome: 'not_installed' },
        },
      }),
    )
    assert.deepEqual(notInstalled, [
      { id: 'git', resolved: true, version: GIT_VERSION_FIXTURE },
      { id: 'gh', resolved: false, reason: 'not_installed' },
    ])

    // Probe failed: a probe that could not answer never reads as installed and
    // never reads as missing.
    const probeFailed = await probeVersionControlProviders(
      deps({ probes: { git: { outcome: 'probe_failed' }, gh: { outcome: 'probe_failed' } }, login: 'octocat' }),
    )
    assert.deepEqual(probeFailed, [
      { id: 'git', resolved: false, reason: 'probe_failed' },
      { id: 'gh', resolved: false, reason: 'probe_failed' },
    ])

    // gh auth login parsing: both report wordings gh has shipped, indented and
    // with the status glyph, and the failure text carries no login.
    assert.equal(
      parseGhAuthLogin('github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Active account: true\n'),
      'octocat',
    )
    assert.equal(parseGhAuthLogin('  ✓ Logged in to github.com as octocat (oauth_token)\n'), 'octocat')
    assert.equal(parseGhAuthLogin('  ✓ Logged in to ghe.example.com account octo-corp (keyring)\n'), 'octo-corp')
    assert.equal(parseGhAuthLogin('You are not logged into any GitHub hosts. To log in, run: gh auth login\n'), null)
    assert.equal(parseGhAuthLogin(''), null)

    console.log('version-control-probe: all assertions passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})

test('each WSL machine gets its own git row, after this machine and the forge', async () => {
  const probes = await probeVersionControlProviders({
    probeVersion: async (binary) =>
      binary === 'git'
        ? { outcome: 'resolved', version: 'git version 0.0.0-win', resolvedPath: 'C:/Program Files/Git/cmd/git.exe' }
        : { outcome: 'not_installed' },
    readGhLogin: async () => null,
    listGitMachines: async () => [
      {
        hostId: 'wsl:Ubuntu',
        label: 'WSL: Ubuntu',
        probeGit: async () => ({ outcome: 'resolved', version: 'git version 0.0.0-linux', resolvedPath: null }),
      },
      { hostId: 'wsl:Debian', label: 'WSL: Debian', probeGit: async () => ({ outcome: 'not_installed' }) },
      {
        hostId: 'wsl:Broken',
        label: 'WSL: Broken',
        probeGit: async () => {
          throw new Error('wsl.exe exited')
        },
      },
    ],
  })
  assert.deepEqual(probes, [
    { id: 'git', resolved: true, version: 'git version 0.0.0-win' },
    { id: 'gh', resolved: false, reason: 'not_installed' },
    {
      id: 'git',
      resolved: true,
      version: 'git version 0.0.0-linux',
      machine: { hostId: 'wsl:Ubuntu', label: 'WSL: Ubuntu' },
    },
    { id: 'git', resolved: false, reason: 'not_installed', machine: { hostId: 'wsl:Debian', label: 'WSL: Debian' } },
    { id: 'git', resolved: false, reason: 'probe_failed', machine: { hostId: 'wsl:Broken', label: 'WSL: Broken' } },
  ])
})
