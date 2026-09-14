#!/usr/bin/env node
// Multicode knowledge activity hook for Claude Code.
//
// Invoked as a PostToolUse hook. Reads Claude's JSON payload from stdin,
// extracts the touched file path, and appends a single JSON line to the
// session trace file under .multicode/knowledge-trace/. Silently no-ops when
// the touched file is outside the configured knowledge root.
//
// Args:
//   --knowledge-root <relative-path>   Knowledge root, workspace-relative.
//   --memory-root <relative-path>      Backward-compatible alias.
//
// The script always exits 0 so a hook failure never breaks Claude.

import { appendFile, mkdir } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'

// The app's own variables answer to two names. Everything was spelled
// `MULTICODE_*` before the 2026-09-08 rename to SprintEngine Studio and is
// spelled `SPRINTENGINE_*` now, and this file is a COPY installed into a
// workspace: the app instance launching an agent may be either side of that
// rename, and this copy may be either side of it too. New name first, old name
// second. An empty value counts as unset here, matching the `||` fallbacks the
// call sites already had.
const studioEnv = (name) =>
  process.env[name] || process.env[name.replace(/^SPRINTENGINE_/, 'MULTICODE_')] || ''


async function readStdin() {
  return new Promise((res) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buf += chunk
    })
    process.stdin.on('end', () => res(buf))
    process.stdin.on('error', () => res(buf))
    if (process.stdin.isTTY) res('')
  })
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--knowledge-root' || a === '--memory-root') {
      args.memoryRoot = argv[i + 1]
      i += 1
    }
  }
  return args
}

// Translate WSL paths to native form when the script runs on Windows.
// Hook + Multicode always run on the same OS, but a Claude session inside
// WSL may emit POSIX paths that point at the same files. We normalize so
// the knowledge-root containment check works either way.
function translatePath(input) {
  if (!input) return input
  if (process.platform === 'win32') {
    const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(input)
    if (m) return `${m[1].toUpperCase()}:${m[2] ? m[2].replace(/\//g, '\\') : '\\'}`
  }
  return input
}

function isInside(parent, child) {
  const p = resolve(parent)
  const c = resolve(child)
  if (process.platform === 'win32') {
    const pl = p.toLowerCase()
    const cl = c.toLowerCase()
    return cl === pl || cl.startsWith(pl + sep.toLowerCase())
  }
  return c === p || c.startsWith(p + sep)
}

function relativeForward(parent, child) {
  const rel = resolve(child).slice(resolve(parent).length).replace(/^[\\/]+/, '')
  return rel.split(sep).join('/')
}

function extractFilePath(payload) {
  const ti = payload?.tool_input
  if (!ti) return null
  if (typeof ti.file_path === 'string') return ti.file_path
  if (typeof ti.path === 'string') return ti.path
  return null
}

async function main() {
  const debug = studioEnv('SPRINTENGINE_HOOK_DEBUG') === '1'
  const log = (msg) => {
    if (debug) process.stderr.write(`[hook] ${msg}\n`)
  }

  const args = parseArgs(process.argv.slice(2))
  if (!args.memoryRoot) {
    log('no --knowledge-root')
    return
  }
  const memoryRoot = isAbsolute(args.memoryRoot)
    ? args.memoryRoot
    : resolve(process.cwd(), args.memoryRoot)
  log(`memoryRoot=${memoryRoot}`)

  const stdinRaw = await readStdin()
  // Strip a leading UTF-8 BOM if present — some shells (notably PowerShell)
  // prepend one when piping a string to a child process. Claude itself does
  // not, but stripping it costs nothing and avoids a confusing failure mode.
  const stdin = stdinRaw.replace(/^﻿/, '')
  log(`stdin.length=${stdin.length}`)
  if (!stdin.trim()) {
    log('empty stdin')
    return
  }

  let payload
  try {
    payload = JSON.parse(stdin)
  } catch (e) {
    log(`parse error: ${e?.message}`)
    return
  }

  const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : null
  const tool = typeof payload?.tool_name === 'string' ? payload.tool_name : null
  if (!sessionId || !tool) {
    log(`missing session/tool: session=${sessionId} tool=${tool}`)
    return
  }

  const rawFile = extractFilePath(payload)
  if (!rawFile) {
    log('no file path in tool_input')
    return
  }
  const absFile = translatePath(rawFile)
  const resolved = isAbsolute(absFile) ? absFile : resolve(process.cwd(), absFile)
  log(`resolved=${resolved}`)

  if (!isInside(memoryRoot, resolved)) {
    log(`outside knowledge root`)
    return
  }

  const traceDir = resolve(process.cwd(), '.multicode', 'knowledge-trace')
  await mkdir(traceDir, { recursive: true })

  const event = {
    sessionId,
    tool,
    file: relativeForward(memoryRoot, resolved),
    ts: Date.now(),
  }

  const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
  const traceFile = resolve(traceDir, `${safeSession}.jsonl`)
  await appendFile(traceFile, JSON.stringify(event) + '\n', { encoding: 'utf8' })
}

main().catch(() => {
  // Never let a hook error break Claude.
}).finally(() => {
  process.exit(0)
})
