#!/usr/bin/env node
// VSCode (and any Electron host) sets ELECTRON_RUN_AS_NODE=1, which disables Electron's
// browser process initialization when spawned as a child. Clear it before starting.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const { spawnSync } = require('child_process')
const bin = require('path').join(require.resolve('electron-vite/package.json'), '../bin/electron-vite.js')

const result = spawnSync('node', [bin, 'dev'], { stdio: 'inherit', env })
process.exit(result.status ?? 0)
