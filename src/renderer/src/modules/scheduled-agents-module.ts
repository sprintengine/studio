import type { RendererModule } from './renderer-host'

// Scheduled agents. Matches the main-side `scheduled-agents` module id, so the
// one enablement override gates both processes: switched off, the scheduler
// stops, and the New chat panel's Scheduled agent switch, the clock beside New
// chat and the scheduled agents' sidebar cards all go with it — each checks
// this module's enablement rather than being registered here, because each
// lives inside a core surface (the New chat panel, the sidebar) rather than
// being one of its own.
export const scheduledAgentsRendererModule: RendererModule = {
  manifest: {
    id: 'scheduled-agents',
    displayName: 'Scheduled agents',
    version: 1,
    publisher: 'sprintengine',
    category: 'orchestration',
    summary: 'Start a chat agent with a prompt on a schedule.',
    defaultEnabled: true,
    dependsOn: ['agent-runtime'],
  },
  registerRenderer() {},
}
