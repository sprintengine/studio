import { spawn } from 'child_process'

import type {
  AgentCli,
  CliDetectResult,
  CliInstallInput,
  CliInstallMethodInfo,
  CliInstallResult,
  CliRuntimeSettings,
} from '../shared/electron-api'
import type {
  PluginInstallMethod,
  PluginInstallPlatform,
  PluginManifest,
} from '../shared/plugin-manifest'
import { getPluginManifest } from './plugin-registry-instance'
import {
  currentRuntimeEnv,
  ensureManagedRuntimeShims,
  withManagedRuntimePath,
} from './managed-runtime'

// Exit code our probe scripts use to signal "binary not found on PATH" so we
// can distinguish a missing CLI from a CLI that exists but whose --version
// failed for some other reason.
const NOT_FOUND_EXIT = 3
const PATH_SENTINEL = 'MULTICODE_PATH:'

export type SpawnDescriptor = { file: string; args: string[] }
type RunOutcome = { code: number; stdout: string; stderr: string }

// Maps the OS platform + per-CLI WSL override onto the manifest install bucket.
// WSL is a logical target (Windows host, POSIX guest) distinct from win32.
export function resolveInstallPlatform(
  platform: NodeJS.Platform,
  useWsl: boolean,
): PluginInstallPlatform {
  if (platform === 'win32') return useWsl ? 'wsl' : 'win32'
  if (platform === 'darwin') return 'darwin'
  // Treat any other POSIX-like platform (linux, and uncommon ones) as linux.
  return 'linux'
}

function isPosixTarget(target: PluginInstallPlatform): boolean {
  return target === 'darwin' || target === 'linux' || target === 'wsl'
}

function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function powerShellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// Wraps a shell snippet in the right host shell for the target. POSIX targets
// run through a login shell so user-local install dirs (~/.local/bin, npm
// global prefix) are on PATH; WSL routes through wsl.exe.
function shellDescriptorForScript(
  target: PluginInstallPlatform,
  script: string,
): SpawnDescriptor {
  if (target === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    }
  }
  if (target === 'wsl') {
    return { file: 'wsl.exe', args: ['-e', 'bash', '-lc', script] }
  }
  return { file: 'bash', args: ['-lc', script] }
}

