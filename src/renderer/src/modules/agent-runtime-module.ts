import type { RendererModule } from './renderer-host'

// Agent runtime — the irreducible core (terminals, the BYO-CLI launch path, the
// agent session runtime). It is `core: true`, so the resolver always keeps it
// enabled and Settings → Modules renders it as a locked-on toggle the user can't
// turn off. Its renderer surfaces (AgentPanel, TerminalView, PlainTerminalPanel,
// the agents/runState store slices) are always present, so it registers no
// gated panels with the host — its manifest exists to anchor the dependency
// graph and present the core in the chooser.
export const agentRuntimeRendererModule: RendererModule = {
  manifest: {
    id: 'agent-runtime',
    displayName: 'Agent Runtime',
    version: 1,
    publisher: 'multicode',
    category: 'core',
    summary:
      'Terminals, the BYO-CLI launch path, and the agent session runtime every other capability builds on. Always on.',
    defaultEnabled: true,
    core: true,
  },
}
