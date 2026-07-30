import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function rendererDevPort(): number {
  const value = process.env['MULTICODE_RENDERER_PORT']?.trim()
  if (!value) return 5173

  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 5173
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    server: {
      port: rendererDevPort(),
      strictPort: process.env['MULTICODE_RENDERER_STRICT_PORT'] === '1',
    },
    build: {
      rollupOptions: {
        // Two HTML entries. `index` is the app; `splash` is the standalone
        // launch plate, which loads no bundle at all — without naming it here
        // the packaged build simply would not emit it, since electron-vite
        // otherwise infers the single implicit `src/renderer/index.html`.
        input: {
          index: resolve('src/renderer/index.html'),
          splash: resolve('src/renderer/splash.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
})
