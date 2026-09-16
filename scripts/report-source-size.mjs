#!/usr/bin/env node
// Report large source files so extraction work has a stable, reproducible size signal.
//
// Usage:
//   node scripts/report-source-size.mjs
//   node scripts/report-source-size.mjs --thresholds 800,1200,2000

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

const SOURCE_ROOTS = [
  'src',
  'packages',
]
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx', '.py'])
const EXCLUDED_DIRS = new Set([
  '__pycache__',
  'dist',
  'dist-electron',
  'node_modules',
  'out',
])
const DEFAULT_THRESHOLDS = [800, 1200, 2000]

function parseThresholds(argv) {
  const index = argv.indexOf('--thresholds')
  if (index < 0) return DEFAULT_THRESHOLDS
  const raw = argv[index + 1]
  if (!raw) {
    throw new Error('Missing comma-separated value after --thresholds')
  }
  const parsed = raw
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0)
  if (parsed.length === 0) {
    throw new Error(`No valid positive thresholds found in "${raw}"`)
  }
  return [...new Set(parsed)].sort((a, b) => a - b)
}

function walk(dir, repoRoot) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      out.push(...walk(join(dir, entry.name), repoRoot))
      continue
    }
    if (!entry.isFile()) continue
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue
    const fullPath = join(dir, entry.name)
    out.push(fullPath.slice(repoRoot.length + 1).split(sep).join('/'))
  }
  return out
}

function lineCount(path) {
  const source = readFileSync(path, 'utf8')
  if (source.length === 0) return 0
  const newlineCount = source.match(/\n/g)?.length ?? 0
  return source.endsWith('\n') ? newlineCount : newlineCount + 1
}

const repoRoot = process.cwd()
let thresholds
try {
  thresholds = parseThresholds(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(2)
}

const files = SOURCE_ROOTS.flatMap((root) => walk(resolve(repoRoot, root), repoRoot)).sort()
const rows = files
  .map((path) => ({ path, lines: lineCount(resolve(repoRoot, path)) }))
  .filter((row) => thresholds.some((threshold) => row.lines >= threshold))
  .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path))

process.stdout.write('Source size report\n')
process.stdout.write(`Roots: ${SOURCE_ROOTS.join(', ')}\n`)
process.stdout.write(`Extensions: ${[...SOURCE_EXTENSIONS].sort().join(', ')}\n`)
process.stdout.write(`Thresholds: ${thresholds.join(', ')} lines\n`)
process.stdout.write(`Files scanned: ${files.length}\n\n`)

if (rows.length === 0) {
  process.stdout.write('No source files meet the configured thresholds.\n')
  process.exit(0)
}

for (const threshold of thresholds) {
  const thresholdRows = rows.filter((row) => row.lines >= threshold)
  process.stdout.write(`>= ${threshold} lines: ${thresholdRows.length}\n`)
}

process.stdout.write('\nLines  Path\n')
for (const row of rows) {
  process.stdout.write(`${String(row.lines).padStart(5, ' ')}  ${row.path}\n`)
}