// Builds a script that prints the resolved path and version, or exits
// NOT_FOUND_EXIT when the binary is not on PATH.
export function buildProbeDescriptor(input: {
  binary: string
  versionArgs: string[]
  target: PluginInstallPlatform
}): SpawnDescriptor {
  const { binary, versionArgs, target } = input
  if (isPosixTarget(target)) {
    const bin = posixSingleQuote(binary)
    const versionPart = versionArgs.map(posixSingleQuote).join(' ')
    const script = [
      `command -v ${bin} >/dev/null 2>&1 || exit ${NOT_FOUND_EXIT}`,
      `printf '${PATH_SENTINEL}%s\\n' "$(command -v ${bin})"`,
      `${bin} ${versionPart} 2>&1 || true`,
    ].join('\n')
    return shellDescriptorForScript(target, script)
  }
  const bin = powerShellSingleQuote(binary)
  const versionPart = versionArgs.map(powerShellSingleQuote).join(' ')
  const script = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$c = Get-Command ${bin}`,
    `if (-not $c) { exit ${NOT_FOUND_EXIT} }`,
    `'${PATH_SENTINEL}' + $c.Source`,
    `& ${bin} ${versionPart} 2>&1`,
  ].join('\n')
  return shellDescriptorForScript(target, script)
}

// Builds a script that exits NOT_FOUND_EXIT when a prerequisite binary (npm,
// brew, curl, …) is absent, without invoking it.
export function buildExistsDescriptor(input: {
  binary: string
  target: PluginInstallPlatform
}): SpawnDescriptor {
  const { binary, target } = input
  if (isPosixTarget(target)) {
    const bin = posixSingleQuote(binary)
    return shellDescriptorForScript(target, `command -v ${bin} >/dev/null 2>&1 || exit ${NOT_FOUND_EXIT}`)
  }
  const bin = powerShellSingleQuote(binary)
  return shellDescriptorForScript(
    target,
    `if (-not (Get-Command ${bin} -ErrorAction SilentlyContinue)) { exit ${NOT_FOUND_EXIT} }`,
  )
}

// Builds the descriptor that runs an install method's command verbatim in the
// target shell.
export function buildInstallDescriptor(input: {
  shell: string
  target: PluginInstallPlatform
}): SpawnDescriptor {
  return shellDescriptorForScript(input.target, input.shell)
}

export function parseProbeOutput(
  code: number,
  stdout: string,
): { installed: boolean; version: string | null; resolvedPath: string | null } {
  if (code === NOT_FOUND_EXIT) {
    return { installed: false, version: null, resolvedPath: null }
  }
  let resolvedPath: string | null = null
  const versionLines: string[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith(PATH_SENTINEL)) {
      resolvedPath = line.slice(PATH_SENTINEL.length).trim() || null
      continue
    }
    versionLines.push(line)
  }
  // First non-path line that carries a version-looking token, else the first
  // line, else null.
  const version =
    versionLines.find((line) => /\d+\.\d+/.test(line)) ?? versionLines[0] ?? null
  return { installed: true, version, resolvedPath }
}

function runDescriptor(
  desc: SpawnDescriptor,
  onData?: (chunk: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(desc.file, desc.args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      onData?.(text)
    })
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      onData?.(text)
    })
    child.on('error', (error) => {
      resolve({ code: 1, stdout, stderr: stderr + (error.message ?? String(error)) })
    })
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

function resolveBinary(manifest: PluginManifest, runtime?: Partial<CliRuntimeSettings>): string {
  const override = typeof runtime?.command === 'string' ? runtime.command.trim() : ''
  return override || manifest.binary
}

// Builds the environment used to run install commands (and the post-install
// re-detect): the managed `node`/`npm` shims and the writable npm prefix bin
// are prepended to PATH so npm-based installs (e.g. Codex) work with no user
// Node, and the freshly installed binary is discoverable on the next probe.
// Returns null when no managed runtime is vendored, so callers fall back to the
// user's own PATH unchanged.
function managedInstallEnv(): Record<string, string> | null {
  const runtimeEnv = currentRuntimeEnv()
  const shims = ensureManagedRuntimeShims(runtimeEnv)
  if (!shims) return null
  const base = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  const withShims = withManagedRuntimePath(base, shims.shimDir, runtimeEnv.platform)
  return withManagedRuntimePath(withShims, shims.prefixBinDir, runtimeEnv.platform)
}

export async function detectCli(
  cli: AgentCli,
  runtime?: Partial<CliRuntimeSettings>,
  env?: NodeJS.ProcessEnv,
): Promise<CliDetectResult> {
  const manifest = getPluginManifest(cli)
  const useWsl = runtime?.useWsl ?? false
  if (!manifest) {
    return {
      cli,
      binary: cli,
      installed: false,
      version: null,
      resolvedPath: null,
      useWsl,
      error: `No plugin manifest found for "${cli}".`,
    }
  }
  const binary = resolveBinary(manifest, runtime)
  const target = resolveInstallPlatform(process.platform, useWsl)
  const versionArgs = manifest.detect?.versionArgs ?? ['--version']
  try {
    const outcome = await runDescriptor(buildProbeDescriptor({ binary, versionArgs, target }), undefined, env)
    const parsed = parseProbeOutput(outcome.code, outcome.stdout)
    return {
      cli,
      binary,
      installed: parsed.installed,
      version: parsed.version,
      resolvedPath: parsed.resolvedPath,
      useWsl,
      error: null,
    }
  } catch (error) {
    return {
      cli,
      binary,
      installed: false,
      version: null,
      resolvedPath: null,
      useWsl,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function prerequisiteAvailable(
  requires: string,
  target: PluginInstallPlatform,
): Promise<boolean> {
  try {
    const outcome = await runDescriptor(buildExistsDescriptor({ binary: requires, target }))
    return outcome.code !== NOT_FOUND_EXIT
  } catch {
    return false
  }
}

function selectInstallMethods(
  manifest: PluginManifest,
  target: PluginInstallPlatform,
): PluginInstallMethod[] {
  return manifest.install?.[target] ?? []
}

export async function cliInstallMethods(
  cli: AgentCli,
  runtime?: Partial<CliRuntimeSettings>,
): Promise<CliInstallMethodInfo[]> {
  const manifest = getPluginManifest(cli)
  if (!manifest) return []
  const useWsl = runtime?.useWsl ?? false
  const target = resolveInstallPlatform(process.platform, useWsl)
  const methods = selectInstallMethods(manifest, target)
  const infos = await Promise.all(
    methods.map(async (method): Promise<CliInstallMethodInfo> => {
      const available = method.requires
        ? await prerequisiteAvailable(method.requires, target)
        : true
      return {
        id: method.id,
        label: method.label,
        available,
        unavailableReason:
          available || !method.requires ? null : `Requires "${method.requires}" on PATH`,
        recommended: method.recommended ?? false,
        commandPreview: method.shell,
        platform: target,
      }
    }),
  )
  return infos
}

export async function installCli(
  input: CliInstallInput,
  runtime: Partial<CliRuntimeSettings> | undefined,
  onData?: (chunk: string) => void,
): Promise<CliInstallResult> {
  const manifest = getPluginManifest(input.cli)
  const useWsl = runtime?.useWsl ?? false
  if (!manifest) {
    return {
      ok: false,
      cli: input.cli,
      installed: false,
      version: null,
      resolvedPath: null,
      log: '',
      error: `No plugin manifest found for "${input.cli}".`,
    }
  }
  const target = resolveInstallPlatform(process.platform, useWsl)
  const method = selectInstallMethods(manifest, target).find((entry) => entry.id === input.methodId)
  if (!method) {
    return {
      ok: false,
      cli: input.cli,
      installed: false,
      version: null,
      resolvedPath: null,
      log: '',
      error: `No install method "${input.methodId}" for ${input.cli} on ${target}.`,
    }
  }

  const banner = `$ ${method.shell}\n`
  onData?.(banner)
  let log = banner
  const capture = (chunk: string): void => {
    log += chunk
    onData?.(chunk)
  }

  // Run the install (and the re-detect below) with the managed node/npm on
  // PATH so npm-based installers work without a user Node and the resulting
  // binary is discoverable. Falls back to the user's PATH when no managed
  // runtime is vendored.
  const installEnv = managedInstallEnv() ?? undefined

  let runError: string | null = null
  try {
    const outcome = await runDescriptor(
      buildInstallDescriptor({ shell: method.shell, target }),
      capture,
      installEnv,
    )
    if (outcome.code !== 0) {
      runError = `Install command exited with code ${outcome.code}.`
    }
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error)
  }

  // Re-detect regardless of exit code: some installers report a non-zero exit
  // while still placing the binary (e.g. PATH advisories).
  const detected = await detectCli(input.cli, runtime, installEnv)
  const ok = detected.installed && runError === null
  return {
    ok,
    cli: input.cli,
    installed: detected.installed,
    version: detected.version,
    resolvedPath: detected.resolvedPath,
    log,
    error: ok ? null : (runError ?? (detected.installed ? null : 'CLI not found on PATH after install.')),
  }
}
