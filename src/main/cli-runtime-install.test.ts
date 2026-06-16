import assert from 'node:assert/strict'

import {
  buildExistsDescriptor,
  buildInstallDescriptor,
  buildProbeDescriptor,
  parseProbeOutput,
  resolveInstallPlatform,
} from './cli-runtime-install'

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

  console.log('cli-runtime-install: all assertions passed')
}

main()
