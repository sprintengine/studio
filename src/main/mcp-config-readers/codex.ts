// `codex` format: TOML with one `[mcp_servers.<id>]` table per server.
//
// Deliberately not a TOML dependency: the only thing anyone needs out of a
// codex config here is those tables and their scalar/array/inline-table values,
// and a full TOML parser would buy nothing but a larger parse surface for
// third-party bytes. Unbalanced or unterminated values throw, which the file
// reader turns into `malformed` rather than silently dropping a server.

import { createFileMcpConfigReader, type McpConfigReader, type RawMcpServer } from './reader'
import { stringArray, stringRecord, stringValue } from './values'

import type { McpTransport } from '../../shared/electron-api'

export function parseCodexMcpServers(raw: string): RawMcpServer[] {
  const sections = parseCodexConfigTables(raw, 'mcp_servers')
  const servers: RawMcpServer[] = []
  for (const [id, config] of Object.entries(sections)) {
    if (!id) continue
    const url = stringValue(config.url)
    const command = stringValue(config.command)
    const transport: McpTransport = url ? 'http' : 'stdio'
    if (transport === 'stdio' && !command) continue
    const bearer = stringValue(config.bearer_token_env_var)
    const envVarNames = [...stringArray(config.env_vars), ...(bearer ? [bearer] : [])]
    servers.push({
      id,
      name: id,
      transport,
      command,
      args: stringArray(config.args),
      url,
      env: stringRecord(config.env),
      headers: stringRecord(config.http_headers),
      envVarNames,
      enabled: config.enabled === false ? false : true,
    })
  }
  return servers
}

export const codexMcpReader: McpConfigReader = createFileMcpConfigReader('codex', parseCodexMcpServers)

export function parseCodexConfigTables(
  raw: string,
  table: 'mcp_servers' | 'plugins' | 'skills',
): Record<string, Record<string, unknown>> {
  const sections: Record<string, Record<string, unknown>> = {}
  let current: Record<string, unknown> | null = null
  const lines = raw.split(/\r?\n/)

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = stripTomlComment(lines[lineIndex]!).trim()
    if (!line) continue

    const section = line.match(new RegExp(`^\\[\\s*${table}\\s*(?:\\.\\s*(.+?)\\s*)?\\]$`))
    if (section) {
      const id = section[1] ? parseTomlKey(section[1]) : ''
      current = sections[id] ?? (sections[id] = {})
      continue
    }
    // A table that is not one of ours ends the current server; codex configs
    // carry model, profile and sandbox tables alongside the MCP ones.
    if (/^\[\[?/.test(line)) {
      current = null
      continue
    }
    if (!current) continue

    const separator = findTopLevelEquals(line)
    if (separator <= 0) continue
    const key = parseTomlKey(line.slice(0, separator).trim())
    if (!key) continue
    let value = line.slice(separator + 1).trim()
    while (value && !isCompleteTomlValue(value)) {
      lineIndex += 1
      if (lineIndex >= lines.length) {
        throw new Error(`Unterminated TOML value for key "${key}".`)
      }
      const continuation = stripTomlComment(lines[lineIndex]!).trim()
      if (continuation) value = `${value} ${continuation}`
    }
    current[key] = parseTomlValue(value)
  }

  return sections
}

function parseTomlValue(value: string): unknown {
  if (!value) return ''
  if (!isCompleteTomlValue(value)) throw new Error('Unbalanced TOML value.')
  if (value === 'true') return true
  if (value === 'false') return false
  if (value.startsWith('"') || value.startsWith("'")) return parseTomlString(value)
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new Error('Invalid TOML array value.')
    return splitTopLevel(value.slice(1, -1)).map((part) => parseTomlValue(part.trim()))
  }
  if (value.startsWith('{')) {
    if (!value.endsWith('}')) throw new Error('Invalid TOML inline table value.')
    const record: Record<string, unknown> = {}
    for (const part of splitTopLevel(value.slice(1, -1))) {
      const separator = findTopLevelEquals(part)
      if (separator <= 0) continue
      const key = parseTomlKey(part.slice(0, separator).trim())
      if (!key) continue
      record[key] = parseTomlValue(part.slice(separator + 1).trim())
    }
    return record
  }
  return value
}

function isCompleteTomlValue(value: string): boolean {
  let quote: '"' | "'" | null = null
  let escaped = false
  let bracketDepth = 0
  let braceDepth = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === '"' && char === '\\' && !escaped) {
      escaped = true
      continue
    }
    if (!escaped && (char === '"' || char === "'")) {
      quote = quote === char ? null : (quote ?? char)
    } else if (!quote) {
      if (char === '[') bracketDepth += 1
      if (char === ']') bracketDepth -= 1
      if (char === '{') braceDepth += 1
      if (char === '}') braceDepth -= 1
    }
    escaped = false
  }
  return quote === null && bracketDepth === 0 && braceDepth === 0
}

function parseTomlKey(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return parseTomlString(trimmed)
  return trimmed
}

function parseTomlString(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      return trimmed.slice(1, trimmed.endsWith('"') ? -1 : undefined)
    }
  }
  if (trimmed.startsWith("'")) return trimmed.slice(1, trimmed.endsWith("'") ? -1 : undefined)
  return trimmed
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote === '"' && char === '\\' && !escaped) {
      escaped = true
      continue
    }
    if (!escaped && (char === '"' || char === "'")) {
      quote = quote === char ? null : (quote ?? char)
    }
    if (!quote && char === '#') return line.slice(0, index)
    escaped = false
  }
  return line
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let start = 0
  let quote: '"' | "'" | null = null
  let escaped = false
  let bracketDepth = 0
  let braceDepth = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === '"' && char === '\\' && !escaped) {
      escaped = true
      continue
    }
    if (!escaped && (char === '"' || char === "'")) {
      quote = quote === char ? null : (quote ?? char)
    } else if (!quote) {
      if (char === '[') bracketDepth += 1
      if (char === ']') bracketDepth -= 1
      if (char === '{') braceDepth += 1
      if (char === '}') braceDepth -= 1
      if (char === ',' && bracketDepth === 0 && braceDepth === 0) {
        parts.push(value.slice(start, index))
        start = index + 1
      }
    }
    escaped = false
  }
  parts.push(value.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

function findTopLevelEquals(value: string): number {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === '"' && char === '\\' && !escaped) {
      escaped = true
      continue
    }
    if (!escaped && (char === '"' || char === "'")) {
      quote = quote === char ? null : (quote ?? char)
    } else if (!quote && char === '=') {
      return index
    }
    escaped = false
  }
  return -1
}
