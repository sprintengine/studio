import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { dirname, delimiter, join, resolve } from 'path'

type CliTool = {
  name: 'sprintengine' | 'souls'
}

export type CliInstallResult = {
  ok: boolean
  binDir: string
  installed: string[]
  errors: string[]
}

const CLI_TOOLS: CliTool[] = [
  { name: 'sprintengine' },
  { name: 'souls' },
]

function getMulticodeCliBinDir(): string {
  const configured = process.env['MULTICODE_CLI_BIN']
  if (configured && configured.trim()) return resolve(configured)
  if (process.platform === 'win32') {
    return resolve(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'Multicode', 'bin')
  }
  return resolve(homedir(), '.multicode', 'bin')
}

export function withMulticodeCliPath(env: Record<string, string>): Record<string, string> {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? (process.platform === 'win32' ? 'Path' : 'PATH')
  const binDir = getMulticodeCliBinDir()
  const current = env[pathKey] ?? ''
  const entries = current.split(delimiter).filter(Boolean)
  if (entries.includes(binDir)) return env
  return {
    ...env,
    [pathKey]: [binDir, ...entries].join(delimiter),
  }
}

export function installMulticodeCliTools(): CliInstallResult {
  const binDir = getMulticodeCliBinDir()
  const installed: string[] = []
  const errors: string[] = []
  try {
    mkdirSync(binDir, { recursive: true })
  } catch (error) {
    return {
      ok: false,
      binDir,
      installed,
      errors: [`Unable to create Multicode CLI bin directory: ${messageForError(error)}`],
    }
  }

  for (const tool of CLI_TOOLS) {
    try {
      const posixSource = resolveToolScript(tool.name, false)
      const cmdSource = resolveToolScript(tool.name, true)
      if (process.platform === 'win32') {
        const target = join(binDir, `${tool.name}.cmd`)
        writeFileSync(
          target,
          [
            '@echo off',
            `"${cmdSource}" %*`,
            '',
          ].join('\r\n'),
          'utf8'
        )
        installed.push(target)
      } else {
        const target = join(binDir, tool.name)
        writeFileSync(
          target,
          [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            `exec ${quotePosix(posixSource)} "$@"`,
            '',
          ].join('\n'),
          { encoding: 'utf8', mode: 0o755 }
        )
        chmodSync(target, 0o755)
        installed.push(target)
      }
    } catch (error) {
      errors.push(`${tool.name}: ${messageForError(error)}`)
    }
  }

  return {
    ok: errors.length === 0,
    binDir,
    installed,
    errors,
  }
}

function resolveToolScript(name: string, windows: boolean): string {
  const override = process.env[`MULTICODE_${name.toUpperCase()}_CLI${windows ? '_CMD' : ''}`]
  if (override && override.trim()) return resolve(override)

  const filename = windows ? `${name}.cmd` : name
  for (const root of candidateToolRoots()) {
    const candidate = join(root, 'scripts', filename)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`could not find scripts/${filename}`)
}

function candidateToolRoots(): string[] {
  const starts = [
    process.resourcesPath,
    process.env['APPDIR'],
    process.env['MULTICODE_TOOL_ROOT'],
    __dirname,
    process.cwd(),
  ].filter(Boolean) as string[]

  const roots: string[] = []
  for (const start of starts) {
    let current = resolve(start)
    for (;;) {
      if (!isAsarPath(current) && existsSync(join(current, 'scripts')) && looksLikeMulticodeToolRoot(current)) roots.push(current)
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return Array.from(new Set(roots))
}

function isAsarPath(pathValue: string): boolean {
  return pathValue.split(/[\\/]/).some((part) => part.endsWith('.asar'))
}

function looksLikeMulticodeToolRoot(root: string): boolean {
  return existsSync(join(root, 'sprintengine_core'))
    || existsSync(join(root, 'souls'))
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
