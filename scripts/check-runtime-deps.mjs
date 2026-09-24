#!/usr/bin/env node
// Keeps `dependencies` in package.json down to what main and preload load from
// node_modules at runtime.
//
// electron-builder copies every package in `dependencies`, and everything they
// depend on, into app.asar whole. Vite has already bundled the renderer's
// packages into out/renderer, so a renderer-only package listed there ships
// twice: once as the few hundred KB the bundle actually uses, and once as its
// entire npm tarball that nothing ever reads. The editor, the canvas editor and
// the diagram importer alone came to ~230 MB of the installed app that way.
//
// The rule this script enforces follows from how electron-vite splits the two:
// its externalizeDepsPlugin leaves every `dependencies` entry as a runtime
// require() in out/main and out/preload, and bundles everything else. So a
// package belongs in `dependencies` exactly when one of those bundles still
// names it, and a package nothing there names belongs in `devDependencies`.
//
// Runs after `electron-vite build` (chained in the "build" script), because it
// reads the bundles that build writes.

import { readFileSync } from 'node:fs'

const BUNDLES = ['out/main/index.js', 'out/preload/index.js', 'out/preload/browser-guest.js']

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const dependencies = Object.keys(manifest.dependencies ?? {})
const bundled = BUNDLES.map((file) => readFileSync(file, 'utf8')).join('\n')

function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

// A runtime lookup of the package or one of its subpaths, in any of the forms
// the bundles use: require('x'), import('x') and a static import from 'x'.
function isLoadedAtRuntime(name) {
  const quoted = `["'\`]${escapeForRegExp(name)}(?:/[^"'\`]*)?["'\`]`
  return new RegExp(`(?:require\\(|import\\(|from\\s*)${quoted}`).test(bundled)
}

const unused = dependencies.filter((name) => !isLoadedAtRuntime(name))
if (unused.length > 0) {
  console.error(
    `[runtime-deps] ${unused.join(', ')} ${unused.length === 1 ? 'is' : 'are'} in "dependencies", ` +
      'but nothing in out/main or out/preload loads it at runtime.',
  )
  console.error(
    '[runtime-deps] electron-builder would copy the whole package into app.asar next to the copy Vite ' +
      'already bundled. Move it to "devDependencies"; the renderer build does not care which list it is in.',
  )
  process.exit(1)
}

console.log(`[runtime-deps] ok — ${dependencies.length} dependencies, each loaded by main or preload at runtime.`)
