#!/usr/bin/env node
// DTCG → CSS custom-property transform. Regenerates foundations/tokens.css
// from foundations/tokens.tokens.json — the derived file is never hand-edited.
// Dependency-free Node ESM (Node >= 18 stdlib only) so any agent, in any repo,
// regenerates with the same implementation that ships with the bundle:
//
//   node scripts/build-tokens.mjs           # from the bundle root
//   node scripts/build-tokens.mjs <bundle>  # explicit bundle root
//
// Emission contract (knowledge/multicode/design-system-bundle.md in the
// authoring repo; stable per design-system.json schemaVersion):
//   - one custom property per token: `--` + token path with `.` → `-`
//   - `:root { … }` holds every token at its light/default $value
//   - `[data-mode="dark"] { … }` re-declares only the tokens whose
//     $extensions["com.multicode"].modes.dark differs from modes.light
//   - aliases emit var(--target); literals emit as-is; fontFamily arrays join
//     with commas, quoting names that contain spaces
//
// Output is a pure function of tokens.tokens.json — no timestamps, no
// environment — so repeated runs are byte-identical. Malformed tokens fail
// loudly (exit 1, token path on stderr); a missing/invalid bundle exits 2.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VENDOR_NAMESPACE = 'com.multicode'
const ALIAS_PATTERN = /^\{([a-z0-9.-]+)\}$/

class BuildFailure extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

function fail(message, code = 1) {
  throw new BuildFailure(message, code)
}

// Exit via stream flush: under Electron utilityProcess the parent IPC port
// keeps the event loop alive (the script never exits on its own) and a bare
// process.exit() truncates buffered pipe output. Flushing both stdio streams
// before the hard exit is correct under plain `node` too.
function exitAfterFlush(code) {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}

function collectTokens(node, path, out) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return out
  if ('$value' in node) {
    out.push({ path: path.join('.'), node })
    return out
  }
  for (const [key, child] of Object.entries(node)) collectTokens(child, [...path, key], out)
  return out
}

function cssVariableName(tokenPath) {
  return `--${tokenPath.replace(/\./g, '-')}`
}

function tokenModes(token) {
  const extensions = token.node.$extensions
  const vendor =
    typeof extensions === 'object' && extensions !== null ? extensions[VENDOR_NAMESPACE] : undefined
  const modes = typeof vendor === 'object' && vendor !== null ? vendor.modes : undefined
  return typeof modes === 'object' && modes !== null ? modes : null
}

function main() {
  const rootArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const bundleRoot = resolve(rootArg ?? join(scriptDir, '..'))

  if (!existsSync(join(bundleRoot, 'design-system.json'))) {
    fail(`Not a design-system bundle (no design-system.json): ${bundleRoot}`, 2)
  }
  const tokensPath = join(bundleRoot, 'foundations', 'tokens.tokens.json')
  if (!existsSync(tokensPath)) {
    fail(`Missing foundations/tokens.tokens.json in bundle: ${bundleRoot}`, 2)
  }

  let tokensDocument
  try {
    tokensDocument = JSON.parse(readFileSync(tokensPath, 'utf8'))
  } catch (error) {
    fail(`foundations/tokens.tokens.json is not valid JSON: ${error.message}`, 2)
  }

  const tokens = collectTokens(tokensDocument, [], [])
  if (tokens.length === 0) fail('foundations/tokens.tokens.json contains no tokens')
  const tokenPaths = new Set(tokens.map((token) => token.path))

  function emitValue(tokenPath, value) {
    if (typeof value === 'string') {
      const alias = ALIAS_PATTERN.exec(value)
      if (alias) {
        if (!tokenPaths.has(alias[1])) fail(`${tokenPath}: alias ${value} resolves to no token`)
        return `var(${cssVariableName(alias[1])})`
      }
      return value
    }
    if (typeof value === 'number') return String(value)
    if (Array.isArray(value)) {
      return value
        .map((entry) => {
          if (typeof entry !== 'string') fail(`${tokenPath}: fontFamily entries must be strings`)
          return /\s/.test(entry) ? `"${entry}"` : entry
        })
        .join(', ')
    }
    fail(`${tokenPath}: unsupported $value form: ${JSON.stringify(value)}`)
    return '' // unreachable; fail() throws
  }

  const darkOverrides = []
  for (const token of tokens) {
    if (typeof token.node.$type !== 'string' || token.node.$type.length === 0) {
      fail(`${token.path}: missing explicit $type`)
    }
    if (token.node.$value === undefined) fail(`${token.path}: missing $value`)
    const modes = tokenModes(token)
    if (!modes) continue
    if (!('light' in modes) || !('dark' in modes)) {
      fail(`${token.path}: modes must declare exactly light and dark`)
    }
    if (JSON.stringify(modes.light) !== JSON.stringify(token.node.$value)) {
      fail(`${token.path}: modes.light must equal $value (light is the default mode)`)
    }
    if (JSON.stringify(modes.dark) !== JSON.stringify(modes.light)) {
      darkOverrides.push({ token, darkValue: modes.dark })
    }
  }

  let css = `/* GENERATED FILE — do not edit by hand.
 * Derived from foundations/tokens.tokens.json by scripts/build-tokens.mjs.
 * Emission contract: knowledge/multicode/design-system-bundle.md.
 * :root carries the light (default) mode; [data-mode="dark"] overrides the
 * tokens whose values differ in dark mode. */
:root {
`
  for (const token of tokens) {
    css += `  ${cssVariableName(token.path)}: ${emitValue(token.path, token.node.$value)};\n`
  }
  css += '}\n[data-mode="dark"] {\n'
  for (const { token, darkValue } of darkOverrides) {
    css += `  ${cssVariableName(token.path)}: ${emitValue(token.path, darkValue)};\n`
  }
  css += '}\n'

  writeFileSync(join(bundleRoot, 'foundations', 'tokens.css'), css)
  return `wrote foundations/tokens.css (${tokens.length} tokens, ${darkOverrides.length} dark overrides)\n`
}

try {
  process.stdout.write(main())
  exitAfterFlush(0)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  exitAfterFlush(error instanceof BuildFailure ? error.code : 1)
}
