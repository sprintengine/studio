#!/usr/bin/env node
// Kept only as a forwarding shim: the suite runs on Vitest (`npm test`).
//
// The marketplace registry's own CI checks out this repository and runs
// `node scripts/testing/run-tests.mjs verify-marketplace.test`, and that
// workflow lives in the registry's repository, not here. Its mirror in
// resources/marketplace/.github/ already calls Vitest; delete this file once the
// registry has taken that copy.
//
//   node scripts/testing/run-tests.mjs [filter...]   same as: npx vitest run [filter...]
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const filters = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const manifestPath = require.resolve('vitest/package.json')
const { bin } = require(manifestPath)
const vitest = path.join(path.dirname(manifestPath), typeof bin === 'string' ? bin : bin.vitest)
const result = spawnSync(process.execPath, [vitest, 'run', ...filters], { stdio: 'inherit' })
process.exit(result.status ?? 1)
