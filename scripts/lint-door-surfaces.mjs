#!/usr/bin/env node
// Door-surface brand gates — the mechanically checkable rules a
// door page must pass:
//
//  1. A door page never paints the themed canvas: `--bg-app` is forbidden
//     under components/workspace/globalSurface/ (owner ruling 2026-07-23 —
//     sage is sidebar/chrome identity; doors paint --bg-surface).
//  2. Marketing radii are reject-on-sight in panels: `rounded-2xl`/`rounded-3xl`
//     are forbidden anywhere under src/renderer/src/components.
//
// Exit 1 with file:line findings on any violation, 0 otherwise.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const componentsRoot = join(root, 'src/renderer/src/components')
const doorRoot = join(componentsRoot, 'workspace/globalSurface')

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(tsx?|css)$/.test(entry)) yield full
  }
}

const violations = []

function scan(file, pattern, message, { allowTests = true } = {}) {
  if (allowTests && /\.test\.tsx?$/.test(file)) return
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (!pattern.test(line)) return
    // Escape hatch mirrors lint-design-tokens: an explicit annotation on the
    // line marks a reviewed exception.
    if (line.includes('door-surfaces-allow')) return
    violations.push(`${relative(root, file)}:${index + 1}: ${message}`)
  })
}

for (const file of walk(doorRoot)) {
  scan(file, /var\(--bg-app\)/, 'door surfaces paint --bg-surface, never the themed canvas (--bg-app)')
}
for (const file of walk(componentsRoot)) {
  scan(file, /rounded-(2xl|3xl)/, 'marketing radii are reject-on-sight in panels (rounded-2xl/3xl)')
}

if (violations.length > 0) {
  console.error('Door-surface brand gate failed:')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log(`lint-door-surfaces: ok (scanned globalSurface + components; 0 violations)`)
