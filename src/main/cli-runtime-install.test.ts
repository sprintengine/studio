import assert from 'node:assert/strict'

import {
  binaryVersionProbeFrom,
  buildExistsDescriptor,
  buildInstallDescriptor,
  buildProbeDescriptor,
  buildUserShellProbeDescriptor,
  parseProbeOutput,
  resolveInstallPlatform,
} from './cli-runtime-install'

// The exit code the probe scripts use for "binary not found on PATH".
const NOT_FOUND_CODE = 3

function main(): void {
  // resolveInstallPlatform: WSL only when on Windows with the override on.
  assert.equal(resolveInstallPlatform('darwin', false), 'darwin')
  assert.equal(resolveInstallPlatform('linux', false), 'linux')
  assert.equal(resolveInstallPlatform('win32', false), 'win32')
  assert.equal(resolveInstallPlatform('win32', true), 'wsl')
  assert.equal(resolveInstallPlatform('darwin', true), 'darwin')
  // Unknown POSIX-like platforms fall back to linux.
  assert.equal(resolveInstallPlatform('freebsd' as NodeJS.Platform, false), 'linux')

  // POSIX probe runs through a login bash and guards on `command -v`.
  const posixProbe = buildProbeDescriptor({ binary: 'claude', versionArgs: ['--version'], target: 'linux' })
  assert.equal(posixProbe.file, 'bash')
  assert.deepEqual(posixProbe.args.slice(0, 1), ['-lc'])
  assert.match(posixProbe.args[1], /command -v 'claude'/)
  assert.match(posixProbe.args[1], /'claude' '--version' 2>&1 \|\| true/)
  assert.match(posixProbe.args[1], /exit 3/)

  // WSL probe is routed through wsl.exe + bash.
  const wslProbe = buildProbeDescriptor({ binary: 'claude', versionArgs: ['--version'], target: 'wsl' })
  assert.equal(wslProbe.file, 'wsl.exe')
  assert.deepEqual(wslProbe.args.slice(0, 3), ['-e', 'bash', '-lc'])

  // Windows probe is PowerShell + Get-Command.
  const winProbe = buildProbeDescriptor({ binary: 'claude', versionArgs: ['--version'], target: 'win32' })
  assert.equal(winProbe.file, 'powershell.exe')
  assert.match(winProbe.args.join(' '), /Get-Command 'claude'/)
  assert.match(winProbe.args.join(' '), /exit 3/)

  // Exists descriptor never invokes the binary, only resolves it.
  const posixExists = buildExistsDescriptor({ binary: 'npm', target: 'linux' })
  assert.match(posixExists.args[1], /command -v 'npm' >\/dev\/null 2>&1 \|\| exit 3/)
  const winExists = buildExistsDescriptor({ binary: 'npm', target: 'win32' })
  assert.match(winExists.args.join(' '), /Get-Command 'npm' -ErrorAction SilentlyContinue/)

  // Install descriptor passes the command verbatim into the host shell.
  const posixInstall = buildInstallDescriptor({ shell: 'curl -fsSL https://example/install.sh | bash', target: 'darwin' })
  assert.equal(posixInstall.file, 'bash')
  assert.equal(posixInstall.args[0], '-lc')
  assert.equal(posixInstall.args[1], 'curl -fsSL https://example/install.sh | bash')
  const winInstall = buildInstallDescriptor({ shell: 'irm https://example/install.ps1 | iex', target: 'win32' })
  assert.equal(winInstall.file, 'powershell.exe')
  assert.equal(winInstall.args.at(-1), 'irm https://example/install.ps1 | iex')

  // Single quotes in a binary path are escaped for POSIX.
  const quoted = buildProbeDescriptor({ binary: "/o'dd/claude", versionArgs: [], target: 'linux' })
  assert.match(quoted.args[1], /'\/o'\\''dd\/claude'/)

  // parseProbeOutput: not-found exit short-circuits.
  assert.deepEqual(parseProbeOutput(3, ''), { installed: false, version: null, resolvedPath: null })

  // parseProbeOutput pulls the path sentinel and the first version-looking line.
  const parsed = parseProbeOutput(0, 'MULTICODE_PATH:/usr/local/bin/claude\nclaude 1.4.2 (build 99)\n')
  assert.equal(parsed.installed, true)
  assert.equal(parsed.resolvedPath, '/usr/local/bin/claude')
  assert.equal(parsed.version, 'claude 1.4.2 (build 99)')

  // Installed but version line missing a number still counts as installed.
  const noVersion = parseProbeOutput(0, 'MULTICODE_PATH:/usr/local/bin/codex\n')
  assert.equal(noVersion.installed, true)
  assert.equal(noVersion.resolvedPath, '/usr/local/bin/codex')
  assert.equal(noVersion.version, null)

  // User-shell fallback probe: consults the user's own zsh/bash as an
  // interactive login shell (terminal parity — PTYs source the same config),
  // and only for POSIX-syntax shells on the host platform.
  const zshFallback = buildUserShellProbeDescriptor({
    binary: 'claude',
    versionArgs: ['--version'],
    target: 'darwin',
    shell: '/bin/zsh',
  })
  assert.ok(zshFallback)
  assert.equal(zshFallback.file, '/bin/zsh')
  assert.equal(zshFallback.args[0], '-ilc')
  assert.match(zshFallback.args[1], /command -v 'claude'/)
  assert.match(zshFallback.args[1], /exit 3/)
  // Interactive shells resolve aliases/functions too; only an absolute
  // executable path may be reported (alias text cannot be spawned headlessly).
  assert.match(zshFallback.args[1], /case "\$p" in \/\*\)/)
  assert.match(zshFallback.args[1], /\[ -x "\$p" \]/)
  const bashFallback = buildUserShellProbeDescriptor({
    binary: 'claude',
    versionArgs: [],
    target: 'linux',
    shell: '/usr/bin/bash',
  })
  assert.equal(bashFallback?.file, '/usr/bin/bash')
  // fish would misparse the POSIX script; Windows/WSL have no user shell to
  // consult; a missing $SHELL yields no fallback.
  assert.equal(buildUserShellProbeDescriptor({ binary: 'claude', versionArgs: [], target: 'darwin', shell: '/usr/bin/fish' }), null)
  assert.equal(buildUserShellProbeDescriptor({ binary: 'claude', versionArgs: [], target: 'win32', shell: '/bin/zsh' }), null)
  assert.equal(buildUserShellProbeDescriptor({ binary: 'claude', versionArgs: [], target: 'wsl', shell: '/bin/zsh' }), null)
  assert.equal(buildUserShellProbeDescriptor({ binary: 'claude', versionArgs: [], target: 'darwin', shell: undefined }), null)
  assert.equal(buildUserShellProbeDescriptor({ binary: 'claude', versionArgs: [], target: 'darwin', shell: '  ' }), null)

  // Unmanaged-binary probe (git/gh): the three outcomes stay distinct. Versions
  // below are synthetic fixtures; real ones only ever come from a real probe.
  assert.deepEqual(
    binaryVersionProbeFrom({
      parsed: parseProbeOutput(0, 'MULTICODE_PATH:/usr/bin/git\ngit version 0.0.0-fixture\n'),
      inconclusive: false,
    }),
    { outcome: 'resolved', version: 'git version 0.0.0-fixture', resolvedPath: '/usr/bin/git' },
  )
  // A binary that is genuinely absent: a definitive verdict.
  assert.deepEqual(
    binaryVersionProbeFrom({ parsed: parseProbeOutput(NOT_FOUND_CODE, ''), inconclusive: false }),
    { outcome: 'not_installed' },
  )
  // A probe killed at its deadline parses as absent, but that is a non-answer:
  // it must never read as a missing binary.
  assert.deepEqual(
    binaryVersionProbeFrom({ parsed: parseProbeOutput(NOT_FOUND_CODE, ''), inconclusive: true }),
    { outcome: 'probe_failed' },
  )
  // Resolves on PATH but prints no version line: ran, told us nothing usable.
  assert.deepEqual(
    binaryVersionProbeFrom({ parsed: parseProbeOutput(0, 'MULTICODE_PATH:/usr/bin/true\n'), inconclusive: false }),
    { outcome: 'probe_failed' },
  )

  console.log('cli-runtime-install: all assertions passed')
}

main()
