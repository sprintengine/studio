import { defineConfig } from 'vitest/config'

// Suites that assert on scheduler timing, so sharing a CPU with the rest makes
// them flake. They run in their own project, one file at a time, after the rest.
const SERIAL = [
  'src/main/account-client.test.ts',
  'src/main/agent-state-service.test.ts',
  'src/main/automation/automation.test.ts',
  'src/main/automation/tailnet-fleet-reachability.test.ts',
  'src/main/automation/tailnet-fleet.test.ts',
  'src/main/automation/tailnet-live-events.test.ts',
  'src/main/automation/tailnet.test.ts',
  'src/main/backlog-service.test.ts',
  'src/main/capability-watcher.test.ts',
  'src/main/companion-agent-service.test.ts',
  'src/main/hosted-feed/card-feed-client.test.ts',
  'src/main/mobile/bridge/index.test.ts',
  'src/main/skills/studio-plugin.test.ts',
  'src/main/studio-plugin-service.test.ts',
  'src/main/terminal-runtime.test.ts',
  'src/renderer/src/components/workspace/ConversationPeekPopover.test.tsx',
  'src/renderer/src/hooks/useSharedBacklogScan.test.ts',
  'src/renderer/src/modules/backlog-reader.test.ts',
  'src/renderer/src/store/workspaceStore.activeSync.test.ts',
  'src/renderer/src/store/workspaceStore.persistence.test.ts',
  'src/renderer/src/store/workspaceStore.registrySnapshotHeal.test.ts',
  'src/seams/conversationSeam.test.ts',
  'src/seams/premiumFeelSeam.test.tsx',
  'src/seams/skillSourcesSeam.test.tsx',
]

export default defineConfig({
  // The renderer's tsx is compiled the way the app's own build compiles it.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: { '@renderer': new URL('./src/renderer/src', import.meta.url).pathname },
  },
  test: {
    setupFiles: ['./tests/setup.ts'],
    environment: 'node',
    // Nearly every file is one test that walks all of its cases in order (see
    // CONTRIBUTING), and the slowest takes ~40s.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // A passing suite's `ok - …` lines are noise; a failing one's are the story.
    silent: 'passed-only',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
      exclude: ['**/*.test.{ts,tsx}', '**/__fixtures__/**', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'html'],
    },
    pool: 'forks',
    // `--expose-gc` lets a suite that bounds what a reader RETAINS collect the
    // garbage first, so the bound does not move with the GC's timing.
    execArgv: ['--max-old-space-size=4096', '--expose-gc'],
    server: {
      deps: {
        // flexlayout-react ships no "exports" map, so Node cannot resolve it as
        // an external; Vite resolves it the way the app's bundle does.
        inline: ['flexlayout-react'],
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}', 'packages/*/test/**/*.test.ts', 'resources/marketplace/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', ...SERIAL],
        },
      },
      {
        extends: true,
        test: {
          name: 'serial',
          include: SERIAL,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
