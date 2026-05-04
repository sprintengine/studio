#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

if (process.platform !== 'darwin') {
  process.exit(0)
}

const helperPath = path.join(
  __dirname,
  '..',
  'node_modules',
  'node-pty',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'spawn-helper'
)

try {
  const stats = fs.statSync(helperPath)
  const executableBits = 0o111
  if ((stats.mode & executableBits) !== executableBits) {
    fs.chmodSync(helperPath, stats.mode | executableBits)
  }
} catch (error) {
  if (error && error.code === 'ENOENT') {
    process.exit(0)
  }
  console.warn(`Unable to repair node-pty spawn-helper permissions: ${error.message}`)
}
